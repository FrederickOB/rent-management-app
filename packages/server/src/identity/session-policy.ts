import { sessionClassFor, type AuthMethod, type SessionClass } from '@rent/domain/policy';
import type { AppConfig } from '../core/config';

/**
 * Session limits by kind of user (AD-06; architecture section 11). A session's `expiresAt` is
 * always the earlier of last activity + idle limit and creation + absolute limit, so every
 * Better Auth route enforces both limits by itself; the actor guard slides it on activity.
 */
export type { SessionClass };

/** `password` is a password-only session: it may only enrol TOTP (staff never work without it). */
export type SessionAuthMethod = AuthMethod | 'password';

export interface SessionLimits {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

const MINUTE = 60_000;

export function limitsFor(sessionClass: SessionClass, config: AppConfig): SessionLimits {
  switch (sessionClass) {
    case 'staff':
    case 'caretaker':
      return {
        idleMs: config.STAFF_IDLE_MINUTES * MINUTE,
        absoluteMs: config.STAFF_ABSOLUTE_MINUTES * MINUTE,
      };
    case 'platform_admin':
      return {
        idleMs: config.PLATFORM_ADMIN_IDLE_MINUTES * MINUTE,
        absoluteMs: config.STAFF_ABSOLUTE_MINUTES * MINUTE,
      };
    case 'tenant':
      return {
        idleMs: config.TENANT_IDLE_MINUTES * MINUTE,
        absoluteMs: config.TENANT_ABSOLUTE_MINUTES * MINUTE,
      };
    case 'enrolment':
      return { idleMs: 15 * MINUTE, absoluteMs: config.ENROLMENT_ABSOLUTE_MINUTES * MINUTE };
  }
}

export const classify = (authMethod: SessionAuthMethod, roles: readonly string[]): SessionClass =>
  sessionClassFor(authMethod, roles);

export function expiryFor(now: Date, createdAt: Date, limits: SessionLimits): Date {
  return new Date(Math.min(now.getTime() + limits.idleMs, createdAt.getTime() + limits.absoluteMs));
}

/** Better Auth endpoint that created a session, mapped to how the person proved who they are. */
export function authMethodForPath(path: string | undefined): SessionAuthMethod {
  if (path === '/phone-number/verify') return 'phone_otp';
  if (path === '/two-factor/verify-totp' || path === '/two-factor/verify-backup-code')
    return 'password_totp';
  return 'password';
}
