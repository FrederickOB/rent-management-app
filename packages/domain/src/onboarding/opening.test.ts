import { describe, expect, it } from 'vitest';
import { planAccrual } from '../billing/allocation';
import { planCreditNote } from '../billing/corrections';
import { firstPeriodStartOnOrAfter } from '../billing/invoicing';
import {
  ALLOCATION_SOURCES,
  chargedAccountOf,
  isOpeningAllocation,
  linesToAccrue,
  postingClassAt,
  type BillingLine,
} from '../billing/lines';
import { VAT_RATES, type Operation, type ScenarioLease } from '../billing/testing/scenarios';
import { DomainError } from '../errors';
import { chargeAllocations, feeBearing, type FeeAllocation } from '../ledger/allocation-fees';
import { balanceOf } from '../ledger/journal';
import { depositApplicationLines } from '../ledger/moveout-posting';
import { creditNoteLines } from '../ledger/posting';
import { ledgerArrears } from '../reporting/dashboard';
import { checkLeaseTerms } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import {
  accrueOpeningState,
  advanceFromPaidThrough,
  openingLeaseFigures,
  openingOwnerTotals,
  planOpeningAdjustment,
  planOpeningLease,
  planOwnerOpening,
  type OpeningItems,
} from './opening';
import { ImportedRunner, platformTwin, TaxBook } from './testing';

/** A lease from 15 January 2026 for 18 months at GH₵1,500, imported at a cut-over of 10 November. */
function example(options: { serviceCharge?: number } = {}): ScenarioLease {
  const terms = checkLeaseTerms({
    startDate: '2026-01-15',
    endDate: '2027-07-14',
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    serviceChargeMonthlyMinor: options.serviceCharge ?? null,
    noticeDays: 30,
    use: 'residential',
  });
  const schedule = rentSchedule(terms).map((p) => ({
    id: `cp-${p.chargeType}-${p.sequence}`,
    sequence: p.sequence,
    chargeType: p.chargeType,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountMinor: p.amountMinor,
    source: 'schedule' as const,
  }));
  return { terms, schedule, vat: null };
}

const CUT_OVER = '2026-11-10';

function imported(lease: ScenarioLease = example()): ImportedRunner {
  const billingStart = firstPeriodStartOnOrAfter(lease.terms, CUT_OVER);
  expect(billingStart).toBe('2026-11-15');
  return new ImportedRunner(lease, CUT_OVER, billingStart);
}

const arrears = (
  i: number,
  periodStart: string,
  amountMinor: number,
  dueDate = periodStart,
  kind: 'rent' | 'service_charge' = 'rent',
) => ({
  itemId: `arrears-${i}`,
  lineId: `opening-line-${i}`,
  kind,
  periodStart,
  dueDate,
  amountMinor,
});
const advance = (amountMinor: number, n = 1) => ({
  itemId: `advance-${n}`,
  paymentId: `opening-pay-${n}`,
  order: `${CUT_OVER}#000000${n}`,
  amountMinor,
});

function commit(run: ImportedRunner, items: OpeningItems, batchId = 'batch-1') {
  const plan = planOpeningLease({ ...run.context(batchId), state: run.state(), items });
  run.adopt(plan);
  run.model.checkInvariants();
  return plan;
}

const figures = (run: ImportedRunner, withholdingOutstandingMinor = 0) =>
  openingLeaseFigures({
    state: run.state(),
    scheduled: run.model.scheduled,
    asOf: run.model.today,
    lastDay: run.model.lastDay,
    withholdingOutstandingMinor,
  });

