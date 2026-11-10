import { describe, expect, it } from 'vitest';
import {
  allowedWhileReadOnly,
  READ_ONLY_ALLOWED,
  READ_ONLY_MONEY_IN_APPROVALS,
  SUBSCRIPTION_READ_ONLY_CODE,
  SUBSCRIPTION_READ_ONLY_MESSAGE,
} from '../subscription/read-only';
import { can, POLICY_ACTIONS, type Actor, type PolicyAction, type PolicyResource } from './policy';
import { STAFF_ROLES, type CompanyKind } from './roles';

/**
 * Every policy action, classified for a company whose subscription is read-only (M10 decision 11,
 * PB-11). A new action fails this file (and the typecheck) until someone classifies it here.
 * `allowed`: staff keep it; `refused`: a change, paused; `money_in`: an approval step that stays
 * open only for a request recording money received (a cash receipt).
 */
const EXPECTED: Record<PolicyAction, 'allowed' | 'refused' | 'money_in'> = {
  'company.view': 'allowed',
  'company.update': 'refused',
  'membership.view': 'allowed',
  'membership.manage': 'refused',
  'audit.search': 'allowed',
  'approval.view': 'allowed',
  'approval.decide': 'money_in',
  'approval.self_confirm': 'money_in',
  'approval.cancel': 'money_in',
  'session.manage_own': 'allowed',
  'document.view': 'allowed',
  'rules.view': 'allowed',
  'rules.add': 'refused',
  'owner.view': 'allowed',
  'owner.manage': 'refused',
  'register.view': 'allowed',
  'register.manage': 'refused',
  'register.import': 'refused',
  'unit.band_override': 'refused',
  'property_photo.view': 'allowed',
  'property_paper.view': 'allowed',
  'property_file.upload': 'refused',
  'tenant.view': 'allowed',
  'tenant.view_details': 'allowed',
  'tenant.manage': 'refused',
  'tenant.id.verify': 'refused',
  'tenant.id.reveal': 'allowed',
  'lease.view': 'allowed',
  'lease.view_terms': 'allowed',
  'lease.manage': 'refused',
  'lease.cancel_signed': 'refused',
  'lease_template.manage': 'refused',
  'tenancy.view_own': 'allowed',
  'billing.view': 'allowed',
  'billing.manage': 'refused',
  'payment.record': 'allowed',
  'payment.record_transfer': 'allowed',
  'cash.bank': 'allowed',
  'cash.bank_others': 'allowed',
  'cash.view_own': 'allowed',
  'payments.view': 'allowed',
  'payments.match': 'allowed',
  'settlement_account.change': 'refused',
  'payment.refund_unmatched': 'refused',
  'settlement_account.reveal': 'allowed',
  'tax.manage': 'refused',
  'withholding.confirm': 'refused',
  'messaging.inbox.read': 'allowed',
  'messaging.reply': 'refused',
  'messaging.assign': 'refused',
  'messaging.triage': 'refused',
  'messaging.broadcast': 'refused',
  'messaging.templates.read': 'allowed',
  'tenant_group.manage': 'refused',
  'messaging.own': 'allowed',
  'whatsapp_account.manage': 'refused',
  'company.plan.manage': 'refused',
  'maintenance.view': 'allowed',
  'notices.read': 'allowed',
  'notices.draft': 'refused',
  'notices.issue': 'refused',
  'notices.approve_quit': 'refused',
  'notices.ladder.control': 'refused',
  'notices.service.record': 'allowed',
  'notices.close': 'refused',
  'notices.quit.acknowledge': 'refused',
  'rent_assessment.record': 'refused',
  'tasks.read': 'allowed',
  'tasks.complete': 'refused',
  'tasks.manage': 'refused',
  'maintenance.read': 'allowed',
  'maintenance.report': 'refused',
  'maintenance.manage': 'refused',
  'maintenance.attend': 'refused',
  'maintenance.alert': 'allowed',
  'artisan.manage': 'refused',
  'inspection.read': 'allowed',
  'inspection.perform': 'refused',
  'moveout.manage': 'refused',
  'moveout.settle': 'refused',
  'expense.read': 'allowed',
  'expense.record': 'refused',
  'statements.read': 'allowed',
  'statements.issue': 'refused',
  'remittance.record': 'refused',
  'fees.manage': 'refused',
  'dashboard.read': 'allowed',
  'compliance.read': 'allowed',
  'metrics.platform.read': 'allowed',
  'subscription.read': 'allowed',
  'subscription.manage': 'allowed',
  'support.grant': 'allowed',
  'company.create': 'refused',
  'company.manage': 'refused',
  'pricing.manage': 'refused',
  'discount.manage': 'refused',
  'support.use': 'refused',
  'usage.read': 'allowed',
  'health.read': 'allowed',
  'onboarding.import': 'refused',
  'data_protection.manage': 'allowed',
  'data_protection.export': 'allowed',
  'platform.ops.replay': 'refused',
  'platform.ops.redrive': 'refused',
  'settlement_account.change_agency': 'refused',
  'person.two_factor.reset': 'refused',
  'person.sessions.revoke': 'refused',
};

