import fc from 'fast-check';
import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import {
  cyclesToIssue,
  expectedTaxMinor,
  invoiceCycles,
  invoiceLinesFor,
  type InvoiceCycle,
} from '../billing/invoicing';
import { isTax, lineBalance, postingClassOf, type BillingLine } from '../billing/lines';
import { LeaseLedgerModel, type ModelPayment } from '../billing/testing/lease-ledger';
import {
  moveOutDay,
  receivedOn,
  type Operation,
  type ScenarioLease,
} from '../billing/testing/scenarios';
import { receiptTax, receiptTaxBase, taxPeriodsFromWalk, type TaxPeriod } from '../tax/rent-tax';
import {
  advanceFromPaidThrough,
  type OpeningItems,
  type OpeningLeaseContext,
  type OpeningLeasePlan,
  type OpeningLeaseState,
} from './opening';

/**
 * Test support for opening balances (P25): a lease imported at a cut-over, billed on the platform
 * from its billing start, in the in-memory model of M4a, and random Balances workbooks for it.
 */

export const LEAD_DAYS = 14;
export const TAX_RULES = {
  rateBps: 800,
  includesServiceCharge: true,
  dueDays: 30,
  alertDays: [21, 28],
};

const day = (iso: string, days: number) => toIsoDate(addDays(parseBusinessDate(iso), days));

/** A lease billed from `billingStart`, as the platform bills an imported paper lease. */
export class ImportedRunner {
  readonly model: LeaseLedgerModel;
  private readonly cycles: InvoiceCycle[];
  private readonly issued = new Set<string>();
  /** The charge period behind each invoice line, for the rent tax walk. */
  readonly periodOf = new Map<string, string>();
  /** Payments recorded on the platform, in order. */
  readonly platformPayments: string[] = [];

  constructor(
    readonly lease: ScenarioLease,
    readonly cutOver: string,
    readonly billingStart: string,
  ) {
    this.model = new LeaseLedgerModel(cutOver);
    this.model.scheduled = this.platformRows().map((s) => ({
      id: s.id,
      chargeType: s.chargeType,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      amountMinor: s.amountMinor,
      taxMinor: expectedTaxMinor(s, lease.vat),
    }));
    this.cycles = invoiceCycles({
      cycle: lease.terms.cycle,
      initialAdvanceMonths: lease.terms.initialAdvanceMonths,
      schedule: lease.schedule,
      billingStartDate: billingStart,
      lastBillableDay: lease.terms.endDate,
      leadDays: LEAD_DAYS,
    });
    this.tick();
  }

  /** The schedule rows the platform bills. */
  platformRows() {
    return this.lease.schedule.filter((s) => s.periodStart >= this.billingStart);
  }

  /** The schedule rows before billing starts: what opening arrears may be for. */
  openingRows() {
    return this.lease.schedule.filter((s) => s.periodStart < this.billingStart);
  }

  /** The daily jobs: invoices due by today, then accrual. */
  tick(): void {
    const last = this.model.lastDay;
    const cycles = last === null ? this.cycles : this.cycles.filter((c) => c.cycleStart <= last);
    for (const cycle of cyclesToIssue(cycles, this.model.today, this.issued)) {
      const drafts = invoiceLinesFor(cycle, this.lease.vat);
      const added = this.model.issue(drafts, cycle.dueDate, cycle.cycleStart);
      drafts.forEach((d, i) => {
        const line = added[i];
        if (d.chargePeriodId && line) this.periodOf.set(line.id, d.chargePeriodId);
      });
      this.issued.add(cycle.cycleStart);
    }
    this.model.accrueTo(this.model.today);
  }

