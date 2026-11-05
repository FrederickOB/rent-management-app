import { DomainError } from '../errors';
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
  // M2: the property register (plan section 4.4).
  'owner.view',
  'owner.manage',
  'register.view',
  'register.manage',
  'register.import',
  'unit.band_override',
  'property_photo.view',
  'property_paper.view',
  'property_file.upload',
  // M3: tenants, leases and e-signing (plan section 4.14).
  'tenant.view',
  'tenant.view_details',
  'tenant.manage',
  'tenant.id.verify',
  'tenant.id.reveal',
  'lease.view',
  'lease.view_terms',
  'lease.manage',
  'lease.cancel_signed',
  'lease_template.manage',
  'tenancy.view_own',
  // M4a: the ledger and billing (plan section 4.17).
  'billing.view',
  'billing.manage',
  'payment.record',
  'payment.record_transfer',
  'cash.bank',
  'cash.bank_others',
  'cash.view_own',
  // M4b: provider payments (plan section 4.11).
  'payments.view',
  'payments.match',
  'settlement_account.change',
  'payment.refund_unmatched',
  // M4b: an account number shown in full, with a reason, audited (CLAUDE.md section 10).
  'settlement_account.reveal',
  // M5: rent tax and VAT paid to GRA, and the rent tax alerts (plan decision 5).
  'tax.manage',
  // M5: a withholding certificate confirmed by a user for its owner (plan decision 3).
  'withholding.confirm',
  // M6: the inbox, broadcasts, templates and groups (plan 4.12). The plan's own limits (Starter
  // has no inbox or broadcasts, decision 9) are checked by EntitlementsService, not here.
  'messaging.inbox.read',
  'messaging.reply',
  'messaging.assign',
  'messaging.triage',
  'messaging.broadcast',
  'messaging.templates.read',
  'tenant_group.manage',
  // M6: a tenant's own conversations, photos and push devices in the tenant app.
  'messaging.own',
  // M6: platform admins register WhatsApp numbers and set the interim plan (decisions 3 and 9).
  'whatsapp_account.manage',
  'company.plan.manage',
  // M6 (decision 12): the reported repairs the bot creates; M8 adds the rest of maintenance.
  'maintenance.view',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Resource facts the policy needs for approval decisions. */
export interface ApprovalResource {
  readonly kind?: 'approval';
  readonly initiatorPersonId: string;
  /** Roles the action type lets approve, declared by its handler. */
  readonly eligibleRoles: readonly StaffRole[];
  /**
   * The property the request's subject belongs to; null for a company-level request (AD-02).
   * Left out, the scope is not judged here.
   */
  readonly propertyId?: string | null;
  /** The properties the deciding session covers (its resolved scope), or null when unscoped. */
  readonly scopeProperties?: readonly string[] | null;
}

/**
 * A withholding certificate to confirm (TX-04; M5 decision 3): a user for its owner confirms it,
 * or an agency admin when the owner has none; never the person who uploaded it.
 */
export interface CertificateResource {
  readonly kind: 'certificate';
  readonly ownerId: string;
  readonly uploadedBy: string;
  /** Whether the owner has a user of their own in the company (see `actsForOwner`). */
  readonly ownerHasUser: boolean;
}

export type PolicyResource = ApprovalResource | CertificateResource;

export interface Decision {
  readonly allowed: boolean;
  /** Why, for logs and tests. */
  readonly reason: string;
  /** Why, for people: a refusal that needs explaining carries it, and the API shows it. */
  readonly message?: string;
}

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string, message?: string): Decision =>
  message === undefined ? { allowed: false, reason } : { allowed: false, reason, message };

/**
 * Audit events carry whole rows from every table, before and after, so the log cannot be cut down
 * to some owners or properties: a session limited to some of them does not search it (M2 S1).
 */
export const AUDIT_NEEDS_WHOLE_COMPANY =
  'The audit log covers the whole company, so it is not open to people limited to some owners or properties';

type Grant = 'own_company' | 'agency_client';

/**
 * Who may do what (plan M1 section 4.6). `owner` means the landlord in their own company
 * (`own_company`) and an agency's client in an agency (`agency_client`).
 */
