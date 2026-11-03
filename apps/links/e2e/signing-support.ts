import { createHmac } from 'node:crypto';
import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

/**
 * Helpers for the signing specs (TL-07). They drive the running stack (pnpm dev): staff act
 * through the API as the seeded demo manager, the worker renders and finalises, and codes are
 * read where the fake SMS provider and Mailpit capture them. Every run makes its own property,
 * tenants and leases, so nothing depends on an earlier run.
 */
export const API = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');
const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3701';

/** Seeded demo accounts (pnpm db:seed; packages/server/scripts/seed.ts). */
export const MANAGER = {
  email: 'manager.one@demo.invalid',
  name: 'Kofi Manager (demo)',
  password: 'demo-password-2026',
};
const DEMO_TOTP_SECRET = 'rent-demo-totp-secret-2026-local';

/** RFC 6238 TOTP (SHA-1, 30 seconds, 6 digits) over the raw secret, as Better Auth keys it. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const value =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(value % 1_000_000).padStart(6, '0');
}

/** Waits out Better Auth's per-address limits when a long run hits them. */
async function postAuth(api: APIRequestContext, path: string, data: unknown) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await api.post(path, { data });
    if (response.status() !== 429 || attempt === 4) return response;
    const seconds = Number(response.headers()['x-retry-after'] ?? '30');
    await new Promise((resolve) =>
      setTimeout(resolve, ((Number.isFinite(seconds) ? seconds : 30) + 1) * 1000),
    );
  }
}

/** The demo manager, signed in to the API with password and TOTP. */
export async function managerApi(): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { origin: WEB_ORIGIN },
  });
  const signIn = await postAuth(api, '/api/auth/sign-in/email', {
    email: MANAGER.email,
    password: MANAGER.password,
  });
  expect(signIn.status(), 'sign in with the demo password (run pnpm db:seed)').toBe(200);
  const verify = await postAuth(api, '/api/auth/two-factor/verify-totp', {
    code: totp(DEMO_TOTP_SECRET),
  });
  expect(verify.status(), 'TOTP verification').toBe(200);
  return api;
}

export async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** A phone in the fake +233 20 7xx xxxx block, so each run's signers have numbers of their own. */
export const freshPhone = (): string =>
  `+233207${String(Math.trunc(Math.random() * 1_000_000)).padStart(6, '0')}`;

const accraDate = (offsetMonths: number, offsetDays = 0): string => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra' })
    .format(new Date())
    .split('-')
    .map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + offsetMonths, Math.min(d, 28) + offsetDays));
  return date.toISOString().slice(0, 10);
};

/** A property of single rooms for the agency's owner OWN-01, made through the API. */
export async function newProperty(api: APIRequestContext, rooms: number) {
  const owners = await ok<{ id: string; reference: string }[]>(await api.get('/owners'), 'owners');
  const owner = owners.find((o) => o.reference === 'OWN-01');
  if (!owner) throw new Error('No OWN-01: run pnpm db:seed');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const part = Array.from({ length: 4 }, () =>
      String.fromCharCode(65 + Math.trunc(Math.random() * 26)),
    ).join('');
    const response = await api.post('/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `Signing test rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: owner.id,
        address: { region: 'Greater Accra' },
        units: [{ unitType: 'single_room', count: rooms }],
      },
    });
    if (response.status() === 409) continue;
    const property = await ok<{ blocks: { units: { id: string; code: string }[] }[] }>(
      response,
      'create a property',
    );
    return property.blocks.flatMap((b) => b.units);
  }
  throw new Error('no free property code');
}

export interface IssuedLease {
  readonly leaseId: string;
  readonly requestId: string;
  readonly tenantPhone: string;
  readonly witnessPhone: string;
  /** Signer ids by role. */
  readonly signers: Record<string, string>;
}

/**
 * A lease issued for e-signing and opened: the tenant (with SMS consent, so the link goes by
 * SMS), the demo manager for the landlord (by email) and a witness with no consent on record,
 * who needs a hand-over link. Waits for the worker to render the PDF and open the request.
 */