const feeRows = (run: ImportedRunner): FeeAllocation[] =>
  run.model.allocations.map((a, i) => ({
    id: `a-${i}`,
    lineId: a.lineId,
    lineKind: (run.model.lines.find((l) => l.id === a.lineId) as BillingLine).kind,
    source: a.source,
    paymentId: a.paymentId,
    amountMinor: a.amountMinor,
    opening: isOpeningAllocation(a, run.openingPaymentIds()),
  }));

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('P25 opening arrears (AR-01): owed against 3900, never income, never accrued again', () => {
  it('arrive at their original periods and due dates, accrued at commit: Dr 1100, Cr 3900', () => {
    const run = imported();
    const plan = commit(run, {
      arrears: [arrears(0, '2026-09-15', 150_000), arrears(1, '2026-10-15', 100_000, '2026-10-20')],
    });
    expect(
      plan.lines.map((l) => [l.periodStart, l.periodEnd, l.dueDate, l.chargePeriodId]),
    ).toEqual([
      ['2026-09-15', '2026-10-14', '2026-09-15', 'cp-rent-8'],
      ['2026-10-15', '2026-11-14', '2026-10-20', 'cp-rent-9'],
    ]);
    expect(plan.lines.every((l) => l.opening && l.accrued && l.chargedOn === CUT_OVER)).toBe(true);
    expect(plan.entries.map((e) => [e.key, e.valueDate])).toEqual([
      ['P25:batch-1:arrears-0', CUT_OVER],
      ['P25:batch-1:arrears-1', CUT_OVER],
    ]);
    const journal = run.model.journal();
    expect(balanceOf(journal, { accountCode: '1100', invoiceLineId: 'opening-line-0' })).toBe(
      150_000,
    );
    expect(balanceOf(journal, { accountCode: '3900' })).toBe(-250_000);
    expect(balanceOf(journal, { accountCode: '4000' })).toBe(0);
    // Months later, the daily accrual has charged the platform's months but never these.
    run.days(40);
    run.model.checkInvariants();
    const later = run.model.journal();
    for (const id of ['opening-line-0', 'opening-line-1']) {
      expect(balanceOf(later, { accountCode: '4000', invoiceLineId: id })).toBe(0);
      expect(run.model.entries.some((e) => e.key === `P02:${id}`)).toBe(false);
    }
    expect(balanceOf(later, { accountCode: '4000' })).toBe(-300_000); // 15 Nov and 15 Dec
    expect(linesToAccrue(run.model.lines, '2030-01-01').some((l) => l.opening)).toBe(false);
    const line = run.model.lines.find((l) => l.id === 'opening-line-0') as BillingLine;
    expect(codeOf(() => planAccrual(line, [], []))).toBe('billing.already_accrued');
    expect(codeOf(() => planAccrual({ ...line, accrued: false }, [], []))).toBe(
      'billing.opening_line',
    );
  });

  it('BC-08 are aged by their due dates as the dashboard ages them; paid-until starts at none', () => {
    const run = imported();
    commit(run, {
      arrears: [arrears(0, '2026-09-15', 150_000), arrears(1, '2026-10-15', 150_000)],
    });
    const f = figures(run);
    expect(f).toEqual({
      arrearsMinor: 300_000,
      arrearsByAge: { '0_30': 150_000, '31_60': 150_000, '61_90': 0, '90_plus': 0 },
      advanceMinor: 0,
      paidUntil: null,
      depositHeldMinor: 0,
      withholdingOutstandingMinor: 0,
      balanceMinor: 300_000,
    });
    expect(
      ledgerArrears({ lines: run.model.lines, allocations: run.model.allocations, asOf: CUT_OVER })
        .byBucket,
    ).toEqual(f.arrearsByAge);
  });

  it('P27 a credit note on an opening line reverses against 3900, never income', () => {
    const run = imported();
    commit(run, { arrears: [arrears(0, '2026-10-15', 150_000)] });
    run.days(2);
    run.pay(100_000);
    const line = run.model.lines.find((l) => l.id === 'opening-line-0') as BillingLine;
    expect(chargedAccountOf(line)).toBe('3900');
    const [part] = planCreditNote({
      line,
      taxLines: [],
      allocations: run.model.allocations,
      payments: run.model.payments,
      amountMinor: 120_000,
    });
    expect(part?.chargedTo).toBe('3900');
    const lines = creditNoteLines({
      bookId: run.model.book,
      lease: run.model.lease,
      invoiceLineId: line.id,
      chargedTo: '3900',
      unpaidMinor: part?.unpaidMinor ?? 0,
      released: part?.released ?? [],
    });
    expect(lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['3900', 120_000],
      ['1100', -50_000],
      ['2010', -70_000],
    ]);
    run.model.creditNote(line.id, 120_000, 'cn-1');
    run.model.checkInvariants();
    expect(run.model.balance('4000', { invoiceLineId: line.id })).toBe(0);
  });
});