const STAFF_MATRIX: Record<
  Exclude<
    PolicyAction,
    | 'approval.decide'
    | 'approval.self_confirm'
    | 'approval.cancel'
    | 'rules.view'
    | 'rules.add'
    | 'whatsapp_account.manage'
    | 'company.plan.manage'
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
  // M2 (plan section 4.4). Rows a scoped actor may see are limited by scopeOf() below.
  'owner.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'adviser',
  ],
  'owner.manage': ['owner:own_company', 'agency_admin'],
  'register.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'register.manage': ['owner:own_company', 'agency_admin', 'property_manager'],
  'register.import': ['owner:own_company', 'agency_admin', 'property_manager'],
  // A band sets the subscription rate (PB-01), so a manager cannot change it.
  'unit.band_override': ['owner:own_company', 'agency_admin'],
  'property_photo.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  // Title deeds, site plans and permits: not caretakers (M2 decision 4).
  'property_paper.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'adviser',
  ],
  'property_file.upload': ['owner:own_company', 'agency_admin', 'property_manager'],
  // M3 (plan section 4.14). A caretaker sees the tenants and leases in their scope, but only a
  // tenant's name, phone and unit and a lease's unit and dates: the rest needs view_details or
  // view_terms. ID numbers are revealed only with tenant.id.reveal, never to caretakers,
  // accountants, advisers or agency client owners (PRD section 15).
  'tenant.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'tenant.view_details': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'adviser',
  ],
  'tenant.manage': ['owner:own_company', 'agency_admin', 'property_manager'],
  'tenant.id.verify': ['owner:own_company', 'agency_admin', 'property_manager'],
  'tenant.id.reveal': ['owner:own_company', 'agency_admin', 'property_manager'],
  'lease.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'lease.view_terms': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'adviser',
  ],
  'lease.manage': ['owner:own_company', 'agency_admin', 'property_manager'],
  // Starts an approval; a second eligible person decides (M3 decision 6).
  'lease.cancel_signed': ['owner:own_company', 'agency_admin', 'property_manager'],
  'lease_template.manage': ['owner:own_company', 'agency_admin'],
  // A tenant's own tenancies in the tenant app; staff use lease.view.
  'tenancy.view_own': [],
  // M4a (plan section 4.17). Caretakers see only their own cash records and cash on hand
  // (cash.view_own), never invoices, balances or owners' money.
  'billing.view': [
    'owner:own_company',
    'owner:agency_client',
    'agency_admin',
    'property_manager',
    'accountant',
    'adviser',
  ],
  // Requests credit notes and write-offs, and matches unmatched receipts; a second person decides.
  'billing.manage': ['owner:own_company', 'agency_admin', 'property_manager', 'accountant'],
  // Cash and cheques: caretakers too, on their assigned properties (scope applies).
  'payment.record': [
    'owner:own_company',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
  ],
  // A transfer straight into the owner's or the agency's account (P28), with proof.
  'payment.record_transfer': [
    'owner:own_company',
    'agency_admin',
    'property_manager',
    'accountant',
  ],
  // Banking one's own cash (P07); cash.bank_others banks anyone's.
  'cash.bank': ['owner:own_company', 'agency_admin', 'property_manager', 'accountant', 'caretaker'],
  'cash.bank_others': ['owner:own_company', 'agency_admin', 'accountant'],
  'cash.view_own': [
    'owner:own_company',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
  ],
  // M4b (plan section 4.11). As with billing.manage, a self-managing landlord is in every row:
  // they are their own company's admin.
  'payments.view': ['owner:own_company', 'agency_admin', 'property_manager', 'accountant'],
  'payments.match': ['owner:own_company', 'agency_admin', 'property_manager', 'accountant'],
  // Redirecting rent is the likeliest fraud (ADR-008): a request, then a second person and 24 hours.
  'settlement_account.change': ['owner:own_company', 'agency_admin'],
  'payment.refund_unmatched': ['owner:own_company', 'agency_admin', 'accountant'],
  'settlement_account.reveal': ['owner:own_company', 'agency_admin'],
  // M5. Paying GRA and the rent tax alerts: "accountants and admins" (plan decision 5); a
  // self-managing landlord is their own company's admin.
  'tax.manage': ['owner:own_company', 'agency_admin', 'accountant'],
  // Owners confirm their own certificates; an agency admin only for an owner with no user, which
  // the certificate resource says (decision 3).
  'withholding.confirm': ['owner:own_company', 'owner:agency_client', 'agency_admin'],
  // M6 (plan 4.12). Scope still applies: a caretaker reads and replies only in conversations of
  // tenants on assigned properties, and triage only shows to people who see the whole company.
  // Accountants and advisers read but do not reply. An agency's client owners stay out of tenant
  // conversations; the agency answers its tenants.
  'messaging.inbox.read': [
    'owner:own_company',
    'agency_admin',
    'property_manager',
    'accountant',
    'caretaker',
    'adviser',
  ],
  'messaging.reply': ['owner:own_company', 'agency_admin', 'property_manager', 'caretaker'],
  'messaging.assign': ['owner:own_company', 'agency_admin', 'property_manager'],
  'messaging.triage': ['owner:own_company', 'agency_admin', 'property_manager'],
  // Agency admins, managers and landlords; no approval step (plan 4.7).
  'messaging.broadcast': ['owner:own_company', 'agency_admin', 'property_manager'],
  'messaging.templates.read': ['owner:own_company', 'agency_admin', 'property_manager'],
  'tenant_group.manage': ['owner:own_company', 'agency_admin', 'property_manager'],
  // Tenants only (below); staff use the inbox.
  'messaging.own': [],
  // Caretakers see the repairs on their assigned properties (scope applies).
  'maintenance.view': ['owner:own_company', 'agency_admin', 'property_manager', 'caretaker'],
};

