import fc from 'fast-check';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../../dates';
import type { CashAccount } from '../../ledger/accounts';
import { checkLeaseTerms, type LeaseTerms, type RentCycle } from '../../tenancy/lease-terms';
import { rentSchedule } from '../../tenancy/schedule';
import {
  cyclesToIssue,
  depositDue,
  invoiceCycles,
  invoiceLinesFor,
  type InvoiceCycle,
  type ScheduleRow,
  type VatRates,
} from '../invoicing';
import { isTax, lineBalance, postingClassOf } from '../lines';
import { LeaseLedgerModel } from './lease-ledger';

/** Random leases and event sequences for the property-based tests (M4a plan section 6). */
export interface ScenarioLease {
  readonly terms: LeaseTerms;
  readonly schedule: readonly ScheduleRow[];
  readonly vat: VatRates | null;
}

export const VAT_RATES: VatRates = {
  vatBps: 1500,
  nhilBps: 250,
  getfundBps: 250,
  appliesToServiceCharge: true,
};

export const leaseArbitrary: fc.Arbitrary<ScenarioLease> = fc
  .record({
    startOffset: fc.integer({ min: 0, max: 500 }),
    months: fc.integer({ min: 1, max: 24 }),
    shortFinalDays: fc.integer({ min: 0, max: 20 }),
    rent: fc.integer({ min: 100, max: 5_000_000 }),
    serviceCharge: fc.option(fc.integer({ min: 100, max: 500_000 }), { nil: null }),
    cycle: fc.constantFrom<RentCycle>('monthly', 'quarterly', 'six_monthly', 'annual'),
    advanceExtra: fc.option(fc.integer({ min: 0, max: 24 }), { nil: null }),
    deposit: fc.option(fc.integer({ min: 100, max: 5_000_000 }), { nil: null }),
    vat: fc.option(fc.boolean(), { nil: null }),
  })
  .map((r): ScenarioLease | null => {
    const start = addDays(parseBusinessDate('2026-01-01'), r.startOffset);
    const end = addDays(addMonths(start, r.months), -1 - r.shortFinalDays);
    try {
      const cycleMonths = { monthly: 1, quarterly: 3, six_monthly: 6, annual: 12 }[r.cycle];
      const probe = checkLeaseTerms({
        startDate: toIsoDate(start),
        endDate: toIsoDate(end),
        monthlyRentMinor: r.rent,
        cycle: 'monthly',
        noticeDays: 30,
        use: 'residential',
      });
      const cycle: RentCycle = cycleMonths <= probe.periodCount ? r.cycle : 'monthly';
      const months = { monthly: 1, quarterly: 3, six_monthly: 6, annual: 12 }[cycle];
      const advance =
        r.advanceExtra === null ? null : Math.min(months + r.advanceExtra, probe.periodCount);
      const terms = checkLeaseTerms({
        startDate: toIsoDate(start),
        endDate: toIsoDate(end),
        monthlyRentMinor: r.rent,
        cycle,
        initialAdvanceMonths: advance,
        depositMinor: r.deposit,
        serviceChargeMonthlyMinor: r.serviceCharge,
        noticeDays: 30,
        use: r.vat === null ? 'residential' : 'commercial',
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
      const vat = r.vat === null ? null : { ...VAT_RATES, appliesToServiceCharge: r.vat };
      return { terms, schedule, vat };
    } catch {
      return null;
    }
  })
  .filter((s: ScenarioLease | null): s is ScenarioLease => s !== null);

export type Operation =
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'pay'; readonly amountMinor: number; readonly cash: CashAccount }
  | { readonly kind: 'reverse'; readonly pick: number }
  | { readonly kind: 'credit'; readonly pick: number; readonly percent: number }
  | { readonly kind: 'write_off'; readonly pick: number; readonly percent: number };

export const operationArbitrary = (withCorrections: boolean): fc.Arbitrary<Operation> => {
  const days = fc.record({
    kind: fc.constant('days' as const),
    days: fc.integer({ min: 1, max: 60 }),
  });
  const pay = fc.record({
    kind: fc.constant('pay' as const),
    amountMinor: fc.oneof(
      fc.integer({ min: 1, max: 200_000 }),
      fc.integer({ min: 200_000, max: 20_000_000 }),
    ),
    cash: fc.constantFrom<CashAccount>('1050', '1060', '1010', '1070'),
  });
  if (!withCorrections)
    return fc.oneof({ arbitrary: days, weight: 3 }, { arbitrary: pay, weight: 3 });
  return fc.oneof(
    { arbitrary: days, weight: 4 },
    { arbitrary: pay, weight: 4 },
    { arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }), weight: 1 },
    {
      arbitrary: fc.record({
        kind: fc.constant('credit' as const),
        pick: fc.nat(),
        percent: fc.integer({ min: 1, max: 100 }),
      }),
      weight: 1,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant('write_off' as const),
        pick: fc.nat(),
        percent: fc.integer({ min: 1, max: 100 }),
      }),
      weight: 1,
    },
  );
};

