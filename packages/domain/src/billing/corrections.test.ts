import { describe, expect, it } from 'vitest';
import { balanceOf } from '../ledger/journal';
import { checkLeaseTerms } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import { linesAfterEnd, planCreditNote, planWriteOff } from './corrections';
import { cyclesToIssue, invoiceCycles, invoiceLinesFor, type ScheduleRow } from './invoicing';
import { lineBalance } from './lines';
import { LeaseLedgerModel } from './testing/lease-ledger';

const RATES = { vatBps: 1500, nhilBps: 250, getfundBps: 250, appliesToServiceCharge: true };

function lease(opts: { commercial?: boolean; startOn?: string } = {}) {
  const terms = checkLeaseTerms({
    startDate: '2026-11-01',
    endDate: '2027-10-31',
    monthlyRentMinor: 150_000,
    cycle: 'quarterly',
    depositMinor: 300_000,
    noticeDays: 30,
    use: opts.commercial ? 'commercial' : 'residential',
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
    initialAdvanceMonths: null,
    schedule,
    billingStartDate: terms.startDate,
    lastBillableDay: terms.endDate,
    leadDays: 14,
  });
  const model = new LeaseLedgerModel(opts.startOn ?? '2026-10-20');
  // Signed today: the deposit invoice is issued at once, due on the start date (decision 2).
  model.issue(
    [
      {
        kind: 'deposit',
        chargePeriodId: null,
        periodStart: null,
        periodEnd: null,
        amountMinor: 300_000,
        rateBps: null,
        baseIndex: null,
      },
    ],
    terms.startDate,
    'deposit',
  );
  const issued = new Set<string>();
  const tick = () => {
    for (const c of cyclesToIssue(cycles, model.today, issued)) {
      model.issue(invoiceLinesFor(c, opts.commercial ? RATES : null), c.dueDate, c.cycleStart);
      issued.add(c.cycleStart);
    }
    model.accrueTo(model.today);
  };
  const until = (date: string) => {
    while (model.today < date) {
      model.nextDay();
      tick();
    }
  };
  tick();
  return { model, until };
}

describe('P21 payment reversal from current allocations', () => {
  it('after accruals drew its credit, restores every line and the credit exactly', () => {
    const { model, until } = lease();
    const first = model.pay(450_000 + 300_000 + 200_000); // deposit, one quarter, and credit
    until('2027-02-10');
    const second = model.pay(450_000);
    model.checkInvariants();
    // The first payment's credit was drawn by February's rent when that quarter accrued.
    const drawn = model.allocations.filter(
      (a) => a.paymentId === first.id && a.source === 'payment',
    );
    expect(drawn.length).toBeGreaterThan(4);
    const before = model.lines.map((l) => [
      l.id,
      lineBalance(l, model.allocations).outstandingMinor,
    ]);
    const mark = model.allocations.length;
    model.reverse(first.id);
    model.checkInvariants();
    const added = model.allocations.slice(mark);
    for (const [id, outstandingBefore] of before) {
      const line = model.lines.find((l) => l.id === id);
      if (!line) throw new Error('line');
      const restored = lineBalance(line, model.allocations).outstandingMinor;
      const share = drawn.filter((a) => a.lineId === id).reduce((s, a) => s + a.amountMinor, 0);
      // P21 restores exactly: the reversal's own rows take back the payment's share of the line.
      const reversedRows = added
        .filter((a) => a.lineId === id && a.paymentId === first.id)
        .reduce((s, a) => s + a.amountMinor, 0);
      expect(reversedRows).toBe(0 - share);
      // Then the later payment's credit pays what the reversal reopened (M4b review F4).
      const redrawn = added
        .filter((a) => a.lineId === id && a.paymentId !== first.id)
        .reduce((s, a) => s + a.amountMinor, 0);
      expect(restored).toBe((outstandingBefore as number) + share - redrawn);
    }
    // The deposit it paid left deposits held; the later payment is untouched.
    expect(balanceOf(model.journal(), { accountCode: '2100' })).toBe(0);
    expect(balanceOf(model.journal(), { accountCode: '1050', paymentId: second.id })).toBe(450_000);
    expect(balanceOf(model.journal(), { accountCode: '1050', paymentId: first.id })).toBe(0);
  });
});

