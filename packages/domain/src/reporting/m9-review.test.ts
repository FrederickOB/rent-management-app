import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AllocationRow, BillingLine } from '../billing/lines';
import { ledgerArrears } from './dashboard';
import { collectionRate, collectionRateByPeriod, type PeriodCollectionLine } from './gate1';
import { ratioOf } from './measures';

/**
 * The M9 review's dashboard and Gate 1 findings, as pure functions: F2's collection rate (rent in
 * the month it covers), the share that never shows 100% short of the whole, and arrears as the
 * ledger holds them.
 */

const line = (
  lineId: string,
  periodStart: string | null,
  amountMinor: number,
  allocations: PeriodCollectionLine['allocations'] = [],
  kind: PeriodCollectionLine['kind'] = 'rent',
): PeriodCollectionLine => ({ lineId, kind, periodStart, amountMinor, allocations });

const paid = (
  amountMinor: number,
  valueDate: string,
  source: 'payment' | 'deposit' | 'withholding' | 'credit_note' | 'write_off' = 'payment',
) => ({ source, amountMinor, valueDate }) as const;

/** An annual invoice issued on the lease start: twelve monthly lines, all due on the first day. */
function annualInvoice(start: { year: number; month: number; day: number }, amountMinor: number) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(start.year, start.month - 1 + i, start.day));
    return {
      lineId: `annual-${i + 1}`,
      periodStart: d.toISOString().slice(0, 10),
      dueDate: `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`,
      amountMinor,
    };
  });
}

