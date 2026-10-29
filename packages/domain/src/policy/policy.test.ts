import { describe, expect, it } from 'vitest';
import { ROLE_NAMES } from '@rent/config/eslint/roles';
import { can, POLICY_ACTIONS, type Actor, type PolicyAction } from './policy';
import { ALL_ROLES, roleUsableWith, type CompanyKind, type StaffRole } from './roles';

type Column =
  | 'owner_own'
  | 'owner_client'
  | 'agency_admin'
  | 'property_manager'
  | 'accountant'
  | 'caretaker'
  | 'adviser'
  | 'platform_admin';

const COLUMNS: Column[] = [
  'owner_own',
  'owner_client',
  'agency_admin',
  'property_manager',
  'accountant',
  'caretaker',
  'adviser',
  'platform_admin',
];

/** The matrix in docs/plans/M1.md section 4.6. 1 = allowed. Approval decisions are tested separately. */
const MATRIX: Partial<Record<PolicyAction, string>> = {
  'company.view': '11111110',
  'company.update': '10100000',
  'membership.view': '10110000',
  'membership.manage': '10100000',
  'audit.search': '10101000',
  'approval.view': '10111000',
  'session.manage_own': '11111111',
  'document.view': '11111110',
  'rules.view': '00000001',
  'rules.add': '00000001',
};

function actorFor(
  column: Column,
  extra: { nominatedApprover?: boolean; personId?: string } = {},
): Actor {
  if (column === 'platform_admin') {
    return {
      kind: 'platform_admin',
      personId: 'p-admin',
      companyId: 'c-platform',
      membershipId: 'm-admin',
      authMethod: 'password_totp',
    };
  }
  const role: StaffRole = column === 'owner_own' || column === 'owner_client' ? 'owner' : column;
  const companyKind: CompanyKind = column === 'owner_own' ? 'landlord' : 'agency';
  return {
    kind: 'staff',
    personId: extra.personId ?? `p-${column}`,
    companyId: 'c-1',
    companyKind,
    membershipId: `m-${column}`,
    role,
    nominatedApprover: extra.nominatedApprover ?? false,
    scope: {},
    authMethod: role === 'caretaker' ? 'phone_otp' : 'password_totp',
  };
}

describe('AD-03 policy matrix', () => {
  for (const [action, row] of Object.entries(MATRIX) as [PolicyAction, string][]) {
    COLUMNS.forEach((column, index) => {
      const expected = row[index] === '1';
      it(`${column} ${expected ? 'may' : 'may not'} ${action}`, () => {
        expect(can(actorFor(column), action).allowed).toBe(expected);
      });
    });
  }

  it('covers every action', () => {
    const tested = new Set([
      ...Object.keys(MATRIX),
      'approval.decide',
      'approval.self_confirm',
      'approval.cancel',
    ]);
    expect(POLICY_ACTIONS.filter((a) => !tested.has(a))).toEqual([]);
  });

  it('lets a nominated approver see approvals', () => {
    expect(can(actorFor('adviser', { nominatedApprover: true }), 'approval.view').allowed).toBe(
      true,
    );
  });

  it('denies everything company-scoped to tenants and system actors', () => {
    expect(
      can({ kind: 'tenant', personId: 't', authMethod: 'phone_otp' }, 'company.view').allowed,
    ).toBe(false);
    expect(can({ kind: 'system', companyId: 'c', job: 'x' }, 'company.view').allowed).toBe(false);
  });
});

describe('AD-05 approvals: the initiator can never approve', () => {
  const resource = {
    initiatorPersonId: 'p-agency_admin',
    eligibleRoles: ['agency_admin', 'property_manager'] as StaffRole[],
  };

  it('denies the initiator, whatever their role', () => {
    expect(can(actorFor('agency_admin'), 'approval.decide', resource).allowed).toBe(false);
    expect(
      can(actorFor('agency_admin', { nominatedApprover: true }), 'approval.decide', resource)
        .allowed,
    ).toBe(false);
  });

  it('allows an eligible second person and a nominated approver, and no one else', () => {
    expect(can(actorFor('property_manager'), 'approval.decide', resource).allowed).toBe(true);
    expect(
      can(actorFor('adviser', { nominatedApprover: true }), 'approval.decide', resource).allowed,
    ).toBe(true);
    expect(can(actorFor('accountant'), 'approval.decide', resource).allowed).toBe(false);
    expect(
      can(actorFor('owner_client'), 'approval.decide', { ...resource, eligibleRoles: ['owner'] })
        .allowed,
    ).toBe(false);
    expect(can(actorFor('agency_admin'), 'approval.decide').allowed).toBe(false);
  });

  it('reserves self-confirmation and withdrawal for the initiator', () => {
    expect(can(actorFor('agency_admin'), 'approval.self_confirm', resource).allowed).toBe(true);
    expect(can(actorFor('property_manager'), 'approval.self_confirm', resource).allowed).toBe(
      false,
    );
    expect(can(actorFor('agency_admin'), 'approval.cancel', resource).allowed).toBe(true);
    expect(can(actorFor('property_manager'), 'approval.cancel', resource).allowed).toBe(false);
  });
});

describe('AD-06 sign-in method per role', () => {
  it('lets a phone-code session carry only phone roles', () => {
    expect(roleUsableWith('caretaker', 'phone_otp')).toBe(true);
    expect(roleUsableWith('property_manager', 'phone_otp')).toBe(false);
    expect(roleUsableWith('platform_admin', 'phone_otp')).toBe(false);
    expect(roleUsableWith('property_manager', 'password_totp')).toBe(true);
  });
});

describe('AD-03 role list', () => {
  it('matches the list the no-role-checks lint rule uses', () => {
    expect([...ALL_ROLES].sort()).toEqual([...ROLE_NAMES].sort());
  });
});
