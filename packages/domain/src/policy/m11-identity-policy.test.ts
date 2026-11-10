import { describe, expect, it } from 'vitest';
import {
  can,
  narrowsApproverSet,
  NEEDS_WHOLE_COMPANY,
  TWO_PERSON_APPROVER_ROLES,
  widensApproverSet,
  type Actor,
} from './policy';
import { roleUsableWith } from './roles';

type Staff = Extract<Actor, { kind: 'staff' }>;

const admin = (scope: Staff['scope'], companyKind: Staff['companyKind'] = 'agency'): Staff => ({
  kind: 'staff',
  personId: 'p-admin',
  companyId: 'c1',
  companyKind,
  membershipId: 'm-admin',
  role: companyKind === 'agency' ? 'agency_admin' : 'owner',
  nominatedApprover: false,
  scope,
  authMethod: 'password_totp',
});

describe('AD-02 M11 security review R2 F1: company-wide admin needs the whole company', () => {
  const actions = [
    'company.update',
    'support.grant',
    'subscription.manage',
    'notices.quit.acknowledge',
    'settlement_account.change_agency',
  ] as const;

  it('refuses them to an admin limited to some owners or properties', () => {
    for (const companyKind of ['agency', 'landlord'] as const)
      for (const scope of [{ owners: ['o1'] }, { properties: ['p1'] }])
        for (const action of actions)
          expect(can(admin(scope, companyKind), action), `${companyKind} ${action}`).toMatchObject({
            allowed: false,
            message: NEEDS_WHOLE_COMPANY,
          });
  });

  it('keeps them for an admin who sees the whole company', () => {
    for (const companyKind of ['agency', 'landlord'] as const)
      for (const action of actions)
        expect(can(admin({}, companyKind), action).allowed, `${companyKind} ${action}`).toBe(true);
  });

  it('leaves an owner settlement account to a scoped admin (their owners are checked by RLS)', () => {
    expect(can(admin({ owners: ['o1'] }), 'settlement_account.change').allowed).toBe(true);
  });
});

describe('AD-06 M11 security review R1 F3: each role only with its own sign-in method', () => {
  it('never lets a password session act as a caretaker, nor a phone session with a password role', () => {
    expect(roleUsableWith('caretaker', 'password_totp')).toBe(false);
    expect(roleUsableWith('caretaker', 'phone_otp')).toBe(true);
    for (const role of [
      'owner',
      'agency_admin',
      'property_manager',
      'accountant',
      'adviser',
      'platform_admin',
    ] as const) {
      expect(roleUsableWith(role, 'password_totp'), role).toBe(true);
      expect(roleUsableWith(role, 'phone_otp'), role).toBe(false);
    }
  });
});

describe('AD-06 M11 founder D4: recovery actions are for platform admins only', () => {
  it('allows them to a platform admin and to nobody in a company', () => {
    const platform: Actor = {
      kind: 'platform_admin',
      personId: 'p-pa',
      companyId: 'c-platform',
      membershipId: 'm-pa',
      authMethod: 'password_totp',
    };
    for (const action of ['person.two_factor.reset', 'person.sessions.revoke'] as const) {
      expect(can(platform, action).allowed, action).toBe(true);
      expect(can(admin({}), action).allowed, action).toBe(false);
      expect(
        can({ kind: 'tenant', personId: 'p-t', authMethod: 'phone_otp' }, action).allowed,
      ).toBe(false);
    }
  });
});

describe('AD-05 M11 founder D1: what widens and narrows the approver set', () => {
  const as = (
    role: Staff['role'],
    nominatedApprover = false,
    companyKind: Staff['companyKind'] = 'agency',
  ) => ({ role, nominatedApprover, companyKind });

  it('treats an invite, promotion, nomination or a role change into an approver role as widening', () => {
    expect(widensApproverSet(null, as('property_manager'))).toBe(true);
    expect(widensApproverSet(null, as('caretaker'))).toBe(false);
    expect(widensApproverSet(null, as('owner'))).toBe(false); // an agency's client owner
    expect(widensApproverSet(null, as('owner', false, 'landlord'))).toBe(true);
    expect(widensApproverSet(as('adviser'), as('accountant'))).toBe(true);
    expect(widensApproverSet(as('accountant'), as('property_manager'))).toBe(true);
    expect(widensApproverSet(as('caretaker'), as('caretaker', true))).toBe(true);
    expect(widensApproverSet(as('accountant'), as('accountant'))).toBe(false);
    expect(widensApproverSet(as('accountant', true), as('accountant'))).toBe(false);
  });

  it('treats a removal, a demotion out of the approver roles or an un-nomination as narrowing', () => {
    expect(narrowsApproverSet(as('accountant'), null)).toBe(true);
    expect(narrowsApproverSet(as('caretaker'), null)).toBe(false);
    expect(narrowsApproverSet(as('property_manager'), as('caretaker'))).toBe(true);
    expect(narrowsApproverSet(as('accountant', true), as('accountant'))).toBe(true);
    expect(narrowsApproverSet(as('accountant'), as('property_manager'))).toBe(false);
  });

  it('names every role an approval handler may use', () => {
    expect([...TWO_PERSON_APPROVER_ROLES].sort()).toEqual([
      'accountant',
      'agency_admin',
      'owner',
      'property_manager',
    ]);
  });
});
