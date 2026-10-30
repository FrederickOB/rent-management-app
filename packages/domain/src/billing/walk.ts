import { daysBetween, parseBusinessDate } from '../dates';
import type { PaymentAmount } from '../ledger/posting';
import {
  isRecurring,
  lineBalance,
  postingClassOf,
  type AllocationRow,
  type BillingLine,
  type CreditPool,
  type RecurringKind,
} from './lines';

/**
 * The forward walk (AR-02, AR-03; architecture section 6): the lease's rent and service-charge
 * lines in accrual order, covered by what was paid towards them and, for lines not charged yet,
 * by the lease's credit applied forward in the order P02 will use. Paid-until, unearned rent and
 * what is due all come from it; none of them is stored.
 */
export interface WalkLine {
  /** The invoice line id, or the charge period id when the period is not invoiced yet. */
  readonly key: string;
  readonly lineId: string | null;
  readonly chargeType: RecurringKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly netMinor: number;
  readonly settledMinor: number;
  readonly writtenOffMinor: number;
  /** Charged already (P02 has run): credit no longer applies to it. */
  readonly charged: boolean;
}

/** A charge period that has no invoice line yet. */
export interface ScheduledPeriod {
  readonly id: string;
  readonly chargeType: RecurringKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountMinor: number;
}

/** The walk's lines: invoiced recurring lines, then periods still to be invoiced. */
export function walkLines(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly scheduled: readonly ScheduledPeriod[];
}): WalkLine[] {
  const invoiced: WalkLine[] = input.lines
    .filter((l) => isRecurring(l.kind) && l.periodStart !== null && l.periodEnd !== null)
    .map((l) => {
      const b = lineBalance(l, input.allocations);
      return {
        key: l.id,
        lineId: l.id,
        chargeType: l.kind as RecurringKind,
        periodStart: l.periodStart as string,
        periodEnd: l.periodEnd as string,
        netMinor: b.netMinor,
        settledMinor: b.settledMinor,
        writtenOffMinor: b.writtenOffMinor,
        charged: l.accrued,
      };
    });
  const scheduled: WalkLine[] = input.scheduled.map((s) => ({
    key: s.id,
    lineId: null,
    chargeType: s.chargeType,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    netMinor: s.amountMinor,
    settledMinor: 0,
    writtenOffMinor: 0,
    charged: false,
  }));
  return [...invoiced, ...scheduled].sort((a, b) =>
    a.periodStart !== b.periodStart
      ? a.periodStart < b.periodStart
        ? -1
        : 1
      : a.chargeType === b.chargeType
        ? 0
        : a.chargeType === 'rent'
          ? -1
          : 1,
  );
}

export interface WalkedLine extends WalkLine {
  /** Credit the walk applies to the line, payment by payment. */
  readonly draws: readonly PaymentAmount[];
  readonly creditMinor: number;
  /** Still to pay after the walk. */
  readonly remainingMinor: number;
}

export interface WalkResult {
  readonly lines: readonly WalkedLine[];
  /** The last day of the last month fully covered in an unbroken run from the first; or null. */
  readonly paidUntil: string | null;
  /** Money towards the next month when it is only partly covered (prd-issues 17). */
  readonly partial: { readonly monthStart: string; readonly amountMinor: number } | null;
  /** AR-03: the rent share of prepayments. */
  readonly unearnedRentMinor: number;
  readonly unearnedServiceChargeMinor: number;
  /** Credit no line in the walk uses: beyond the term, for now. */
  readonly creditLeftMinor: number;
}

export function forwardWalk(lines: readonly WalkLine[], pools: readonly CreditPool[]): WalkResult {
  const credit = pools.map((p) => ({ ...p }));
  let poolIndex = 0;
  const walked: WalkedLine[] = [];
  let unearnedRent = 0;
  let unearnedService = 0;
  for (const line of lines) {
    const outstanding = line.netMinor - line.settledMinor - line.writtenOffMinor;
    const draws: PaymentAmount[] = [];
    let need = line.charged ? 0 : outstanding;
    while (need > 0 && poolIndex < credit.length) {
      const pool = credit[poolIndex] as CreditPool & { amountMinor: number };
      const amount = Math.min(pool.amountMinor, need);
      if (amount > 0) draws.push({ paymentId: pool.paymentId, amountMinor: amount });
      pool.amountMinor -= amount;
      need -= amount;
      if (pool.amountMinor === 0) poolIndex += 1;
    }
    const creditMinor = draws.reduce((sum, d) => sum + d.amountMinor, 0);
    if (!line.charged) {
      const prepaid = line.settledMinor + creditMinor;
      if (line.chargeType === 'rent') unearnedRent += prepaid;
      else unearnedService += prepaid;
    }
    walked.push({ ...line, draws, creditMinor, remainingMinor: outstanding - creditMinor });
  }

  const months = new Map<string, WalkedLine[]>();
  for (const line of walked)
    months.set(line.periodStart, [...(months.get(line.periodStart) ?? []), line]);
  let paidUntil: string | null = null;
  let partial: WalkResult['partial'] = null;
  for (const [monthStart, monthLines] of months) {
    if (monthLines.every((l) => l.remainingMinor === 0)) {
      paidUntil = monthLines.reduce((end, l) => (l.periodEnd > end ? l.periodEnd : end), '');
      continue;
    }
    const amount = monthLines.reduce((sum, l) => sum + l.settledMinor + l.creditMinor, 0);
    if (amount > 0) partial = { monthStart, amountMinor: amount };
    break;
  }
  return {
    lines: walked,
    paidUntil,
    partial,
    unearnedRentMinor: unearnedRent,
    unearnedServiceChargeMinor: unearnedService,
    creditLeftMinor: credit.slice(poolIndex).reduce((sum, p) => sum + p.amountMinor, 0),
  };
}

