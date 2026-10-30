import { describe, expect, it } from 'vitest';
import { isPayable, leasePickLabel, pickedLeaseOf } from './lease-pick';

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
