import type { AllocationSource, LineKind } from '../billing/lines';
import {
  addHours,
  addMinutes,
  compareDates,
  epochMillisOf,
  instantFrom,
  parseBusinessDate,
  type Instant,
} from '../dates';
import { DomainError } from '../errors';
import type { NoticeType } from '../notices/types';
import {
  inReportMonth,
  medianOf,
  percentileOf,
  ratioOf,
  reportMonth,
  type Ratio,
} from './measures';

/**
 * The Gate 1 metrics (PRD section 19; M9 plan decisions 9 and 10), as definitions over plain
 * facts. The rollup (`reporting.metrics-rollup`) selects the month's facts and stores the result
 * with its inputs; these functions only count. Every share carries its numerator and denominator,
 * and is null when there is nothing to measure.
 */

type InstantLike = Date | string | Instant;

const amountOf = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount))
    throw new DomainError('report.bad_amount', `${what} must be a whole number of pesewas`);
  return amount;
};

// Collection rate (decision 9).

/** An invoice line with its allocations, each dated by its value date. */
export interface CollectionLine {
  readonly lineId: string;
  readonly kind: LineKind;
  readonly dueDate: string;
  readonly amountMinor: number;
  readonly allocations: readonly {
    readonly source: AllocationSource;
    /** Signed: reversals and releases are negative rows. */
    readonly amountMinor: number;
    readonly valueDate: string;
  }[];
}

export interface CollectionRate {
  readonly month: string;
  readonly lines: number;
  readonly dueMinor: number;
  readonly collectedMinor: number;
  /** Never above 100%: each line counts at most what it was due. */
  readonly rate: Ratio;
}

const onOrBefore = (date: string, limit: string): boolean =>
  compareDates(parseBusinessDate(date), parseBusinessDate(limit)) <= 0;

const SETTLING_SOURCES: readonly AllocationSource[] = ['payment', 'deposit', 'withholding'];

/**
 * Due and collected over lines already chosen for the month: each line's amount after credit
 * notes dated by the month's end, and what of it was settled by then, never more than it was due.
 */
function rateOver(
  month: ReturnType<typeof reportMonth>,
  lines: readonly {
    readonly amountMinor: number;
    readonly allocations: readonly {
      readonly source: AllocationSource;
      readonly amountMinor: number;
      readonly valueDate: string;
    }[];
  }[],
): CollectionRate {
  let due = 0;
  let collected = 0;
  for (const line of lines) {
    let credited = 0;
    let settled = 0;
    for (const a of line.allocations) {
      amountOf(a.amountMinor, 'An allocation');
      if (!onOrBefore(a.valueDate, month.lastDay)) continue;
      if (a.source === 'credit_note') credited += a.amountMinor;
      else if (SETTLING_SOURCES.includes(a.source)) settled += a.amountMinor;
    }
    const net = Math.max(0, amountOf(line.amountMinor, 'A line') - credited);
    due += net;
    collected += Math.min(net, Math.max(0, settled));
  }
  return {
    month: month.month,
    lines: lines.length,
    dueMinor: due,
    collectedMinor: collected,
    rate: ratioOf(collected, due),
  };
}

const isRent = (kind: LineKind) => kind === 'rent' || kind === 'service_charge';

/**
 * Decision 9, on its first basis: the rent and service-charge lines falling due in the month.
 * F2 (founder decision, 2026-11-06) replaced this basis with the month each line covers, so the
 * dashboard and the rollup use `collectionRateByPeriod`; this is kept for its first tests.
 * Due: after credit notes dated by the month's end. Collected: what of each was settled by the
 * month's end, by allocations with a value date on or before it, so money paid in advance and tax
 * withheld both count. Deposits, VAT and levies, and one-off charges are left out; a write-off is
 * not collected.
 */
export function collectionRate(input: {
  readonly month: string;
  readonly lines: readonly CollectionLine[];
}): CollectionRate {
  const month = reportMonth(input.month);
  return rateOver(
    month,
    input.lines.filter((line) => isRent(line.kind) && inReportMonth(line.dueDate, month)),
  );
}