/** Platform-level actions: platform admins only, never staff of a company (M6 decisions 3 and 9). */
const PLATFORM_ACTIONS: readonly PolicyAction[] = [
  'rules.view',
  'rules.add',
  'session.manage_own',
  'whatsapp_account.manage',
  'company.plan.manage',
];

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

/**
 * Whether a staff actor is a user for an owner (M5 decision 3): a landlord in their own company
 * (within any owner scope it has), or an agency's client owner with that owner in scope.
 */
export function actsForOwner(actor: Actor, ownerId: string): boolean {
  if (actor.kind !== 'staff' || actor.role !== 'owner') return false;
  const owners = actor.scope.owners ?? [];
  if (actor.companyKind === 'agency') return owners.includes(ownerId);
  return owners.length === 0 || owners.includes(ownerId);
}

function certificateDecision(
  actor: Extract<Actor, { kind: 'staff' }>,
  resource: CertificateResource,
): Decision {
  if (resource.uploadedBy === actor.personId)
    return deny(
      'the uploader never confirms (decision 3)',
      'The person who uploaded a certificate cannot confirm it',
    );
  if (actsForOwner(actor, resource.ownerId)) return allow('a user for the owner');
  // M5 decision 7 (OQ-29): the company's nominated second approver confirms too.
  if (actor.nominatedApprover) return allow('the nominated approver');
  if (actor.role === 'agency_admin' && !resource.ownerHasUser)
    return allow('an agency admin, for an owner with no user');
  return deny(
    'not a user for this owner',
    resource.ownerHasUser
      ? 'A user for this owner confirms their certificates'
      : 'Only a user for this owner, or an agency admin, confirms this certificate',
  );
}

export function can(actor: Actor, action: PolicyAction, resource?: PolicyResource): Decision {
  switch (actor.kind) {
    case 'system':
      return deny('system actors act through jobs, not the policy layer');
    case 'tenant':
      if (action === 'session.manage_own') return allow('tenants manage their own sessions');
      // Only their own tenancies, which the tenancy module finds by person (TL-01, OQ-30).
      if (action === 'tenancy.view_own') return allow('tenants see their own tenancies');
      // M6: their own conversation with each landlord, and their own push devices.
      if (action === 'messaging.own') return allow('tenants use their own conversations');
      return deny('not available to tenants');
    case 'platform_admin':
      if (PLATFORM_ACTIONS.includes(action)) return allow('platform admin');
      return deny('platform admins see company data only under a support grant (M10)');
    case 'staff': {
      if (action === 'rules.view' || action === 'rules.add')
        return deny('rules are managed by platform admins');
      if (action === 'whatsapp_account.manage' || action === 'company.plan.manage')
        return deny('WhatsApp numbers and plans are managed by platform admins');
      if (
        action === 'approval.decide' ||
        action === 'approval.self_confirm' ||
        action === 'approval.cancel'
      ) {
        if (!resource || resource.kind === 'certificate')
          return deny('approval decisions need the request');
        const isInitiator = resource.initiatorPersonId === actor.personId;
        if (action === 'approval.decide') {
          if (isInitiator) return deny('the initiator can never approve (AD-05)');
          // A scoped person decides only requests about their properties; a company-level
          // request is for people who see the whole company (AD-02; M4a review 8).
          // Checked when the caller says where the request belongs (the approvals engine does).
          if (
            resource.propertyId !== undefined &&
            scopeOf(actor) !== null &&
            !(resource.propertyId && resource.scopeProperties?.includes(resource.propertyId))
          )
            return deny('the request is outside this person’s properties');
          return eligibleToApprove(actor, resource)
            ? allow('eligible approver')
            : deny('not an eligible approver for this action');
        }
        // Withdrawing a request and self-confirming after cooling off (OQ-29) are for the
        // initiator only; the approvals engine checks the mode and the time.
        return isInitiator ? allow('the initiator') : deny('only the initiator can do this');
      }
      if (action === 'approval.view' && actor.nominatedApprover) return allow('nominated approver');
      // M5 decision 7: a nominated approver confirms certificates whatever their role.
      if (
        action === 'withholding.confirm' &&
        actor.nominatedApprover &&
        resource?.kind === 'certificate'
      )
        return certificateDecision(actor, resource);
      const allowed = STAFF_MATRIX[action];
      if (!allowed.includes(staffKey(actor.role, actor.companyKind)))
        return deny(`${actor.role} may not ${action}`);
      if (action === 'audit.search' && scopeOf(actor) !== null)
        return deny('the audit log needs access to the whole company', AUDIT_NEEDS_WHOLE_COMPANY);
      if (action === 'withholding.confirm' && resource?.kind === 'certificate')
        return certificateDecision(actor, resource);
      return allow(`${actor.role} may ${action}`);
    }
  }
}