describe('P25 the opening payment (AR-01, AR-02, BC-07): an advance held in 2010, drawn first', () => {
  it('pays opening arrears first, oldest first, then is held: paid-until counts it', () => {
    const run = imported();
    const plan = commit(run, {
      arrears: [arrears(0, '2026-09-15', 150_000), arrears(1, '2026-10-15', 100_000)],
      advances: [advance(400_000)],
    });
    // The 15 November invoice was issued on 1 November: the rest of the advance is held on it.
    const [entry] = plan.entries.filter((e) => e.key === 'P25:batch-1:advance-1');
    expect(
      entry?.lines.map((l) => [l.accountCode, l.amountMinor, l.invoiceLineId ?? null]),
    ).toEqual([
      ['3900', 400_000, null],
      ['1100', -150_000, 'opening-line-0'],
      ['1100', -100_000, 'opening-line-1'],
      ['2010', -150_000, run.model.lines.find((l) => l.periodStart === '2026-11-15')?.id],
    ]);
    expect(plan.payments).toEqual([
      {
        id: 'opening-pay-1',
        amountMinor: 400_000,
        order: `${CUT_OVER}#0000001`,
        itemId: 'advance-1',
        receivedOn: CUT_OVER,
      },
    ]);
    expect(figures(run)).toMatchObject({
      arrearsMinor: 0,
      advanceMinor: 150_000,
      paidUntil: '2026-12-14',
      balanceMinor: -150_000,
    });
  });

  it('an advance given as a paid-through date becomes exactly the months it covers', () => {
    const run = imported(example({ serviceCharge: 20_000 }));
    const paidThrough = '2027-02-14';
    const amount = advanceFromPaidThrough({
      periods: run.platformPeriods(),
      billingStart: run.billingStart,
      paidThrough,
    });
    expect(amount).toBe(3 * 170_000);
    commit(run, { advances: [advance(amount)] });
    expect(figures(run)).toMatchObject({ advanceMinor: 510_000, paidUntil: paidThrough });
    // Nothing ahead of the billing start is nothing to bring in.
    expect(
      advanceFromPaidThrough({
        periods: run.platformPeriods(),
        billingStart: run.billingStart,
        paidThrough: '2026-11-14',
      }),
    ).toBe(0);
    expect(
      codeOf(() =>
        advanceFromPaidThrough({
          periods: run.platformPeriods(),
          billingStart: run.billingStart,
          paidThrough: '2027-02-10',
        }),
      ),
    ).toBe('opening.paid_through_not_period_end');
    expect(
      codeOf(() =>
        advanceFromPaidThrough({
          periods: run.platformPeriods(),
          billingStart: run.billingStart,
          paidThrough: '2027-08-14',
        }),
      ),
    ).toBe('opening.paid_through_not_period_end');
  });

  it('is drawn before credit paid on the platform, first in, first out, and issues no receipt', () => {
    const run = imported();
    commit(run, { advances: [advance(300_000)] });
    run.days(5);
    run.pay(200_000); // 15 November is paid ahead by the advance; this is credit too
    run.days(40); // 15 November and 15 December start
    const draws = run.model.allocations.filter((a) => a.source === 'payment');
    expect(draws.every((a) => a.paymentId === 'opening-pay-1')).toBe(true);
    // Its entry is P25's, dated the cut-over: no receipt, no P03, no receipt number.
    expect(run.model.entries.some((e) => e.key === 'P03:opening-pay-1')).toBe(false);
    expect(run.model.entries.find((e) => e.key === 'P25:batch-1:advance-1')?.valueDate).toBe(
      CUT_OVER,
    );
    expect(figures(run)).toMatchObject({ advanceMinor: 200_000, paidUntil: '2027-02-14' });
    run.model.checkInvariants();
  });
});

