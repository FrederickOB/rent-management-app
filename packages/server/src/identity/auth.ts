import { expo } from '@better-auth/expo';
import { eq, schema, sql, withSystem, type Database } from '@rent/db';
import { tryNormalisePhone } from '@rent/domain/phone';
import { requiresPasswordAndTotp } from '@rent/domain/policy';
import type { AlertPort, EmailPort, SmsPort } from '@rent/integrations';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { isPasswordCompromised, phoneNumber, twoFactor } from 'better-auth/plugins';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../core/clock';
import { DEV_BETTER_AUTH_SECRET, type AppConfig } from '../core/config';
import type { AppLogger } from '../core/logging/logger';
import type { MembershipDirectory } from './memberships';
import { HASHED_CODE_VALUE, OtpHasher, PLAIN_CODE_VALUE } from './otp-hash';
import {
  hashPassword,
  needsRehash,
  OWASP_SCRYPT,
  TEST_SCRYPT,
  verifyPassword,
} from './password-hash';
import { isPlaceholderEmail } from './person-accounts';
import { authMethodForPath, classify, expiryFor, limitsFor } from './session-policy';
import { StepUpVerifier } from './step-up';

export const AUTH_BASE_PATH = '/api/auth';
const CODE_TTL_SECONDS = 600; // 10 minutes (CLAUDE.md section 9)
const CODE_ATTEMPTS = 5;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
/** An invitation's set-password link stays valid for 3 days; a reset of a password, an hour (R1 F13). */
export const INVITE_LINK_SECONDS = 3 * 24 * HOUR_SECONDS;
export const RESET_LINK_SECONDS = HOUR_SECONDS;
/** Codes sent to one phone in a day, and wrong codes tried for it, before it waits (R1 F2). */
export const OTP_SENDS_PER_PHONE_PER_DAY = 10;
export const OTP_WRONG_PER_PHONE_PER_DAY = 15;
/** Wrong passwords for one account in 15 minutes, from any address, before it waits (R1 F1). */
export const SIGN_IN_FAILURES_PER_ACCOUNT = 10;
const SIGN_IN_FAILURE_WINDOW_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
/** Stored backup codes are keyed hashes with this prefix (R1 F9); never the codes themselves. */
const BACKUP_CODE_HASH = 'h1:';

/** A security event about a person's account, for the audit chain (M11 review R1 F5). */
export interface AuthAuditEvent {
  readonly personId: string;
  readonly action: string;
  readonly recordType: 'session' | 'person';
  readonly recordId: string;
  /** Never a password, code, token, email, phone number or IP address in the clear. */
  readonly data?: Record<string, unknown>;
}

/**
 * Whether a new password is in a breach corpus (plan decision 6). Rejects or throws when the check
 * cannot be made; the caller then accepts the password and raises an alert.
 */
export type BreachedPasswordCheck = (password: string) => Promise<boolean>;

export interface AuthDependencies {
  readonly database: Database;
  readonly config: AppConfig;
  readonly sms: SmsPort;
  readonly email: EmailPort;
  readonly clock: Clock;
  readonly logger: AppLogger;
  readonly memberships: MembershipDirectory;
  /** Called after each successful sign-in (audit, M1 step 5). */
  readonly onSignedIn?: (event: {
    personId: string;
    sessionId: string;
    authMethod: string;
    /** A keyed hash of the address (never the address), and the browser or app (R1 F5). */
    ipHash?: string | null;
    userAgent?: string | null;
  }) => Promise<void>;
  /** Every other account event (R1 F5): failures, sign-out, passwords, TOTP, sessions. */
  readonly onAuthEvent?: (event: AuthAuditEvent) => Promise<void>;
  /** Daily-cap and lockout alerts (R1 F2, F4). */
  readonly alerts?: AlertPort;
  /** Better Auth's Have I Been Pwned check by default; tests pass a fake. */
  readonly breachedPassword?: BreachedPasswordCheck;
}

