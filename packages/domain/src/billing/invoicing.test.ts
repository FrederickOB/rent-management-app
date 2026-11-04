import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkLeaseTerms, type LeaseTermsInput, type RentCycle } from '../tenancy/lease-terms';
import { holdingOverPeriods, rentSchedule } from '../tenancy/schedule';
import {
  checkBillingStart,
  cyclesForAdvance,
  cyclesToIssue,
  depositDue,
  draftTotal,
  firstPeriodStartOnOrAfter,
  invoiceCycles,
  invoiceLinesFor,
  taxLinesOn,
  type ScheduleRow,
} from './invoicing';

const base: LeaseTermsInput = {
  startDate: '2026-11-01',
  endDate: '2027-10-31',
  monthlyRentMinor: 150_000,
  cycle: 'monthly',
  noticeDays: 30,
  use: 'residential',
};

const scheduleOf = (input: LeaseTermsInput): ScheduleRow[] =>
  rentSchedule(checkLeaseTerms(input)).map((p) => ({
    id: `${p.chargeType}-${p.sequence}`,
    sequence: p.sequence,
    chargeType: p.chargeType,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountMinor: p.amountMinor,
    source: 'schedule' as const,
  }));

const cyclesFor = (
  input: LeaseTermsInput,
  over: Partial<Parameters<typeof invoiceCycles>[0]> = {},
) => {
  const terms = checkLeaseTerms(input);
  return invoiceCycles({
    cycle: terms.cycle,
    initialAdvanceMonths: terms.initialAdvanceMonths,
    schedule: scheduleOf(input),
    billingStartDate: terms.startDate,
    lastBillableDay: terms.endDate,
    leadDays: 14,
    ...over,
  });
};

