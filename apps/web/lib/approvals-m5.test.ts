import { describe, expect, it } from 'vitest';
import {
  approvalActionLabel,
  approvalEvidence,
  approvalFacts,
  approvalWarning,
  MONEY_ACTIONS,
  payloadSubject,
  subjectHref,
} from './approvals';

const LEASE = '019a3000-0000-7000-8000-0000000000e2';
const WITHHOLDING = '019a3000-0000-7000-8000-0000000000e8';

describe('TX-04 a write-off of withholding with no certificate reads plainly to the second person (P24)', () => {
  /** `withholding.write_off` as the API stores it (packages/server tax/withholding.service). */
  const payload = {
    withholdingId: WITHHOLDING,
    leaseId: LEASE,
    unitCode: 'ACC-OSU-G-01',
    tenantName: 'Osu Pharmacy Ltd (demo)',
    amountMinor: 150_000,
    valueDate: '2026-11-05',
    reason: 'The tenant closed its Accra office',
    open: true,
  };

  it('names the request, the amount from pesewas, when it was withheld and why', () => {
    expect(approvalActionLabel('withholding.write_off')).toBe(
      'Write off withholding tax whose certificate never came',
    );
    expect(MONEY_ACTIONS).toContain('withholding.write_off');
    expect(approvalFacts('withholding.write_off', payload)).toEqual([
      { label: 'Amount', value: 'GH₵1,500.00' },
      { label: 'Withheld on', value: '5 Nov 2026' },
      { label: 'Unit', value: 'ACC-OSU-G-01' },
      { label: 'Tenant', value: 'Osu Pharmacy Ltd (demo)' },
      { label: 'Reason', value: 'The tenant closed its Accra office' },
    ]);
    expect(approvalEvidence('withholding.write_off', payload)).toBeNull();
  });

  it('says when there is nothing left to write off', () => {
    expect(approvalWarning('withholding.write_off', payload)).toBeNull();
    expect(approvalWarning('withholding.write_off', { ...payload, open: false })?.title).toBe(
      'No longer open',
    );
  });

  it('leads to the lease, where the withholding is', () => {
    expect(payloadSubject({ subjectType: 'withholding', payload })).toEqual({
      title: 'Lease for ACC-OSU-G-01',
      detail: 'Osu Pharmacy Ltd (demo)',
      leaseId: LEASE,
    });
    expect(subjectHref({ subjectType: 'withholding', subjectId: WITHHOLDING, payload })).toBe(
      `/leases/${LEASE}`,
    );
    expect(subjectHref({ subjectType: 'withholding', subjectId: WITHHOLDING, payload: {} })).toBe(
      null,
    );
  });
});

describe('AR-04 an early termination’s settlement and refund reads plainly to the second person (P13)', () => {
  const TERMINATION = '019a3000-0000-7000-8000-0000000000e9';
  /** `lease.refund` as the API stores it (packages/server billing/termination.service). */
  const payload = {
    terminationId: TERMINATION,
    leaseId: LEASE,
    unitCode: 'ACC-ELG-B1-05',
    tenantName: 'Esi Early-Exit (demo)',
    lastDay: '2026-11-15',
    charges: [{ description: 'Early termination fee', amountMinor: 50_000 }],
    deductions: [],
    chargesMinor: 50_000,
    unusedDaysCreditMinor: 75_000,
    appliedMinor: 50_000,
    deductionsMinor: 0,
    refundMinor: 1_075_000,
    arrearsMinor: 0,
    open: true,
  };

  it('names the request and shows each step’s figure from pesewas', () => {
    expect(approvalActionLabel('lease.refund')).toBe(
      'Settle an early termination and refund the tenant',
    );
    expect(approvalFacts('lease.refund', payload)).toEqual([
      { label: 'Unit', value: 'ACC-ELG-B1-05' },
      { label: 'Tenant', value: 'Esi Early-Exit (demo)' },
      { label: 'Last day of the tenancy', value: '15 Nov 2026' },
      { label: 'Agreed charges', value: 'Early termination fee, GH₵500.00' },
      { label: 'Unused days credited', value: 'GH₵750.00' },
      { label: 'Prepayment applied to open charges', value: 'GH₵500.00' },
      { label: 'Deductions', value: 'None' },
      { label: 'Refund to the tenant', value: 'GH₵10,750.00' },
      { label: 'Still owed after it', value: 'GH₵0.00' },
    ]);
  });

  it('says when the figures no longer hold, and leads to the lease', () => {
    expect(approvalWarning('lease.refund', payload)).toBeNull();
    expect(approvalWarning('lease.refund', { ...payload, open: false })?.title).toBe(
      'The figures no longer hold',
    );
    expect(subjectHref({ subjectType: 'early_termination', subjectId: TERMINATION, payload })).toBe(
      `/leases/${LEASE}`,
    );
  });
});