/** A sequence long enough to run a lease for months: 5 to 40 operations. */
export const operationsArbitrary = (withCorrections: boolean): fc.Arbitrary<Operation[]> =>
  fc.array(operationArbitrary(withCorrections), { minLength: 5, maxLength: 40, size: 'max' });

/** Runs a lease: issued at signing 20 days before its start, invoices on their issue dates. */
export class ScenarioRunner {
  readonly model: LeaseLedgerModel;
  private readonly cycles: InvoiceCycle[];
  private readonly issued = new Set<string>();
  private corrections = 0;

  constructor(
    readonly lease: ScenarioLease,
    readonly leadDays = 14,
  ) {
    const signedOn = toIsoDate(addDays(parseBusinessDate(lease.terms.startDate), -20));
    this.model = new LeaseLedgerModel(signedOn);
    this.model.scheduled = lease.schedule.map((s) => ({
      id: s.id,
      chargeType: s.chargeType,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      amountMinor: s.amountMinor,
    }));
    this.cycles = invoiceCycles({
      cycle: lease.terms.cycle,
      initialAdvanceMonths: lease.terms.initialAdvanceMonths,
      schedule: lease.schedule,
      billingStartDate: lease.terms.startDate,
      lastBillableDay: lease.terms.endDate,
      leadDays,
    });
    const deposit = depositDue({
      depositMinor: lease.terms.depositMinor,
      startDate: lease.terms.startDate,
      billingStartDate: lease.terms.startDate,
      carriedDepositMinor: 0,
    });
    if (deposit > 0)
      this.model.issue(
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
        lease.terms.startDate,
        'deposit',
      );
    this.tick();
  }

  /** The daily jobs: invoices due by today, then accrual. */
  tick(): void {
    for (const cycle of cyclesToIssue(this.cycles, this.model.today, this.issued)) {
      this.model.issue(invoiceLinesFor(cycle, this.lease.vat), cycle.dueDate, cycle.cycleStart);
      this.issued.add(cycle.cycleStart);
    }
    this.model.accrueTo(this.model.today);
  }

  get correctionCount(): number {
    return this.corrections + this.model.corrections;
  }

  apply(op: Operation): void {
    const m = this.model;
    switch (op.kind) {
      case 'days':
        for (let i = 0; i < op.days; i += 1) {
          m.nextDay();
          this.tick();
        }
        return;
      case 'pay':
        m.pay(op.amountMinor, op.cash);
        return;
      case 'reverse': {
        const live = m.payments.filter((p) => !p.reversed);
        if (live.length === 0) return;
        m.reverse((live[op.pick % live.length] as { id: string }).id);
        return;
      }
      case 'credit': {
        const bases = m.lines.filter((l) => !isTax(l.kind));
        if (bases.length === 0) return;
        const line = bases[op.pick % bases.length];
        if (!line) return;
        const b = lineBalance(line, m.allocations);
        const creditable =
          line.kind === 'deposit' ? b.outstandingMinor : b.netMinor - b.writtenOffMinor;
        const amount = Math.floor((creditable * op.percent) / 100);
        if (amount <= 0) return;
        m.creditNote(line.id, amount, `${line.id}-${m.allocations.length}`);
        return;
      }
      case 'write_off': {
        const owed = m.lines.filter(
          (l) =>
            postingClassOf(l) === 'receivable' &&
            lineBalance(l, m.allocations).outstandingMinor > 0,
        );
        if (owed.length === 0) return;
        const line = owed[op.pick % owed.length];
        if (!line) return;
        const amount = Math.floor(
          (lineBalance(line, m.allocations).outstandingMinor * op.percent) / 100,
        );
        if (amount <= 0) return;
        m.writeOff(line.id, amount, `${line.id}-${m.allocations.length}`);
        return;
      }
    }
  }
}
