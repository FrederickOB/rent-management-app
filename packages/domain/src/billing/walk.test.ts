import { describe, expect, it } from 'vitest';
import { balanceOf } from '../ledger/journal';
import { checkLeaseTerms } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import { cyclesToIssue, invoiceCycles, invoiceLinesFor, type ScheduleRow } from './invoicing';
import { creditPools } from './lines';
import { LeaseLedgerModel } from './testing/lease-ledger';
import { ageBucket, agedLines, moneySummary } from './walk';

/** Worked example A as a lease run day by day: GH₵36,000 for 24 months at GH₵1,500. */
function twoYearAdvance() {
  const terms = checkLeaseTerms({
    startDate: '2026-11-01',
    endDate: '2028-10-31',
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    initialAdvanceMonths: 24,
    noticeDays: 30,
    use: 'residential',
  });
  const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
    id: `cp-${p.sequence}`,
    sequence: p.sequence,
    chargeType: p.chargeType,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountMinor: p.amountMinor,
    source: 'schedule' as const,
  }));
  const cycles = invoiceCycles({
    cycle: terms.cycle,
    initialAdvanceMonths: terms.initialAdvanceMonths,
    schedule,
    billingStartDate: terms.startDate,
    lastBillableDay: terms.endDate,
    leadDays: 14,
  });
  const model = new LeaseLedgerModel('2026-10-18');
  const issued = new Set<string>();
  const tick = () => {
    for (const c of cyclesToIssue(cycles, model.today, issued)) {
      model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
      issued.add(c.cycleStart);
    }
    model.accrueTo(model.today);
  };
  tick();
  return { model, tick };
}

describe('AR-01 a two-year advance month by month', () => {
  it('recognises GH₵1,500 a month from the advance; unearned rent falls by GH₵1,500; paid-until stays put', () => {
    const { model, tick } = twoYearAdvance();
    while (model.today < '2026-10-25') {
      model.nextDay();
      tick();
    }
    model.pay(3_600_000, '1050');
    expect(model.walk().paidUntil).toBe('2028-10-31');
    expect(model.walk().unearnedRentMinor).toBe(3_600_000);
    let months = 0;
    while (model.today < '2028-11-05') {
      model.nextDay();
      tick();
      model.checkInvariants();
      if (model.today.endsWith('-01')) {
        months += 1;
        const journal = model.journal();
        const recognised = -balanceOf(journal, { accountCode: '4000' });
        const prepayments = -balanceOf(journal, { accountCode: '2010' });
        expect(recognised).toBe(150_000 * Math.min(months, 24));
        expect(recognised + prepayments).toBe(3_600_000);
        const walk = model.walk();
        expect(walk.paidUntil).toBe('2028-10-31');
        expect(walk.unearnedRentMinor).toBe(3_600_000 - 150_000 * Math.min(months, 24));
        expect(balanceOf(journal, { accountCode: '1100' })).toBe(0);
      }
    }
    expect(months).toBe(25);
  });
});

