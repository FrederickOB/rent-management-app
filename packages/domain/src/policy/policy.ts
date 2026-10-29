import type { AuthMethod, CompanyKind, StaffRole } from './roles';

/** Scope inside a company (AD-02). Filled from M2 (owners, properties). */
export interface MembershipScope {
  readonly owners?: readonly string[];
  readonly properties?: readonly string[];
}

export type Actor =
  | {
      readonly kind: 'staff';
      readonly personId: string;
      readonly companyId: string;
      readonly companyKind: CompanyKind;
      readonly membershipId: string;
      readonly role: StaffRole;
      readonly nominatedApprover: boolean;
      readonly scope: MembershipScope;
      readonly authMethod: AuthMethod;
    }
  | {
      readonly kind: 'platform_admin';
      readonly personId: string;
      readonly companyId: string;
      readonly membershipId: string;
      readonly authMethod: AuthMethod;
    }
  | { readonly kind: 'tenant'; readonly personId: string; readonly authMethod: AuthMethod }
  | { readonly kind: 'system'; readonly companyId: string; readonly job: string };

export const POLICY_ACTIONS = [
  'company.view',
  'company.update',
  'membership.view',
  'membership.manage',
  'audit.search',
  'approval.view',
  'approval.decide',
  'approval.self_confirm',
  'approval.cancel',
  'session.manage_own',
  'document.view',
  'rules.view',
  'rules.add',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Resource facts the policy needs for approval decisions. */
export interface ApprovalResource {
  readonly initiatorPersonId: string;
  /** Roles the action type lets approve, declared by its handler. */
  readonly eligibleRoles: readonly StaffRole[];
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
}

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

type Grant = 'own_company' | 'agency_client';

/**
 * Who may do what (plan M1 section 4.6). `owner` means the landlord in their own company
 * (`own_company`) and an agency's client in an agency (`agency_client`).
 */
const STAFF_MATRIX: Record<
  Exclude<
    PolicyAction,
    'approval.decide' | 'approval.self_confirm' | 'approval.cancel' | 'rules.view' | 'rules.add'
  >,
  readonly (StaffRole | `owner:${Grant}`)[]
> = {
  'company.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'company.update': ['owner:own_company', 'agency_admin'],
  'membership.view': ['owner:own_company', 'agency_admin', 'property_manager'],
  'membership.manage': ['owner:own_company', 'agency_admin'],
  'audit.search': ['owner:own_company', 'agency_admin', 'accountant'],
  'approval.view': ['owner:own_company', 'agency_admin', 'property_manager', 'accountant'],
  'session.manage_own': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'document.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
};

function staffKey(role: StaffRole, companyKind: CompanyKind): StaffRole | `owner:${Grant}` {
  if (role !== 'owner') return role;
  return companyKind === 'agency' ? 'owner:agency_client' : 'owner:own_company';
}

function eligibleToApprove(
  actor: Extract<Actor, { kind: 'staff' }>,
  resource: ApprovalResource,
): boolean {
  if (actor.nominatedApprover) return true;
  if (actor.role === 'owner' && actor.companyKind === 'agency') return false;
  return resource.eligibleRoles.includes(actor.role);
}

export function can(actor: Actor, action: PolicyAction, resource?: ApprovalResource): Decision {
  switch (actor.kind) {
    case 'system':
      return deny('system actors act through jobs, not the policy layer');
    case 'tenant':
      return action === 'session.manage_own'
        ? allow('tenants manage their own sessions')
        : deny('not available to tenants');
    case 'platform_admin':
      if (action === 'rules.view' || action === 'rules.add' || action === 'session.manage_own') {
        return allow('platform admin');
      }
      return deny('platform admins see company data only under a support grant (M10)');
    case 'staff': {
      if (action === 'rules.view' || action === 'rules.add')
        return deny('rules are managed by platform admins');
      if (
        action === 'approval.decide' ||
        action === 'approval.self_confirm' ||
        action === 'approval.cancel'
      ) {
        if (!resource) return deny('approval decisions need the request');
        const isInitiator = resource.initiatorPersonId === actor.personId;
        if (action === 'approval.decide') {
          if (isInitiator) return deny('the initiator can never approve (AD-05)');
          return eligibleToApprove(actor, resource)
            ? allow('eligible approver')
            : deny('not an eligible approver for this action');
        }
        // Withdrawing a request and self-confirming after cooling off (OQ-29) are for the
        // initiator only; the approvals engine checks the mode and the time.
        return isInitiator ? allow('the initiator') : deny('only the initiator can do this');
      }
      if (action === 'approval.view' && actor.nominatedApprover) return allow('nominated approver');
      const allowed = STAFF_MATRIX[action];
      return allowed.includes(staffKey(actor.role, actor.companyKind))
        ? allow(`${actor.role} may ${action}`)
        : deny(`${actor.role} may not ${action}`);
    }
  }
}

/** The role an actor acts with, for display (never for decisions; use can()). */
export function roleOf(actor: Actor | null): string | null {
  if (!actor) return null;
  if (actor.kind === 'staff') return actor.role;
  return actor.kind === 'platform_admin' ? 'platform_admin' : null;
}

/** The company an actor works in, if any. */
export function companyOf(actor: Actor | null): string | null {
  if (!actor || actor.kind === 'tenant') return null;
  return actor.companyId;
}
