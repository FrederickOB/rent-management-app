import type { AppConfig } from '@rent/server/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  Device,
  enrolStaff,
  owner,
  startApi,
  superuser,
  type TestApi,
} from './support';

/**
 * M11 independent review, reviewer B, identity findings (docs/plans/M11.md section 9, Identity,
 * Review round), over HTTP.
 */

const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let landlordX: string;
let landlordZ: string;
let n = 0;
const nextEmail = (tag: string) => `${tag}.${(n += 1)}@identity-review.invalid`;
const nextPhone = () => `+23320${String(7_200_000 + (n += 1)).padStart(7, '0')}`;
const codeIn = (body: string) => /\b(\d{6})\b/.exec(body)![1]!;

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  landlordX = await createCompany(api, 'landlord', 'Landlord X');
  landlordZ = await createCompany(api, 'landlord', 'Landlord Z');
});

afterAll(async () => {
  await api?.close();
});

async function owner_(companyId: string) {
  const email = nextEmail('owner');
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, 'owner');
  return { personId, device: (await enrolStaff(api, email, PASSWORD)).device };
}

async function phoneSignIn(phone: string, device = new Device(api.baseUrl), body: object = {}) {
  await device.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone } });
  const code = codeIn(api.sms.lastTo(phone)!.body);
  const verified = await device.call('/api/auth/phone-number/verify', {
    body: { phoneNumber: phone, code, ...body },
  });
  return { device, verified };
}

describe('TL-12 AD-03 review B-M1: an inviter’s typed phone never attaches someone else’s tenancy', () => {
  it('stores only the email for a password-role invitee, never the phone typed beside it', async () => {
    const x = await owner_(landlordX);
    const victimPhone = nextPhone();
    const invited = await x.device.call('/memberships', {
      body: {
        name: 'Adviser',
        email: nextEmail('attacker'),
        phone: victimPhone,
        role: 'adviser',
      },
    });
    expect(invited.status, JSON.stringify(invited.json)).toBe(200);
    expect(invited.json.phoneMasked).toBeNull();
    const [row] = await owner(api, 'select phone_number from person where id = $1', [
      invited.json.personId,
    ]);
    expect(row!.phone_number).toBeNull();
  });

  it('links a victim’s tenancy to their own person, not to a record holding their phone unverified', async () => {
    // A record from before the fix: someone's email and password, beside a phone nobody proved.
    const victimPhone = nextPhone();
    const attackerEmail = nextEmail('attacker');
    const mixed = await createPerson(api, {
      name: 'Attacker',
      email: attackerEmail,
      phone: victimPhone,
      password: PASSWORD,
    });
    await addMembership(api, landlordX, mixed.personId, 'owner');

    const z = await owner_(landlordZ);
    const created = await z.device.call('/tenants', {
      body: { kind: 'individual', displayName: 'Victim Tenant', phone: victimPhone },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const tenantId = (created.json.tenant as { id: string }).id;
    const [tenant] = await superuser(api, 'select person_id from tenant where id = $1', [tenantId]);
    expect(tenant!.person_id).not.toBe(mixed.personId);
    // The phone left the record that never proved it.
    const [released] = await owner(api, 'select phone_number from person where id = $1', [
      mixed.personId,
    ]);
    expect(released!.phone_number).toBeNull();

    // The victim signs in to their own person; landlord X's chain never sees it.
    const { device } = await phoneSignIn(victimPhone);
    const me = await device.call('/me');
    expect(me.json.personId).toBe(tenant!.person_id);
    const seen = await superuser(
      api,
      `select 1 from audit_event where company_id = $1 and action = 'auth.signed_in' and actor_person_id = $2`,
      [landlordX, tenant!.person_id],
    );
    expect(seen).toEqual([]);
  });
});

describe('AD-06 review: phone verify takes only the phone number and the code', () => {
  it('ignores disableSession and updatePhoneNumber sent with the code', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Body Tenant', phone });
    const { device, verified } = await phoneSignIn(phone, new Device(api.baseUrl), {
      disableSession: true,
      updatePhoneNumber: true,
    });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    expect(verified.json.token).toEqual(expect.any(String));
    expect((await device.call('/me')).status).toBe(200);
  });
});

describe('NFR-SEC review B1: parallel wrong passwords for one account are each counted first', () => {
  let proxied: TestApi;

  beforeAll(async () => {
    proxied = await startApi({
      AUTH_RATE_LIMITS: 'on',
      TRUSTED_PROXIES: '127.0.0.1/32, ::1/128',
    } as Partial<AppConfig>);
  });

  afterAll(async () => {
    await proxied?.close();
  });

  it('lets at most 10 of 20 parallel wrong passwords reach the password check', async () => {
    const email = nextEmail('raced');
    const { personId } = await createPerson(proxied, { name: 'Raced', email, password: PASSWORD });
    await addMembership(
      proxied,
      await createCompany(proxied, 'landlord', 'Raced Co'),
      personId,
      'owner',
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        new Device(proxied.baseUrl).call('/api/auth/sign-in/email', {
          body: { email, password: 'not the password, raced' },
          headers: { 'x-forwarded-for': `192.0.2.${i + 1}` },
        }),
      ),
    );
    expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(10);
  });
});