describe('BC-11 the deposit held at the cut-over: settled, in 2100, never income', () => {
  it('is a settled opening deposit line, so move-out takes it as any deposit', () => {
    const run = imported();
    const plan = commit(run, {
      deposits: [{ itemId: 'deposit', lineId: 'dep-1', amountMinor: 300_000 }],
    });
    expect(plan.allocations).toEqual([
      {
        lineId: 'dep-1',
        source: 'opening_balance',
        paymentId: null,
        amountMinor: 300_000,
        recordId: 'deposit',
        itemId: 'deposit',
        valueDate: CUT_OVER,
      },
    ]);
    expect(run.model.balance('2100', { leaseId: 'lease-1' })).toBe(-300_000);
    expect(figures(run).depositHeldMinor).toBe(300_000);
    expect(ALLOCATION_SOURCES).toContain('opening_balance');
    // P11 takes a share with no payment behind it, as the engine's deposit parts give it.
    const applied = depositApplicationLines({
      bookId: run.model.book,
      lease: run.model.lease,
      shares: [{ paymentId: null, amountMinor: 300_000 }],
      lines: [{ invoiceLineId: 'x', amountMinor: 200_000 }],
      retainedMinor: 100_000,
    });
    expect(balanceOf([...run.model.journal(), ...applied], { accountCode: '2100' })).toBe(0);
  });
});

describe('TX-01 rent tax: none on opening money; arrears paid after the cut-over taxed as usual', () => {
  it('an advance brought in is never taxed, nor its credit drawn onto later months', () => {
    const run = imported();
    commit(run, { advances: [advance(450_000)] });
    const tax = new TaxBook(true);
    expect(tax.base(run)).toBe(0);
    expect(new TaxBook(false).base(run)).toBe(450_000); // what P25 leaves out
    run.days(70);
    expect(tax.base(run)).toBe(0);
    // A month paid on the platform beyond the advance is rent received, taxed in full (D9).
    const p = run.pay(150_000);
    expect(tax.receipt(run, p.id)).toBe(150_000);
  });

  it('a receipt that pays opening arrears is taxed on the rent it covers', () => {
    const run = imported();
    commit(run, {
      arrears: [arrears(0, '2026-09-15', 150_000), arrears(1, '2026-10-15', 150_000)],
    });
    run.days(2);
    const p = run.pay(200_000);
    expect(new TaxBook(true).receipt(run, p.id)).toBe(200_000);
  });

  it('with arrears and an advance, only what the platform receipt adds is taxed', () => {
    const run = imported();
    commit(run, {
      arrears: [arrears(0, '2026-10-15', 150_000)],
      advances: [advance(100_000)],
    });
    const tax = new TaxBook(true);
    expect(tax.base(run)).toBe(0);
    const p = run.pay(200_000); // 50,000 of October, then 150,000 of 15 November
    expect(tax.receipt(run, p.id)).toBe(200_000);
  });
});