  days(n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.model.nextDay();
      this.tick();
    }
  }

  pay(amountMinor: number, cash: ModelPayment['cash'] = '1050', daysBack = 0): ModelPayment {
    const p = this.model.pay(
      amountMinor,
      cash,
      receivedOn(this.model.today, daysBack, this.cutOver),
    );
    this.platformPayments.push(p.id);
    return p;
  }

  openingPaymentIds(): Set<string> {
    return new Set(this.model.payments.filter((p) => p.opening).map((p) => p.id));
  }

  state(): OpeningLeaseState {
    this.model.walk(); // brings the model's accrued flags up to date
    return {
      lines: this.model.lines,
      allocations: this.model.allocations,
      payments: this.model.payments.filter((p) => !p.reversed),
      openingPaymentIds: this.openingPaymentIds(),
    };
  }

  context(batchId: string): OpeningLeaseContext {
    return {
      batchId,
      cutOver: this.cutOver,
      today: this.model.today,
      bookId: this.model.book,
      lease: this.model.lease,
      schedule: this.lease.schedule,
      billingStart: this.billingStart,
      lastDay: this.model.lastDay,
    };
  }

  /** Records a plan as the server would post it. */
  adopt(plan: OpeningLeasePlan): void {
    for (const line of plan.lines)
      if (line.chargePeriodId) this.periodOf.set(line.id, line.chargePeriodId);
    this.model.adopt({
      lines: plan.lines,
      allocations: plan.allocations,
      payments: plan.payments,
      reductions: plan.reductions,
      entries: plan.entries,
    });
  }

  /** The periods the walk charges from the billing start, with their VAT and levies. */
  platformPeriods() {
    return this.platformRows().map((s) => ({
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      amountMinor: s.amountMinor,
      taxMinor: expectedTaxMinor(s, this.lease.vat),
    }));
  }

  /** A line's place regardless of its id, so two models of one lease can be compared. */
  keyOf(line: BillingLine): string {
    if (line.baseLineId) {
      const base = this.model.lines.find((l) => l.id === line.baseLineId) as BillingLine;
      return `${base.periodStart}|${base.kind}|${line.kind}`;
    }
    if (line.kind === 'deposit') return 'deposit';
    return `${line.periodStart ?? line.dueDate}|${line.kind}`;
  }

  /** Every line's balance by its place (deposits added up). */
  balancesByKey(): Record<string, { net: number; settled: number; writtenOff: number }> {
    this.model.walk();
    const out: Record<string, { net: number; settled: number; writtenOff: number }> = {};
    for (const line of this.model.lines) {
      const b = lineBalance(line, this.model.allocations);
      const key = this.keyOf(line);
      const was = out[key] ?? { net: 0, settled: 0, writtenOff: 0 };
      out[key] = {
        net: was.net + b.netMinor,
        settled: was.settled + b.settledMinor,
        writtenOff: was.writtenOff + b.writtenOffMinor,
      };
    }
    return out;
  }

  /**
   * An operation after the cut-over, picking lines by their place so two models of one lease pick
   * the same one: days, payments (received on or after the cut-over), reversals of platform
   * payments, credit notes, write-offs and a move-out.
   */
  apply(op: Operation): void {
    const m = this.model;
    switch (op.kind) {
      case 'days':
        this.days(op.days);
        return;
      case 'pay':
        this.pay(op.amountMinor, op.cash, op.daysBack);
        return;
      case 'reverse': {
        const live = this.platformPayments.filter(
          (id) => !(m.payments.find((p) => p.id === id) as ModelPayment).reversed,
        );
        if (live.length === 0) return;
        m.reverse(live[op.pick % live.length] as string);
        return;
      }
      case 'credit': {
        m.walk();
        const bases = this.sorted(m.lines.filter((l) => !isTax(l.kind)));
        const line = bases[op.pick % Math.max(1, bases.length)];
        if (!line) return;
        const b = lineBalance(line, m.allocations);
        const creditable =
          line.kind === 'deposit' ? b.outstandingMinor : b.netMinor - b.writtenOffMinor;
        const amount = Math.floor((creditable * op.percent) / 100);
        if (amount <= 0) return;
        m.creditNote(line.id, amount, `${this.keyOf(line)}-${m.allocations.length}`);
        return;
      }
      case 'write_off': {
        m.walk();
        const owed = this.sorted(
          m.lines.filter(
            (l) =>
              postingClassOf(l) === 'receivable' &&
              lineBalance(l, m.allocations).outstandingMinor > 0,
          ),
        );
        const line = owed[op.pick % Math.max(1, owed.length)];
        if (!line) return;
        const amount = Math.floor(
          (lineBalance(line, m.allocations).outstandingMinor * op.percent) / 100,
        );
        if (amount <= 0) return;
        m.writeOff(line.id, amount, `${this.keyOf(line)}-${m.allocations.length}`);
        return;
      }
      case 'move_out': {
        const lastDay = moveOutDay(m.today, op.daysBack, this.cutOver, m.lastDay);
        if (lastDay) m.moveOut(lastDay);
        return;
      }
    }
  }

  private sorted(lines: readonly BillingLine[]): BillingLine[] {
    return [...lines].sort((a, b) => (this.keyOf(a) < this.keyOf(b) ? -1 : 1));
  }
}

// Workbooks.

export type AdvanceInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'amount'; readonly amountMinor: number }
  /** A month index from the billing start, or -1 for the day before it. */
  | { readonly kind: 'paid_through'; readonly month: number };