export function createAuth(deps: AuthDependencies) {
  const { database, config, sms, email, clock, logger, memberships } = deps;
  const production = config.NODE_ENV === 'production';
  // R1 F11: the development secret is published; production never runs on it.
  if (
    production &&
    (config.BETTER_AUTH_SECRET === DEV_BETTER_AUTH_SECRET ||
      config.BETTER_AUTH_SECRET.startsWith('dev-only'))
  )
    throw new Error('BETTER_AUTH_SECRET must be a secret of its own in production');
  const hasher = new OtpHasher(config.BETTER_AUTH_SECRET);
  const cost = config.NODE_ENV === 'test' ? TEST_SCRYPT : OWASP_SCRYPT;
  const stepUp = new StepUpVerifier(database, config, undefined, deps.alerts, clock);
  /** What the before hooks learned, for the after hooks of the same request. */
  const pending = new WeakMap<object, { personId: string; extra?: Record<string, unknown> }>();

  const audit = async (event: AuthAuditEvent): Promise<void> => {
    if (!deps.onAuthEvent) return;
    await deps.onAuthEvent(event).catch((error: unknown) => {
      logger.error({ err: error, action: event.action }, 'auth audit failed');
    });
  };
  const alert = async (code: string, message: string, context: Record<string, unknown>) => {
    await deps.alerts
      ?.raise({ severity: 'warning', code, message, context })
      .catch((error: unknown) => logger.error({ err: error, code }, 'auth alert failed'));
  };

  /**
   * Counts one hit on a fixed-window key and returns the count. Keys hold a keyed hash, never a
   * phone number or an email in the clear.
   */
  async function hit(key: string, windowMinutes: number): Promise<number> {
    const now = clock.now().getTime();
    const windowStart = now - windowMinutes * 60_000;
    return withSystem(database, {}, async (tx) => {
      const result = await tx.execute<{ count: number }>(sql`
        insert into rate_limit (key, count, last_request) values (${key}, 1, ${now})
        on conflict (key) do update set
          count = case when rate_limit.last_request <= ${windowStart} then 1 else rate_limit.count + 1 end,
          last_request = case when rate_limit.last_request <= ${windowStart} then ${now} else rate_limit.last_request end
        returning count`);
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  /** The count on a fixed-window key, without adding to it. */
  async function count(key: string, windowMinutes: number): Promise<number> {
    const windowStart = clock.now().getTime() - windowMinutes * 60_000;
    return withSystem(database, {}, async (tx) => {
      const result = await tx.execute<{ count: number }>(
        sql`select count from rate_limit where key = ${key} and last_request > ${windowStart}`,
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  /** Fixed-window send limits per phone: a few in 15 minutes, and a daily cap with an alert. */
  async function allowCodeSend(phone: string): Promise<'ok' | 'short' | 'daily'> {
    const digest = hasher.hash('rate-limit', phone);
    if (
      (await hit(`otp-phone:${digest}`, config.OTP_SEND_WINDOW_MINUTES)) >
      config.OTP_SENDS_PER_PHONE
    )
      return 'short';
    const today = await hit(`otp-send-day:${digest}`, DAY_MINUTES);
    if (today === OTP_SENDS_PER_PHONE_PER_DAY + 1)
      await alert('auth.otp_send_daily_cap', 'A phone reached its daily limit of sign-in codes', {
        phoneHash: digest.slice(0, 16),
      });
    return today <= OTP_SENDS_PER_PHONE_PER_DAY ? 'ok' : 'daily';
  }

  async function personWithPhone(phone: string): Promise<string | null> {
    return withSystem(database, {}, async (tx) => {
      const rows = await tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.phoneNumber, phone))
        .limit(1);
      return rows[0]?.id ?? null;
    });
  }

  async function hasPassword(personId: string): Promise<boolean> {
    return withSystem(database, { personId }, async (tx) => {
      const rows = await tx
        .select({ id: schema.account.id })
        .from(schema.account)
        .where(
          sql`${schema.account.userId} = ${personId} and ${schema.account.providerId} = 'credential'
            and ${schema.account.password} is not null`,
        );
      return rows.length > 0;
    });
  }

  /**
   * Checks a code against its stored HMAC (M11 review R1 F2). The attempt is counted first, in
   * one atomic update that also refuses a sixth, so parallel guesses each use up an attempt; only
   * then is the code compared. The winning check deletes the row. A phone also has a daily cap
   * on wrong codes, which raises an alert.
   */
  async function verifyCode(phone: string, code: string): Promise<boolean> {
    const digest = hasher.hash('rate-limit', phone);
    if ((await count(`otp-verify-day:${digest}`, DAY_MINUTES)) >= OTP_WRONG_PER_PHONE_PER_DAY)
      // Its own code (not the per-code TOO_MANY_ATTEMPTS), so apps can say "try again tomorrow".
      throw APIError.from('FORBIDDEN', {
        code: 'DAILY_ATTEMPTS_EXCEEDED',
        message: 'Too many attempts today. Try again tomorrow.',
      });
    const counted = await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string; value: string }>(sql`
        update verification set
          value = split_part(value, ':', 1) || ':' || (split_part(value, ':', 2)::int + 1)::text,
          updated_at = now()
        where id = (
            select id from verification where identifier = ${phone}
            order by created_at desc limit 1)
          and value ~ '^[0-9a-f]{64}:[0-9]+$'
          and split_part(value, ':', 2)::int < ${CODE_ATTEMPTS}
          and expires_at > ${clock.now()}
        returning id, value`),
    );
    const row = counted.rows[0];
    if (!row) {
      // No live code with attempts left: drop whatever is stored for this phone.
      const dropped = await withSystem(database, {}, (tx) =>
        tx.execute<{ value: string; expires_at: Date }>(sql`
          delete from verification where identifier = ${phone} returning value, expires_at`),
      );
      const exhausted = dropped.rows.some((r) => {
        const match = HASHED_CODE_VALUE.exec(r.value);
        return (
          match !== null &&
          Number(match[2]) >= CODE_ATTEMPTS &&
          new Date(r.expires_at).getTime() > clock.now().getTime()
        );
      });
      if (exhausted)
        throw APIError.from('FORBIDDEN', {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many attempts. Request a new code.',
        });
      return false;
    }
    const [, storedHash = ''] = HASHED_CODE_VALUE.exec(row.value) ?? [];
    if (!/^\d{6}$/.test(code) || !hasher.matches(phone, code, storedHash)) {
      const wrong = await hit(`otp-verify-day:${digest}`, DAY_MINUTES);
      if (wrong === OTP_WRONG_PER_PHONE_PER_DAY)
        await alert(
          'auth.otp_wrong_daily_cap',
          'A phone reached its daily limit of wrong sign-in codes',
          {
            phoneHash: digest.slice(0, 16),
          },
        );
      return false;
    }
    const consumed = await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string }>(
        sql`delete from verification where id = ${row.id} and value = ${row.value} returning id`,
      ),
    );
    return consumed.rows.length === 1;
  }

  function normalisedPhone(body: unknown): string {
    const raw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).phoneNumber
        : undefined;
    const phone = typeof raw === 'string' ? tryNormalisePhone(raw) : null;
    if (!phone)
      throw APIError.from('BAD_REQUEST', {
        code: 'INVALID_PHONE_NUMBER',
        message: 'Enter a valid phone number.',
      });
    return phone;
  }

  const accountKey = (rawEmail: unknown): string | null =>
    typeof rawEmail === 'string' && rawEmail.trim()
      ? `sign-in-account:${hasher.hash('sign-in-account', rawEmail.trim().toLowerCase())}`
      : null;

  async function personByEmail(rawEmail: unknown): Promise<string | null> {
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) return null;
    return withSystem(database, {}, async (tx) => {
      const [row] = await tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.email, rawEmail.trim().toLowerCase()));
      return row?.id ?? null;
    });
  }

  /** The person a two-factor challenge (the cookie set by the password step) belongs to. */
  async function challengedPerson(ctx: {
    getSignedCookie: (name: string, secret: string) => Promise<string | null | false>;
    context: {
      createAuthCookie: (name: string) => { name: string };
      secret: string;
      internalAdapter: {
        findVerificationValue: (identifier: string) => Promise<{ value: string } | null>;
      };
    };
  }): Promise<string | null> {
    const cookie = ctx.context.createAuthCookie('two_factor');
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!signed) return null;
    return (await ctx.context.internalAdapter.findVerificationValue(signed))?.value ?? null;
  }

  const tenantOrigin = new URL(config.TENANT_WEB_ORIGIN).origin;
  /**
   * Founder D2: the tenant app signs in from its web build's origin, or natively with the Expo
   * client's `expo-origin` header (staff web sign-ins come through the web app's origin).
   */
  const tenantApp = (headers: Headers | undefined): boolean =>
    !!headers && (headers.has('expo-origin') || headers.get('origin') === tenantOrigin);

  const backupHash = (code: string) =>
    `${BACKUP_CODE_HASH}${hasher.hash('backup-code', code.trim())}`;

  const breached: BreachedPasswordCheck = deps.breachedPassword ?? isPasswordCompromised;

  /**
   * Plan decision 6: a new password found in Have I Been Pwned's corpus is refused. Only the first
   * five characters of its SHA-1 hash leave the server. If the service cannot be reached, the
   * password is accepted and an alert is raised (Better Auth's plugin would refuse it instead).
   */
  async function refuseBreached(password: unknown, personId: string | null): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) return;
    let compromised: boolean;
    try {
      compromised = await breached(password);
    } catch {
      await alert(
        'auth.breach_check_unavailable',
        'The breached-password check could not be reached; a new password was accepted unchecked',
        personId ? { personId } : {},
      );
      return;
    }
    if (compromised)
      throw APIError.from('BAD_REQUEST', {
        code: 'PASSWORD_COMPROMISED',
        message:
          'This password has appeared in a data breach elsewhere. Choose a different password.',
      });
  }

  return betterAuth({
    appName: config.APP_NAME,
    baseURL: config.API_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.WEB_ORIGIN, config.TENANT_WEB_ORIGIN, `${config.TENANT_APP_SCHEME}://`],
    database: drizzleAdapter(database.db, {
      provider: 'pg',
      schema: {
        user: schema.person,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        rateLimit: schema.rateLimit,
      },
    }),
    user: {
      modelName: 'user',
      additionalFields: {
        isTestContact: { type: 'boolean', required: false, input: false, defaultValue: false },
      },
    },
    session: {
      // Outer cap only. The real expiry is set per session class (session-policy.ts), and
      // Better Auth never refreshes a session itself: the actor guard slides it on activity.
      expiresIn: THIRTY_DAYS_SECONDS,
      updateAge: THIRTY_DAYS_SECONDS,
      // R1 F6: no "fresh session" rule on the device list and revocation. Its default (a day)
      // emptied the tenant app's device list after 24 hours; our own idle and absolute limits
      // apply to every session, and sensitive changes ask for the password or a TOTP code.
      freshAge: 0,
      cookieCache: { enabled: false },
      additionalFields: {
        authMethod: { type: 'string', required: false, input: false },
        activeCompanyId: { type: 'string', required: false, input: false },
        // Founder D2: 'tenant_app' for sessions made in the tenant app, which act as the tenant.
        client: { type: 'string', required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // R1 F13: a reset link lives an hour. An invitation's first-password link is extended to
      // 3 days when it is sent (sendResetPassword).
      resetPasswordTokenExpiresIn: RESET_LINK_SECONDS,
      // R1 F12: scrypt at OWASP's minimum (password-hash.ts). Older hashes still verify, and are
      // rewritten at the new cost once the right password is given.
      password: {
        hash: (password) => hashPassword(password, cost),
        async verify({ hash, password }) {
          const valid = await verifyPassword(hash, password);
          if (valid && needsRehash(hash, cost)) {
            const rehashed = await hashPassword(password, cost);
            await withSystem(database, {}, (tx) =>
              tx
                .update(schema.account)
                .set({ password: rehashed, updatedAt: clock.now() })
                .where(eq(schema.account.password, hash)),
            ).catch((error: unknown) => logger.error({ err: error }, 'password rehash failed'));
          }
          return valid;
        },
      },
      // Doubles as the invitation: the link sets a first password (MembershipsService.invite).
      async sendResetPassword({ user, url, token }) {
        if (isPlaceholderEmail(user.email)) return; // phone-only people have no real address
        // Founder D2: only someone who holds, or is invited to, a role that signs in with a
        // password can set one. Everyone else gets the same answer and no email.
        const roles = (await memberships.forPerson(user.id)).map((m) => m.role);
        if (!roles.some((role) => requiresPasswordAndTotp(role))) return;
        const invitation = !(await hasPassword(user.id));
        if (invitation)
          await withSystem(database, {}, (tx) =>
            tx
              .update(schema.verification)
              .set({ expiresAt: new Date(clock.now().getTime() + INVITE_LINK_SECONDS * 1000) })
              .where(eq(schema.verification.identifier, `reset-password:${token}`)),
          );
        await email.send({
          to: user.email,
          subject: invitation
            ? `${config.APP_NAME}: set your password`
            : `${config.APP_NAME}: reset your password`,
          text: invitation
            ? `Hello ${user.name},\n\nUse this link to set your password. It expires in 3 days.\n\n${url}\n\nIf you did not expect this email, you can ignore it.`
            : `Hello ${user.name},\n\nUse this link to choose a new password. It expires in 1 hour.\n\n${url}\n\nIf you did not ask for this, you can ignore this email: your password has not changed.`,
        });
      },
    },
    advanced: {
      // R1 F10: `__Host-` in production (Secure, Path=/, no Domain: host-only on the web origin,
      // which proxies /api/auth). Development and e2e run over http, where a `__Host-` cookie is
      // refused by browsers, so they keep the plain name.
      cookiePrefix: production ? '__Host-rent' : 'rent',
      useSecureCookies: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: production, path: '/' },
      database: { generateId: () => uuidv7() },
      // R3 F1: set by the API's Fastify mount from `request.ip`, which Fastify takes from the
      // socket or, only behind a proxy listed in TRUSTED_PROXIES, from X-Forwarded-For. Any
      // x-rent-client-ip a client sends is dropped by the mount before it is set.
      ipAddress: { ipAddressHeaders: ['x-rent-client-ip'] },
      // R1 F16: codes and emails are sent after the response, so its timing says nothing about
      // whether a phone or email is registered. Tests keep them inline, to read them at once.
      ...(config.NODE_ENV === 'test'
        ? {}
        : {
            backgroundTasks: {
              handler: (promise: Promise<unknown>) => {
                void promise.catch((error: unknown) =>
                  logger.error({ err: error }, 'auth background task failed'),
                );
              },
            },
          }),
    },
    rateLimit: {
      enabled: config.AUTH_RATE_LIMITS === 'on',
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/verify-totp': { window: 60, max: 5 },
        '/two-factor/verify-backup-code': { window: 60, max: 5 },
        '/phone-number/send-otp': { window: 3600, max: 10 },
        '/phone-number/verify': { window: 600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
      },
    },
    plugins: [
      // R1 F9: backup codes are stored as keyed hashes. A code given at sign-in is hashed the same
      // way before Better Auth compares it (hooks.before), so the codes themselves are never kept.
      // Rows from before M11 (encrypted) are read once and rewritten hashed at their next use.
      twoFactor({
        issuer: config.APP_NAME,
        skipVerificationOnEnable: false,
        backupCodeOptions: {
          storeBackupCodes: {
            encrypt: async (json: string) =>
              JSON.stringify(
                (JSON.parse(json) as string[]).map((c) =>
                  c.startsWith(BACKUP_CODE_HASH) ? c : backupHash(c),
                ),
              ),
            decrypt: async (stored: string) => {
              if (stored.startsWith('[')) return stored;
              const plain = await symmetricDecrypt({
                key: config.BETTER_AUTH_SECRET,
                data: stored,
              });
              return JSON.stringify((JSON.parse(plain) as string[]).map(backupHash));
            },
          },
        },
      }),
      phoneNumber({
        otpLength: 6,
        expiresIn: CODE_TTL_SECONDS,
        allowedAttempts: CODE_ATTEMPTS,
        async sendOTP({ phoneNumber: phone, code }) {
          // Same response for every number; only people already on record get a code.
          if (!(await personWithPhone(phone))) return;
          await sms.send({
            to: phone,
            body: `${config.APP_NAME}: your sign-in code is ${code}. It expires in 10 minutes. Never share it.`,
            reference: 'sign-in-code',
          });
        },
        verifyOTP: ({ phoneNumber: phone, code }) => verifyCode(phone, code),
      }),
      expo(),
    ],
    databaseHooks: {
      verification: {
        create: {
          before: async (verification) => {
            const match = PLAIN_CODE_VALUE.exec(verification.value);
            if (!match) return { data: verification };
            const [, code = '', attempts = '0'] = match;
            return {
              data: {
                ...verification,
                value: `${hasher.hash(verification.identifier, code)}:${attempts}`,
              },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            let authMethod = authMethodForPath(context?.path);
            // R1 F13: a password change keeps the strength of the session it was made from.
            const previous = (
              context?.context as { session?: { session?: Record<string, unknown> } } | undefined
            )?.session?.session;
            const fromChange = context?.path === '/change-password' && previous;
            if (fromChange && previous.authMethod === 'password_totp') authMethod = 'password_totp';
            const roles = (await memberships.forPerson(session.userId))
              .filter((m) => m.status === 'active')
              .map((m) => m.role);
            const now = clock.now();
            const expiresAt = expiryFor(now, now, limitsFor(classify(authMethod, roles), config));
            return {
              data: {
                ...session,
                authMethod,
                expiresAt,
                client: tenantApp(context?.headers) ? 'tenant_app' : 'web',
                ...(fromChange && typeof previous.activeCompanyId === 'string'
                  ? { activeCompanyId: previous.activeCompanyId }
                  : {}),
              },
            };
          },
          after: async (session, context) => {
            // R1 F14: signing in again in the same browser or app ends the session it replaces.
            if (context && context.path !== '/change-password') {
              const replaced = await context
                .getSignedCookie(
                  context.context.authCookies.sessionToken.name,
                  context.context.secret,
                )
                .catch(() => null);
              if (replaced && replaced !== session.token)
                await withSystem(database, { personId: session.userId }, (tx) =>
                  tx.delete(schema.session).where(eq(schema.session.token, replaced)),
                ).catch((error: unknown) => logger.error({ err: error }, 'session replace failed'));
            }
            if (!deps.onSignedIn) return;
            const ip = (session as { ipAddress?: string | null }).ipAddress;
            await deps
              .onSignedIn({
                personId: session.userId,
                sessionId: session.id,
                authMethod: String((session as Record<string, unknown>).authMethod ?? ''),
                ipHash: ip ? hasher.hash('audit-ip', ip).slice(0, 32) : null,
                userAgent:
                  ((session as { userAgent?: string | null }).userAgent ?? '').slice(0, 300) ||
                  null,
              })
              .catch((error: unknown) => {
                logger.error({ err: error }, 'sign-in audit failed');
              });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        switch (ctx.path) {
          case '/phone-number/send-otp': {
            const phone = normalisedPhone(ctx.body);
            const allowed = await allowCodeSend(phone);
            if (allowed === 'short')
              throw APIError.from('TOO_MANY_REQUESTS', {
                code: 'TOO_MANY_CODES',
                message: 'Too many codes requested. Try again later.',
              });
            if (allowed === 'daily')
              throw APIError.from('TOO_MANY_REQUESTS', {
                code: 'DAILY_CODES_EXCEEDED',
                message: 'Too many codes requested today. Try again tomorrow.',
              });
            return { context: { body: { phoneNumber: phone } } };
          }
          case '/phone-number/verify': {
            const code = typeof body.code === 'string' ? body.code : '';
            const phone = normalisedPhone(ctx.body);
            if (ctx.request) pending.set(ctx.request, { personId: '', extra: { phone } });
            return { context: { body: { phoneNumber: phone, code } } };
          }
          case '/sign-in/email': {
            // R1 F1: wrong passwords are limited per account too, from whatever address.
            const key = accountKey(body.email);
            if (
              key &&
              (await count(key, SIGN_IN_FAILURE_WINDOW_MINUTES)) >= SIGN_IN_FAILURES_PER_ACCOUNT
            )
              throw APIError.from('TOO_MANY_REQUESTS', {
                code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many attempts. Try again in 15 minutes.',
              });
            return undefined;
          }
          case '/two-factor/verify-totp':
          case '/two-factor/verify-backup-code': {
            const session = await getSessionFromCtx(ctx).catch(() => null);
            const personId = session?.user.id ?? (await challengedPerson(ctx));
            if (personId && ctx.request)
              pending.set(ctx.request, { personId, extra: { enrolling: !!session } });
            // Staff always give a code: no "trust this device".
            return {
              context: {
                body: {
                  ...body,
                  trustDevice: false,
                  ...(ctx.path === '/two-factor/verify-backup-code'
                    ? { code: backupHash(typeof body.code === 'string' ? body.code : '') }
                    : {}),
                },
              },
            };
          }
          case '/two-factor/generate-backup-codes': {
            // R1 F9: new backup codes need a current TOTP code as well as the password.
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (!session) return undefined; // the endpoint refuses it
            const outcome = await stepUp.check(
              session.user.id,
              typeof body.code === 'string' ? body.code : '',
            );
            if (outcome !== 'verified') {
              await audit({
                personId: session.user.id,
                action: 'auth.step_up_failed',
                recordType: 'person',
                recordId: session.user.id,
                data: { purpose: 'backup_codes', outcome },
              });
              throw APIError.from(outcome === 'locked' ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST', {
                code: outcome === 'locked' ? 'STEP_UP_LOCKED' : 'TOTP_REQUIRED',
                message:
                  outcome === 'locked'
                    ? 'Too many wrong codes. Try again in 15 minutes.'
                    : 'Enter a current code from your authenticator app',
              });
            }
            if (ctx.request) pending.set(ctx.request, { personId: session.user.id });
            return { context: { body: { password: body.password } } };
          }
          case '/request-password-reset':
            // R1 F8: the link always lands on the web app's set-password page, never a URL the
            // request named (a custom scheme could hand the token to another app).
            return {
              context: {
                body: {
                  email: typeof body.email === 'string' ? body.email : '',
                  redirectTo: `${config.WEB_ORIGIN}/accept-invite`,
                },
              },
            };
          case '/reset-password': {
            const token = typeof body.token === 'string' ? body.token : '';
            const [row] = token
              ? await withSystem(database, {}, (tx) =>
                  tx
                    .select({ value: schema.verification.value })
                    .from(schema.verification)
                    .where(eq(schema.verification.identifier, `reset-password:${token}`)),
                )
              : [];
            await refuseBreached(body.newPassword, row?.value ?? null);
            if (row && ctx.request)
              pending.set(ctx.request, {
                personId: row.value,
                extra: { via: (await hasPassword(row.value)) ? 'reset' : 'invitation' },
              });
            return undefined;
          }
          case '/change-password': {
            const session = await getSessionFromCtx(ctx).catch(() => null);
            await refuseBreached(body.newPassword, session?.user.id ?? null);
            if (session && ctx.request) pending.set(ctx.request, { personId: session.user.id });
            return undefined;
          }
          case '/sign-out':
          case '/revoke-session':
          case '/revoke-other-sessions': {
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (session && ctx.request)
              pending.set(ctx.request, {
                personId: session.user.id,
                extra: { sessionId: session.session.id },
              });
            return undefined;
          }
          default:
            return undefined;
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);
        const known = ctx.request ? pending.get(ctx.request) : undefined;
        switch (ctx.path) {
          case '/sign-in/email': {
            if (!failed) return;
            const status = (returned as { statusCode?: number }).statusCode;
            if (status !== 401 && status !== 400) return;
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const key = accountKey(body.email);
            if (key) await hit(key, SIGN_IN_FAILURE_WINDOW_MINUTES);
            const personId = await personByEmail(body.email);
            if (personId)
              await audit({
                personId,
                action: 'auth.sign_in_failed',
                recordType: 'person',
                recordId: personId,
                data: { step: 'password' },
              });
            return;
          }
          case '/two-factor/verify-totp':
          case '/two-factor/verify-backup-code': {
            if (!known?.personId) return;
            const step = ctx.path === '/two-factor/verify-totp' ? 'totp' : 'backup_code';
            if (failed)
              await audit({
                personId: known.personId,
                action: known.extra?.enrolling
                  ? 'auth.totp_enrolment_failed'
                  : 'auth.sign_in_failed',
                recordType: 'person',
                recordId: known.personId,
                data: { step },
              });
            else if (known.extra?.enrolling && step === 'totp')
              await audit({
                personId: known.personId,
                action: 'auth.totp_enrolled',
                recordType: 'person',
                recordId: known.personId,
              });
            else if (step === 'backup_code')
              await audit({
                personId: known.personId,
                action: 'auth.backup_code_used',
                recordType: 'person',
                recordId: known.personId,
              });
            return;
          }
          case '/phone-number/verify': {
            if (!failed) return;
            const phone = known?.extra?.phone;
            const personId = typeof phone === 'string' ? await personWithPhone(phone) : null;
            if (personId)
              await audit({
                personId,
                action: 'auth.sign_in_failed',
                recordType: 'person',
                recordId: personId,
                data: { step: 'phone_code' },
              });
            return;
          }
          case '/reset-password': {
            if (failed || !known) return;
            // The link reached them, so the address is theirs (founder D2: matched only when proved).
            await withSystem(database, { personId: known.personId }, (tx) =>
              tx
                .update(schema.person)
                .set({ emailVerified: true, updatedAt: clock.now() })
                .where(eq(schema.person.id, known.personId)),
            );
            await audit({
              personId: known.personId,
              action: 'auth.password_set',
              recordType: 'person',
              recordId: known.personId,
              data: { via: known.extra?.via ?? 'reset' },
            });
            return;
          }
          case '/change-password':
          case '/two-factor/generate-backup-codes': {
            if (failed || !known) return;
            await audit({
              personId: known.personId,
              action:
                ctx.path === '/change-password'
                  ? 'auth.password_changed'
                  : 'auth.backup_codes_regenerated',
              recordType: 'person',
              recordId: known.personId,
            });
            return;
          }
          case '/sign-out':
          case '/revoke-session':
          case '/revoke-other-sessions': {
            if (failed || !known) return;
            await audit({
              personId: known.personId,
              action: {
                '/sign-out': 'auth.signed_out',
                '/revoke-session': 'auth.session_revoked',
                '/revoke-other-sessions': 'auth.other_sessions_revoked',
              }[ctx.path],
              recordType: 'session',
              recordId: String(known.extra?.sessionId ?? known.personId),
            });
            return;
          }
          default:
            return;
        }
      }),
    },
    logger: {
      level: config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace' ? 'debug' : 'warn',
      log: (level, message) => logger[level]({ source: 'better-auth' }, message),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