/** What a line still needs after the walk; recurring lines may be covered by credit to come. */
function remainingAfterWalk(
  line: BillingLine,
  allocations: readonly AllocationRow[],
  walk: WalkResult,
): number {
  const { outstandingMinor } = lineBalance(line, allocations);
  if (!isRecurring(line.kind)) return outstandingMinor;
  const walked = walk.lines.find((l) => l.lineId === line.id);
  return walked ? walked.remainingMinor : outstandingMinor;
}

export interface MoneySummary {
  /** Due on or before today and not covered. */
  readonly dueNowMinor: number;
  /** Due before today and not covered: "overdue invoices", the contractual amount. */
  readonly overdueMinor: number;
  /** Earned and unpaid (1100). */
  readonly earnedUnpaidMinor: number;
  readonly creditMinor: number;
  readonly unearnedRentMinor: number;
  readonly paidUntil: string | null;
  readonly partial: WalkResult['partial'];
}

/** The lease's money card (M4a plan 4.19), from its lines, allocations and the walk. */
export function moneySummary(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly pools: readonly CreditPool[];
  readonly walk: WalkResult;
  readonly today: string;
}): MoneySummary {
  let dueNow = 0;
  let overdue = 0;
  let earnedUnpaid = 0;
  for (const line of input.lines) {
    const remaining = remainingAfterWalk(line, input.allocations, input.walk);
    if (line.dueDate <= input.today) dueNow += remaining;
    if (line.dueDate < input.today) overdue += remaining;
    if (postingClassOf(line) === 'receivable')
      earnedUnpaid += lineBalance(line, input.allocations).outstandingMinor;
  }
  return {
    dueNowMinor: dueNow,
    overdueMinor: overdue,
    earnedUnpaidMinor: earnedUnpaid,
    creditMinor: input.pools.reduce((sum, p) => sum + p.amountMinor, 0),
    unearnedRentMinor: input.walk.unearnedRentMinor,
    paidUntil: input.walk.paidUntil,
    partial: input.walk.partial,
  };
}

/** Arrears buckets (BC-08): days past the due date. */
export const AGE_BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const AGE_BUCKET_LABELS: Record<AgeBucket, string> = {
  '0_30': '0–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '90_plus': 'Over 90 days',
};

/** The bucket for a line due on `dueDate`, as of `asOf`; null when it is not yet past due. */
export function ageBucket(dueDate: string, asOf: string): AgeBucket | null {
  const days = daysBetween(parseBusinessDate(dueDate), parseBusinessDate(asOf));
  if (days <= 0) return null;
  if (days <= 30) return '0_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

export interface AgedLine {
  readonly lineId: string;
  readonly dueDate: string;
  readonly daysOverdue: number;
  readonly bucket: AgeBucket;
  readonly amountMinor: number;
}

/**
 * Lines past their due date with an amount outstanding, as of a date (BC-08). The caller passes
 * the allocations and credit as they stood on that date.
 */
export function agedLines(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly walk: WalkResult;
  readonly asOf: string;
}): AgedLine[] {
  const aged: AgedLine[] = [];
  for (const line of input.lines) {
    const bucket = ageBucket(line.dueDate, input.asOf);
    if (!bucket) continue;
    const amount = remainingAfterWalk(line, input.allocations, input.walk);
    if (amount <= 0) continue;
    aged.push({
      lineId: line.id,
      dueDate: line.dueDate,
      daysOverdue: daysBetween(parseBusinessDate(line.dueDate), parseBusinessDate(input.asOf)),
      bucket,
      amountMinor: amount,
    });
  }
  return aged;
}