/** A rent or service-charge line as F2 reads it: by the charge period it covers. */
export interface PeriodCollectionLine {
  readonly lineId: string;
  readonly kind: LineKind;
  /** The first day of the monthly charge period the line covers; null for a line with none. */
  readonly periodStart: string | null;
  readonly amountMinor: number;
  /** When the line was recorded; needed with `asOf`. */
  readonly recordedAt?: InstantLike;
  readonly allocations: readonly {
    readonly source: AllocationSource;
    /** Signed: reversals and releases are negative rows. */
    readonly amountMinor: number;
    readonly valueDate: string;
    /** When the allocation was recorded; needed with `asOf`. */
    readonly recordedAt?: InstantLike;
  }[];
}

/**
 * F2 (founder decision, 2026-11-06; replaces decision 9's "falling due in the month"): rent due
 * in a month is the rent and service-charge lines whose charge period starts in the month,
 * whatever the billing cycle, so an annual invoice's months count one in each month they cover.
 * Collected is the part of those lines settled by the month's end: allocations with a value date
 * on or before it, so money paid in advance and tax withheld count, and never more than a line
 * was due. A credit note dated by the month's end reduces what is due; a write-off is not
 * collected. Deposits, VAT and levies, and one-off charges are left out.
 *
 * With `asOf`, only lines and allocations recorded by then count (M9 review), so the figures for
 * a past moment never change when something is recorded later with an earlier value date.
 */
export function collectionRateByPeriod(input: {
  readonly month: string;
  readonly lines: readonly PeriodCollectionLine[];
  readonly asOf?: InstantLike;
}): CollectionRate {
  const month = reportMonth(input.month);
  const asOf = input.asOf === undefined ? null : epochMillisOf(input.asOf);
  const recordedBy = (at: InstantLike | undefined, what: string): boolean => {
    if (asOf === null) return true;
    if (at === undefined)
      throw new DomainError('report.no_recorded_at', `${what} needs the time it was recorded`);
    return epochMillisOf(at) <= asOf;
  };
  const lines = input.lines
    .filter(
      (line) =>
        isRent(line.kind) &&
        line.periodStart !== null &&
        inReportMonth(line.periodStart, month) &&
        recordedBy(line.recordedAt, 'A line'),
    )
    .map((line) => ({
      amountMinor: line.amountMinor,
      allocations: line.allocations.filter((a) => recordedBy(a.recordedAt, 'An allocation')),
    }));
  return rateOver(month, lines);
}

// Digital payment share (decision 10).

