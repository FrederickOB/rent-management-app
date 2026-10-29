import { expo } from '@better-auth/expo';
import { and, desc, eq, schema, sql, withSystem, type Database } from '@rent/db';
import { tryNormalisePhone } from '@rent/domain/phone';
import type { EmailPort, SmsPort } from '@rent/integrations';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { phoneNumber, twoFactor } from 'better-auth/plugins';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import type { AppLogger } from '../core/logging/logger';
import type { MembershipDirectory } from './memberships';
import { HASHED_CODE_VALUE, OtpHasher, PLAIN_CODE_VALUE } from './otp-hash';
import { authMethodForPath, classify, expiryFor, limitsFor } from './session-policy';

export const AUTH_BASE_PATH = '/api/auth';
const CODE_TTL_SECONDS = 600; // 10 minutes (CLAUDE.md section 9)
const CODE_ATTEMPTS = 5;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

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
  }) => Promise<void>;
}

export function createAuth(deps: AuthDependencies) {
  const { database, config, sms, email, clock, logger, memberships } = deps;
  const hasher = new OtpHasher(config.BETTER_AUTH_SECRET);
  const production = config.NODE_ENV === 'production';

  /** Fixed-window send limit per phone, keyed by an HMAC so no number is stored in the clear. */
  async function allowCodeSend(phone: string): Promise<boolean> {
    const key = `otp-phone:${hasher.hash('rate-limit', phone)}`;
    const now = clock.now().getTime();
    const windowStart = now - config.OTP_SEND_WINDOW_MINUTES * 60_000;
    return withSystem(database, {}, async (tx) => {
      const result = await tx.execute<{ count: number }>(sql`
        insert into rate_limit (key, count, last_request) values (${key}, 1, ${now})
        on conflict (key) do update set
          count = case when rate_limit.last_request <= ${windowStart} then 1 else rate_limit.count + 1 end,
          last_request = case when rate_limit.last_request <= ${windowStart} then ${now} else rate_limit.last_request end
        returning count`);
      return Number(result.rows[0]?.count ?? 0) <= config.OTP_SENDS_PER_PHONE;
    });
  }

  async function personWithPhone(phone: string): Promise<boolean> {
    return withSystem(database, {}, async (tx) => {
      const rows = await tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.phoneNumber, phone))
        .limit(1);
      return rows.length === 1;
    });
  }

  /** Checks a code against its stored HMAC, counting attempts; the winning check deletes the row. */
  async function verifyCode(phone: string, code: string): Promise<boolean> {
    return withSystem(database, {}, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.identifier, phone))
        .orderBy(desc(schema.verification.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      const match = HASHED_CODE_VALUE.exec(row.value);
      if (!match || row.expiresAt.getTime() <= clock.now().getTime()) {
        await tx.delete(schema.verification).where(eq(schema.verification.id, row.id));
        return false;
      }
      const [, storedHash = '', rawAttempts = '0'] = match;
      const attempts = Number(rawAttempts);
      if (attempts >= CODE_ATTEMPTS) {
        await tx.delete(schema.verification).where(eq(schema.verification.id, row.id));
        throw APIError.from('FORBIDDEN', {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many attempts. Request a new code.',
        });
      }
      if (!/^\d{6}$/.test(code) || !hasher.matches(phone, code, storedHash)) {
        await tx
          .update(schema.verification)
          .set({ value: `${storedHash}:${attempts + 1}`, updatedAt: clock.now() })
          .where(and(eq(schema.verification.id, row.id), eq(schema.verification.value, row.value)));
        return false;
      }
      const consumed = await tx
        .delete(schema.verification)
        .where(and(eq(schema.verification.id, row.id), eq(schema.verification.value, row.value)))
        .returning({ id: schema.verification.id });
      return consumed.length === 1;
    });
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
      cookieCache: { enabled: false },
      additionalFields: {
        authMethod: { type: 'string', required: false, input: false },
        activeCompanyId: { type: 'string', required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60 * 24 * 3, // invites stay valid for 3 days
      // Doubles as the invitation: the link sets a first password (MembershipsService.invite).
      async sendResetPassword({ user, url }) {
        if (user.email.endsWith('@users.invalid')) return; // phone-only people have no real address
        await email.send({
          to: user.email,
          subject: `${config.APP_NAME}: set your password`,
          text: `Hello ${user.name},\n\nUse this link to set your password. It expires in 3 days.\n\n${url}\n\nIf you did not expect this email, you can ignore it.`,
        });
      },
    },
    advanced: {
      cookiePrefix: 'rent',
      useSecureCookies: production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: production },
      database: { generateId: () => uuidv7() },
      // Set by the API's Fastify mount from the socket or the trusted proxy, never by the client.
      ipAddress: { ipAddressHeaders: ['x-rent-client-ip'] },
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
      // Backup codes are encrypted at rest; Better Auth's default is plain JSON.
      twoFactor({
        issuer: config.APP_NAME,
        skipVerificationOnEnable: false,
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
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
            const authMethod = authMethodForPath(context?.path);
            const roles = (await memberships.forPerson(session.userId))
              .filter((m) => m.status === 'active')
              .map((m) => m.role);
            const now = clock.now();
            const expiresAt = expiryFor(now, now, limitsFor(classify(authMethod, roles), config));
            return { data: { ...session, authMethod, expiresAt } };
          },
          after: async (session) => {
            if (!deps.onSignedIn) return;
            await deps
              .onSignedIn({
                personId: session.userId,
                sessionId: session.id,
                authMethod: String((session as Record<string, unknown>).authMethod ?? ''),
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
        if (ctx.path === '/phone-number/send-otp') {
          const phone = normalisedPhone(ctx.body);
          if (!(await allowCodeSend(phone))) {
            throw APIError.from('TOO_MANY_REQUESTS', {
              code: 'TOO_MANY_CODES',
              message: 'Too many codes requested. Try again later.',
            });
          }
          return { context: { body: { phoneNumber: phone } } };
        }
        if (ctx.path === '/phone-number/verify') {
          const code = typeof ctx.body?.code === 'string' ? ctx.body.code : '';
          return { context: { body: { phoneNumber: normalisedPhone(ctx.body), code } } };
        }
        if (
          ctx.path === '/two-factor/verify-totp' ||
          ctx.path === '/two-factor/verify-backup-code'
        ) {
          // Staff always give a code: no "trust this device".
          return {
            context: { body: { ...(ctx.body as Record<string, unknown>), trustDevice: false } },
          };
        }
        return undefined;
      }),
    },
    logger: {
      level: config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace' ? 'debug' : 'warn',
      log: (level, message) => logger[level]({ source: 'better-auth' }, message),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
