import { describe, expect, it } from 'vitest';
import {
  isPayable,
  leasePickLabel,
  ownerAccountOf,
  pickedLeaseOf,
  uniqueLeases,
} from './lease-pick';

const LEASE = '019a3000-0000-7000-8000-0000000000d1';
const UNIT = '019a3000-0000-7000-8000-0000000000d2';
const TENANT = '019a3000-0000-7000-8000-0000000000d3';

describe('BC-05 choosing the lease cash is for', () => {
  it('names a lease by unit, tenant and state for staff, and by unit and state for a caretaker', () => {
    const full = pickedLeaseOf({
      access: 'full',
      id: LEASE,
      status: 'active',
      unit: { id: UNIT, code: 'ACC-LEG-B1-01' },
      propertyName: 'Legon compound house (demo)',
      tenant: { id: TENANT, displayName: 'Kwame Monthly (demo)' },
      startDate: '2026-07-30',
      endDate: '2027-07-29',
      monthlyRentMinor: 80_000,
      cycle: 'monthly',
      signedOnPaper: true,
      advanceFlagged: false,
    });
    expect(leasePickLabel(full)).toBe('ACC-LEG-B1-01 · Kwame Monthly (demo) · Active');
    expect(full.propertyName).toBe('Legon compound house (demo)');
    const limited = pickedLeaseOf({
      access: 'limited',
      id: LEASE,
      status: 'holding_over',
      unit: { id: UNIT, code: 'ACC-LEG-B1-01' },
      startDate: '2025-07-30',
      endDate: '2026-07-29',
    });
    expect(leasePickLabel(limited)).toBe('ACC-LEG-B1-01 · Holding over');
    expect(limited.tenantName).toBeNull();
  });

  it('offers signed leases, started or ended, but not drafts or cancelled ones', () => {
    expect(isPayable('active')).toBe(true);
    expect(isPayable('ended')).toBe(true);
    expect(isPayable('signed')).toBe(true);
    expect(isPayable('draft')).toBe(false);
    expect(isPayable('pending_signatures')).toBe(false);
    expect(isPayable('cancelled')).toBe(false);
  });
});

describe('P23 matching money in an owner’s account to that owner’s leases', () => {
  it('limits the match to the owner whose account holds the money, and not for the agency’s', () => {
    const OWNER = '019a3000-0000-7000-8000-0000000000b1';
    expect(
      ownerAccountOf({ receivedInto: 'owner_account', ownerId: OWNER, ownerName: 'Ama (demo)' }),
    ).toEqual({ ownerId: OWNER, ownerName: 'Ama (demo)' });
    expect(
      ownerAccountOf({ receivedInto: 'agency_account', ownerId: null, ownerName: null }),
    ).toBeNull();
    expect(
      ownerAccountOf({ receivedInto: 'owner_account', ownerId: null, ownerName: null }),
    ).toBeNull();
  });

  it('reads it from a payment’s own detail, where money taken another way has no owner account', () => {
    const OWNER = '019a3000-0000-7000-8000-0000000000b1';
    expect(
      ownerAccountOf({ receivedInto: 'provider', ownerId: OWNER, ownerName: 'Ama (demo)' }),
    ).toBeNull();
    expect(
      ownerAccountOf({ receivedInto: 'collector', ownerId: OWNER, ownerName: 'Ama (demo)' }),
    ).toBeNull();
  });

  it('lists each lease once when an owner’s leases are gathered property by property', () => {
    const lease = (id: string) => ({
      id,
      unitCode: `ACC-LEG-B1-0${id}`,
      status: 'active' as const,
      tenantName: null,
      propertyName: null,
    });
    expect(uniqueLeases([lease('1'), lease('2'), lease('1')]).map((l) => l.id)).toEqual(['1', '2']);
  });
});
