import { randomBytes, scryptSync } from 'node:crypto';
import { schema, withCompany } from '@rent/db';
import type { AppConfig } from '@rent/server/core';
import { AccountRecoveryService } from '@rent/server/identity';
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
  totpFrom,
  type TestApi,
} from './support';

/**
 * M11 security review, identity (docs/plans/M11.md section 9, Identity): reviewer 1 F1 to F16,
 * reviewer 2 F3, reviewer 3 F1's trustProxy part, and founder decisions D2 and D4, over HTTP.
 */

const PASSWORD = 'correct horse battery staple';

/** Better Auth's default hash before M11 (`salt:key`, scrypt N=2^14, r=16, p=1). */
function betterAuthDefaultHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${key.toString('hex')}`;
}
const NATIVE = { origin: '', 'expo-origin': 'rentplatform://' };

let api: TestApi;
let agencyId: string;
let platformId: string;
let phones = 0;
let emails = 0;

const nextPhone = () => `+23320${String(7_100_000 + (phones += 1)).padStart(7, '0')}`;
const nextEmail = (tag: string) => `${tag}.${(emails += 1)}@identity.invalid`;

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Identity Agency');
  platformId = await createCompany(api, 'platform', 'Platform');
});

afterAll(async () => {
  await api?.close();
});

async function staff(role: 'property_manager' | 'agency_admin' = 'property_manager') {
  const email = nextEmail(role);
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, agencyId, personId, role);
  return { email, personId };
}

const codeIn = (body: string) => /\b(\d{6})\b/.exec(body)![1]!;

async function phoneSignIn(
  target: TestApi,
  phone: string,
  device = new Device(target.baseUrl),
  headers: Record<string, string> = {},
) {
  await device.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone }, headers });
  const code = codeIn(target.sms.lastTo(phone)!.body);
  const verified = await device.call('/api/auth/phone-number/verify', {
    body: { phoneNumber: phone, code },
    headers,
  });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  return device;
}

const byActor = async (target: TestApi, action: string, personId: string) =>
  superuser(
    target,
    'select company_id, record_type, data from audit_event where action = $1 and actor_person_id = $2',
    [action, personId],
  );

const events = async (target: TestApi, action: string, recordId?: string) =>
  superuser(
    target,
    `select company_id, record_id, data from audit_event where action = $1 ${
      recordId ? 'and record_id = $2' : ''
    } order by occurred_at`,
    recordId ? [action, recordId] : [action],
  );

describe('NFR-SEC M11 review R3 F1 and R1 F1: client addresses come from trusted proxies only', () => {
  let edge: TestApi;
  let behindProxy: TestApi;

  beforeAll(async () => {
    // As deployed: rate limits on, X-Forwarded-For believed only from the listed proxies. (The
    // test environment, because production needs real providers; trustProxy follows the list
    // alone, and production refuses to start without one: request-origin.test.ts.)
    const production = { AUTH_RATE_LIMITS: 'on' } as Partial<AppConfig>;
    edge = await startApi({ ...production, TRUSTED_PROXIES: '10.0.0.0/8' } as Partial<AppConfig>);
    behindProxy = await startApi({
      ...production,
      TRUSTED_PROXIES: '127.0.0.1/32, ::1/128',
    } as Partial<AppConfig>);
  });

  afterAll(async () => {
    await edge?.close();
    await behindProxy?.close();
  });

  const signedInIp = async (target: TestApi, forwardedFor: string) => {
    const email = nextEmail('ip');
    const { personId } = await createPerson(target, { name: 'IP', email, password: PASSWORD });
    await addMembership(
      target,
      await createCompany(target, 'agency', `IP ${email}`),
      personId,
      'property_manager',
    );
    const device = new Device(target.baseUrl);
    const signIn = await device.call('/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
      headers: { 'x-forwarded-for': forwardedFor },
    });
    expect(signIn.status, JSON.stringify(signIn.json)).toBe(200);
    const [row] = await owner(target, 'select ip_address from session where user_id = $1', [
      personId,
    ]);
    return String(row!.ip_address);
  };

  it('ignores X-Forwarded-For from a client that is not a listed proxy', async () => {
    expect(await signedInIp(edge, '203.0.113.9')).toMatch(
      /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/,
    );
  });

  it('behind a listed proxy, takes the right-most address the proxy added, never the client’s own', async () => {
    expect(await signedInIp(behindProxy, '203.0.113.9, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('keeps the per-address sign-in limit when the client rotates X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await new Device(edge.baseUrl).call('/api/auth/sign-in/email', {
        body: { email: nextEmail('nobody'), password: 'not the password at all' },
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      statuses.push(response.status);
    }
    // Five a minute from one address (one was used above), however the header is rotated.
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.slice(5)).toEqual([429, 429]);
    const keys = await owner(edge, `select key from rate_limit where key like '%/sign-in/email%'`);
    expect(keys).toHaveLength(1);
  });

  it('limits wrong passwords per account, whatever address they come from', async () => {
    const email = nextEmail('account-limit');
    const { personId } = await createPerson(behindProxy, {
      name: 'Limited',
      email,
      password: PASSWORD,
    });
    await addMembership(
      behindProxy,
      await createCompany(behindProxy, 'agency', 'Limit Co'),
      personId,
      'property_manager',
    );
    const attempt = (i: number, password: string) =>
      new Device(behindProxy.baseUrl).call('/api/auth/sign-in/email', {
        body: { email, password },
        headers: { 'x-forwarded-for': `192.0.2.${i}` },
      });
    for (let i = 1; i <= 10; i += 1)
      expect((await attempt(i, 'wrong password, again')).status).toBe(401);
    // From an eleventh address, even with the right password: wait.
    const refused = await attempt(11, PASSWORD);
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('TOO_MANY_ATTEMPTS');
    // No email is kept in the clear.
    const keys = await owner(
      behindProxy,
      `select key from rate_limit where key like 'sign-in-account:%'`,
    );
    expect(keys.map((k) => String(k.key)).join()).not.toContain(email);
    expect(keys.map((k) => String(k.key)).join()).not.toContain('account-limit');
  });
});

describe('AD-06 M11 review R1 F2: a phone code survives no more than five guesses', () => {
  it('counts parallel wrong guesses one by one: after 20 at once the code is dead', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Raced Tenant', phone });
    const device = new Device(api.baseUrl);
    await device.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone } });
    const code = codeIn(api.sms.lastTo(phone)!.body);
    const wrong = code === '000000' ? '111111' : '000000';
    const before = new Set(
      (await owner(api, `select key from rate_limit where key like 'otp-verify-day:%'`)).map((r) =>
        String(r.key),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        new Device(api.baseUrl).call('/api/auth/phone-number/verify', {
          body: { phoneNumber: phone, code: wrong },
        }),
      ),
    );
    expect(results.every((r) => r.status === 400 || r.status === 403)).toBe(true);
    // At most five guesses were compared with the code (each wrong comparison is counted for the
    // phone's daily cap); every other request was refused without one.
    const compared = (
      await owner(api, `select key, count from rate_limit where key like 'otp-verify-day:%'`)
    ).filter((r) => !before.has(String(r.key)));
    expect(compared).toHaveLength(1);
    expect(Number(compared[0]!.count)).toBeLessThanOrEqual(5);
    const right = await device.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: phone, code },
    });
    expect([400, 403]).toContain(right.status);
    expect((await device.call('/me')).status).toBe(401);
  });

  it('caps wrong codes per phone per day, and raises an alert', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Daily Cap', phone });
    const send = async () => {
      // A fresh window for the 3-per-15-minutes send limit each time (it is not under test).
      await owner(api, `delete from rate_limit where key like 'otp-phone:%'`);
      await new Device(api.baseUrl).call('/api/auth/phone-number/send-otp', {
        body: { phoneNumber: phone },
      });
      return codeIn(api.sms.lastTo(phone)!.body);
    };
    let wrongGuesses = 0;
    while (wrongGuesses < 15) {
      const code = await send();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5 && wrongGuesses < 15; i += 1, wrongGuesses += 1)
        await new Device(api.baseUrl).call('/api/auth/phone-number/verify', {
          body: { phoneNumber: phone, code: wrong },
        });
    }
    const code = await send();
    const refused = await new Device(api.baseUrl).call('/api/auth/phone-number/verify', {
      body: { phoneNumber: phone, code },
    });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('DAILY_ATTEMPTS_EXCEEDED');
    const alerts = await owner(
      api,
      `select code, data from alert_event where code = 'auth.otp_wrong_daily_cap'`,
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(alerts)).not.toContain(phone.slice(4));
  });
});

describe('NFR-SEC M11 review R1 F7: state-changing requests must come from our apps', () => {
  it('refuses another site’s Origin, on the auth mount and on the API', async () => {
    const evil = { origin: 'https://evil.example' };
    const auth = await new Device(api.baseUrl).call('/api/auth/sign-in/email', {
      body: { email: 'x@identity.invalid', password: PASSWORD },
      headers: evil,
    });
    expect(auth.status).toBe(403);
    expect(auth.json.code).toBe('FORBIDDEN_ORIGIN');
    const { email } = await staff();
    const { device } = await enrolStaff(api, email, PASSWORD);
    const company = await device.call('/me/active-company', {
      body: { companyId: agencyId },
      headers: evil,
    });
    expect(company.status).toBe(403);
    // A cross-site request without Origin still says where it comes from.
    const site = await device.call('/me/active-company', {
      body: { companyId: agencyId },
      headers: { origin: '', 'sec-fetch-site': 'cross-site' },
    });
    expect(site.status).toBe(403);
  });

  it('refuses form bodies, the login CSRF a cross-site form could send', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Form Tenant', phone });
    await new Device(api.baseUrl).call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: phone },
    });
    const code = codeIn(api.sms.lastTo(phone)!.body);
    for (const type of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await fetch(`${api.baseUrl}/api/auth/phone-number/verify`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: `phoneNumber=${encodeURIComponent(phone)}&code=${code}`,
      });
      expect(response.status, type).toBe(415);
    }
  });

  it('still serves the native app (no Origin), and webhooks that post forms', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Native Tenant', phone });
    const device = await phoneSignIn(api, phone, new Device(api.baseUrl, 'Expo/Android'), NATIVE);
    expect((await device.call('/me', { headers: NATIVE })).json.actorKind).toBe('tenant');
    const webhook = await fetch(`${api.baseUrl}/webhooks/sms/inbound?secret=wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B233200000000&Content=hello',
    });
    expect([403, 415]).not.toContain(webhook.status);
  });
});