describe('P27 credit notes', () => {
  it('a line not yet accrued is cancelled with no income entry, and its money returns to credit', () => {
    const { model } = lease();
    const payment = model.pay(300_000 + 450_000);
    const december = model.lines.find((l) => l.periodStart === '2026-12-01');
    if (!december) throw new Error('line');
    const incomeBefore = balanceOf(model.journal(), { accountCode: '4000' });
    model.creditNote(december.id, december.amountMinor, 'cancel-december');
    model.checkInvariants();
    expect(balanceOf(model.journal(), { accountCode: '4000' })).toBe(incomeBefore);
    expect(lineBalance(december, model.allocations)).toMatchObject({
      netMinor: 0,
      outstandingMinor: 0,
    });
    expect(model.walk().lines.find((l) => l.lineId === december.id)?.remainingMinor).toBe(0);
    expect(
      model.allocations
        .filter((a) => a.paymentId === payment.id)
        .reduce((s, a) => s + a.amountMinor, 0),
    ).toBe(300_000 + 300_000);
  });

  it('an accrued, unpaid line stops being owed and its income is reversed', () => {
    const { model, until } = lease();
    until('2026-11-02');
    const november = model.lines.find((l) => l.periodStart === '2026-11-01');
    if (!november) throw new Error('line');
    model.creditNote(november.id, 50_000, 'reduce-november');
    model.checkInvariants();
    expect(-balanceOf(model.journal(), { accountCode: '4000' })).toBe(100_000);
    expect(balanceOf(model.journal(), { accountCode: '1100', invoiceLineId: november.id })).toBe(
      100_000,
    );
  });

  it('an accrued, paid line returns the payment’s money to its credit', () => {
    const { model, until } = lease();
    until('2026-11-02');
    const payment = model.pay(300_000 + 450_000);
    const november = model.lines.find((l) => l.periodStart === '2026-11-01');
    if (!november) throw new Error('line');
    model.creditNote(november.id, 150_000, 'void-november');
    model.checkInvariants();
    expect(
      -balanceOf(model.journal(), {
        accountCode: '2010',
        paymentId: payment.id,
        invoiceLineId: null,
      }),
    ).toBe(150_000);
    expect(balanceOf(model.journal(), { accountCode: '4000' })).toBe(0);
  });

  it('takes the VAT and levies off with the line they are charged on', () => {
    const { model, until } = lease({ commercial: true });
    until('2026-11-02');
    const november = model.lines.find((l) => l.periodStart === '2026-11-01');
    if (!november) throw new Error('line');
    const taxes = model.lines.filter((l) => l.baseLineId === november.id);
    expect(taxes.map((t) => t.amountMinor)).toEqual([22_500, 3_750, 3_750]);
    model.creditNote(november.id, 50_000, 'reduce');
    model.checkInvariants();
    expect(taxes.map((t) => lineBalance(t, model.allocations).netMinor)).toEqual([
      15_000, 2_500, 2_500,
    ]);
  });

  it('credits only the unpaid part of a deposit', () => {
    const { model } = lease();
    model.pay(200_000);
    const deposit = model.lines.find((l) => l.kind === 'deposit');
    if (!deposit) throw new Error('line');
    expect(() =>
      planCreditNote({
        line: deposit,
        taxLines: [],
        allocations: model.allocations,
        payments: model.payments,
        amountMinor: 100_001,
      }),
    ).toThrow(/unpaid part of a deposit/);
    model.creditNote(deposit.id, 100_000, 'deposit-reduced');
    model.checkInvariants();
  });
});

describe('P24 write-offs', () => {
  it('writes off only what is owed on a charged line', () => {
    const { model, until } = lease();
    until('2026-11-02');
    const november = model.lines.find((l) => l.periodStart === '2026-11-01');
    const december = model.lines.find((l) => l.periodStart === '2026-12-01');
    if (!november || !december) throw new Error('line');
    expect(() =>
      planWriteOff({ line: december, allocations: model.allocations, amountMinor: 1 }),
    ).toThrow(/already owed/);
    expect(() =>
      planWriteOff({ line: november, allocations: model.allocations, amountMinor: 150_001 }),
    ).toThrow(/exceed/);
    model.writeOff(november.id, 150_000, 'bad-debt');
    model.checkInvariants();
    expect(balanceOf(model.journal(), { accountCode: '5900' })).toBe(150_000);
    expect(balanceOf(model.journal(), { accountCode: '1100' })).toBe(0);
  });
});

describe('BC-01 no billing after a lease ends', () => {
  it('finds the lines of periods that start after the last day', () => {
    const { model } = lease();
    expect(linesAfterEnd(model.lines, '2026-11-20').map((l) => l.periodStart)).toEqual([
      '2026-12-01',
      '2027-01-01',
    ]);
  });
});