export interface Workbook {
  readonly arrears: readonly {
    readonly kind: 'rent' | 'service_charge';
    readonly periodStart: string;
    readonly amountMinor: number;
    readonly dueDate: string;
  }[];
  readonly advance: AdvanceInput;
  readonly depositMinor: number | null;
  readonly withholdingMinor: number | null;
}

export interface Imported {
  readonly lease: ScenarioLease;
  readonly cutOver: string;
  readonly billingStart: string;
  readonly workbook: Workbook;
}

/**
 * A lease with rent periods before and after its billing start, a cut-over on or before that
 * start (`minDaysBefore` days at least), and a Balances workbook for it.
 */
export const importedArbitrary = (
  leases: fc.Arbitrary<ScenarioLease>,
  options: { readonly minDaysBefore?: number; readonly advance?: boolean } = {},
): fc.Arbitrary<Imported> =>
  leases
    .filter((l) => l.terms.periodCount >= 2)
    .chain((lease) => {
      const rents = lease.schedule
        .filter((s) => s.chargeType === 'rent')
        .sort((a, b) => a.sequence - b.sequence);
      return fc
        .record({
          j: fc.integer({ min: 1, max: rents.length - 1 }),
          daysBefore: fc.integer({ min: options.minDaysBefore ?? 0, max: 27 }),
          picks: fc.array(
            fc.record({
              pick: fc.nat(),
              percent: fc.integer({ min: 1, max: 100 }),
              dueAfter: fc.integer({ min: 0, max: 5 }),
            }),
            { maxLength: 5 },
          ),
          advance:
            options.advance === false
              ? fc.constant<AdvanceInput>({ kind: 'none' })
              : fc.oneof(
                  fc.constant<AdvanceInput>({ kind: 'none' }),
                  fc.record({
                    kind: fc.constant('amount' as const),
                    amountMinor: fc.oneof(
                      fc.integer({ min: 1, max: 500_000 }),
                      fc.integer({ min: 500_000, max: 40_000_000 }),
                    ),
                  }),
                  fc.record({
                    kind: fc.constant('paid_through' as const),
                    month: fc.integer({ min: -1, max: 30 }),
                  }),
                ),
          depositMinor: fc.option(fc.integer({ min: 1, max: 5_000_000 }), { nil: null }),
          withholdingMinor: fc.option(fc.integer({ min: 1, max: 500_000 }), { nil: null }),
        })
        .map((r): Imported => {
          const billingStart = (rents[r.j] as { periodStart: string }).periodStart;
          const cutOver = day(billingStart, -r.daysBefore);
          const before = lease.schedule.filter((s) => s.periodStart < billingStart);
          const chosen = new Map<string, Workbook['arrears'][number]>();
          for (const p of r.picks) {
            const row = before[p.pick % before.length];
            if (!row || chosen.has(row.id)) continue;
            const due = day(row.periodStart, p.dueAfter);
            chosen.set(row.id, {
              kind: row.chargeType,
              periodStart: row.periodStart,
              amountMinor: Math.max(1, Math.floor((row.amountMinor * p.percent) / 100)),
              dueDate: due > cutOver ? row.periodStart : due,
            });
          }
          return {
            lease,
            cutOver,
            billingStart,
            workbook: {
              arrears: [...chosen.values()],
              advance: r.advance,
              depositMinor: r.depositMinor,
              withholdingMinor: r.withholdingMinor,
            },
          };
        });
    });

/** The day an advance's paid-through input names. */
export function paidThroughOf(run: ImportedRunner, month: number): string {
  if (month < 0) return day(run.billingStart, -1);
  const ends = [...new Set(run.platformRows().map((r) => r.periodEnd))].sort();
  return ends[Math.min(month, ends.length - 1)] as string;
}

/** The workbook as the server hands it to the plan. */
export function itemsOf(run: ImportedRunner, wb: Workbook): OpeningItems {
  const advance =
    wb.advance.kind === 'amount'
      ? wb.advance.amountMinor
      : wb.advance.kind === 'paid_through'
        ? advanceFromPaidThrough({
            periods: run.platformPeriods(),
            billingStart: run.billingStart,
            paidThrough: paidThroughOf(run, wb.advance.month),
          })
        : 0;
  return {
    arrears: wb.arrears.map((a, i) => ({
      itemId: `arrears-${i}`,
      lineId: `opening-line-${i}`,
      kind: a.kind,
      periodStart: a.periodStart,
      dueDate: a.dueDate,
      amountMinor: a.amountMinor,
    })),
    advances:
      advance > 0
        ? [
            {
              itemId: 'advance',
              paymentId: 'opening-pay-1',
              order: `${run.cutOver}#0000000`,
              amountMinor: advance,
            },
          ]
        : [],
    deposits: wb.depositMinor
      ? [{ itemId: 'deposit', lineId: 'opening-deposit', amountMinor: wb.depositMinor }]
      : [],
    withholding: wb.withholdingMinor
      ? [{ itemId: 'withholding', amountMinor: wb.withholdingMinor }]
      : [],
  };
}