type Staff = Extract<Actor, { kind: 'staff' }>;

/** Every staff role in a landlord's and an agency's company, nominated as approver or not. */
const STAFF: Staff[] = STAFF_ROLES.flatMap((role) =>
  (['landlord', 'agency'] as CompanyKind[]).flatMap((companyKind) =>
    [false, true].map((nominatedApprover): Staff => ({
      kind: 'staff',
      personId: `p-${role}-${companyKind}`,
      companyId: 'c-1',
      companyKind,
      membershipId: `m-${role}-${companyKind}`,
      role,
      nominatedApprover,
      scope: {},
      authMethod: role === 'caretaker' ? 'phone_otp' : 'password_totp',
    })),
  ),
);

/** No resource, approvals by someone else or by the actor, with and without money in, and the rest. */
const resourcesFor = (actor: Staff): (PolicyResource | undefined)[] => {
  const approval = (initiatorPersonId: string, recordsMoneyIn?: boolean): PolicyResource => ({
    kind: 'approval',
    initiatorPersonId,
    eligibleRoles: [...STAFF_ROLES],
    ...(recordsMoneyIn === undefined ? {} : { recordsMoneyIn }),
  });
  return [
    undefined,
    approval('p-someone-else'),
    approval('p-someone-else', false),
    approval('p-someone-else', true),
    approval(actor.personId, true),
    approval(actor.personId, false),
    { kind: 'certificate', ownerId: 'o-1', uploadedBy: 'p-someone-else', ownerHasUser: false },
    { kind: 'task', assigneePersonId: actor.personId },
  ];
};

const READ_ONLY_REFUSAL = {
  allowed: false,
  reason: 'the subscription is read-only (PB-11)',
  code: SUBSCRIPTION_READ_ONLY_CODE,
  message: SUBSCRIPTION_READ_ONLY_MESSAGE,
};

