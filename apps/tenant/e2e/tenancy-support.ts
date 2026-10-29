import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';

/**
 * Helpers for the tenant app's M3 specs (TL-01, TL-07, TL-12), after apps/links/e2e/signing-support.ts.
 * Staff act through the API as seeded demo accounts; the worker renders and finalises; codes are
 * read where the fake SMS provider and Mailpit capture them. Each run makes its own properties,
 * tenants and leases, on fresh phones, so nothing depends on an earlier run or on the seeded
 * people other suites use.
 */
const API = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');
const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3701';

/** Seeded demo staff (pnpm db:seed; packages/server/scripts/seed.ts). */
const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_TOTP_SECRET = 'rent-demo-totp-secret-2026-local';
export const MANAGER = { email: 'manager.one@demo.invalid', name: 'Kofi Manager (demo)' };
/** The self-managing landlord's owner. */
export const LANDLORD = { email: 'landlord@demo.invalid', name: 'Kwabena Landlord (demo)' };

/**
 * RFC 6238 TOTP (SHA-1, 30 seconds, 6 digits) over the raw secret, as Better Auth keys it. Web
 * Crypto, because the app's TypeScript has no Node types.
 */
async function totp(secret: string, at = Date.now()): Promise<string> {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(at / 30_000)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
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

/** A seeded staff member, signed in to the API with password and TOTP. */
export async function staffApi(person: { readonly email: string }): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { origin: WEB_ORIGIN },
  });
  const signIn = await postAuth(api, '/api/auth/sign-in/email', {
    email: person.email,
    password: DEMO_PASSWORD,
  });
  expect(signIn.status(), `sign in as ${person.email} (run pnpm db:seed)`).toBe(200);
  const verify = await postAuth(api, '/api/auth/two-factor/verify-totp', {
    code: await totp(DEMO_TOTP_SECRET),
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

/** The staff member's company name, as the tenant app shows it. */
export async function companyName(api: APIRequestContext): Promise<string> {
  return (await ok<{ displayName: string }>(await api.get('/company'), 'the company')).displayName;
}

/** A phone in the fake +233 20 8xx xxxx block (the links specs use 7xx, the web specs 9xx). */
export const freshPhone = (): string =>
  `+233208${String(Math.trunc(Math.random() * 1_000_000)).padStart(6, '0')}`;

/** Today in Accra (the demo companies' time zone), and dates from it, as YYYY-MM-DD. */
export const today = (): string =>
  toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
export const monthsFromToday = (months: number): string =>
  toIsoDate(addMonths(parseBusinessDate(today()), months));
export const monthsAfter = (iso: string, months: number): string =>
  toIsoDate(addMonths(parseBusinessDate(iso), months));
/** The last day of a term of `months` months from `start`. */
export const termEnd = (start: string, months: number): string =>
  toIsoDate(addDays(addMonths(parseBusinessDate(start), months), -1));

export interface Unit {
  readonly id: string;
  readonly code: string;
}

/**
 * A property of single rooms made through the API: for the agency, owned by OWN-01; for the
 * self-managing landlord, the company's own.
 */
export async function newRooms(
  api: APIRequestContext,
  rooms: number,
  options: { readonly ownerReference?: string } = {},
): Promise<Unit[]> {
  let ownerId: string | undefined;
  if (options.ownerReference) {
    const owners = await ok<{ id: string; reference: string }[]>(
      await api.get('/owners'),
      'owners',
    );
    ownerId = owners.find((o) => o.reference === options.ownerReference)?.id;
    if (!ownerId) throw new Error(`No ${options.ownerReference}: run pnpm db:seed`);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const part = Array.from({ length: 4 }, () =>
      String.fromCharCode(65 + Math.trunc(Math.random() * 26)),
    ).join('');
    const response = await api.post('/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `Tenant app rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ...(ownerId ? { ownerId } : {}),
        address: { region: 'Greater Accra', town: 'Madina' },
        units: [{ unitType: 'single_room', count: rooms }],
      },
    });
    if (response.status() === 409) continue;
    const property = await ok<{ blocks: { units: Unit[] }[] }>(response, 'create a property');
    return property.blocks.flatMap((b) => b.units.map((u) => ({ id: u.id, code: u.code })));
  }
  throw new Error('no free property code');
}

/** An individual tenant with SMS consent, so signing links go by SMS. */
export async function newTenant(
  api: APIRequestContext,
  displayName: string,
  phone: string,
): Promise<string> {
  const saved = await ok<{ tenant: { id: string } }>(
    await api.post('/tenants', {
      data: { kind: 'individual', displayName, phone, consent: { sms: true } },
    }),
    'create a tenant',
  );
  return saved.tenant.id;
}

/** A one-page PDF, enough for the storage's content check. */
const PAPER_SCAN = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

/** SHA-256 in hex, as the API reports fingerprints. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PaperLease {
  readonly unitId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly startDate: string;
  readonly months: number;
  readonly monthlyRentMinor: number;
  readonly cycle: 'monthly' | 'quarterly' | 'six_monthly' | 'annual';
  readonly depositMinor?: number;
  readonly serviceChargeMonthlyMinor?: number;
  readonly steps?: readonly { readonly effectiveFrom: string; readonly monthlyRentMinor: number }[];
  readonly noticeDays: number;
}

/**
 * A lease already signed on paper (decision 7), with its scan sent straight to storage. Its scan
 * is the lease's signed copy, which the tenant app downloads.
 */