/**
 * The same lease billed on the platform throughout (the comparison of plan section 6), made on the
 * cut-over day: the deposit raised and paid, the arrears raised as ordinary lines and accrued to
 * income, and the advance received as an ordinary payment, oldest debt first. Its money must then
 * behave exactly as the imported lease's.
 */
export function platformTwin(of: ImportedRunner, items: OpeningItems): ImportedRunner {
  const twin = new ImportedRunner(of.lease, of.cutOver, of.billingStart);
  const m = twin.model;
  const deposit = (items.deposits ?? []).reduce((s, d) => s + d.amountMinor, 0);
  if (deposit > 0) {
    m.issue(
      [
        {
          kind: 'deposit',
          chargePeriodId: null,
          periodStart: null,
          periodEnd: null,
          amountMinor: deposit,
          rateBps: null,
          baseIndex: null,
        },
      ],
      of.cutOver,
      'twin-deposit',
    );
    m.pay(deposit, '1050', of.cutOver);
  }
  (items.arrears ?? []).forEach((a, i) => {
    const row = of.lease.schedule.find(
      (s) => s.chargeType === a.kind && s.periodStart === a.periodStart,
    );
    m.issue(
      [
        {
          kind: a.kind,
          chargePeriodId: null,
          periodStart: a.periodStart,
          periodEnd: row?.periodEnd ?? a.periodStart,
          amountMinor: a.amountMinor,
          rateBps: null,
          baseIndex: null,
        },
      ],
      a.dueDate,
      `twin-arrears-${i}`,
    );
  });
  m.accrueTo(m.today);
  const advance = (items.advances ?? []).reduce((s, a) => s + a.amountMinor, 0);
  if (advance > 0) m.pay(advance, '1050', of.cutOver);
  return twin;
}

// Rent tax, as the tax module assesses it per receipt (M5), with or without P25's exclusion.

export class TaxBook {
  readonly items = new Map<string, { key: string; baseMinor: number; taxMinor: number }[]>();
  readonly bases = new Map<string, number>();

  constructor(private readonly withOpening: boolean) {}

  pinned(): Map<string, { baseMinor: number; taxMinor: number }> {
    const totals = new Map<string, { baseMinor: number; taxMinor: number }>();
    for (const lines of this.items.values())
      for (const l of lines) {
        const t = totals.get(l.key) ?? { baseMinor: 0, taxMinor: 0 };
        totals.set(l.key, {
          baseMinor: t.baseMinor + l.baseMinor,
          taxMinor: t.taxMinor + l.taxMinor,
        });
      }
    return totals;
  }

  periods(run: ImportedRunner): TaxPeriod[] {
    return taxPeriodsFromWalk({
      walk: run.model.walk(),
      periodKeyOf: (key) => run.periodOf.get(key) ?? key,
      taxed: this.pinned(),
      withheld: new Set(),
      opening: this.withOpening
        ? { paymentIds: run.openingPaymentIds(), allocations: run.model.allocations }
        : null,
    });
  }

  /** What a receipt would be taxed on now. */
  base(run: ImportedRunner): number {
    return receiptTaxBase(this.periods(run), TAX_RULES).baseMinor;
  }

  /**
   * Taxes a receipt as the tax module does when its payment posts; returns its base. Its cap is
   * the tax module's: the payment less what it paid towards deposits, VAT and one-off charges.
   */
  receipt(run: ImportedRunner, paymentId: string): number {
    const periods = this.periods(run);
    const payment = run.model.payments.find((p) => p.id === paymentId);
    let cap = payment?.amountMinor ?? 0;
    for (const a of run.model.allocations) {
      if (a.paymentId !== paymentId || a.source !== 'payment') continue;
      const kind = run.model.lines.find((l) => l.id === a.lineId)?.kind;
      if (kind !== 'rent' && kind !== 'service_charge') cap -= a.amountMinor;
    }
    const { baseMinor, pins } = receiptTaxBase(periods, TAX_RULES, cap);
    const tax = receiptTax(pins, periods, TAX_RULES.rateBps);
    this.items.set(paymentId, [...tax.lines]);
    this.bases.set(paymentId, baseMinor);
    return baseMinor;
  }

  reverse(paymentId: string): void {
    this.items.delete(paymentId);
  }
}