describe('AD-06 M11 review R1 F6, F8 to F14: sessions, passwords and two-factor', () => {
  it('lists a tenant’s devices after the first day (no fresh-session rule)', async () => {
    const phone = nextPhone();
    const { personId } = await createPerson(api, { name: 'Long Tenant', phone });
    const device = await phoneSignIn(api, phone);
    await owner(
      api,
      `update session set created_at = now() - interval '3 days' where user_id = $1`,
      [personId],
    );
    const listed = await device.call('/api/auth/list-sessions');
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect(listed.json as unknown as unknown[]).toHaveLength(1);
  });

  it('sends every reset link to the web app’s set-password page, whatever the request asks', async () => {
    const { email } = await staff();
    const before = api.email.sent.length;
    await new Device(api.baseUrl).call('/api/auth/request-password-reset', {
      body: { email, redirectTo: 'rentplatform://steal' },
    });
    const message = api.email.sent.slice(before).find((m) => m.to === email);
    expect(message?.text).toContain(encodeURIComponent(`${api.config.WEB_ORIGIN}/accept-invite`));
    expect(message?.text).not.toContain('rentplatform');
    // A reset of an existing password lives an hour (an invitation, 3 days: below).
    expect(message?.text).toContain('1 hour');
    const [row] = await owner(
      api,
      `select extract(epoch from expires_at - created_at) as seconds from verification
       where identifier like 'reset-password:%' order by created_at desc limit 1`,
    );
    expect(Number(row!.seconds)).toBeLessThanOrEqual(3600 + 5);
  });

  it('gives an invitation’s first-password link 3 days', async () => {
    const email = nextEmail('first');
    const { personId } = await createPerson(api, { name: 'First Password', email });
    await addMembership(api, agencyId, personId, 'accountant');
    await new Device(api.baseUrl).call('/api/auth/request-password-reset', { body: { email } });
    const [row] = await owner(
      api,
      `select extract(epoch from expires_at - created_at) as seconds from verification
       where identifier like 'reset-password:%' and value = $1`,
      [personId],
    );
    expect(Number(row!.seconds)).toBeGreaterThan(3 * 86_400 - 60);
  });

  it('sends no reset to someone with no password role, and nothing different in the answer (D2)', async () => {
    const email = nextEmail('caretaker-email');
    const { personId } = await createPerson(api, {
      name: 'Caretaker With Email',
      email,
      phone: nextPhone(),
    });
    await addMembership(api, agencyId, personId, 'caretaker');
    const before = api.email.sent.length;
    const response = await new Device(api.baseUrl).call('/api/auth/request-password-reset', {
      body: { email },
    });
    expect(response.status).toBe(200);
    expect(api.email.sent.slice(before).filter((m) => m.to === email)).toEqual([]);
  });

  it('marks the address verified and audits the password set through the link', async () => {
    const email = nextEmail('set');
    const { personId } = await createPerson(api, { name: 'Sets Password', email });
    await addMembership(api, agencyId, personId, 'accountant');
    const before = api.email.sent.length;
    await new Device(api.baseUrl).call('/api/auth/request-password-reset', { body: { email } });
    const link = api.email.sent.slice(before).find((m) => m.to === email)!.text!;
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(link)![1]!;
    const reset = await new Device(api.baseUrl).call('/api/auth/reset-password', {
      body: { token, newPassword: 'a brand new long password' },
    });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    const [person] = await owner(api, 'select email_verified from person where id = $1', [
      personId,
    ]);
    expect(person!.email_verified).toBe(true);
    const audit = await events(api, 'auth.password_set', personId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toEqual({ via: 'invitation' });
  });

  it('no longer offers get-totp-uri, and new backup codes need a current TOTP code (R1 F9)', async () => {
    const { email, personId } = await staff();
    const { device, totpURI, backupCodes } = await enrolStaff(api, email, PASSWORD);
    expect(
      (await device.call('/api/auth/two-factor/get-totp-uri', { body: { password: PASSWORD } }))
        .status,
    ).toBe(404);
    // Stored as keyed hashes, never the codes.
    const [stored] = await owner(api, 'select backup_codes from two_factor where user_id = $1', [
      personId,
    ]);
    expect(String(stored!.backup_codes)).toMatch(/^\["h1:[0-9a-f]{64}"/);
    for (const code of backupCodes) expect(String(stored!.backup_codes)).not.toContain(code);

    const withoutCode = await device.call('/api/auth/two-factor/generate-backup-codes', {
      body: { password: PASSWORD },
    });
    expect(withoutCode.status).toBe(400);
    expect(withoutCode.json.code).toBe('TOTP_REQUIRED');
    // The enrolment code's step is not spent here: step-up keeps its own last step.
    const made = await device.call('/api/auth/two-factor/generate-backup-codes', {
      body: { password: PASSWORD, code: await totpFrom(totpURI) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const fresh = made.json.backupCodes as unknown as string[];
    expect(fresh).toHaveLength(10);
    // The same code again, within its step: refused (replay).
    const replay = await device.call('/api/auth/two-factor/generate-backup-codes', {
      body: { password: PASSWORD, code: await totpFrom(totpURI) },
    });
    expect(replay.status).toBe(400);
    expect(await events(api, 'auth.backup_codes_regenerated', personId)).toHaveLength(1);
    // A new code works once at sign-in; an old one never.
    const laptop = new Device(api.baseUrl);
    await laptop.call('/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    expect(
      (
        await laptop.call('/api/auth/two-factor/verify-backup-code', {
          body: { code: backupCodes[0]! },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await laptop.call('/api/auth/two-factor/verify-backup-code', { body: { code: fresh[0]! } }))
        .status,
    ).toBe(200);
  });

  it('hashes passwords at OWASP’s scrypt cost, and rewrites an older hash at the next sign-in (R1 F12)', async () => {
    const { email, personId } = await staff();
    await owner(
      api,
      `update account set password = $2 where user_id = $1 and provider_id = 'credential'`,
      [personId, betterAuthDefaultHash(PASSWORD)],
    );
    const signIn = await new Device(api.baseUrl).call('/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    const [row] = await owner(api, `select password from account where user_id = $1`, [personId]);
    // Tests run at the test cost (n=16384, r=8, p=1); production at OWASP's (password-hash.test.ts).
    expect(String(row!.password)).toMatch(/^\$scrypt\$n=16384,r=8,p=1\$/);
  });

  it('keeps a password change at password and TOTP strength, in the same company (R1 F13)', async () => {
    const { email, personId } = await staff();
    const { device } = await enrolStaff(api, email, PASSWORD);
    const changed = await device.call('/api/auth/change-password', {
      body: {
        currentPassword: PASSWORD,
        newPassword: 'another long password here',
        revokeOtherSessions: true,
      },
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const me = await device.call('/me');
    expect(me.json).toMatchObject({
      state: 'ready',
      authMethod: 'password_totp',
      activeCompanyId: agencyId,
    });
    expect(await events(api, 'auth.password_changed', personId)).toHaveLength(1);
  });

  it('ends the session a new sign-in in the same browser replaces (R1 F14)', async () => {
    const phone = nextPhone();
    const { personId } = await createPerson(api, { name: 'Twice Tenant', phone });
    const device = await phoneSignIn(api, phone);
    const first = device.sessionToken();
    await owner(api, `delete from rate_limit where key like 'otp-phone:%'`);
    await phoneSignIn(api, phone, device);
    const tokens = (
      await owner(api, 'select token from session where user_id = $1', [personId])
    ).map((r) => String(r.token));
    expect(tokens).toHaveLength(1);
    expect(tokens).not.toContain(first);
  });
});

describe('AD-07 NFR-AUDIT M11 review R1 F5: account events are audited, without secrets', () => {
  it('records sign-in with a hashed address and the user agent, failures, revocations and sign-out', async () => {
    const { email, personId } = await staff();
    const { device, totpURI } = await enrolStaff(api, email, PASSWORD);
    expect(await events(api, 'auth.totp_enrolled', personId)).toHaveLength(1);
    const [signedIn] = await events(api, 'auth.signed_in');
    expect(signedIn!.data).toMatchObject({
      authMethod: expect.any(String),
      ipHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(JSON.stringify(signedIn!.data)).not.toMatch(/127\.0\.0\.1|::1/);

    const failed = await new Device(api.baseUrl).call('/api/auth/sign-in/email', {
      body: { email, password: 'definitely not it' },
    });
    expect(failed.status).toBe(401);
    const failures = await events(api, 'auth.sign_in_failed', personId);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain('definitely');
    expect(JSON.stringify(failures)).not.toContain(email);

    const laptop = new Device(api.baseUrl, 'laptop-browser');
    await laptop.call('/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    const wrong = await laptop.call('/api/auth/two-factor/verify-totp', {
      body: { code: '000000' },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await events(api, 'auth.sign_in_failed', personId)).toHaveLength(2);
    await laptop.call('/api/auth/two-factor/verify-totp', {
      body: { code: await totpFrom(totpURI) },
    });
    expect(
      (await device.call('/api/auth/revoke-session', { body: { token: laptop.sessionToken() } }))
        .status,
    ).toBe(200);
    expect(await byActor(api, 'auth.session_revoked', personId)).toMatchObject([
      { record_type: 'session' },
    ]);
    expect((await device.call('/api/auth/revoke-other-sessions', { body: {} })).status).toBe(200);
    expect(await byActor(api, 'auth.other_sessions_revoked', personId)).toMatchObject([
      { record_type: 'session' },
    ]);
    expect((await device.call('/api/auth/sign-out', { body: {} })).status).toBe(200);
    const out = await superuser(
      api,
      `select company_id from audit_event where action = 'auth.signed_out' and actor_person_id = $1`,
      [personId],
    );
    expect(out.map((r) => r.company_id)).toEqual([agencyId]);
  });
});

describe('AD-06 TL-12 founder D2: the tenant app acts as the tenant', () => {
  it('resolves a caretaker’s tenant-app session to the tenant, and their staff sign-in to staff', async () => {
    const phone = nextPhone();
    const { personId } = await createPerson(api, { name: 'Caretaker Tenant', phone });
    await addMembership(api, agencyId, personId, 'caretaker');
    const app = await phoneSignIn(api, phone, new Device(api.baseUrl, 'Expo/iOS'), NATIVE);
    expect((await app.call('/me', { headers: NATIVE })).json).toMatchObject({
      actorKind: 'tenant',
      role: null,
    });
    await owner(api, `delete from rate_limit where key like 'otp-phone:%'`);
    const web = await phoneSignIn(api, phone);
    expect((await web.call('/me')).json).toMatchObject({ actorKind: 'staff', role: 'caretaker' });
  });
});

describe('AD-06 AD-07 founder D4: a platform admin resets lost two-factor and signs a person out everywhere', () => {
  it('removes the TOTP and every session, audits it in the platform and company chains, and asks for enrolment again', async () => {
    const adminEmail = nextEmail('pa');
    const admin = await createPerson(api, {
      name: 'Recovery Admin',
      email: adminEmail,
      password: PASSWORD,
    });
    const membershipId = await addMembership(api, platformId, admin.personId, 'platform_admin');
    // Review B4: the CLI operator proves themselves with their own current TOTP code.
    const { totpURI: adminTotp } = await enrolStaff(api, adminEmail, PASSWORD);
    const { email, personId } = await staff();
    await enrolStaff(api, email, PASSWORD);
    const recovery = api.app.get(AccountRecoveryService);
    const platformAdmin = {
      kind: 'platform_admin' as const,
      personId: admin.personId,
      companyId: platformId,
      membershipId,
      authMethod: 'password_totp' as const,
    };
    await expect(
      recovery.resetTwoFactor({ kind: 'console', actor: platformAdmin }, personId, 'short'),
    ).rejects.toMatchObject({ code: 'reason_required' });
    const manager = {
      kind: 'staff' as const,
      personId,
      companyId: agencyId,
      companyKind: 'agency' as const,
      membershipId: 'x',
      role: 'agency_admin' as const,
      nominatedApprover: false,
      scope: {},
      authMethod: 'password_totp' as const,
    };
    await expect(
      recovery.resetTwoFactor(
        { kind: 'console', actor: manager },
        personId,
        'Lost phone, identity checked by video call',
      ),
    ).rejects.toMatchObject({ status: 403 });

    const done = await recovery.resetTwoFactor(
      { kind: 'console', actor: platformAdmin },
      personId,
      'Lost phone, identity checked by video call, ticket 812',
    );
    expect(done).toMatchObject({ twoFactorReset: true, sessionsRevoked: 1 });
    expect(await owner(api, 'select id from two_factor where user_id = $1', [personId])).toEqual(
      [],
    );
    const audit = await events(api, 'auth.two_factor_reset', personId);
    expect(audit.map((e) => e.company_id).sort()).toEqual([agencyId, platformId].sort());
    expect(audit.find((e) => e.company_id === platformId)!.data).toMatchObject({
      reason: expect.stringContaining('ticket 812'),
    });
    expect(JSON.stringify(audit.find((e) => e.company_id === agencyId)!.data)).not.toContain(
      'ticket',
    );
    // Their next sign-in is a password-only session that may only enrol.
    const again = new Device(api.baseUrl);
    await again.call('/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    expect((await again.call('/me')).json.state).toBe('enrolment_required');

    const out = await recovery.revokeAllSessions(
      {
        kind: 'cli',
        operatorEmail: adminEmail,
        operatorCode: await totpFrom(adminTotp),
        origin: { osUser: 'ops', host: 'ops-laptop' },
      },
      personId,
      'Suspected stolen laptop, per runbook',
    );
    expect(out.sessionsRevoked).toBe(1);
    expect((await again.call('/me')).status).toBe(401);
  });
});

describe('AD-03 founder D2: invitations are accepted by the invited person, over HTTP', () => {
  it('lists a caretaker invitation for the phone’s owner, who accepts it signed in by phone code', async () => {
    const admin = await staff('agency_admin');
    const { device: adminDevice } = await enrolStaff(api, admin.email, PASSWORD);
    const phone = nextPhone();
    const { personId } = await createPerson(api, { name: 'Their Own Name', phone });
    const invited = await adminDevice.call('/memberships', {
      body: { name: 'Gate Keeper', phone, role: 'caretaker' },
    });
    expect(invited.status, JSON.stringify(invited.json)).toBe(200);
    expect(invited.json).toMatchObject({
      personId,
      status: 'invited',
      name: 'Gate Keeper',
      email: null,
    });

    const caretaker = await phoneSignIn(api, phone);
    const pending = await caretaker.call('/me/invitations');
    expect(pending.status).toBe(200);
    expect(pending.json).toEqual([
      expect.objectContaining({ membershipId: invited.json.membershipId, role: 'caretaker' }),
    ]);
    const accepted = await caretaker.call(
      `/me/invitations/${String(invited.json.membershipId)}/accept`,
      {
        method: 'POST',
        body: {},
      },
    );
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json).toMatchObject({ actorKind: 'staff', role: 'caretaker' });
  });
});

describe('AD-06 founder D4: the platform console’s recovery routes', () => {
  it('finds a person by email and resets their two-factor; staff are refused', async () => {
    const adminEmail = nextEmail('console');
    const admin = await createPerson(api, {
      name: 'Console Admin',
      email: adminEmail,
      password: PASSWORD,
    });
    await addMembership(api, platformId, admin.personId, 'platform_admin');
    const { device: platform } = await enrolStaff(api, adminEmail, PASSWORD);
    const target = await staff();
    const { device: targetDevice } = await enrolStaff(api, target.email, PASSWORD);

    const found = await platform.call('/platform/people/find', { body: { email: target.email } });
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json).toMatchObject({ personId: target.personId, twoFactorEnabled: true });
    expect(
      (await targetDevice.call('/platform/people/find', { body: { email: adminEmail } })).status,
    ).toBe(403);

    const reset = await platform.call(`/platform/people/${target.personId}/two-factor/reset`, {
      body: { reason: 'Lost phone; identity checked by video call, ticket 913' },
    });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    expect(reset.json).toMatchObject({ twoFactorReset: true });
    expect((await targetDevice.call('/me')).status).toBe(401);
  });
});

describe('AD-06 M11 review R1 F2: a daily cap on codes sent to one phone', () => {
  it('sends ten codes a day, then answers with its own code and raises an alert', async () => {
    const phone = nextPhone();
    await createPerson(api, { name: 'Many Codes', phone });
    const send = async () => {
      // A fresh window for the 3-per-15-minutes limit each time (it is not under test).
      await owner(api, `delete from rate_limit where key like 'otp-phone:%'`);
      return new Device(api.baseUrl).call('/api/auth/phone-number/send-otp', {
        body: { phoneNumber: phone },
      });
    };
    for (let i = 0; i < 10; i += 1) expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('DAILY_CODES_EXCEEDED');
    const alerts = await owner(
      api,
      `select code from alert_event where code = 'auth.otp_send_daily_cap'`,
    );
    expect(alerts).toHaveLength(1);
  });
});

describe('AD-06 founder D4: the recovery CLI acts only for an active platform admin', () => {
  it('refuses an operator who is not an active platform admin, by email', async () => {
    const recovery = api.app.get(AccountRecoveryService);
    const target = await staff();
    const reason = 'Suspected stolen laptop, per the runbook';
    const origin = { osUser: 'ops', host: 'ops-laptop' };
    const notAdmin = await staff('agency_admin');
    for (const operatorEmail of [notAdmin.email, nextEmail('nobody'), 'not-an-email'])
      await expect(
        recovery.revokeAllSessions(
          { kind: 'cli', operatorEmail, operatorCode: '000000', origin },
          target.personId,
          reason,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'not_a_platform_admin' });

    // A platform admin whose membership is not active yet (an invitation) is refused too.
    const pendingEmail = nextEmail('pending-pa');
    const pending = await createPerson(api, { name: 'Pending PA', email: pendingEmail });
    await withCompany(api.database, { companyId: platformId, actorKind: 'system' }, (tx) =>
      tx.insert(schema.membership).values({
        companyId: platformId,
        personId: pending.personId,
        role: 'platform_admin',
        status: 'invited',
      }),
    );
    await expect(
      recovery.revokeAllSessions(
        { kind: 'cli', operatorEmail: pendingEmail, operatorCode: '000000', origin },
        target.personId,
        reason,
      ),
    ).rejects.toMatchObject({ code: 'not_a_platform_admin' });

    const activeEmail = nextEmail('active-pa');
    const active = await createPerson(api, {
      name: 'Active PA',
      email: activeEmail,
      password: PASSWORD,
    });
    await addMembership(api, platformId, active.personId, 'platform_admin');
    const { totpURI: activeTotp } = await enrolStaff(api, activeEmail, PASSWORD);
    const done = await recovery.revokeAllSessions(
      {
        kind: 'cli',
        operatorEmail: ` ${activeEmail.toUpperCase()} `,
        operatorCode: await totpFrom(activeTotp),
        origin,
      },
      target.personId,
      reason,
    );
    expect(done.twoFactorReset).toBe(false);
    const [event] = await byActor(api, 'auth.sessions_revoked_all', active.personId);
    expect(event).toMatchObject({ record_type: 'person' });
  });
});

describe('AD-10 founder D2: a new company’s first admin who already exists accepts first', () => {
  it('onboards with them pending, tells them by email, and makes them admin once they accept', async () => {
    const adminEmail = nextEmail('onboarder');
    const platformAdmin = await createPerson(api, {
      name: 'Onboarding Admin',
      email: adminEmail,
      password: PASSWORD,
    });
    await addMembership(api, platformId, platformAdmin.personId, 'platform_admin');
    const { device: platform } = await enrolStaff(api, adminEmail, PASSWORD);
    const existing = await staff();
    const { device: theirs } = await enrolStaff(api, existing.email, PASSWORD);
    const before = api.email.sent.length;

    const companyName = `Pending Agency ${emails}`;
    const made = await platform.call('/platform/companies', {
      body: {
        kind: 'agency',
        name: companyName,
        tier: 'starter',
        adminName: 'Typed By The Platform',
        adminEmail: existing.email,
      },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const sent = api.email.sent.slice(before).filter((m) => m.to === existing.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('accept the invitation');
    expect(sent[0]!.text).not.toContain('reset-password');

    const pending = await theirs.call('/me/invitations');
    const invitation = (
      pending.json as unknown as { membershipId: string; companyName: string }[]
    ).find((i) => i.companyName === companyName);
    expect(invitation).toBeDefined();
    const accepted = await theirs.call(`/me/invitations/${invitation!.membershipId}/accept`, {
      method: 'POST',
      body: {},
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(
      (accepted.json.memberships as unknown as { role: string }[]).map((m) => m.role).sort(),
    ).toEqual(['agency_admin', 'property_manager']);
  });
});
