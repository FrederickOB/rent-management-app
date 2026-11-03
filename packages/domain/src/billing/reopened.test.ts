import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planReopenedDraws } from './allocation';
import { creditPools, isRecurring, lineBalance } from './lines';
import { LeaseLedgerModel } from './testing/lease-ledger';
import { leaseArbitrary, operationsArbitrary, ScenarioRunner } from './testing/scenarios';
import { agedLines, moneySummary } from './walk';

/**
 * Spare credit pays debt a correction reopened (M4b review F4): a reversal or a credit note can
 * leave an accrued period owing while the lease holds credit from other payments. The engine
 * and the reference model draw that credit at once (P02), so ageing, reminders and paid-until
 * agree with what the tenant has paid.
 */
const month = (start: string, end: string, id: string) => ({
  kind: 'rent' as const,
  chargePeriodId: id,
  periodStart: start,
  periodEnd: end,
  amountMinor: 100_000,
  rateBps: null,
  baseIndex: null,
});

describe('AR-02 spare credit pays debt a reversal reopened (review F4)', () => {
  it('the reviewer’s bounced cheque: November is paid from the later payment’s credit', () => {
    const m = new LeaseLedgerModel('2026-11-01');
    m.issue([month('2026-11-01', '2026-11-30', 'p1')], '2026-11-01', 'inv1');
    m.accrueTo('2026-11-01');
    const a = m.pay(100_000); // pays November
    const b = m.pay(300_000); // nothing else is invoiced yet: all credit
    m.reverse(a.id); // A's cheque bounces
    m.checkInvariants();
    expect(lineBalance(m.lines[0]!, m.allocations).outstandingMinor).toBe(0);
    for (let i = 0; i < 40; i += 1) m.nextDay();
    m.issue([month('2026-12-01', '2026-12-31', 'p2')], '2026-12-01', 'inv2');
    m.accrueTo(m.today);
    m.checkInvariants();
    const walk = m.walk();
    const pools = creditPools(
      m.payments.filter((p) => !p.reversed),
      m.allocations,
    );
    expect(pools).toEqual([{ paymentId: b.id, amountMinor: 100_000, order: b.order }]);
    const summary = moneySummary({
      lines: m.lines,
      allocations: m.allocations,
      pools,
      walk,
      today: m.today,
    });
    expect(summary).toMatchObject({ overdueMinor: 0, earnedUnpaidMinor: 0, creditMinor: 100_000 });
    expect(walk.paidUntil).not.toBeNull();
    expect(agedLines({ lines: m.lines, allocations: m.allocations, walk, asOf: m.today })).toEqual(
      [],
    );
    expect(m.balance('1100')).toBe(0);
  });

  it('draws in allocation order, oldest payment first, and leaves deposits and one-offs alone', () => {
    const lines = [
      {
        id: 'dep',
        invoiceId: 'i0',
        kind: 'deposit' as const,
        amountMinor: 50_000,
        dueDate: '2026-10-01',
        periodStart: null,
        periodEnd: null,
        accrued: false,
        sequence: 1,
        baseLineId: null,
      },
      {
        id: 'oct',
        invoiceId: 'i1',
        kind: 'rent' as const,
        amountMinor: 100_000,
        dueDate: '2026-10-01',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        accrued: true,
        sequence: 2,
        baseLineId: null,
      },
      {
        id: 'nov',
        invoiceId: 'i2',
        kind: 'rent' as const,
        amountMinor: 100_000,
        dueDate: '2026-11-01',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        accrued: true,
        sequence: 3,
        baseLineId: null,
      },
      {
        id: 'dec',
        invoiceId: 'i3',
        kind: 'rent' as const,
        amountMinor: 100_000,
        dueDate: '2026-12-01',
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        accrued: false,
        sequence: 4,
        baseLineId: null,
      },
    ] as unknown as Parameters<typeof planReopenedDraws>[0];
    const plans = planReopenedDraws(
      lines,
      [],
      [
        { paymentId: 'older', amountMinor: 60_000, order: '1' },
        { paymentId: 'newer', amountMinor: 200_000, order: '2' },
      ],
    );
    expect(plans).toEqual([
      {
        lineId: 'oct',
        draws: [
          { paymentId: 'older', amountMinor: 60_000 },
          { paymentId: 'newer', amountMinor: 40_000 },
        ],
      },
      { lineId: 'nov', draws: [{ paymentId: 'newer', amountMinor: 100_000 }] },
    ]);
  });
});

describe('BC-07 credit never sits beside reopened debt (review F4)', () => {
  it('after any sequence with corrections, no accrued period owes while the lease holds credit', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) {
          run.apply(op);
          const m = run.model;
          const credit = creditPools(
            m.payments.filter((p) => !p.reversed),
            m.allocations,
          ).reduce((sum, p) => sum + p.amountMinor, 0);
          if (credit === 0) continue;
          const owing = m.lines.filter(
            (l) =>
              isRecurring(l.kind) &&
              l.baseLineId === null &&
              l.accrued &&
              lineBalance(l, m.allocations).outstandingMinor > 0,
          );
          expect(owing.map((l) => l.id)).toEqual([]);
        }
      }),
      { numRuns: 150 },
    );
  });
});