export async function issuedLease(
  api: APIRequestContext,
  unitId: string,
  tenantName: string,
): Promise<IssuedLease> {
  const tenantPhone = freshPhone();
  const witnessPhone = freshPhone();
  const tenant = await ok<{ tenant: { id: string } }>(
    await api.post('/tenants', {
      data: {
        kind: 'individual',
        displayName: tenantName,
        phone: tenantPhone,
        consent: { sms: true },
      },
    }),
    'create a tenant',
  );
  const start = accraDate(2);
  const draft = await ok<{ id: string; parties: Record<string, unknown>[] }>(
    await api.post('/leases', {
      data: {
        unitId,
        tenantId: tenant.tenant.id,
        startDate: start,
        endDate: accraDate(14, -1),
        monthlyRentMinor: 90_000,
        cycle: 'monthly',
        noticeDays: 30,
      },
    }),
    'draft a lease',
  );
  await ok(
    await api.patch(`/leases/${draft.id}`, {
      data: {
        parties: [
          ...draft.parties.map((p) => ({
            role: p.role,
            name: p.name,
            phone: p.phone,
            email: p.email,
            tenantContactId: p.tenantContactId,
            staffPersonId: p.staffPersonId,
          })),
          { role: 'witness', name: 'Esi Witness (e2e)', phone: witnessPhone },
        ],
      },
    }),
    'add the witness',
  );
  await ok(await api.post(`/leases/${draft.id}/issue`, { data: {} }), 'issue the lease');
  let progress: {
    status: string;
    requestId: string;
    signers: { id: string; role: string }[];
  } | null = null;
  await expect
    .poll(
      async () => {
        progress = await ok(await api.get(`/leases/${draft.id}/signing`), 'signing progress');
        return progress?.status;
      },
      { message: 'the worker renders the PDF and opens the request', timeout: 45_000 },
    )
    .toBe('pending');
  const opened = progress!;
  return {
    leaseId: draft.id,
    requestId: opened.requestId,
    tenantPhone,
    witnessPhone,
    signers: Object.fromEntries(opened.signers.map((s) => [s.role, s.id])),
  };
}

/** A hand-over link for one signer, as staff would show it; returns the page path. */
export async function handoverPath(
  api: APIRequestContext,
  lease: IssuedLease,
  role: string,
): Promise<string> {
  const link = await ok<{ url: string }>(
    await api.post(`/signing-requests/${lease.requestId}/signers/${lease.signers[role]}/link`, {
      data: {},
    }),
    `hand over a link to the ${role}`,
  );
  return pathOf(link.url);
}

/** The page path of a link URL (the API names the dev links host; tests use their own). */
export function pathOf(url: string): string {
  const token = /\/l\/([A-Za-z0-9_-]{43})/.exec(url)?.[1];
  if (!token) throw new Error('no link token in that URL');
  return `/l/${token}`;
}

interface Captured {
  readonly body: string;
  readonly at: string;
}

/** SMS the fake provider captured for a phone, newest first. */
export async function smsTo(phone: string): Promise<Captured[]> {
  const response = await fetch(
    `${FAKE_PROVIDERS}/messages?channel=sms&to=${encodeURIComponent(phone)}`,
  );
  return (await response.json()) as Captured[];
}

/** The newest SMS to a phone that matches, waiting for the worker or the API to send it. */
export async function waitForSms(phone: string, pattern: RegExp, after = 0): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const message = (await smsTo(phone)).find(
          (m) => pattern.test(m.body) && Date.parse(m.at) >= after,
        );
        found = message?.body ?? '';
        return found !== '';
      },
      { message: `an SMS matching ${pattern} to the signer`, timeout: 30_000 },
    )
    .toBe(true);
  return found;
}

export async function codeTextedTo(phone: string, after: number): Promise<string> {
  const body = await waitForSms(phone, /is your code/, after);
  return /^(\d{6})/.exec(body)![1]!;
}

/** The newest signing code emailed to an address since `after` (Mailpit). */
export async function codeEmailedTo(address: string, after: number): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address} subject:"Your code to sign"`)}&limit=5`,
        );
        const { messages } = (await search.json()) as {
          messages: { ID: string; Created: string }[];
        };
        const newest = messages.find((m) => Date.parse(m.Created) >= after - 1_000);
        if (!newest) return false;
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`)).json()) as {
          Text: string;
        };
        code = /Your code is (\d{6})/.exec(message.Text)?.[1] ?? '';
        return code !== '';
      },
      { message: 'a signing code emailed to the landlord’s signer', timeout: 30_000 },
    )
    .toBe(true);
  return code;
}
