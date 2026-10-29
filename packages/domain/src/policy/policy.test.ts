import { describe, expect, it } from 'vitest';
import { ROLE_NAMES } from '@rent/config/eslint/roles';
import {
  can,
  checkMembershipScope,
  POLICY_ACTIONS,
  scopeOf,
  scopeRuleFor,
  type Actor,
  type PolicyAction,
} from './policy';
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

/**
 * The matrices in docs/plans/M1.md section 4.6 and docs/plans/M2.md section 4.4. 1 = allowed.
 * Approval decisions are tested separately; scope is tested below.
 */
const MATRIX: Partial<Record<PolicyAction, string>> = {
  'owner.view': '11111010',
  'owner.manage': '10100000',
  'register.view': '11111110',
  'register.manage': '10110000',
  'register.import': '10110000',
  'unit.band_override': '10100000',
  'property_photo.view': '11111110',
  'property_paper.view': '11111010',
  'property_file.upload': '10110000',
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

describe('AD-02 scope', () => {
  const scoped = (column: Column, scope: { owners?: string[]; properties?: string[] }) => {
    const actor = actorFor(column);
    return actor.kind === 'staff' ? scopeOf({ ...actor, scope }) : scopeOf(actor);
  };

  it("limits an agency's client owners and advisers to their owners, even before one is assigned", () => {
    expect(scoped('owner_client', { owners: ['o1'] })).toEqual({
      ownerIds: ['o1'],
      propertyIds: [],
    });
    expect(scoped('adviser', {})).toEqual({ ownerIds: [], propertyIds: [] });
  });

  it('limits a caretaker to assigned properties and never to whole owners', () => {
    expect(scoped('caretaker', { properties: ['p1'], owners: ['o1'] })).toEqual({
      ownerIds: [],
      propertyIds: ['p1'],
    });
    expect(scoped('caretaker', {})).toEqual({ ownerIds: [], propertyIds: [] });
  });

  it('scopes others only when their membership names owners or properties', () => {
    expect(scoped('owner_own', {})).toBeNull();
    expect(scoped('agency_admin', {})).toBeNull();
    expect(scoped('property_manager', {})).toBeNull();
    expect(scoped('property_manager', { owners: ['o2'] })).toEqual({
      ownerIds: ['o2'],
      propertyIds: [],
    });
    expect(scopeOf(actorFor('platform_admin'))).toBeNull();
  });
});

describe('AD-02 required scopes', () => {
  it('needs a property for a caretaker and an owner for an agency client owner or adviser', () => {
    expect(scopeRuleFor('caretaker', 'agency')).toEqual({
      owners: 'unused',
      properties: 'required',
    });
    expect(scopeRuleFor('caretaker', 'landlord')).toEqual({
      owners: 'unused',
      properties: 'required',
    });
    for (const role of ['owner', 'adviser'] as const)
      expect(scopeRuleFor(role, 'agency')).toEqual({ owners: 'required', properties: 'optional' });
    for (const role of ['owner', 'agency_admin', 'property_manager', 'accountant'] as const)
      expect(scopeRuleFor(role, 'landlord')).toEqual({
        owners: 'optional',
        properties: 'optional',
      });
    expect(scopeRuleFor('property_manager', 'agency')).toEqual({
      owners: 'optional',
      properties: 'optional',
    });
  });

  it('refuses a scope that leaves out a required list', () => {
    expect(() => checkMembershipScope('caretaker', 'agency', { owners: ['o1'] })).toThrow(
      expect.objectContaining({ code: 'scope.properties_required' }),
    );
    expect(() => checkMembershipScope('adviser', 'agency', { properties: ['p1'] })).toThrow(
      expect.objectContaining({ code: 'scope.owners_required' }),
    );
    expect(() => checkMembershipScope('owner', 'agency', {})).toThrow(
      expect.objectContaining({ code: 'scope.owners_required' }),
    );
  });

  it('drops lists a role does not use and keeps ids sorted without repeats', () => {
    expect(
      checkMembershipScope('caretaker', 'agency', {
        owners: ['o1'],
        properties: ['p2', 'p1', 'p2'],
      }),
    ).toEqual({ properties: ['p1', 'p2'] });
    expect(
      checkMembershipScope('property_manager', 'agency', { owners: [], properties: [] }),
    ).toEqual({});
    expect(checkMembershipScope('adviser', 'agency', { owners: ['o2', 'o1'] })).toEqual({
      owners: ['o1', 'o2'],
    });
  });

  it('agrees with scopeOf: a role with a required list is scoped even when it is empty', () => {
    for (const column of COLUMNS) {
      const actor = actorFor(column);
      if (actor.kind !== 'staff') continue;
      const rule = scopeRuleFor(actor.role, actor.companyKind);
      const always = rule.owners === 'required' || rule.properties === 'required';
      expect(scopeOf({ ...actor, scope: {} }) !== null, column).toBe(always);
    }
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
