/** Roles (AD-03). Only the policy module compares roles (CLAUDE.md section 5). */
export const STAFF_ROLES = [
  'owner',
  'agency_admin',
  'property_manager',
  'accountant',
  'caretaker',
  'adviser',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Defined now, used later: artisans work through job-sheet links (M8); tenants and commercial tenant users are actor kinds (M3, P2). */
export const RESERVED_ROLES = ['artisan', 'tenant', 'commercial_tenant_user'] as const;

export const PLATFORM_ROLES = ['platform_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type MembershipRole = StaffRole | PlatformRole;
export const MEMBERSHIP_ROLES: readonly MembershipRole[] = [...STAFF_ROLES, ...PLATFORM_ROLES];

export const ALL_ROLES = [...STAFF_ROLES, ...RESERVED_ROLES, ...PLATFORM_ROLES] as const;

export type CompanyKind = 'landlord' | 'agency' | 'platform';
export type AuthMethod = 'password_totp' | 'phone_otp';

/** Roles that sign in with a password and TOTP (AD-06). Everyone else uses a phone code. */
const PASSWORD_ROLES: ReadonlySet<MembershipRole> = new Set([
  'owner',
  'agency_admin',
  'property_manager',
  'accountant',
  'adviser',
  'platform_admin',
]);

export const requiresPasswordAndTotp = (role: MembershipRole): boolean => PASSWORD_ROLES.has(role);

/**
 * A session carries a membership only if it was authenticated the way that role signs in: a
 * phone-code session never acts with a password role, and (M11 security review R1 F3) a password
 * session never acts as a caretaker, so a password set on a shared person record cannot reach a
 * caretaker membership granted to that phone's owner.
 */
export function roleUsableWith(role: MembershipRole, method: AuthMethod): boolean {
  return method === 'password_totp' ? PASSWORD_ROLES.has(role) : !PASSWORD_ROLES.has(role);
}

export const isMembershipRole = (value: string): value is MembershipRole =>
  (MEMBERSHIP_ROLES as readonly string[]).includes(value);

export const isPlatformRole = (role: MembershipRole): boolean => role === 'platform_admin';

/** Which session limits apply (AD-06): see the identity module's session policy. */
export type SessionClass = 'staff' | 'platform_admin' | 'caretaker' | 'tenant' | 'enrolment';

export function sessionClassFor(
  authMethod: AuthMethod | 'password',
  roles: readonly string[],
): SessionClass {
  if (authMethod === 'password') return 'enrolment';
  if (authMethod === 'password_totp')
    return roles.includes('platform_admin') ? 'platform_admin' : 'staff';
  return roles.includes('caretaker') ? 'caretaker' : 'tenant';
}