/** The owners and properties a scoped actor sees (AD-02). Matches the database's scope context. */
export interface ScopeIds {
  readonly ownerIds: readonly string[];
  readonly propertyIds: readonly string[];
}

/** Whether a membership's scope must, may or does not use a list (AD-02; M2 plan section 4.4). */
export type ScopeListUse = 'required' | 'optional' | 'unused';

export interface ScopeRule {
  readonly owners: ScopeListUse;
  readonly properties: ScopeListUse;
}

/**
 * Caretakers work on assigned properties only, never whole owners. An agency's client owners and
 * advisers always see through their owners, so they need at least one. Everyone else may be
 * limited either way, or not at all.
 */
export function scopeRuleFor(role: StaffRole, companyKind: CompanyKind): ScopeRule {
  if (role === 'caretaker') return { owners: 'unused', properties: 'required' };
  if (companyKind === 'agency' && (role === 'owner' || role === 'adviser'))
    return { owners: 'required', properties: 'optional' };
  return { owners: 'optional', properties: 'optional' };
}

/**
 * A scope as it is saved for a role: the lists the role needs are checked, lists it does not use
 * are dropped, and ids are sorted without repeats so equal scopes compare equal.
 */
export function checkMembershipScope(
  role: StaffRole,
  companyKind: CompanyKind,
  scope: MembershipScope,
): MembershipScope {
  const rule = scopeRuleFor(role, companyKind);
  const list = (use: ScopeListUse, ids: readonly string[] | undefined) =>
    use === 'unused' ? [] : [...new Set(ids ?? [])].sort();
  const owners = list(rule.owners, scope.owners);
  const properties = list(rule.properties, scope.properties);
  if (rule.owners === 'required' && owners.length === 0)
    throw new DomainError('scope.owners_required', 'Choose at least one owner for this person');
  if (rule.properties === 'required' && properties.length === 0)
    throw new DomainError(
      'scope.properties_required',
      'Choose at least one property for this caretaker',
    );
  return {
    ...(owners.length ? { owners } : {}),
    ...(properties.length ? { properties } : {}),
  };
}

/**
 * The part of its company an actor sees (AD-02; M2 plan section 4.4). Null means everything.
 * A role with a required list is scoped even before anything is assigned (then it sees nothing).
 * Others are scoped only when their membership names owners or properties.
 */
export function scopeOf(actor: Actor): ScopeIds | null {
  if (actor.kind !== 'staff') return null;
  const rule = scopeRuleFor(actor.role, actor.companyKind);
  const ownerIds = rule.owners === 'unused' ? [] : (actor.scope.owners ?? []);
  const propertyIds = rule.properties === 'unused' ? [] : (actor.scope.properties ?? []);
  const always = rule.owners === 'required' || rule.properties === 'required';
  return always || ownerIds.length > 0 || propertyIds.length > 0 ? { ownerIds, propertyIds } : null;
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