describe('TX-01 a receipt is taxed on the rent its own money covers, never on the opening advance', () => {
  it('when the advance’s credit is pushed from rent onto VAT and back (the seed -2052424322 case)', () => {
    // A commercial lease, VAT on rent only, billed from the cut-over, with GH₵132,391.24 brought
    // in as an advance. The twin is the same lease billed on the platform, the advance received as
    // an ordinary payment and taxed on the GH₵110,868.34 of rent it covered then (M5's walk).
    const terms = checkLeaseTerms({
      startDate: '2027-05-13',
      endDate: '2028-08-01',
      monthlyRentMinor: 1_793_579,
      cycle: 'monthly',
      serviceChargeMonthlyMinor: 117,
      noticeDays: 30,
      use: 'commercial',
    });
    const lease: ScenarioLease = {
      terms,
      schedule: rentSchedule(terms).map((p) => ({
        id: `cp-${p.chargeType}-${p.sequence}`,
        sequence: p.sequence,
        chargeType: p.chargeType,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        amountMinor: p.amountMinor,
        source: 'schedule' as const,
      })),
      vat: { ...VAT_RATES, appliesToServiceCharge: false },
    };
    const run = new ImportedRunner(lease, '2027-06-13', '2027-06-13');
    const items: OpeningItems = {
      advances: [
        {
          itemId: 'advance',
          paymentId: 'opening-pay-1',
          order: '2027-06-13#0000000',
          amountMinor: 13_239_124,
        },
      ],
    };
    run.adopt(planOpeningLease({ ...run.context('b'), state: run.state(), items }));
    const twin = platformTwin(run, items);
    const ours = new TaxBook(true);
    const theirs = new TaxBook(false);
    const twinAdvance = twin.model.payments.at(-1)?.id as string;
    expect(theirs.receipt(twin, twinAdvance)).toBe(11_086_834);
    expect(ours.base(run)).toBe(0);

    const ops: Operation[] = [
      { kind: 'days', days: 16 },
      { kind: 'pay', amountMinor: 1_385_267, cash: '1050', daysBack: 0 },
      { kind: 'pay', amountMinor: 83_653, cash: '1050', daysBack: 0 },
      { kind: 'pay', amountMinor: 1, cash: '1050', daysBack: 0 },
      { kind: 'days', days: 13 },
      // The advance's credit reaches exactly to the end of December's rent: this pesewa pays July
      // and pushes the advance's last pesewa onto December's VAT, which is not rent.
      { kind: 'pay', amountMinor: 1, cash: '1050', daysBack: 0 },
      // Reversing the GH₵836.53 receipt brings that pesewa of the advance back onto rent.
      { kind: 'reverse', pick: 1 },
      { kind: 'days', days: 1 },
      { kind: 'pay', amountMinor: 83_653, cash: '1050', daysBack: 0 },
    ];
    const ourBases: number[] = [];
    const twinBases: number[] = [];
    for (const op of ops) {
      run.apply(op);
      twin.apply(op);
      // The money is the same in both: the same walk, line for line.
      expect(run.balancesByKey()).toEqual(twin.balancesByKey());
      if (op.kind === 'reverse') {
        ours.reverse(run.platformPayments[1] as string);
        theirs.reverse(twin.platformPayments[1] as string);
      } else if (op.kind === 'pay') {
        ourBases.push(ours.receipt(run, run.platformPayments.at(-1) as string));
        twinBases.push(theirs.receipt(twin, twin.platformPayments.at(-1) as string));
      }
    }
    // Each of our receipts is taxed on the rent its own money covers. The twin's cumulative walk
    // charges the 12 July pesewa to the advance's lost rent, then recovers it from the next receipt.
    expect(ourBases).toEqual([1_385_267, 83_653, 1, 1, 83_652]);
    expect(twinBases).toEqual([1_385_267, 83_653, 1, 0, 83_653]);
    // Live receipts (the reversed one left out) carry the same base in total: all the rent the
    // platform's money covers, and the advance none of it.
    const live = (bases: number[]) => bases.reduce((s, b) => s + b, 0) - bases[1]!;
    expect(live(ourBases)).toBe(live(twinBases));
    expect(live(ourBases)).toBe(1_468_921);
  });
});

describe('AC-02 management fees: none on opening money; a receipt paying opening arrears carries one', () => {
  it('allocations of opening money bear no fee; a platform payment on an opening line does', () => {
    const run = imported();
    commit(run, {
      arrears: [arrears(0, '2026-09-15', 150_000), arrears(1, '2026-10-15', 150_000)],
      advances: [advance(200_000)],
      deposits: [{ itemId: 'deposit', lineId: 'dep-1', amountMinor: 300_000 }],
    });
    expect(feeRows(run).filter(feeBearing)).toEqual([]);
    expect(chargeAllocations(feeRows(run), 1_000)).toEqual([]);
    run.days(2);
    const p = run.pay(100_000);
    const charged = chargeAllocations(feeRows(run), 1_000);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({ paymentId: p.id, baseMinor: 100_000, feeMinor: 10_000 });
  });
});

