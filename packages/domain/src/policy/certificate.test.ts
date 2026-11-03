import { describe, expect, it } from 'vitest';
import { actsForOwner, can, type Actor, type CertificateResource } from './policy';
import type { CompanyKind, StaffRole } from './roles';

const staff = (
  role: StaffRole,
  companyKind: CompanyKind,
  personId: string,
  owners?: string[],
): Actor => ({
  kind: 'staff',
  personId,
  companyId: 'c-1',
  companyKind,
  membershipId: `m-${personId}`,
  role,
  nominatedApprover: false,
  scope: owners ? { owners } : {},
  authMethod: 'password_totp',
});

const certificate = (over: Partial<CertificateResource> = {}): CertificateResource => ({
  kind: 'certificate',
  ownerId: 'o-1',
  uploadedBy: 'p-manager',
  ownerHasUser: true,
  ...over,
});

describe('TX-04 who confirms a withholding certificate (decision 3)', () => {
  it('lets a user for the owner confirm, in an agency or their own company', () => {
    expect(
      can(staff('owner', 'agency', 'p-owner', ['o-1']), 'withholding.confirm', certificate())
        .allowed,
    ).toBe(true);
    expect(
      can(staff('owner', 'landlord', 'p-landlord'), 'withholding.confirm', certificate()).allowed,
    ).toBe(true);
  });

  it('refuses another owner’s client, and an agency admin while the owner has a user', () => {
    expect(
      can(staff('owner', 'agency', 'p-other', ['o-2']), 'withholding.confirm', certificate())
        .allowed,
    ).toBe(false);
    const admin = can(
      staff('agency_admin', 'agency', 'p-admin'),
      'withholding.confirm',
      certificate(),
    );
    expect(admin.allowed).toBe(false);
    expect(admin.message).toMatch(/user for this owner/);
  });

  it('lets an agency admin confirm for an owner with no user', () => {
    expect(
      can(
        staff('agency_admin', 'agency', 'p-admin'),
        'withholding.confirm',
        certificate({ ownerHasUser: false }),
      ).allowed,
    ).toBe(true);
  });

  it('never lets the uploader confirm, whoever they are', () => {
    const decision = can(
      staff('agency_admin', 'agency', 'p-admin'),
      'withholding.confirm',
      certificate({ uploadedBy: 'p-admin', ownerHasUser: false }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.message).toMatch(/uploaded a certificate cannot confirm/);
    expect(
      can(
        staff('owner', 'agency', 'p-owner', ['o-1']),
        'withholding.confirm',
        certificate({ uploadedBy: 'p-owner' }),
      ).allowed,
    ).toBe(false);
  });

  it('never lets managers, accountants or caretakers confirm', () => {
    for (const role of ['property_manager', 'accountant', 'caretaker', 'adviser'] as const)
      expect(
        can(
          staff(role, 'agency', `p-${role}`),
          'withholding.confirm',
          certificate({ ownerHasUser: false }),
        ).allowed,
        role,
      ).toBe(false);
  });

  it('knows who is a user for an owner', () => {
    expect(actsForOwner(staff('owner', 'agency', 'a', ['o-1']), 'o-1')).toBe(true);
    expect(actsForOwner(staff('owner', 'agency', 'a', ['o-2']), 'o-1')).toBe(false);
    expect(actsForOwner(staff('owner', 'landlord', 'a'), 'o-1')).toBe(true);
    expect(actsForOwner(staff('agency_admin', 'agency', 'a'), 'o-1')).toBe(false);
  });
});