/** How money was received (the payment's method). `test` is the provider test harness (M4a). */
export const COLLECTION_METHODS = [
  'momo',
  'card',
  'bank_transfer',
  'cash',
  'cheque',
  'test',
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

/** MoMo, card and bank count as digital; the test harness stands in for a provider payment. */
export const DIGITAL_METHODS: readonly CollectionMethod[] = [
  'momo',
  'card',
  'bank_transfer',
  'test',
];

export const isCollectionMethod = (method: string): method is CollectionMethod =>
  (COLLECTION_METHODS as readonly string[]).includes(method);

export interface DigitalShare {
  readonly byMethod: Readonly<Record<CollectionMethod, number>>;
  readonly digitalMinor: number;
  readonly totalMinor: number;
  readonly share: Ratio;
}

/** Totals by method, every method present and in a fixed order. */
export function byCollectionMethod(
  payments: readonly { readonly method: CollectionMethod; readonly amountMinor: number }[],
): Record<CollectionMethod, number> {
  const totals = Object.fromEntries(COLLECTION_METHODS.map((m) => [m, 0])) as Record<
    CollectionMethod,
    number
  >;
  for (const p of payments) {
    if (!isCollectionMethod(p.method))
      throw new DomainError('report.bad_method', `Not a payment method: ${String(p.method)}`);
    totals[p.method] += amountOf(p.amountMinor, 'A payment');
  }
  return totals;
}

/**
 * Decision 10: rent money received by MoMo, card or bank, against cash and cheques, by amount.
 * The caller passes the month's payments net of reversals; none may be below zero.
 */
export function digitalPaymentShare(
  payments: readonly { readonly method: CollectionMethod; readonly amountMinor: number }[],
): DigitalShare {
  for (const p of payments)
    if (amountOf(p.amountMinor, 'A payment') < 0)
      throw new DomainError('report.bad_amount', 'A payment counts zero or more');
  const byMethod = byCollectionMethod(payments);
  const totalMinor = COLLECTION_METHODS.reduce((sum, m) => sum + byMethod[m], 0);
  const digitalMinor = DIGITAL_METHODS.reduce((sum, m) => sum + byMethod[m], 0);
  return { byMethod, digitalMinor, totalMinor, share: ratioOf(digitalMinor, totalMinor) };
}

// Auto-match rate (decision 10; prd-issues 35).

export interface AutoMatchRate {
  readonly provider: {
    readonly automatic: number;
    readonly byPerson: number;
    readonly unmatched: number;
    /** Matched with no person, against every provider payment. */
    readonly rate: Ratio;
  };
  readonly directTransfers: {
    readonly againstLease: number;
    readonly unmatched: number;
    /** Shown separately (M4b): recorded against a lease when entered, against all recorded. */
    readonly rate: Ratio;
  };
}

/**
 * Decision 10: provider payments matched with no person, against all provider payments (one still
 * in the queue counts against the rate). Direct transfers are staff records, so they are shown
 * apart: the share recorded against a lease rather than left unmatched.
 */
export function autoMatchRate(input: {
  readonly providerPayments: readonly {
    readonly match: 'automatic' | 'by_person' | 'unmatched';
  }[];
  readonly directTransfers: readonly { readonly recordedAgainstLease: boolean }[];
}): AutoMatchRate {
  const count = (m: 'automatic' | 'by_person' | 'unmatched') =>
    input.providerPayments.filter((p) => p.match === m).length;
  const automatic = count('automatic');
  const byPerson = count('by_person');
  const unmatched = count('unmatched');
  if (automatic + byPerson + unmatched !== input.providerPayments.length)
    throw new DomainError('report.bad_match', 'Each provider payment is matched or unmatched');
  const againstLease = input.directTransfers.filter((t) => t.recordedAgainstLease).length;
  return {
    provider: {
      automatic,
      byPerson,
      unmatched,
      rate: ratioOf(automatic, input.providerPayments.length),
    },
    directTransfers: {
      againstLease,
      unmatched: input.directTransfers.length - againstLease,
      rate: ratioOf(againstLease, input.directTransfers.length),
    },
  };
}

// Time to receipt (decision 10).

/** The PRD's target: a receipt within one minute of the payment's confirmation. */
export const RECEIPT_TARGET_MS = 60_000;

export interface TimeToReceipt {
  readonly receipts: number;
  readonly sent: number;
  readonly withinTarget: number;
  /** Sent within the target, against every receipt: one never sent counts as late. */
  readonly share: Ratio;
  /** Of the receipts sent, by nearest rank. */
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
}

/**
 * Decision 10: the share of receipts sent within a minute of confirmation (inclusive), plus the
 * median and 95th percentile of the time taken. `latencyMs` is what the receipt delivery recorded
 * (M4b), null when it has not been sent.
 */
export function timeToReceipt(
  receipts: readonly { readonly latencyMs: number | null }[],
  targetMs: number = RECEIPT_TARGET_MS,
): TimeToReceipt {
  if (!Number.isSafeInteger(targetMs) || targetMs < 0)
    throw new DomainError('report.bad_target', 'A target is a whole number of milliseconds');
  const sent: number[] = [];
  for (const r of receipts) {
    if (r.latencyMs === null) continue;
    if (!Number.isSafeInteger(r.latencyMs) || r.latencyMs < 0)
      throw new DomainError('report.bad_latency', 'A latency is zero or more milliseconds');
    sent.push(r.latencyMs);
  }
  const withinTarget = sent.filter((ms) => ms <= targetMs).length;
  return {
    receipts: receipts.length,
    sent: sent.length,
    withinTarget,
    share: ratioOf(withinTarget, receipts.length),
    medianMs: medianOf(sent),
    p95Ms: percentileOf(sent, 95),
  };
}

// Notice acknowledgement (decision 10).

/** The PRD's window: e-signed within 7 days of issue, counted in hours from the issue instant. */
export const NOTICE_ACK_WINDOW_DAYS = 7;

export interface NoticeForMetric {
  readonly type: NoticeType;
  readonly issuedAt: InstantLike;
  /** One per recipient: a building-wide notice has many, any other notice one. */
  readonly recipients: readonly { readonly signedAt: InstantLike | null }[];
}

export interface WindowedShare {
  /** Within the window. */
  readonly met: number;
  /** The window closed without it. */
  readonly missed: number;
  /** The window is still open and it has not happened yet: left out of the share. */
  readonly pending: number;
  readonly rate: Ratio;
}

/**
 * Counts events against a window closing at `closes` (inclusive), as of `asOf`: an event after
 * `asOf` has not happened yet, so the figures for a past moment never change.
 */
function windowTally() {
  let met = 0;
  let missed = 0;
  let pending = 0;
  return {
    add(at: InstantLike | null, closes: number, asOf: number): void {
      const when = at === null ? null : epochMillisOf(at);
      if (when !== null && when <= asOf && when <= closes) met += 1;
      else if (asOf < closes) pending += 1;
      else missed += 1;
    },
    result: (): WindowedShare => ({ met, missed, pending, rate: ratioOf(met, met + missed) }),
  };
}

/**
 * Decision 10: of the notices issued in the month, the share e-signed within 7 days, counted per
 * recipient, so a building-wide notice counts once for each. Tenant-originated notices are left
 * out. A recipient still inside the window at `asOf` without signing is pending, not missed.
 */
export function noticeAcknowledgement(input: {
  readonly notices: readonly NoticeForMetric[];
  readonly asOf: InstantLike;
  readonly windowDays?: number;
}): WindowedShare {
  const windowDays = input.windowDays ?? NOTICE_ACK_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 0)
    throw new DomainError('report.bad_window', 'A window is a whole number of days');
  const asOf = epochMillisOf(input.asOf);
  const tally = windowTally();
  for (const notice of input.notices) {
    if (notice.type === 'tenant_originated') continue;
    const closes = addHours(instantFrom(notice.issuedAt), windowDays * 24).epochMilliseconds;
    for (const recipient of notice.recipients) tally.add(recipient.signedAt, closes, asOf);
  }
  return tally.result();
}

