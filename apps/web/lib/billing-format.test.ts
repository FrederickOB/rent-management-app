import type { LeaseBilling } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  CASH_RECORD_STATUS_LABELS,
  moneyFacts,
  NOT_BILLED_LABELS,
  paidUntilLabel,
  paidUntilParts,
  periodLabel,
  rateLabel,
} from './billing-format';

const LEASE = '019a3000-0000-7000-8000-0000000000d1';

const billing = (overrides: Partial<LeaseBilling> = {}): LeaseBilling => ({
  leaseId: LEASE,
  paymentReference: 'K7Q2M4X',
  billingStartDate: '2026-10-15',
  notBilledReason: null,
  dueNowMinor: 45_000,
  overdueMinor: 40_000,
  earnedUnpaidMinor: 40_000,
  paidUntil: '2026-11-14',
  partial: null,
  unearnedRentMinor: 3_300_000,
  depositHeldMinor: 500_000,
  creditMinor: 1_250,
  currency: 'GHS',
  ...overrides,
});

describe('AR-02 paid-until on the lease page', () => {
  it('shows the last day of the last whole month paid for', () => {
    expect(paidUntilParts(billing())).toEqual({ date: '14 Nov 2026', partial: null });
    expect(paidUntilLabel(billing())).toBe('14 Nov 2026');
  });

  it('adds partial cover in the words of prd-issues 17', () => {
    const part = billing({ partial: { monthStart: '2026-11-15', amountMinor: 45_000 } });
    expect(paidUntilParts(part)).toEqual({
      date: '14 Nov 2026',
      partial: 'plus GH₵450.00 towards the month starting 15 Nov 2026',
    });
    expect(paidUntilLabel(part)).toBe(
      '14 Nov 2026, plus GH₵450.00 towards the month starting 15 Nov 2026',
    );
  });

  it('says so when no whole month is paid, with or without money towards the first', () => {
    expect(
      paidUntilLabel(
        billing({ paidUntil: null, partial: { monthStart: '2026-10-15', amountMinor: 20_000 } }),
      ),
    ).toBe('Not a whole month yet: GH₵200.00 towards the month starting 15 Oct 2026');
    expect(paidUntilLabel(billing({ paidUntil: null }))).toBe('No rent paid yet');
  });
});

describe('AR-03, BC-11 and plan 4.12 the money card says what each figure is', () => {
  it('lists every figure from the API, formatted from pesewas only at the edge', () => {
    const facts = moneyFacts(billing());
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ['Due now', 'GH₵450.00'],
      ['Overdue invoices', 'GH₵400.00'],
      ['Earned and unpaid', 'GH₵400.00'],
      ['Paid until', '14 Nov 2026'],
      ['Unearned rent', 'GH₵33,000.00'],
      ['Deposit held', 'GH₵5,000.00'],
      ['Credit', 'GH₵12.50'],
    ]);
  });

  it('keeps "overdue invoices" (what invoices ask) apart from "earned and unpaid" (what is owed)', () => {
    const facts = moneyFacts(billing());
    expect(facts.find((f) => f.key === 'overdue')?.hint).toContain('invoices asked for');
    expect(facts.find((f) => f.key === 'earned-unpaid')?.hint).toContain(
      'periods that have started',
    );
    expect(facts.find((f) => f.key === 'deposit-held')?.hint).toContain('never counted as income');
  });

  it('says why a lease is not billed', () => {
    expect(NOT_BILLED_LABELS.joint_owners).toContain('Record joint owners as one owner');
    expect(NOT_BILLED_LABELS.not_signed).toContain('once it is signed');
  });
});

describe('CT-04 VAT and levy rates on screen', () => {
  it('prints basis points as percentages without floating point', () => {
    expect(rateLabel(1500)).toBe('15%');
    expect(rateLabel(250)).toBe('2.5%');
    expect(rateLabel(25)).toBe('0.25%');
    expect(rateLabel(1250)).toBe('12.5%');
    expect(rateLabel(5)).toBe('0.05%');
    expect(rateLabel(0)).toBe('0%');
  });

  it('names a line’s period, or nothing for a line without one', () => {
    expect(periodLabel('2026-11-15', '2026-12-14')).toBe('15 Nov 2026 to 14 Dec 2026');
    expect(periodLabel(null, null)).toBeNull();
  });
});

describe('BC-05 and decision 7 cash waits for confirmation', () => {
  it('shows cash waiting for a second person, or for a lone landlord’s own confirmation, the same way', () => {
    expect(CASH_RECORD_STATUS_LABELS.awaiting_approval).toBe('Recorded, waiting for confirmation');
    expect(CASH_RECORD_STATUS_LABELS.rejected).toContain('not posted');
  });
});