describe('DA-01 Gate 1 collection rate on F2’s basis: rent in the month it covers', () => {
  it('counts one month of an annual invoice in each month it covers, not twelve in the month it is due', () => {
    const lines = annualInvoice({ year: 2026, month: 1, day: 1 }, 100_000);
    // Paid in full on the day it was issued.
    const allocated = lines.map((l) => ({
      ...l,
      kind: 'rent' as const,
      allocations: [paid(100_000, '2026-01-01')],
    }));
    const march = collectionRateByPeriod({ month: '2026-03', lines: allocated });
    expect(march).toEqual({
      month: '2026-03',
      lines: 1,
      dueMinor: 100_000,
      collectedMinor: 100_000,
      rate: { numerator: 100_000, denominator: 100_000, bps: 10_000 },
    });
    // On decision 9's basis, all twelve fell in January and none in March.
    expect(collectionRate({ month: '2026-01', lines: allocated }).dueMinor).toBe(1_200_000);
    expect(collectionRate({ month: '2026-03', lines: allocated }).lines).toBe(0);
    expect(collectionRateByPeriod({ month: '2026-01', lines: allocated }).dueMinor).toBe(100_000);
  });

  it('counts a month billed ahead in the month it covers, and a period anchored mid-month in its own month', () => {
    const result = collectionRateByPeriod({
      month: '2026-11',
      lines: [
        // Billed in October for November: November's rent.
        line('nov', '2026-11-01', 150_000, [paid(150_000, '2026-10-28')]),
        // A lease anchored on the 15th: its period from 15 November is November's.
        line('mid', '2026-11-15', 80_000, [paid(30_000, '2026-11-20')]),
        line('nov-sc', '2026-11-01', 20_000, [], 'service_charge'),
        // Other months, other kinds, and a line with no period: left out.
        line('oct', '2026-10-15', 80_000, [paid(80_000, '2026-11-02')]),
        line('dec', '2026-12-01', 150_000, [paid(150_000, '2026-11-25')]),
        line('deposit', '2026-11-01', 300_000, [paid(300_000, '2026-11-01')], 'deposit'),
        line('vat', '2026-11-01', 22_500, [paid(22_500, '2026-11-01')], 'vat'),
        line('charge', null, 10_000, [paid(10_000, '2026-11-01')], 'one_off'),
        line('no-period', null, 50_000, [paid(50_000, '2026-11-01')]),
      ],
    });
    expect(result).toMatchObject({ lines: 3, dueMinor: 250_000, collectedMinor: 180_000 });
    expect(result.rate.bps).toBe(7_200);
  });

  it('settles by the month’s end only, counts withholding and deposits applied, takes back reversals, and never counts a write-off', () => {
    const result = collectionRateByPeriod({
      month: '2026-11',
      lines: [
        line('withheld', '2026-11-01', 1_000_000, [
          paid(850_000, '2026-11-05'),
          paid(150_000, '2026-11-05', 'withholding'),
        ]),
        line('deposit-applied', '2026-11-01', 50_000, [paid(50_000, '2026-11-30', 'deposit')]),
        line('late', '2026-11-01', 150_000, [paid(150_000, '2026-12-01')]),
        line('bounced', '2026-11-01', 150_000, [
          paid(150_000, '2026-11-02'),
          paid(-150_000, '2026-11-09'),
        ]),
        line('credited', '2026-11-01', 150_000, [
          paid(50_000, '2026-11-10', 'credit_note'),
          paid(100_000, '2026-11-11'),
        ]),
        line('written-off', '2026-11-01', 150_000, [paid(150_000, '2026-11-28', 'write_off')]),
      ],
    });
    expect(result.dueMinor).toBe(1_000_000 + 50_000 + 150_000 + 150_000 + 100_000 + 150_000);
    expect(result.collectedMinor).toBe(1_000_000 + 50_000 + 100_000);
  });

  it('with asOf, counts only lines and allocations recorded by then, so a past moment’s figures never change', () => {
    const at = (iso: string) => new Date(iso);
    const lines: PeriodCollectionLine[] = [
      {
        ...line('a', '2026-11-01', 100_000),
        recordedAt: at('2026-10-25T09:00:00Z'),
        allocations: [
          { ...paid(60_000, '2026-11-03'), recordedAt: at('2026-11-03T10:00:00Z') },
          // Cash received on the 30th, recorded on 2 December: not known on the 1st.
          { ...paid(40_000, '2026-11-30'), recordedAt: at('2026-12-02T08:00:00Z') },
        ],
      },
      {
        ...line('b', '2026-11-01', 100_000),
        recordedAt: at('2026-10-25T09:00:00Z'),
        // A credit note recorded later does not reduce what was due before it.
        allocations: [
          { ...paid(100_000, '2026-11-20', 'credit_note'), recordedAt: at('2026-12-02T08:00:00Z') },
        ],
      },
      // Invoiced after the moment measured: not due yet then.
      { ...line('c', '2026-11-15', 70_000), recordedAt: at('2026-12-01T05:00:00Z') },
    ];
    const onThe1st = collectionRateByPeriod({
      month: '2026-11',
      lines,
      asOf: '2026-12-01T04:00:00Z',
    });
    expect(onThe1st).toMatchObject({ lines: 2, dueMinor: 200_000, collectedMinor: 60_000 });
    const now = collectionRateByPeriod({ month: '2026-11', lines });
    expect(now).toMatchObject({ lines: 3, dueMinor: 170_000, collectedMinor: 100_000 });
    // Without the time it was recorded, an allocation cannot be cut: refused, never guessed.
    expect(() =>
      collectionRateByPeriod({
        month: '2026-11',
        lines: [line('x', '2026-11-01', 1, [paid(1, '2026-11-01')])],
        asOf: '2026-12-01T04:00:00Z',
      }),
    ).toThrow(/recorded/);
  });

  it('counts every line in exactly the month its period starts, and never above 100%', () => {
    const months = ['2026-10', '2026-11', '2026-12'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            month: fc.constantFrom(...months),
            day: fc.integer({ min: 1, max: 28 }),
            amount: fc.integer({ min: 0, max: 5_000_000 }),
            allocations: fc.array(
              fc.record({
                source: fc.constantFrom('payment', 'deposit', 'withholding', 'write_off'),
                amountMinor: fc.integer({ min: -2_000_000, max: 6_000_000 }),
                offset: fc.integer({ min: -400, max: 120 }),
              }),
              { maxLength: 5 },
            ),
          }),
          { maxLength: 15 },
        ),
        (rows) => {
          const lines = rows.map((r, i) =>
            line(
              `l${i}`,
              `${r.month}-${String(r.day).padStart(2, '0')}`,
              r.amount,
              r.allocations.map((a) => ({
                source: a.source,
                amountMinor: a.amountMinor,
                valueDate: new Date(Date.UTC(2026, 9, 1 + a.offset)).toISOString().slice(0, 10),
              })),
            ),
          );
          const results = months.map((month) => collectionRateByPeriod({ month, lines }));
          expect(results.reduce((s, r) => s + r.lines, 0)).toBe(lines.length);
          expect(results.reduce((s, r) => s + r.dueMinor, 0)).toBe(
            lines.reduce((s, l) => s + l.amountMinor, 0),
          );
          for (const r of results) {
            expect(r.collectedMinor).toBeGreaterThanOrEqual(0);
            expect(r.collectedMinor).toBeLessThanOrEqual(r.dueMinor);
            if (r.rate.bps !== null) expect(r.rate.bps).toBeLessThanOrEqual(10_000);
          }
        },
      ),
    );
  });
});