describe('P25 validation', () => {
  const plan = (
    items: OpeningItems,
    extra: Partial<ReturnType<ImportedRunner['context']>> = {},
  ) => {
    const run = imported();
    return codeOf(() =>
      planOpeningLease({ ...run.context('b'), ...extra, state: run.state(), items }),
    );
  };

  it('arrears are for the lease’s periods before billing starts, once each', () => {
    expect(plan({ arrears: [arrears(0, '2026-09-16', 1)] })).toBe('opening.not_a_period');
    expect(plan({ arrears: [arrears(0, '2026-11-15', 1)] })).toBe('opening.period_billed');
    expect(plan({ arrears: [arrears(0, '2026-09-15', 1, '2026-09-15', 'service_charge')] })).toBe(
      'opening.not_a_period',
    );
    expect(plan({ arrears: [arrears(0, '2026-09-15', 1), arrears(1, '2026-09-15', 2)] })).toBe(
      'opening.repeated_period',
    );
    expect(plan({ arrears: [arrears(0, '2026-09-15', 0)] })).toBe('opening.bad_amount');
    expect(plan({ arrears: [arrears(0, '2026-09-15', 1, 'soon')] })).toBe('opening.bad_date');
  });

  it('items are above zero, each given once, and post on or after the cut-over', () => {
    expect(plan({ advances: [advance(-5)] })).toBe('opening.bad_amount');
    expect(plan({ deposits: [{ itemId: 'd', lineId: 'l', amountMinor: 1.5 }] })).toBe(
      'opening.bad_amount',
    );
    expect(
      plan({
        deposits: [
          { itemId: 'd', lineId: 'l1', amountMinor: 1 },
          { itemId: 'd', lineId: 'l2', amountMinor: 1 },
        ],
      }),
    ).toBe('opening.repeated_item');
    expect(plan({ advances: [advance(1)] }, { today: '2026-11-09' })).toBe(
      'opening.before_cut_over',
    );
    expect(plan({ withholding: [{ itemId: 'w', amountMinor: 0 }] })).toBe('opening.bad_amount');
  });

  it('committing the same items again plans the same entries, and never doubles them', () => {
    const fresh = imported();
    const items: OpeningItems = {
      arrears: [arrears(0, '2026-10-15', 150_000)],
      advances: [advance(400_000)],
      deposits: [{ itemId: 'deposit', lineId: 'dep-1', amountMinor: 300_000 }],
      withholding: [{ itemId: 'wht', amountMinor: 12_000 }],
    };
    const first = planOpeningLease({ ...fresh.context('b'), state: fresh.state(), items });
    const again = planOpeningLease({ ...fresh.context('b'), state: fresh.state(), items });
    expect(again).toEqual(first);
    fresh.adopt(first);
    const entries = fresh.model.entries.length;
    fresh.model.adopt({ entries: first.entries });
    expect(fresh.model.entries).toHaveLength(entries);
    // The records exist now: planning them again on top is refused, never a second copy.
    expect(
      codeOf(() => planOpeningLease({ ...fresh.context('b'), state: fresh.state(), items })),
    ).toBe('opening.line_exists');
  });
});