describe('BC-01 invoices from lease terms', () => {
  it.each<[RentCycle, number, number]>([
    ['monthly', 12, 1],
    ['quarterly', 4, 3],
    ['six_monthly', 2, 6],
    ['annual', 1, 12],
  ])('a %s cycle gives %i invoices of %i periods', (cycle, invoices, months) => {
    const cycles = cyclesFor({ ...base, cycle });
    expect(cycles).toHaveLength(invoices);
    for (const c of cycles) {
      expect(c.rows).toHaveLength(months);
      expect(c.dueDate).toBe(c.rows[0]?.periodStart);
    }
  });

  it('issues each invoice 14 days before its due date, the first day of its cycle', () => {
    const [first, second] = cyclesFor({ ...base, cycle: 'quarterly' });
    expect(first).toMatchObject({ dueDate: '2026-11-01', issueDate: '2026-10-18' });
    expect(second).toMatchObject({
      dueDate: '2027-02-01',
      issueDate: '2027-01-18',
      periodTo: '2027-04-30',
    });
  });

  it('puts the initial advance in the first invoice, then one cycle each', () => {
    const cycles = cyclesFor({ ...base, cycle: 'quarterly', initialAdvanceMonths: 6 });
    expect(cycles.map((c) => c.rows.length)).toEqual([6, 3, 3]);
    expect(cycles[1]?.cycleStart).toBe('2027-05-01');
  });

  it('applies escalation steps through the schedule', () => {
    const cycles = cyclesFor({
      ...base,
      steps: [{ effectiveFrom: '2027-05-01', monthlyRentMinor: 165_000 }],
    });
    expect(cycles[5]?.rows[0]?.amountMinor).toBe(150_000);
    expect(cycles[6]?.rows[0]?.amountMinor).toBe(165_000);
  });

  it('bills from the billing start, and never a period after the last billable day', () => {
    const cycles = cyclesFor(
      { ...base, cycle: 'quarterly' },
      {
        billingStartDate: '2027-01-01',
        lastBillableDay: '2027-06-15',
      },
    );
    expect(cycles.map((c) => [c.cycleStart, c.rows.length])).toEqual([
      ['2027-01-01', 1],
      ['2027-02-01', 3],
      ['2027-05-01', 2],
    ]);
  });

  it('keeps service charge in the same invoice as the rent of its period', () => {
    const [first] = cyclesFor({ ...base, serviceChargeMonthlyMinor: 20_000 });
    expect(first?.rows.map((r) => r.chargeType)).toEqual(['rent', 'service_charge']);
  });

  it('invoices each held-over month on the day it starts', () => {
    const terms = checkLeaseTerms(base);
    const held = holdingOverPeriods(terms, terms.periodCount).map((p) => ({
      id: `h-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'holding_over' as const,
    }));
    const cycles = invoiceCycles({
      cycle: 'annual',
      initialAdvanceMonths: null,
      schedule: [...scheduleOf({ ...base, cycle: 'annual' }), ...held],
      billingStartDate: base.startDate,
      lastBillableDay: null,
      leadDays: 14,
    });
    expect(cycles.at(-1)).toMatchObject({
      holdingOver: true,
      cycleStart: '2027-11-01',
      issueDate: '2027-11-01',
    });
  });

  it('issues only what is due, once: a rerun issues nothing new', () => {
    const cycles = cyclesFor(base);
    const due = cyclesToIssue(cycles, '2026-11-20', new Set());
    expect(due.map((c) => c.cycleStart)).toEqual(['2026-11-01', '2026-12-01']);
    expect(cyclesToIssue(cycles, '2026-11-20', new Set(due.map((c) => c.cycleStart)))).toEqual([]);
  });

  it('every period from the billing start is invoiced exactly once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 36 }),
        fc.constantFrom<RentCycle>('monthly', 'quarterly', 'six_monthly', 'annual'),
        fc.integer({ min: 0, max: 36 }),
        fc.integer({ min: 0, max: 36 }),
        (months, cycle, advanceExtra, startAt) => {
          const end = new Date(Date.UTC(2026, 10 + months, 0)).toISOString().slice(0, 10);
          const input = { ...base, endDate: end, cycle };
          let terms;
          try {
            terms = checkLeaseTerms({
              ...input,
              initialAdvanceMonths: advanceExtra === 0 ? null : undefined,
            });
          } catch {
            return;
          }
          const schedule = scheduleOf(input);
          const billingStart = firstPeriodStartOnOrAfter(
            terms,
            schedule[Math.min(startAt, schedule.length - 1)]?.periodStart ?? base.startDate,
          );
          const cycles = invoiceCycles({
            cycle,
            initialAdvanceMonths: null,
            schedule,
            billingStartDate: billingStart,
            lastBillableDay: terms.endDate,
            leadDays: 14,
          });
          const billed = cycles.flatMap((c) => c.rows.map((r) => r.id));
          expect(new Set(billed).size).toBe(billed.length);
          expect(billed.sort()).toEqual(
            schedule
              .filter((s) => s.periodStart >= billingStart)
              .map((s) => s.id)
              .sort(),
          );
        },
      ),
    );
  });
});

describe('BC-01 billing start (decision 1)', () => {
  const terms = checkLeaseTerms({ ...base, startDate: '2025-03-15', endDate: '2027-03-14' });

  it('a paper lease bills from the first rent period starting on or after the day it is recorded', () => {
    expect(firstPeriodStartOnOrAfter(terms, '2026-10-30')).toBe('2026-11-15');
    expect(firstPeriodStartOnOrAfter(terms, '2026-11-15')).toBe('2026-11-15');
    expect(firstPeriodStartOnOrAfter(terms, '2024-01-01')).toBe('2025-03-15');
  });

  it('accepts only the start of a rent period', () => {
    expect(checkBillingStart(terms, '2026-01-15')).toBe('2026-01-15');
    expect(() => checkBillingStart(terms, '2026-01-16')).toThrow(/first day of one/);
  });

  it('issues a deposit invoice only when billing starts at the lease start', () => {
    const at = { depositMinor: 300_000, startDate: '2025-03-15', carriedDepositMinor: 0 };
    expect(depositDue({ ...at, billingStartDate: '2025-03-15' })).toBe(300_000);
    expect(depositDue({ ...at, billingStartDate: '2026-11-15' })).toBe(0);
    expect(
      depositDue({ ...at, billingStartDate: '2025-03-15', carriedDepositMinor: 250_000 }),
    ).toBe(50_000);
    expect(
      depositDue({ ...at, billingStartDate: '2025-03-15', carriedDepositMinor: 400_000 }),
    ).toBe(0);
  });
});

describe('CT-04 VAT on commercial invoices', () => {
  const rates = { vatBps: 1500, nhilBps: 250, getfundBps: 250, appliesToServiceCharge: true };

  it('charges VAT, NHIL and GETFund on each line’s net amount, rounded half up once per line', () => {
    expect(taxLinesOn(1_000_000, rates)).toEqual([
      { kind: 'vat', rateBps: 1500, amountMinor: 150_000 },
      { kind: 'nhil', rateBps: 250, amountMinor: 25_000 },
      { kind: 'getfund', rateBps: 250, amountMinor: 25_000 },
    ]);
    // A rate that rounds to nothing gives no line: 15% of 3 pesewas is 0.45, so 0.
    expect(taxLinesOn(3, rates)).toEqual([]);
    // 15% of 10 pesewas is 1.5, rounded half up to 2; 2.5% is 0.25, rounded to 0.
    expect(taxLinesOn(10, { vatBps: 1500, nhilBps: 250, getfundBps: 250 })).toEqual([
      { kind: 'vat', rateBps: 1500, amountMinor: 2 },
    ]);
  });

  it('puts the tax lines straight after their base line, and on service charge only when the rule says so', () => {
    const input = { ...base, use: 'commercial' as const, serviceChargeMonthlyMinor: 20_000 };
    const [first] = cyclesFor(input);
    if (!first) throw new Error('no cycle');
    expect(invoiceLinesFor(first, rates).map((l) => [l.kind, l.baseIndex])).toEqual([
      ['rent', null],
      ['vat', 0],
      ['nhil', 0],
      ['getfund', 0],
      ['service_charge', null],
      ['vat', 4],
      ['nhil', 4],
      ['getfund', 4],
    ]);
    expect(
      invoiceLinesFor(first, { ...rates, appliesToServiceCharge: false }).map((l) => l.kind),
    ).toEqual(['rent', 'vat', 'nhil', 'getfund', 'service_charge']);
    expect(invoiceLinesFor(first, null).map((l) => l.kind)).toEqual(['rent', 'service_charge']);
  });

  it('issues the invoices an advance pays for, up to the lease end (the payment is the tax point)', () => {
    const cycles = cyclesFor({ ...base, use: 'commercial' });
    const monthWithVat = draftTotal(invoiceLinesFor(cycles[0] as never, rates));
    expect(monthWithVat).toBe(150_000 + 22_500 + 3_750 + 3_750);
    const chosen = cyclesForAdvance({
      pending: cycles.slice(1),
      openMinor: monthWithVat,
      paymentMinor: monthWithVat * 3 + 1,
      vat: rates,
    });
    expect(chosen.map((c) => c.cycleStart)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);
    expect(
      cyclesForAdvance({ pending: cycles.slice(1), openMinor: 0, paymentMinor: 1e12, vat: rates }),
    ).toHaveLength(11);
  });
});

describe('BC-01 a two-yearly cycle (M4b decision 9)', () => {
  it('bundles 24 periods in one invoice, due on the first day, with the service charge of each month', () => {
    const cycles = cyclesFor({
      ...base,
      endDate: '2028-10-31',
      cycle: 'two_yearly',
      serviceChargeMonthlyMinor: 20_000,
    });
    expect(cycles).toHaveLength(1);
    const [cycle] = cycles;
    expect(cycle).toMatchObject({
      dueDate: '2026-11-01',
      issueDate: '2026-10-18',
      periodFrom: '2026-11-01',
      periodTo: '2028-10-31',
    });
    expect(cycle?.rows.filter((r) => r.chargeType === 'rent')).toHaveLength(24);
    expect(cycle?.rows.filter((r) => r.chargeType === 'service_charge')).toHaveLength(24);
    expect(draftTotal(invoiceLinesFor(cycle!, null))).toBe(170_000 * 24);
  });

  it('a longer lease gets one invoice every two years, and a short final cycle', () => {
    const cycles = cyclesFor({ ...base, endDate: '2029-10-31', cycle: 'two_yearly' });
    expect(cycles.map((c) => [c.dueDate, c.rows.length])).toEqual([
      ['2026-11-01', 24],
      ['2028-11-01', 12],
    ]);
  });
});