export async function recordPaperLease(api: APIRequestContext, lease: PaperLease): Promise<string> {
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await api.post('/lease-uploads', {
      data: { contentType: 'application/pdf', sizeBytes: PAPER_SCAN.length },
    }),
    'ask for an upload',
  );
  // Storage wants the policy fields first and the file last, as a browser sends them.
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([PAPER_SCAN], { type: 'application/pdf' }), 'paper-lease.pdf');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the scan: ${stored.status}`).toBe(true);
  const saved = await ok<{ id: string; status: string }>(
    await api.post('/leases/paper', {
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        startDate: lease.startDate,
        endDate: termEnd(lease.startDate, lease.months),
        monthlyRentMinor: lease.monthlyRentMinor,
        cycle: lease.cycle,
        depositMinor: lease.depositMinor ?? null,
        serviceChargeMonthlyMinor: lease.serviceChargeMonthlyMinor ?? null,
        steps: lease.steps ?? [],
        noticeDays: lease.noticeDays,
        parties: [{ role: 'tenant', name: lease.tenantName, paperSignedOn: lease.startDate }],
        scanUploadId: slot.uploadId,
        signedOn: lease.startDate,
      },
    }),
    'record the paper lease',
  );
  return saved.id;
}

export interface IssuedLease {
  readonly leaseId: string;
  readonly requestId: string;
  /** Signer ids by role. */
  readonly signers: Record<string, string>;
}

/**
 * A lease issued for e-signing and opened: the tenant (who has SMS consent), the demo manager for
 * the landlord (by email) and a witness with no consent on record, who needs a hand-over link.
 * Waits for the worker to render the PDF and open the request.
 */
export async function issueLease(
  api: APIRequestContext,
  lease: {
    readonly unitId: string;
    readonly tenantId: string;
    readonly witnessPhone: string;
    readonly startDate: string;
    readonly monthlyRentMinor: number;
  },
): Promise<IssuedLease> {
  const draft = await ok<{ id: string; parties: Record<string, unknown>[] }>(
    await api.post('/leases', {
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        startDate: lease.startDate,
        endDate: termEnd(lease.startDate, 12),
        monthlyRentMinor: lease.monthlyRentMinor,
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
          { role: 'witness', name: 'Esi Witness (e2e)', phone: lease.witnessPhone },
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
    signers: Object.fromEntries(opened.signers.map((s) => [s.role, s.id])),
  };
}

/** A hand-over link for one signer, as staff would show it (decision 2). */
export async function handoverLink(
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
  return link.url;
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

/** The 6-digit code in the newest SMS to a phone that matches `pattern`, sent since `after`. */
async function codeInSms(phone: string, pattern: RegExp, after: number, what: string) {
  let code = '';
  await expect
    .poll(
      async () => {
        const message = (await smsTo(phone)).find(
          (m) => pattern.test(m.body) && Date.parse(m.at) >= after - 1_000,
        );
        code = (message && /\b(\d{6})\b/.exec(message.body)?.[1]) ?? '';
        return code !== '';
      },
      { message: `${what} reaches the fake SMS provider`, timeout: 30_000 },
    )
    .toBe(true);
  return code;
}

export const signInCodeTo = (phone: string, after: number) =>
  codeInSms(phone, /sign-in code is \d{6}/, after, 'the sign-in code');

export const signingCodeTo = (phone: string, after: number) =>
  codeInSms(phone, /is your code/, after, 'the signing code');

/** The newest signing code emailed to an address since `after` (Mailpit). */
export async function signingCodeEmailedTo(address: string, after: number): Promise<string> {
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

/**
 * Signs in to the tenant app by phone, as a tenant would, typing the number in its local form.
 * Each call sends one code: the API allows 10 sends an hour from one address (AUTH_RATE_LIMITS),
 * so a spec signs in once and reuses the page.
 */
export async function signInToApp(page: Page, phone: string): Promise<void> {
  const started = Date.now();
  await page.goto('/');
  await expect(page.getByTestId('phone-input')).toBeVisible();
  await page.getByTestId('phone-input').fill(`0${phone.slice(4)}`);
  await page.getByTestId('send-code').click();
  const refused = page.getByTestId('error');
  await expect(page.getByTestId('code-input').or(refused)).toBeVisible();
  if (await refused.isVisible())
    throw new Error(`The app could not send a sign-in code: ${await refused.innerText()}`);
  await page.getByTestId('code-input').fill(await signInCodeTo(phone, started));
  await page.getByTestId('verify-code').click();
}

/** One signer signs on a links signing page with a typed name, after asking for a code. */
export async function signOnLinksPage(
  page: Page,
  name: string,
  codeSentSince: (after: number) => Promise<string>,
): Promise<void> {
  const started = Date.now();
  await page
    .getByRole('button', { name: /send me a code|send a new code/i })
    .first()
    .click();
  await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
  await page.getByLabel('Your 6-digit code').fill(await codeSentSince(started));
  await page.getByLabel('Type your full name to sign').fill(name);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you: you have signed');
}
