import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  Device,
  enrolStaff,
  owner,
  startApi,
  totpFrom,
  type TestApi,
} from './support';

const PASSWORD = 'correct horse battery staple';
const MINUTE = 60_000;

let api: TestApi;
let agencyId: string;
let platformId: string;

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Test Agency');
  platformId = await createCompany(api, 'platform', 'Platform');
});

afterAll(async () => {
  await api?.close();
});

const expiresInMs = (me: Record<string, unknown>) =>
  new Date(String(me.sessionExpiresAt)).getTime() - Date.now();

async function staff(
  email: string,
  role: 'property_manager' | 'agency_admin' = 'property_manager',
  companyId = () => agencyId,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId(), personId, role);
  return personId;
}

describe('PLATFORM api skeleton (spike check 1)', () => {
  it('serves health checks without a session and refuses everything else', async () => {
    const device = new Device(api.baseUrl);
    expect((await device.call('/health/live')).status).toBe(200);
    expect((await device.call('/health/ready')).status).toBe(200);
    const me = await device.call('/me');
    expect(me.status).toBe(401);
    expect(me.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes an OpenAPI description generated from the contracts (ADR-014)', async () => {
    const spec = await new Device(api.baseUrl).call('/openapi.json');
    expect(spec.status).toBe(200);
    expect(Object.keys(spec.json.paths as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['/me', '/company', '/memberships', '/audit-events']),
    );
  });

  it('exposes only the allowlisted Better Auth endpoints', async () => {
    const device = new Device(api.baseUrl);
    for (const path of [
      '/api/auth/sign-up/email',
      '/api/auth/two-factor/disable',
      '/api/auth/phone-number/request-password-reset',
      '/api/auth/delete-user',
    ]) {
      expect((await device.call(path, { body: {} })).status, path).toBe(404);
    }
  });
});

describe('AD-06 staff sign-in (spike check 2)', () => {
  it('gives a password-only session nothing but TOTP enrolment', async () => {
    await staff('enrol-only@test.invalid');
    const device = new Device(api.baseUrl);
    expect(
      (
        await device.call('/api/auth/sign-in/email', {
          body: { email: 'enrol-only@test.invalid', password: PASSWORD },
        })
      ).status,
    ).toBe(200);
    const me = await device.call('/me');
    expect(me.status).toBe(200);
    expect(me.json.state).toBe('enrolment_required');
    expect(me.json.actorKind).toBeNull();
    const blocked = await device.call('/me/active-company', { body: { companyId: agencyId } });
    expect(blocked.status).toBe(403);
  });

  it('completes sign-in once TOTP is enrolled, and asks for the code every time after', async () => {
    await staff('manager@test.invalid');
    const { device, totpURI } = await enrolStaff(api, 'manager@test.invalid', PASSWORD);
    const me = await device.call('/me');
    expect(me.json).toMatchObject({
      state: 'ready',
      authMethod: 'password_totp',
      actorKind: 'staff',
      role: 'property_manager',
      activeCompanyId: agencyId,
    });

    const laptop = new Device(api.baseUrl, 'second-laptop');
    const signIn = await laptop.call('/api/auth/sign-in/email', {
      body: { email: 'manager@test.invalid', password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    expect(signIn.json.twoFactorRedirect).toBe(true);
    expect((await laptop.call('/me')).status).toBe(401);
    expect(
      (await laptop.call('/api/auth/two-factor/verify-totp', { body: { code: '000000' } })).status,
    ).toBeGreaterThanOrEqual(400);
    const verified = await laptop.call('/api/auth/two-factor/verify-totp', {
      body: { code: await totpFrom(totpURI), trustDevice: true },
    });
    expect(verified.status).toBe(200);
    expect((await laptop.call('/me')).json.state).toBe('ready');
    // "Trust this device" is ignored: no trust cookie was set.
    expect(
      verified.headers
        .getSetCookie()
        .some((c) => c.includes('trust_device') && !/max-age=0/i.test(c)),
    ).toBe(false);
  });

  it('accepts each backup code once', async () => {
    await staff('backup@test.invalid');
    const { backupCodes } = await enrolStaff(api, 'backup@test.invalid', PASSWORD);
    const code = backupCodes[0]!;
    const first = new Device(api.baseUrl);
    await first.call('/api/auth/sign-in/email', {
      body: { email: 'backup@test.invalid', password: PASSWORD },
    });
    expect(
      (await first.call('/api/auth/two-factor/verify-backup-code', { body: { code } })).status,
    ).toBe(200);
    const second = new Device(api.baseUrl);
    await second.call('/api/auth/sign-in/email', {
      body: { email: 'backup@test.invalid', password: PASSWORD },
    });
    expect(
      (await second.call('/api/auth/two-factor/verify-backup-code', { body: { code } })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describe('AD-06 session timeouts (spike check 3)', () => {
  it('gives staff a 30-minute idle limit that slides with activity, capped at 12 hours', async () => {
    const personId = await staff('timeouts@test.invalid');
    const { device } = await enrolStaff(api, 'timeouts@test.invalid', PASSWORD);
    const me = await device.call('/me');
    expect(expiresInMs(me.json)).toBeGreaterThan(29 * MINUTE);
    expect(expiresInMs(me.json)).toBeLessThanOrEqual(30 * MINUTE + 5_000);

    // Created 11h50m ago: activity may extend it only to the 12-hour mark.
    await owner(
      api,
      `update session set created_at = now() - interval '11 hours 50 minutes', expires_at = now() + interval '1 minute' where user_id = $1`,
      [personId],
    );
    const capped = await device.call('/me');
    expect(capped.status).toBe(200);
    expect(expiresInMs(capped.json)).toBeLessThanOrEqual(10 * MINUTE + 5_000);
    expect(expiresInMs(capped.json)).toBeGreaterThan(9 * MINUTE);

    // Past 12 hours: refused and signed out.
    await owner(
      api,
      `update session set created_at = now() - interval '12 hours 1 minute' where user_id = $1`,
      [personId],
    );
    expect((await device.call('/me')).status).toBe(401);
    expect(await owner(api, 'select id from session where user_id = $1', [personId])).toHaveLength(
      0,
    );
  });

  it('refuses a session idle for longer than its limit', async () => {
    const personId = await staff('idle@test.invalid');
    const { device } = await enrolStaff(api, 'idle@test.invalid', PASSWORD);
    await owner(
      api,
      `update session set expires_at = now() - interval '1 second' where user_id = $1`,
      [personId],
    );
    expect((await device.call('/me')).status).toBe(401);
    // Better Auth's own routes refuse it too.
    expect((await device.call('/api/auth/list-sessions')).status).toBe(401);
  });

  it('gives platform admins a 15-minute idle limit and tenants 30 days', async () => {
    const { personId } = await createPerson(api, {
      name: 'Admin',
      email: 'admin@test.invalid',
      password: PASSWORD,
    });
    await addMembership(api, platformId, personId, 'platform_admin');
    const { device } = await enrolStaff(api, 'admin@test.invalid', PASSWORD);
    const adminMe = await device.call('/me');
    expect(adminMe.json.actorKind).toBe('platform_admin');
    expect(expiresInMs(adminMe.json)).toBeLessThanOrEqual(15 * MINUTE + 5_000);

    await createPerson(api, { name: 'Tenant Timeout', phone: '+233200000101' });
    const phone = new Device(api.baseUrl);
    await phone.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: '+233200000101' } });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000101')!.body)![1]!;
    await phone.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000101', code },
    });
    const tenantMe = await phone.call('/me');
    expect(expiresInMs(tenantMe.json)).toBeGreaterThan(29 * 24 * 60 * MINUTE);
  });
});

describe('AD-06 devices and remote sign-out (spike check 4)', () => {
  it('lists sessions with device details and revokes one remotely', async () => {
    await staff('devices@test.invalid');
    const { device: phone, totpURI } = await enrolStaff(api, 'devices@test.invalid', PASSWORD);
    const laptop = new Device(api.baseUrl, 'laptop-browser');
    await laptop.call('/api/auth/sign-in/email', {
      body: { email: 'devices@test.invalid', password: PASSWORD },
    });
    await laptop.call('/api/auth/two-factor/verify-totp', {
      body: { code: await totpFrom(totpURI) },
    });
    expect((await laptop.call('/me')).status).toBe(200);

    const listed = await phone.call('/api/auth/list-sessions');
    expect(listed.status).toBe(200);
    const sessions = listed.json as unknown as { token: string; userAgent: string }[];
    expect(sessions.map((s) => s.userAgent)).toContain('laptop-browser');

    const laptopToken = laptop.sessionToken();
    expect(laptopToken).toBeTruthy();
    expect(
      (await phone.call('/api/auth/revoke-session', { body: { token: laptopToken } })).status,
    ).toBe(200);
    expect((await laptop.call('/me')).status).toBe(401);
    expect((await phone.call('/me')).status).toBe(200);
  });
});

describe('AD-06 phone sign-in (spike checks 5 and 6)', () => {
  it('sends a 6-digit code, stores only its HMAC, and signs the tenant in', async () => {
    await createPerson(api, { name: 'Ama Tenant', phone: '0200000201' });
    const device = new Device(api.baseUrl);
    const sent = await device.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '020 000 0201' },
    });
    expect(sent.status).toBe(200);
    const message = api.sms.lastTo('+233200000201');
    const code = /\b(\d{6})\b/.exec(message!.body)![1]!;

    const [stored] = await owner(api, 'select value from verification where identifier = $1', [
      '+233200000201',
    ]);
    expect(String(stored!.value)).toMatch(/^[0-9a-f]{64}:0$/);
    expect(String(stored!.value)).not.toContain(code);

    expect(
      (
        await device.call('/api/auth/phone-number/verify', {
          body: { phoneNumber: '+233200000201', code: code === '111111' ? '222222' : '111111' },
        })
      ).status,
    ).toBe(400);
    const [afterWrong] = await owner(api, 'select value from verification where identifier = $1', [
      '+233200000201',
    ]);
    expect(String(afterWrong!.value)).toMatch(/:1$/);

    const verified = await device.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000201', code },
    });
    expect(verified.status).toBe(200);
    const me = await device.call('/me');
    expect(me.json).toMatchObject({
      state: 'ready',
      authMethod: 'phone_otp',
      actorKind: 'tenant',
      role: null,
    });

    // The code cannot be used twice.
    const again = new Device(api.baseUrl);
    expect(
      (
        await again.call('/api/auth/phone-number/verify', {
          body: { phoneNumber: '+233200000201', code },
        })
      ).status,
    ).toBe(400);
  });

  it('accepts the native app the way the Expo client calls it: expo-origin and a cookie header, no browser Origin', async () => {
    await createPerson(api, { name: 'Native Tenant', phone: '+233200000207' });
    const nativeHeaders = { origin: '', 'expo-origin': 'rentplatform://' };
    const phone = new Device(api.baseUrl, 'Expo/iOS');
    await phone.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000207' },
      headers: nativeHeaders,
    });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000207')!.body)![1]!;
    const verified = await phone.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000207', code },
      headers: nativeHeaders,
    });
    expect(verified.status).toBe(200);
    const me = await phone.call('/me', { headers: nativeHeaders });
    expect(me.json).toMatchObject({ state: 'ready', authMethod: 'phone_otp', actorKind: 'tenant' });
  });

  it('gives an unknown number the same answer and sends nothing', async () => {
    const before = api.sms.sent.length;
    const response = await new Device(api.baseUrl).call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000299' },
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ message: 'code sent' });
    expect(api.sms.sent.length).toBe(before);
  });

  it('locks a code after 5 wrong attempts', async () => {
    await createPerson(api, { name: 'Kofi Tenant', phone: '+233200000202' });
    const device = new Device(api.baseUrl);
    await device.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000202' },
    });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000202')!.body)![1]!;
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await device.call('/api/auth/phone-number/verify', {
            body: { phoneNumber: '+233200000202', code: wrong },
          })
        ).status,
      ).toBe(400);
    }
    const locked = await device.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000202', code },
    });
    expect(locked.status).toBe(403);
  });

  it('refuses an expired code', async () => {
    await createPerson(api, { name: 'Efua Tenant', phone: '+233200000203' });
    const device = new Device(api.baseUrl);
    await device.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000203' },
    });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000203')!.body)![1]!;
    await owner(
      api,
      `update verification set expires_at = now() - interval '1 second' where identifier = $1`,
      ['+233200000203'],
    );
    expect(
      (
        await device.call('/api/auth/phone-number/verify', {
          body: { phoneNumber: '+233200000203', code },
        })
      ).status,
    ).toBe(400);
  });

  it('limits codes to 3 per phone in 15 minutes', async () => {
    await createPerson(api, { name: 'Yaw Tenant', phone: '+233200000204' });
    const device = new Device(api.baseUrl);
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await device.call('/api/auth/phone-number/send-otp', {
            body: { phoneNumber: '+233200000204' },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await device.call('/api/auth/phone-number/send-otp', {
          body: { phoneNumber: '+233200000204' },
        })
      ).status,
    ).toBe(429);
  });

  it('never lets a phone-code session act with a password role', async () => {
    const { personId } = await createPerson(api, {
      name: 'Phone Manager',
      email: 'phone-manager@test.invalid',
      phone: '+233200000205',
      password: PASSWORD,
    });
    await addMembership(api, agencyId, personId, 'property_manager');
    const device = new Device(api.baseUrl);
    await device.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000205' },
    });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000205')!.body)![1]!;
    await device.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000205', code },
    });
    const me = await device.call('/me');
    expect(me.json.role).toBeNull();
    expect(me.json.memberships).toEqual([]);
  });

  it('signs a caretaker in by phone with the staff idle limit', async () => {
    const { personId } = await createPerson(api, { name: 'Caretaker', phone: '+233200000206' });
    await addMembership(api, agencyId, personId, 'caretaker');
    const device = new Device(api.baseUrl);
    await device.call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '+233200000206' },
    });
    const code = /\b(\d{6})\b/.exec(api.sms.lastTo('+233200000206')!.body)![1]!;
    await device.call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '+233200000206', code },
    });
    const me = await device.call('/me');
    expect(me.json).toMatchObject({ state: 'ready', role: 'caretaker', actorKind: 'staff' });
    expect(expiresInMs(me.json)).toBeLessThanOrEqual(30 * MINUTE + 5_000);
  });
});
