import { describe, expect, it } from 'vitest';
import { balanceOf } from '../ledger/journal';
import { lateDrawLines, receiptLines } from '../ledger/posting';
import { planAllocation } from './allocation';
import { linesAfterEnd, planCreditNote } from './corrections';
import type { AllocationRow, BillingLine } from './lines';
import { forwardWalk, walkLines } from './walk';

/** The independent review's findings 2 and 4 (M4a), as regression tests. */
const rent = (n: number, start: string, end: string, accrued: boolean): BillingLine => ({
  id: `l${n}`,
  kind: 'rent',
  baseLineId: null,
  rateBps: null,
  dueDate: '2026-01-01',
  periodStart: start,
  periodEnd: end,
  amountMinor: 100_000,
  accrued,
  sequence: n,
});
const lease = { propertyId: 'pr', unitId: 'u', leaseId: 'le', tenantId: 't' };

describe('AR-02 paid-until never runs past the end (review 4)', () => {
  const quarter = () => [
    rent(1, '2026-01-01', '2026-01-31', true),
    rent(2, '2026-02-01', '2026-02-28', false),
    rent(3, '2026-03-01', '2026-03-31', false),
  ];

  it('stops at a move-out when the cancelled months were paid ahead', () => {
    // A quarterly invoice, all of it paid; the tenant moves out on 31 January.
    const lines = quarter();
    let allocations: AllocationRow[] = lines.map((l) => ({
      lineId: l.id,
      source: 'payment',
      paymentId: 'p1',
      amountMinor: 100_000,
    }));
    for (const line of linesAfterEnd(lines, '2026-01-31'))
      for (const part of planCreditNote({
        line,
        taxLines: [],
        allocations,
        payments: [{ id: 'p1', amountMinor: 300_000, order: 'a' }],
        amountMinor: 100_000,
      }))
        allocations = [...allocations, ...part.rows];
    const walk = forwardWalk(walkLines({ lines, allocations, scheduled: [] }), [
      { paymentId: 'p1', order: 'a', amountMinor: 200_000 },
    ]);
    // The credit released by the cancelled months does not make them paid.
    expect(walk.paidUntil).toBe('2026-01-31');
    expect(
      forwardWalk(walkLines({ lines, allocations, scheduled: [] }), [], { lastDay: '2026-01-15' })
        .paidUntil,
    ).toBe('2026-01-15');
  });

  it('shows nothing paid on a lease cancelled before it started', () => {
    const lines = quarter().map((l) => ({ ...l, accrued: false }));
    let allocations: AllocationRow[] = [];
    for (const line of lines)
      for (const part of planCreditNote({
        line,
        taxLines: [],
        allocations,
        payments: [],
        amountMinor: 100_000,
      }))
        allocations = [...allocations, ...part.rows];
    expect(forwardWalk(walkLines({ lines, allocations, scheduled: [] }), []).paidUntil).toBeNull();
  });
});

describe('BC-07 a payment is classified as of the day it arrived (review 2)', () => {
  it('holds money for a period that started later as its advance, then draws it at the start', () => {
    // Cash received on 25 January, approved on 3 February after February accrued.
    const feb = rent(1, '2026-02-01', '2026-02-28', true);
    const plan = planAllocation({
      lines: [feb],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 100_000,
      lease,
      valueDate: '2026-01-25',
    });
    const receipt = receiptLines({
      cash: { bookId: 'b', account: '1060', collectorId: 'c' },
      bookId: 'b',
      paymentId: 'p1',
      lease,
      allocations: plan.postings,
      surplusMinor: plan.surplusMinor,
    });
    // As of 25 January nothing is owed on February: the money is February's advance.
    expect(balanceOf(receipt, { accountCode: '1100' })).toBe(0);
    expect(balanceOf(receipt, { accountCode: '2010' })).toBe(-100_000);
    expect(plan.lateDraws).toEqual([
      { lineId: feb.id, paymentId: 'p1', amountMinor: 100_000, valueDate: '2026-02-01' },
    ]);
    const draw = lateDrawLines({
      bookId: 'b',
      lease,
      invoiceLineId: feb.id,
      paymentId: 'p1',
      amountMinor: 100_000,
    });
    // On 1 February the advance pays the line it was for.
    expect(balanceOf([...receipt, ...draw], { accountCode: '2010' })).toBe(0);
    expect(balanceOf(draw, { accountCode: '1100' })).toBe(-100_000);
  });
});

describe('CT-04 a tax line is owed from its tax point (second review A)', () => {
  it('holds money that arrived before the VAT was charged, then draws it on that day', () => {
    const rentLine = { ...rent(1, '2026-02-01', '2026-02-28', true) };
    const vat: BillingLine = {
      id: 'v1',
      kind: 'vat',
      baseLineId: rentLine.id,
      rateBps: 1500,
      dueDate: '2026-02-01',
      periodStart: null,
      periodEnd: null,
      amountMinor: 15_000,
      accrued: false,
      sequence: 2,
      chargedOn: '2026-02-01',
    };
    const plan = planAllocation({
      lines: [rentLine, vat],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 115_000,
      lease,
      valueDate: '2026-01-28',
    });
    expect(plan.postings.map((p) => [p.invoiceLineId, p.postingClass])).toEqual([
      ['l1', 'prepayment'],
      ['v1', 'prepayment'],
    ]);
    expect(plan.lateDraws).toEqual([
      { lineId: 'l1', paymentId: 'p1', amountMinor: 100_000, valueDate: '2026-02-01' },
      { lineId: 'v1', paymentId: 'p1', amountMinor: 15_000, valueDate: '2026-02-01' },
    ]);
    // Money arriving on or after the tax point pays the VAT as owed at once.
    const later = planAllocation({
      lines: [rentLine, vat],
      allocations: [],
      paymentId: 'p2',
      amountMinor: 115_000,
      lease,
      valueDate: '2026-02-01',
    });
    expect(later.lateDraws).toEqual([]);
  });
});