describe('DA-01 a share never shows 100% unless it is the whole', () => {
  it('holds a share short of the whole at 99.99%, and keeps half-up rounding everywhere else', () => {
    expect(ratioOf(19_999, 20_000).bps).toBe(9_999);
    expect(ratioOf(39_999, 40_000).bps).toBe(9_999);
    expect(ratioOf(20_000, 20_000).bps).toBe(10_000);
    expect(ratioOf(19_997, 20_000).bps).toBe(9_999); // 9,998.5 rounds half up
    expect(ratioOf(19_996, 20_000).bps).toBe(9_998);
    expect(ratioOf(2, 3).bps).toBe(6_667);
    expect(ratioOf(1, 20_000).bps).toBe(1);
    expect(ratioOf(0, 5).bps).toBe(0);
    expect(ratioOf(0, 0).bps).toBeNull();
  });

  it('shows 100% exactly when everything was counted, and only then', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.nat(), (denominator, n) => {
        const numerator = n % (denominator + 1);
        const { bps } = ratioOf(numerator, denominator);
        expect(bps === 10_000).toBe(numerator === denominator);
        expect(bps).toBeGreaterThanOrEqual(0);
        expect(bps).toBeLessThanOrEqual(10_000);
      }),
    );
  });
});

describe('DA-01 BC-08 arrears as the ledger holds them (1100 past due, as the statement counts)', () => {
  const base = {
    baseLineId: null,
    rateBps: null,
    sequence: 0,
  } as const;

  it('keeps an annual invoice’s months not started out of arrears, as billed and not started', () => {
    const asOf = '2026-03-10';
    const lines: BillingLine[] = annualInvoice({ year: 2026, month: 1, day: 1 }, 100_000).map(
      (l, i) => ({
        ...base,
        id: l.lineId,
        kind: 'rent',
        dueDate: l.dueDate,
        periodStart: l.periodStart,
        periodEnd: l.periodStart.slice(0, 8) + '28',
        amountMinor: l.amountMinor,
        accrued: l.periodStart <= asOf,
        sequence: i,
      }),
    );
    // The first month paid; nothing else.
    const allocations: AllocationRow[] = [
      { lineId: 'annual-1', source: 'payment', paymentId: 'p1', amountMinor: 100_000 },
    ];
    const arrears = ledgerArrears({ lines, allocations, asOf });
    // February and March are owed (1100), 68 days past their due date of 1 January.
    expect(arrears.byBucket).toEqual({ '0_30': 0, '31_60': 0, '61_90': 200_000, '90_plus': 0 });
    expect(arrears.totalMinor).toBe(200_000);
    // April to December are billed and past due but not started.
    expect(arrears.dueNotStartedMinor).toBe(9 * 100_000);
  });

  it('counts months not started by their allocations only, ages tax lines in 1100, and never counts a deposit', () => {
    const asOf = '2026-03-10';
    const lines: BillingLine[] = [
      {
        ...base,
        id: 'jan',
        kind: 'rent',
        dueDate: '2026-01-01',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        amountMinor: 100_000,
        accrued: true,
        sequence: 1,
      },
      {
        ...base,
        id: 'jan-vat',
        kind: 'vat',
        baseLineId: 'jan',
        rateBps: 1_500,
        dueDate: '2026-01-01',
        periodStart: null,
        periodEnd: null,
        amountMinor: 15_000,
        accrued: false,
        sequence: 2,
        chargedOn: '2026-01-01',
      },
      {
        ...base,
        id: 'apr',
        kind: 'rent',
        dueDate: '2026-01-01',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        amountMinor: 100_000,
        accrued: false,
        sequence: 3,
      },
      {
        ...base,
        id: 'may',
        kind: 'rent',
        dueDate: '2026-01-01',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        amountMinor: 100_000,
        accrued: false,
        sequence: 4,
      },
      {
        ...base,
        id: 'deposit',
        kind: 'deposit',
        dueDate: '2026-01-01',
        periodStart: null,
        periodEnd: null,
        amountMinor: 200_000,
        accrued: false,
        sequence: 5,
      },
      // Due today, so not past due yet: neither.
      {
        ...base,
        id: 'mar-late',
        kind: 'one_off',
        dueDate: '2026-03-10',
        periodStart: null,
        periodEnd: null,
        amountMinor: 5_000,
        accrued: false,
        sequence: 6,
        chargedOn: '2026-03-01',
      },
    ];
    const allocations: AllocationRow[] = [
      { lineId: 'jan', source: 'payment', paymentId: 'p1', amountMinor: 40_000 },
      // May paid ahead in part: what is unpaid on it is still billed and not started.
      { lineId: 'may', source: 'payment', paymentId: 'p1', amountMinor: 25_000 },
    ];
    const arrears = ledgerArrears({ lines, allocations, asOf });
    expect(arrears.totalMinor).toBe(60_000 + 15_000);
    expect(arrears.byBucket['61_90']).toBe(75_000);
    // Surplus the tenant holds is credit, shown once there, never netted off here.
    expect(arrears.dueNotStartedMinor).toBe(100_000 + 75_000);
  });
});