describe('P25 adjustments: signed changes, never below what is paid or drawn', () => {
  it('lowering arrears credits the opening line, refused below what has been paid', () => {
    const run = imported();
    commit(run, { arrears: [arrears(0, '2026-10-15', 150_000)] });
    run.days(2);
    run.pay(100_000);
    const lower = (amountMinor: number) =>
      planOpeningAdjustment({
        ...run.context('adj'),
        state: run.state(),
        lower: { arrears: [{ itemId: 'a', lineId: 'opening-line-0', amountMinor }] },
      });
    expect(codeOf(() => lower(50_001))).toBe('opening.below_paid');
    const plan = lower(50_000);
    expect(plan.entries[0]?.lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['3900', 50_000],
      ['1100', -50_000],
    ]);
    run.adopt(plan);
    run.model.checkInvariants();
    expect(figures(run).arrearsMinor).toBe(0);
  });

  it('lowering an advance is refused below what has been drawn from it', () => {
    const run = imported();
    commit(run, { advances: [advance(300_000)] });
    run.days(40); // 15 November (paid at commit) and 15 December draw 300,000 between them
    expect(figures(run).advanceMinor).toBe(0);
    run.model.checkInvariants();
    const lower = (amountMinor: number, paymentId?: string) =>
      planOpeningAdjustment({
        ...run.context('adj'),
        state: run.state(),
        lower: { advances: [{ itemId: 'a', paymentId, amountMinor }] },
      });
    expect(codeOf(() => lower(1))).toBe('opening.below_drawn');
    expect(codeOf(() => lower(1, 'payment-9'))).toBe('opening.not_opening_payment');
    // Raised again, then lowered within what is left.
    const raised = planOpeningAdjustment({
      ...run.context('adj-1'),
      state: run.state(),
      raise: { advances: [advance(150_000, 2)] },
    });
    run.adopt(raised);
    const plan = lower(100_000);
    expect(plan.reductions).toEqual([
      { itemId: 'a', paymentId: 'opening-pay-2', amountMinor: 100_000 },
    ]);
    expect(plan.entries[0]?.lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['2010', 100_000],
      ['3900', -100_000],
    ]);
    run.adopt(plan);
    run.model.checkInvariants();
    expect(figures(run).advanceMinor).toBe(50_000);
  });

  it('lowering a deposit is refused below what a move-out or renewal has taken', () => {
    const run = imported();
    commit(run, { deposits: [{ itemId: 'deposit', lineId: 'dep-1', amountMinor: 300_000 }] });
    const lower = (amountMinor: number, depositHeldMinor: number) =>
      planOpeningAdjustment({
        ...run.context('adj'),
        state: run.state(),
        depositHeldMinor,
        lower: { deposits: [{ itemId: 'd', amountMinor }] },
      });
    expect(codeOf(() => lower(100_000, 50_000))).toBe('opening.below_drawn');
    expect(codeOf(() => lower(300_001, 300_000))).toBe('opening.below_drawn');
    const plan = lower(100_000, 300_000);
    expect(plan.entries[0]?.lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['2100', 100_000],
      ['3900', -100_000],
    ]);
    run.adopt(plan);
    run.model.checkInvariants();
    expect(figures(run).depositHeldMinor).toBe(200_000);
  });

  it('raising arrears adds an opening item, which credit already held pays at once', () => {
    const run = imported();
    commit(run, { advances: [advance(450_000)] });
    const plan = planOpeningAdjustment({
      ...run.context('adj'),
      state: run.state(),
      raise: { arrears: [arrears(5, '2026-08-15', 100_000)] },
    });
    expect(plan.entries.map((e) => e.key)).toEqual([
      'P25:adj:arrears-5',
      'P02:opening-line-5:redraw:0',
    ]);
    run.adopt(plan);
    run.model.checkInvariants();
    expect(figures(run)).toMatchObject({ arrearsMinor: 0, advanceMinor: 350_000 });
  });

  it('withholding is lowered only within what is still outstanding', () => {
    const run = imported();
    const lower = (amountMinor: number, outstandingMinor: number) =>
      planOpeningAdjustment({
        ...run.context('adj'),
        state: run.state(),
        lower: { withholding: [{ itemId: 'w', amountMinor, outstandingMinor }] },
      });
    expect(codeOf(() => lower(5_001, 5_000))).toBe('opening.below_drawn');
    expect(
      lower(5_000, 5_000).entries[0]?.lines.map((l) => [l.accountCode, l.amountMinor]),
    ).toEqual([
      ['3900', 5_000],
      ['1150', -5_000],
    ]);
  });
});

