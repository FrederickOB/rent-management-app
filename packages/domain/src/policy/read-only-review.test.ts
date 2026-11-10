import { describe, expect, it } from 'vitest';
import { can, POLICY_ACTIONS, type Actor } from './policy';
import { STAFF_ROLES, type CompanyKind } from './roles';
import {
  keptStep,
  READ_ONLY_ALLOWED,
  READ_ONLY_KEPT_STEPS,
  SUBSCRIPTION_ENDED_MESSAGE,
  SUBSCRIPTION_READ_ONLY_CODE,
  SUBSCRIPTION_READ_ONLY_MESSAGE,
  type ReadOnlyKeptStep,
} from '../subscription/read-only';

/**
 * M10 review: the steps that stay open while a company is read-only although their action is a
 * change in general (BE-18: removing a member; BE-24: refreshing the dashboard), and the refusal's
 * words once the subscription has ended (BE-27, decision 12). The allowlist itself is unchanged
 * (read-only.test.ts).
 */
type Staff = Extract<Actor, { kind: 'staff' }>;

const STAFF: Staff[] = STAFF_ROLES.flatMap((role) =>
  (['landlord', 'agency'] as CompanyKind[]).map((companyKind): Staff => ({
    kind: 'staff',
    personId: `p-${role}-${companyKind}`,
    companyId: 'c-1',
    companyKind,
    membershipId: `m-${role}-${companyKind}`,
    role,
    nominatedApprover: false,
    scope: {},
    authMethod: role === 'caretaker' ? 'phone_otp' : 'password_totp',
  })),
);

const STEPS = Object.keys(READ_ONLY_KEPT_STEPS) as ReadOnlyKeptStep[];
const readOnly = (s: Staff): Staff => ({ ...s, subscriptionAccess: 'read_only' });
const ended = (s: Staff): Staff => ({
  ...s,
  subscriptionAccess: 'read_only',
  subscriptionEnded: true,
});

describe('BE-18 BE-24 PB-11 steps kept open while read-only', () => {
  it('judges each kept step by the role alone: the same answer as at full access, for every role', () => {
    for (const step of STEPS)
      for (const staff of STAFF)
        for (const actor of [staff, readOnly(staff), ended(staff)]) {
          const judged = keptStep(actor, step);
          expect(judged.action, step).toBe(READ_ONLY_KEPT_STEPS[step]);
          expect(can(judged.actor, judged.action), `${step} ${staff.role}`).toEqual(
            can(staff, READ_ONLY_KEPT_STEPS[step]),
          );
        }
  });

  it('never widens a role: who may not remove members or refresh still may not', () => {
    const caretaker = STAFF.find((s) => s.role === 'caretaker')!;
    const accountant = STAFF.find((s) => s.role === 'accountant')!;
    for (const actor of [readOnly(caretaker), readOnly(accountant)]) {
      const removal = keptStep(actor, 'membership.revoke');
      expect(can(removal.actor, removal.action).allowed).toBe(false);
    }
    const refresh = keptStep(readOnly(caretaker), 'dashboard.refresh');
    expect(can(refresh.actor, refresh.action).allowed).toBe(false);
  });

  it('keeps removing a member and refreshing open while inviting and other changes stay paused', () => {
    const admin = readOnly(STAFF.find((s) => s.role === 'agency_admin')!);
    const removal = keptStep(admin, 'membership.revoke');
    expect(can(removal.actor, removal.action).allowed).toBe(true);
    // Inviting and role changes ask membership.manage for the actor as it is: still paused.
    expect(can(admin, 'membership.manage')).toMatchObject({
      allowed: false,
      code: SUBSCRIPTION_READ_ONLY_CODE,
    });
    const manager = readOnly(STAFF.find((s) => s.role === 'property_manager')!);
    const refresh = keptStep(manager, 'dashboard.refresh');
    expect(can(refresh.actor, refresh.action).allowed).toBe(true);
    expect(can(manager, 'lease.manage').code).toBe(SUBSCRIPTION_READ_ONLY_CODE);
  });

  it('passes anyone but a read-only staff member through unchanged', () => {
    const full = STAFF[0]!;
    const tenant: Actor = { kind: 'tenant', personId: 'p-t', authMethod: 'phone_otp' };
    const platformAdmin: Actor = {
      kind: 'platform_admin',
      personId: 'p-a',
      companyId: 'c-platform',
      membershipId: 'm-a',
      authMethod: 'password_totp',
    };
    const job: Actor = { kind: 'system', companyId: 'c-1', job: 'test' };
    for (const actor of [full, tenant, platformAdmin, job])
      expect(keptStep(actor, 'membership.revoke').actor).toBe(actor);
    // The read-only actor itself is never changed.
    const actor = readOnly(full);
    keptStep(actor, 'dashboard.refresh');
    expect(actor.subscriptionAccess).toBe('read_only');
  });

  it('adds no action to the allowlist', () => {
    for (const action of Object.values(READ_ONLY_KEPT_STEPS))
      expect(READ_ONLY_ALLOWED.includes(action), action).toBe(false);
  });
});

describe('BE-27 PB-10 the refusal once a subscription has ended (decision 12)', () => {
  it('says the subscription has ended, with the same code, and never says past due', () => {
    const manager = STAFF.find((s) => s.role === 'property_manager')!;
    const refused = can(ended(manager), 'lease.manage');
    expect(refused).toMatchObject({
      allowed: false,
      code: SUBSCRIPTION_READ_ONLY_CODE,
      message: SUBSCRIPTION_ENDED_MESSAGE,
    });
    expect(refused.message!.toLowerCase()).not.toContain('past due');
    expect(SUBSCRIPTION_ENDED_MESSAGE).toContain('has ended');
    // Past due keeps its own words.
    expect(can(readOnly(manager), 'lease.manage').message).toBe(SUBSCRIPTION_READ_ONLY_MESSAGE);
  });

  it('changes only the words: every action is allowed or refused as for a past-due company', () => {
    for (const staff of STAFF)
      for (const action of POLICY_ACTIONS) {
        const pastDue = can(readOnly(staff), action);
        const after = can(ended(staff), action);
        expect(after.allowed, `${staff.role} ${action}`).toBe(pastDue.allowed);
        expect(after.code, `${staff.role} ${action}`).toBe(pastDue.code);
      }
  });

  it('means nothing without read-only access', () => {
    const manager = STAFF.find((s) => s.role === 'property_manager')!;
    expect(can({ ...manager, subscriptionEnded: true }, 'lease.manage').allowed).toBe(true);
  });
});