describe('PB-11 read-only allowlist', () => {
  it('classifies every policy action', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...POLICY_ACTIONS].sort());
    expect(new Set(READ_ONLY_ALLOWED).size).toBe(READ_ONLY_ALLOWED.length);
    for (const action of POLICY_ACTIONS) {
      expect(READ_ONLY_ALLOWED.includes(action), action).toBe(EXPECTED[action] === 'allowed');
      expect(READ_ONLY_MONEY_IN_APPROVALS.includes(action), action).toBe(
        EXPECTED[action] === 'money_in',
      );
      expect(allowedWhileReadOnly(action), action).toBe(EXPECTED[action] === 'allowed');
    }
  });

  it('keeps every action on the list as full access has it, and refuses the rest with its own code', () => {
    for (const action of POLICY_ACTIONS)
      for (const actor of STAFF)
        for (const resource of resourcesFor(actor)) {
          const full = can(actor, action, resource);
          expect(can({ ...actor, subscriptionAccess: 'full' }, action, resource)).toEqual(full);
          const readOnly = can({ ...actor, subscriptionAccess: 'read_only' }, action, resource);
          const label = `${actor.role}/${actor.companyKind}${actor.nominatedApprover ? '/nominated' : ''} ${action}`;
          // Read-only never allows what full access refuses, and never rewrites a refusal.
          if (!full.allowed) {
            expect(readOnly, label).toEqual(full);
            continue;
          }
          const moneyIn =
            resource !== undefined &&
            resource.kind !== 'certificate' &&
            resource.kind !== 'task' &&
            resource.recordsMoneyIn === true;
          const kept =
            EXPECTED[action] === 'allowed' || (EXPECTED[action] === 'money_in' && moneyIn);
          expect(readOnly, label).toEqual(kept ? full : READ_ONLY_REFUSAL);
        }
  });

  it('refuses a change in plain words, with the code the API maps to 403 SUBSCRIPTION_READ_ONLY', () => {
    const manager = {
      ...STAFF.find((s) => s.role === 'property_manager')!,
      subscriptionAccess: 'read_only' as const,
    };
    const decision = can(manager, 'lease.manage');
    expect(decision).toEqual(READ_ONLY_REFUSAL);
    expect(decision.message).toBe(
      'Your subscription is past due, so changes are paused. Nothing was changed. Tenants can still pay and get receipts. Paying the subscription restores access at once.',
    );
    expect(can({ ...manager, subscriptionAccess: 'full' }, 'lease.manage').allowed).toBe(true);
  });

  it('still records money received and its receipt, and the service of notices already issued', () => {
    const caretaker = {
      ...STAFF.find((s) => s.role === 'caretaker' && s.companyKind === 'agency')!,
      subscriptionAccess: 'read_only' as const,
    };
    for (const action of [
      'payment.record',
      'cash.bank',
      'notices.service.record',
      'session.manage_own',
    ] as const)
      expect(can(caretaker, action).allowed, action).toBe(true);
    const accountant = {
      ...STAFF.find((s) => s.role === 'accountant')!,
      subscriptionAccess: 'read_only' as const,
    };
    for (const action of ['payment.record_transfer', 'payments.match', 'cash.bank_others'] as const)
      expect(can(accountant, action).allowed, action).toBe(true);
  });

  it('lets a landlord pay the subscription, export and grant support access while read-only', () => {
    const landlord = {
      ...STAFF.find((s) => s.role === 'owner' && s.companyKind === 'landlord')!,
      subscriptionAccess: 'read_only' as const,
    };
    for (const action of ['subscription.read', 'subscription.manage', 'support.grant'] as const)
      expect(can(landlord, action).allowed, action).toBe(true);
    expect(can(landlord, 'company.update').code).toBe(SUBSCRIPTION_READ_ONLY_CODE);
  });

  it('keeps a cash receipt’s approval open, and pauses every other approval', () => {
    const admin = {
      ...STAFF.find((s) => s.role === 'agency_admin' && !s.nominatedApprover)!,
      subscriptionAccess: 'read_only' as const,
    };
    const request = { initiatorPersonId: 'p-other', eligibleRoles: ['agency_admin' as const] };
    expect(can(admin, 'approval.decide', { ...request, recordsMoneyIn: true }).allowed).toBe(true);
    expect(can(admin, 'approval.decide', request)).toEqual(READ_ONLY_REFUSAL);
    // The initiator can still never approve, money in or not (AD-05).
    expect(
      can(admin, 'approval.decide', {
        ...request,
        initiatorPersonId: admin.personId,
        recordsMoneyIn: true,
      }).allowed,
    ).toBe(false);
  });

  it('never touches tenants, system jobs or platform admins', () => {
    const tenant: Actor = { kind: 'tenant', personId: 't-1', authMethod: 'phone_otp' };
    const system: Actor = { kind: 'system', companyId: 'c-1', job: 'billing.accrue' };
    const platformAdmin: Actor = {
      kind: 'platform_admin',
      personId: 'p-admin',
      companyId: 'c-platform',
      membershipId: 'm-admin',
      authMethod: 'password_totp',
    };
    for (const actor of [tenant, system, platformAdmin]) {
      // Only staff carry the company's access; even if a caller attached it, nothing changes.
      expect('subscriptionAccess' in actor).toBe(false);
      const smuggled = { ...actor, subscriptionAccess: 'read_only' } as unknown as Actor;
      for (const action of POLICY_ACTIONS)
        expect(can(smuggled, action), action).toEqual(can(actor, action));
    }
    // A tenant still sees their tenancies and uses their conversations.
    expect(can(tenant, 'tenancy.view_own').allowed).toBe(true);
    expect(can(tenant, 'messaging.own').allowed).toBe(true);
  });

  it('gives only staff actors a subscription access to carry (type level)', () => {
    const tenant: Actor = {
      kind: 'tenant',
      personId: 't-1',
      authMethod: 'phone_otp',
      // @ts-expect-error: tenants are never judged on a company's subscription.
      subscriptionAccess: 'read_only',
    };
    expect(tenant.kind).toBe('tenant');
  });
});