describe('P25 owner items (AC-05, TX-02) and the preview totals', () => {
  it('agent-held cash and rent tax outstanding with its due date; lowering stays within what is left', () => {
    const plan = planOwnerOpening({
      batchId: 'b',
      cutOver: CUT_OVER,
      bookId: 'book-owner',
      changes: [
        { itemId: 'cash', kind: 'agent_cash', amountMinor: 500_000 },
        { itemId: 'tax', kind: 'rent_tax', amountMinor: 40_000, dueOn: '2026-11-24' },
      ],
    });
    expect(
      plan.entries.map((e) => [e.key, e.lines.map((l) => [l.accountCode, l.amountMinor])]),
    ).toEqual([
      [
        'P25:b:cash',
        [
          ['1070', 500_000],
          ['3900', -500_000],
        ],
      ],
      [
        'P25:b:tax',
        [
          ['3900', 40_000],
          ['2200', -40_000],
        ],
      ],
    ]);
    expect(plan.rentTaxItems).toEqual([
      { itemId: 'tax', amountMinor: 40_000, dueOn: '2026-11-24' },
    ]);
    const lower = (amountMinor: number, availableMinor: number) =>
      codeOf(() =>
        planOwnerOpening({
          batchId: 'adj',
          cutOver: CUT_OVER,
          bookId: 'book-owner',
          changes: [
            { itemId: 'x', kind: 'agent_cash', amountMinor, availableMinor },
            { itemId: 'y', kind: 'agent_cash', amountMinor, availableMinor },
          ],
        }),
      );
    expect(lower(-200_000, 300_000)).toBe('opening.below_drawn');
    expect(lower(-150_000, 300_000)).toBe('no error');
    expect(
      codeOf(() =>
        planOwnerOpening({
          batchId: 'b',
          cutOver: CUT_OVER,
          bookId: 'book-owner',
          changes: [{ itemId: 't', kind: 'rent_tax', amountMinor: 1 }],
        }),
      ),
    ).toBe('opening.bad_date');
  });

  it('owner totals add up their leases and their own items', () => {
    const run = imported();
    commit(run, {
      arrears: [arrears(0, '2026-10-15', 150_000)],
      deposits: [{ itemId: 'deposit', lineId: 'dep-1', amountMinor: 300_000 }],
    });
    const f = figures(run, 12_000);
    const totals = openingOwnerTotals({
      leases: [
        { ownerId: 'owner-1', figures: f },
        { ownerId: 'owner-1', figures: f },
        { ownerId: 'owner-2', figures: f },
      ],
      owners: [
        {
          ownerId: 'owner-1',
          agentCashMinor: 500_000,
          rentTaxOutstandingMinor: 40_000,
          rentTaxDueOn: '2026-12-01',
        },
        {
          ownerId: 'owner-1',
          agentCashMinor: 0,
          rentTaxOutstandingMinor: 10_000,
          rentTaxDueOn: '2026-11-24',
        },
      ],
    });
    expect(totals).toEqual([
      {
        ownerId: 'owner-1',
        leases: 2,
        arrearsMinor: 300_000,
        advancesMinor: 0,
        depositsHeldMinor: 600_000,
        withholdingOutstandingMinor: 24_000,
        agentCashMinor: 500_000,
        rentTaxOutstandingMinor: 50_000,
        rentTaxDueOn: '2026-11-24',
      },
      {
        ownerId: 'owner-2',
        leases: 1,
        arrearsMinor: 150_000,
        advancesMinor: 0,
        depositsHeldMinor: 300_000,
        withholdingOutstandingMinor: 12_000,
        agentCashMinor: 0,
        rentTaxOutstandingMinor: 0,
        rentTaxDueOn: null,
      },
    ]);
  });

  it('the preview brings the lease to the day as the daily accrual would', () => {
    const run = imported();
    commit(run, { advances: [advance(300_000)] });
    const state = accrueOpeningState(run.state(), '2026-12-20');
    const f = openingLeaseFigures({ state, scheduled: run.model.scheduled, asOf: '2026-12-20' });
    // 15 November was paid at commit; 15 December's invoice was not issued in this state, so the
    // walk still holds the credit for it.
    expect(f).toMatchObject({ advanceMinor: 150_000, paidUntil: '2027-01-14' });
    run.days(40);
    expect(figures(run)).toMatchObject({ advanceMinor: 0, paidUntil: '2027-01-14' });
  });

  it('opening lines are owed in the ledger from the cut-over', () => {
    const run = imported();
    commit(run, { arrears: [arrears(0, '2026-09-15', 150_000)] });
    const line = run.model.lines.find((l) => l.opening) as BillingLine;
    expect(postingClassAt(line, CUT_OVER)).toBe('receivable');
    expect(postingClassAt(line, '2026-11-01')).toBe('prepayment');
  });
});
