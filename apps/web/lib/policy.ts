import { membershipSchema, type Me } from '@rent/contracts';
import { can, type Actor, type AuthMethod, type PolicyAction } from '@rent/domain/policy';

function strongMethod(method: Me['authMethod']): AuthMethod | null {
  switch (method) {
    case 'password_totp':
    case 'phone_otp':
      return method;
    default:
      return null;
  }
}

/** The actor the API builds for this session, rebuilt from GET /me. */
export function actorOf(me: Me): Actor | null {
  const authMethod = strongMethod(me.authMethod);
  const active = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  if (!authMethod || !active) return null;
  switch (me.actorKind) {
    case 'staff': {
      const role = membershipSchema.shape.role.safeParse(active.role);
      if (!role.success) return null;
      return {
        kind: 'staff',
        personId: me.personId,
        companyId: active.companyId,
        companyKind: active.companyKind,
        membershipId: active.membershipId,
        role: role.data,
        nominatedApprover: active.nominatedApprover,
        // The membership's owners and properties (AD-02), so the policy can refuse what the API
        // refuses a scoped session, such as the audit log.
        scope: active.scope ?? {},
        authMethod,
      };
    }
    case 'platform_admin':
      return {
        kind: 'platform_admin',
        personId: me.personId,
        companyId: active.companyId,
        membershipId: active.membershipId,
        authMethod,
      };
    default:
      return null;
  }
}

/**
 * Whether to offer a control. This asks the same policy function the API's PolicyService uses
 * (AD-03), so the screens never compare roles; the API still enforces every request.
 */
export function allowed(me: Me, action: PolicyAction): boolean {
  const actor = actorOf(me);
  return actor ? can(actor, action).allowed : false;
}
