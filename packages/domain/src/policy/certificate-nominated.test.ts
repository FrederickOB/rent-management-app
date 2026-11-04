import { describe, expect, it } from 'vitest';
import { can, type Actor, type CertificateResource } from './policy';

/** M5 decision 7 (founder, 2026-11-03; OQ-29): a nominated second approver confirms certificates. */
const nominated = (personId: string): Actor => ({
  kind: 'staff',
  personId,
  companyId: 'c-1',
  companyKind: 'landlord',
  membershipId: `m-${personId}`,
  role: 'adviser',
  nominatedApprover: true,
  scope: {},
  authMethod: 'password_totp',
});
const certificate: CertificateResource = {
  kind: 'certificate',
  ownerId: 'o-1',
  uploadedBy: 'p-landlord',
  ownerHasUser: true,
};

describe('TX-04 a nominated approver confirms a certificate (M5 decision 7)', () => {
  it('lets the nominated approver confirm whatever their role, never their own upload', () => {
    expect(can(nominated('p-approver'), 'withholding.confirm', certificate).allowed).toBe(true);
    expect(
      can(nominated('p-approver'), 'withholding.confirm', {
        ...certificate,
        uploadedBy: 'p-approver',
      }).allowed,
    ).toBe(false);
    // Without the certificate the matrix applies: an adviser is not a confirmer by role.
    expect(can(nominated('p-approver'), 'withholding.confirm').allowed).toBe(false);
  });
});