describe('AR-02 paid-until and partial cover', () => {
  function monthly(withService: boolean) {
    const terms = checkLeaseTerms({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      monthlyRentMinor: 150_000,
      serviceChargeMonthlyMinor: withService ? 20_000 : null,
      cycle: 'monthly',
      noticeDays: 30,
      use: 'residential',
    });
    const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
      id: `cp-${p.chargeType}-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'schedule' as const,
    }));
    const model = new LeaseLedgerModel('2026-11-03');
    model.scheduled = schedule.map((s) => ({ ...s }));
    const cycles = invoiceCycles({
      cycle: 'monthly',
      initialAdvanceMonths: null,
      schedule,
      billingStartDate: terms.startDate,
      lastBillableDay: terms.endDate,
      leadDays: 14,
    });
    for (const c of cyclesToIssue(cycles, model.today, new Set()))
      model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
    model.accrueTo(model.today);
    return model;
  }

  it('shows the last whole month covered, plus what went towards the next one', () => {
    const model = monthly(true);
    model.pay(170_000 * 2 + 50_000);
    const walk = model.walk();
    expect(walk.paidUntil).toBe('2026-12-31');
    expect(walk.partial).toEqual({ monthStart: '2027-01-01', amountMinor: 50_000 });
  });

  it('counts a month covered only when its rent and service charge both are', () => {
    const model = monthly(true);
    model.pay(150_000);
    expect(model.walk().paidUntil).toBeNull();
    expect(model.walk().partial).toEqual({ monthStart: '2026-11-01', amountMinor: 150_000 });
  });

  it('applies credit forward to months not invoiced yet', () => {
    const model = monthly(false);
    model.pay(150_000 * 5);
    expect(model.walk().paidUntil).toBe('2027-03-31');
    expect(model.walk().unearnedRentMinor).toBe(150_000 * 4);
  });

  it('works out what is due now and overdue, net of credit that will cover it', () => {
    const model = monthly(false);
    const pools = creditPools(model.payments, model.allocations);
    const summary = moneySummary({
      lines: model.lines,
      allocations: model.allocations,
      pools,
      walk: model.walk(),
      today: model.today,
    });
    expect(summary).toMatchObject({
      dueNowMinor: 150_000,
      overdueMinor: 150_000,
      earnedUnpaidMinor: 150_000,
    });
  });
});

describe('BC-08 arrears ageing', () => {
  it('buckets days past the due date', () => {
    expect(ageBucket('2026-11-01', '2026-11-01')).toBeNull();
    expect(ageBucket('2026-11-01', '2026-11-02')).toBe('0_30');
    expect(ageBucket('2026-11-01', '2026-12-01')).toBe('0_30');
    expect(ageBucket('2026-11-01', '2026-12-02')).toBe('31_60');
    expect(ageBucket('2026-11-01', '2027-01-30')).toBe('61_90');
    expect(ageBucket('2026-11-01', '2027-01-31')).toBe('90_plus');
  });

  it('ages what is still owed after the walk, line by line', () => {
    const terms = checkLeaseTerms({
      startDate: '2026-08-01',
      endDate: '2027-07-31',
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      use: 'residential',
    });
    const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
      id: `cp-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'schedule' as const,
    }));
    const model = new LeaseLedgerModel('2026-11-04');
    const cycles = invoiceCycles({
      cycle: 'monthly',
      initialAdvanceMonths: null,
      schedule,
      billingStartDate: terms.startDate,
      lastBillableDay: terms.endDate,
      leadDays: 14,
    });
    for (const c of cyclesToIssue(cycles, model.today, new Set()))
      model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
    model.accrueTo(model.today);
    model.pay(100_000);
    const aged = agedLines({
      lines: model.lines,
      allocations: model.allocations,
      walk: model.walk(),
      asOf: model.today,
    });
    expect(aged.map((a) => [a.dueDate, a.bucket, a.amountMinor])).toEqual([
      ['2026-08-01', '90_plus', 50_000],
      ['2026-09-01', '61_90', 150_000],
      ['2026-10-01', '31_60', 150_000],
      ['2026-11-01', '0_30', 150_000],
    ]);
  });
});

describe('AR-02 a part payment on an annual invoice with service charge (M4b decision 9)', () => {
  it('covers whole months, so paid-until moves month by month', () => {
    const terms = checkLeaseTerms({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      monthlyRentMinor: 150_000,
      serviceChargeMonthlyMinor: 20_000,
      cycle: 'annual',
      noticeDays: 30,
      use: 'residential',
    });
    const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
      id: `cp-${p.chargeType}-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'schedule' as const,
    }));
    const model = new LeaseLedgerModel('2026-10-18');
    model.scheduled = schedule.map((s) => ({ ...s }));
    const cycles = invoiceCycles({
      cycle: 'annual',
      initialAdvanceMonths: null,
      schedule,
      billingStartDate: terms.startDate,
      lastBillableDay: terms.endDate,
      leadDays: 14,
    });
    for (const c of cyclesToIssue(cycles, model.today, new Set()))
      model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
    model.pay(170_000 * 3 + 100_000);
    model.checkMonthByMonth();
    const walk = model.walk();
    expect(walk.paidUntil).toBe('2027-01-31');
    expect(walk.partial).toEqual({ monthStart: '2027-02-01', amountMinor: 100_000 });
    // Each month as it starts is fully covered, service charge included.
    while (model.today < '2027-01-02') {
      model.nextDay();
      model.accrueTo(model.today);
    }
    model.checkInvariants();
    expect(balanceOf(model.journal(), { accountCode: '1100' })).toBe(0);
    expect(-balanceOf(model.journal(), { accountCode: '4100' })).toBe(20_000 * 3);
  });
});
