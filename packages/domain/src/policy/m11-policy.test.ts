import { describe, expect, it } from 'vitest';
import { can, NEEDS_WHOLE_COMPANY, type Actor } from './policy';
import type { CompanyKind, StaffRole } from './roles';

const staff = (
  role: StaffRole,
  companyKind: CompanyKind,
  scope: { owners?: string[]; properties?: string[] } = {},
): Actor => ({
  kind: 'staff',
  personId: `p-${role}`,
  companyId: 'c-1',
  companyKind,
  membershipId: `m-${role}`,
  role,
  nominatedApprover: false,
  scope,
  authMethod: role === 'caretaker' ? 'phone_otp' : 'password_totp',
});

const M11_COMPANY_ACTIONS = [
  'onboarding.import',
  'data_protection.manage',
  'data_protection.export',
] as const;

describe('AD-02 M11 whole-company actions (plan 4.13)', () => {
  it('lets an unscoped manager import, but not a manager limited to some owners or properties', () => {
    expect(can(staff('property_manager', 'agency'), 'onboarding.import').allowed).toBe(true);
    for (const scope of [{ owners: ['o-1'] }, { properties: ['pr-1'] }]) {
      const refused = can(staff('property_manager', 'agency', scope), 'onboarding.import');
      expect(refused).toMatchObject({ allowed: false, message: NEEDS_WHOLE_COMPANY });
    }
  });

  it('refuses every M11 company action to a scoped agency admin', () => {
    for (const action of M11_COMPANY_ACTIONS) {
      expect(can(staff('agency_admin', 'agency'), action).allowed, action).toBe(true);
      expect(
        can(staff('agency_admin', 'agency', { owners: ['o-1'] }), action),
        action,
      ).toMatchObject({ allowed: false, message: NEEDS_WHOLE_COMPANY });
    }
  });

  it('keeps data protection for company admins: a manager handles none of it', () => {
    for (const action of ['data_protection.manage', 'data_protection.export'] as const) {
      expect(can(staff('owner', 'landlord'), action).allowed, action).toBe(true);
      expect(can(staff('property_manager', 'agency'), action).allowed, action).toBe(false);
      expect(can(staff('accountant', 'agency'), action).allowed, action).toBe(false);
    }
  });

  it('gives caretakers, advisers and an agency’s client owners none of them', () => {
    for (const action of M11_COMPANY_ACTIONS) {
      expect(can(staff('caretaker', 'agency', { properties: ['pr-1'] }), action).allowed).toBe(
        false,
      );
      expect(can(staff('adviser', 'agency'), action).allowed).toBe(false);
      expect(can(staff('owner', 'agency', { owners: ['o-1'] }), action).allowed).toBe(false);
    }
  });

  it('keeps replay and redrive for platform admins (M11 decision 9)', () => {
    const admin: Actor = {
      kind: 'platform_admin',
      personId: 'p-admin',
      companyId: 'c-platform',
      membershipId: 'm-admin',
      authMethod: 'password_totp',
    };
    for (const action of ['platform.ops.replay', 'platform.ops.redrive'] as const) {
      expect(can(admin, action).allowed).toBe(true);
      expect(can(staff('agency_admin', 'agency'), action).allowed).toBe(false);
      expect(
        can({ kind: 'tenant', personId: 'p-t', authMethod: 'phone_otp' }, action).allowed,
      ).toBe(false);
    }
  });
});