// Repair response (decision 10; M8 data).

interface RepairJobFacts {
  readonly priority: 'emergency' | 'urgent' | 'routine';
  /** When the response clock started: the job was reported as, or became, an emergency. */
  readonly clockStartedAt: InstantLike;
  /** The response target in force for the job (M8 decision 4: 2 hours by default), in minutes. */
  readonly targetMinutes: number;
}

/**
 * An emergency job as the metric reads it. "Attended" means work started (founder decision,
 * 2026-11-05): the first time the job moved to In progress, which M8 allows only with a before
 * photo or a recorded reason (M8 decision 7). Being assigned is not attending. Null while work has
 * not started. A dispute that returns the job to In progress later does not move the time.
 */
export type RepairJobForMetric = RepairJobFacts &
  (
    | { readonly workStartedAt: InstantLike | null; readonly attendedAt?: never }
    | {
        /**
         * The name this field had before the founder's decision: the same instant, work started.
         * Kept so the first tests of this metric run unchanged; use `workStartedAt`.
         */
        readonly attendedAt: InstantLike | null;
        readonly workStartedAt?: never;
      }
  );

/** When work started on the job, by either name; null while it has not. */
export const workStartedAtOf = (job: RepairJobForMetric): InstantLike | null =>
  job.workStartedAt !== undefined ? job.workStartedAt : (job.attendedAt ?? null);

/**
 * Decision 10: the share of emergency jobs attended within their target, where attended means
 * work started (founder decision, 2026-11-05). A job still inside its target at `asOf` with no
 * work started is pending, not missed. Urgent and routine jobs are left out.
 */
export function repairResponse(input: {
  readonly jobs: readonly RepairJobForMetric[];
  readonly asOf: InstantLike;
}): WindowedShare {
  const asOf = epochMillisOf(input.asOf);
  const tally = windowTally();
  for (const job of input.jobs) {
    if (job.priority !== 'emergency') continue;
    if (!Number.isSafeInteger(job.targetMinutes) || job.targetMinutes < 0)
      throw new DomainError('report.bad_target', 'A target is a whole number of minutes');
    const due = addMinutes(instantFrom(job.clockStartedAt), job.targetMinutes).epochMilliseconds;
    tally.add(workStartedAtOf(job), due, asOf);
  }
  return tally.result();
}
