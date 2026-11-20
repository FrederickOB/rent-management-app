import type { AllocationSource, LineKind } from '../billing/lines';
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  compareDates,
  epochMillisOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
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

// M11 decision 4: the Gate 1 targets and the added metrics (PRD sections 18 and 19). New
// definitions beside the M9 ones above, which stay as they were. Each company's figures and the
// platform's total come from the same function or add up exactly (`combine…`), never as an
// average of shares.

/** The two Gate 1 targets (PRD section 18): 95% collection, and 95% of provider payments auto-matched. */
export const GATE1_TARGET_BPS = { collectionRate: 9_500, autoMatch: 9_500 } as const;

export interface TargetOutcome {
  readonly targetBps: number;
  /** Null while there is nothing to measure. */
  readonly met: boolean | null;
}

export interface Gate1Targets {
  readonly collectionRate: TargetOutcome;
  readonly autoMatch: TargetOutcome;
}

/**
 * Whether a share reaches a target, from its exact numerator and denominator, never from its
 * rounded basis points: 18,999 of 20,000 shows as 95.00% (half up) but is short of 95%, so it is
 * not met. Null when there is nothing to measure.
 */
export function meetsTarget(share: Ratio, targetBps: number): boolean | null {
  if (!Number.isSafeInteger(targetBps) || targetBps < 0 || targetBps > 10_000)
    throw new DomainError('report.bad_target', 'A target is 0 to 10,000 basis points');
  const { numerator, denominator } = ratioOf(share.numerator, share.denominator);
  if (denominator === 0) return null;
  return BigInt(numerator) * 10_000n >= BigInt(targetBps) * BigInt(denominator);
}

/**
 * Decision 4: the Gate 1 targets, met or not, for a company or the platform's total. The
 * collection rate is F2's; auto-match is provider payments matched with no person (`autoMatch.
 * provider.rate`), as decision 10 defines it.
 */
export function gate1Targets(input: {
  readonly collectionRate: Ratio;
  readonly autoMatch: Ratio;
}): Gate1Targets {
  return {
    collectionRate: {
      targetBps: GATE1_TARGET_BPS.collectionRate,
      met: meetsTarget(input.collectionRate, GATE1_TARGET_BPS.collectionRate),
    },
    autoMatch: {
      targetBps: GATE1_TARGET_BPS.autoMatch,
      met: meetsTarget(input.autoMatch, GATE1_TARGET_BPS.autoMatch),
    },
  };
}

const zeroOrMore = (amount: number, what: string): number => {
  if (amountOf(amount, what) < 0)
    throw new DomainError('report.bad_amount', `${what} is zero or more`);
  return amount;
};

const sumOf = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);

// Arrears over 60 days.

/** A lease's row of the daily snapshot (`lease_snapshot`), as this metric reads it. */
export interface ArrearsSnapshotRow {
  readonly arrears61To90Minor: number;
  readonly arrears90PlusMinor: number;
  /** The rent roll (decision 12): zero for a lease not holding its unit that day. */
  readonly rentMinor: number;
  readonly serviceChargeMinor: number;
}

export interface ArrearsOver60 {
  readonly arrearsMinor: number;
  readonly rentRollMinor: number;
  /** Can pass 100%: a tenant can owe more than a month's rent roll. */
  readonly share: Ratio;
  readonly baselineMonth: string | null;
  readonly baselineShare: Ratio | null;
}

/**
 * The pilot baseline (decision 4): the first full calendar month on the platform after the
 * cut-over. Opening balances are dated the cut-over and the platform bills from it, so a cut-over
 * on the 1st makes its own month the first full one; any later day, the next month. Null with no
 * cut-over.
 */
export function arrearsBaselineMonth(cutOverDate: string | null): string | null {
  if (cutOverDate === null) return null;
  const day = toIsoDate(parseBusinessDate(cutOverDate));
  const month = day.slice(0, 7);
  if (day.endsWith('-01')) return month;
  return toIsoDate(addMonths(parseBusinessDate(`${month}-01`), 1)).slice(0, 7);
}

/**
 * PRD section 19: arrears more than 60 days overdue (the snapshot's 61–90 and over-90 buckets,
 * BC-08) as a share of the rent roll (rent and service charge of the leases holding their units),
 * from one day's snapshot: the month's last day, or the latest while the month runs. The baseline
 * share is the baseline month's own figure: this month's, in the baseline month; the stored
 * `baselineShare` for later months; none before it.
 */
export function arrearsOver60(input: {
  readonly month: string;
  readonly rows: readonly ArrearsSnapshotRow[];
  readonly cutOverDate: string | null;
  /** The baseline month's share, as stored for it; read only for months after it. */
  readonly baselineShare?: Ratio | null;
}): ArrearsOver60 {
  reportMonth(input.month);
  let arrearsMinor = 0;
  let rentRollMinor = 0;
  for (const row of input.rows) {
    arrearsMinor +=
      zeroOrMore(row.arrears61To90Minor, 'Arrears') + zeroOrMore(row.arrears90PlusMinor, 'Arrears');
    rentRollMinor +=
      zeroOrMore(row.rentMinor, 'Rent') + zeroOrMore(row.serviceChargeMinor, 'A service charge');
  }
  const share = ratioOf(arrearsMinor, rentRollMinor);
  const baselineMonth = arrearsBaselineMonth(input.cutOverDate);
  let baselineShare: Ratio | null = null;
  if (baselineMonth !== null && input.month === baselineMonth) baselineShare = share;
  else if (baselineMonth !== null && input.month > baselineMonth && input.baselineShare)
    baselineShare = ratioOf(input.baselineShare.numerator, input.baselineShare.denominator);
  return { arrearsMinor, rentRollMinor, share, baselineMonth, baselineShare };
}

/**
 * Arrears over 60 days across companies: amounts added up and the share worked out again. The
 * baseline is added up the same way, only once every company has one (so it covers the same
 * companies as the share), dated the latest of their baseline months. Null for no companies.
 */
export function combineArrearsOver60(parts: readonly ArrearsOver60[]): ArrearsOver60 | null {
  if (parts.length === 0) return null;
  const arrearsMinor = sumOf(parts.map((p) => p.arrearsMinor));
  const rentRollMinor = sumOf(parts.map((p) => p.rentRollMinor));
  const baselines = parts.flatMap((p) =>
    p.baselineMonth !== null && p.baselineShare !== null
      ? [{ month: p.baselineMonth, share: p.baselineShare }]
      : [],
  );
  const every = baselines.length === parts.length;
  return {
    arrearsMinor,
    rentRollMinor,
    share: ratioOf(arrearsMinor, rentRollMinor),
    baselineMonth: every
      ? baselines
          .map((b) => b.month)
          .sort()
          .at(-1)!
      : null,
    baselineShare: every
      ? ratioOf(
          sumOf(baselines.map((b) => b.share.numerator)),
          sumOf(baselines.map((b) => b.share.denominator)),
        )
      : null,
  };
}

// Weekly active managers.

/** A week counts for a staff member active on at least this many of its days (decision 4). */
export const WEEKLY_ACTIVE_DAYS = 3;

/**
 * The weeks starting in a month: its Mondays. Each week runs Monday to Sunday and may end in the
 * next month.
 */
export function weeksStartingIn(month: string): string[] {
  const range = reportMonth(month);
  const first = parseBusinessDate(range.firstDay);
  // Temporal numbers the days Monday 1 to Sunday 7.
  const weeks: string[] = [];
  for (
    let monday = addDays(first, (8 - first.dayOfWeek) % 7);
    inReportMonth(toIsoDate(monday), range);
    monday = addDays(monday, 7)
  )
    weeks.push(toIsoDate(monday));
  return weeks;
}

/** A staff member of a company: one row per company and person. */
export interface StaffMember {
  readonly companyId: string;
  readonly personId: string;
}

/** A day a staff member used the app (`staff_active_day`), a business date in the company's zone. */
export interface StaffActiveDay extends StaffMember {
  readonly day: string;
}

export interface WeeklyActiveManagers {
  readonly staff: number;
  readonly weeks: readonly { readonly weekStart: string; readonly active: number }[];
  /** Staff-weeks active out of staff × weeks: never above 100%. */
  readonly share: Ratio;
}

const staffKey = (s: StaffMember) => `${s.companyId}\u0000${s.personId}`;

/**
 * PRD section 19, decision 4: for each week starting in the month, the staff members active on 3
 * days or more of it (each day counted once), and the share of staff-weeks active out of staff ×
 * weeks. A person on staff in two companies counts in each. Active days of anyone not in `staff`
 * are left out. With `asOf`, weeks starting after it are left out, so a running month is not
 * held down by weeks still to come.
 */
export function weeklyActiveManagers(input: {
  readonly month: string;
  readonly staff: readonly StaffMember[];
  readonly activeDays: readonly StaffActiveDay[];
  readonly asOf?: string;
}): WeeklyActiveManagers {
  const asOf = input.asOf === undefined ? null : parseBusinessDate(input.asOf);
  const weekStarts = weeksStartingIn(input.month).filter(
    (w) => asOf === null || compareDates(parseBusinessDate(w), asOf) <= 0,
  );
  const days = new Map<string, Set<string>>();
  for (const member of input.staff) {
    const key = staffKey(member);
    if (days.has(key))
      throw new DomainError('report.duplicate_staff', 'Each staff member is listed once');
    days.set(key, new Set());
  }
  for (const active of input.activeDays)
    days.get(staffKey(active))?.add(toIsoDate(parseBusinessDate(active.day)));
  const weeks = weekStarts.map((weekStart) => {
    const start = parseBusinessDate(weekStart);
    const span = Array.from({ length: 7 }, (_, i) => toIsoDate(addDays(start, i)));
    let active = 0;
    for (const set of days.values())
      if (span.filter((day) => set.has(day)).length >= WEEKLY_ACTIVE_DAYS) active += 1;
    return { weekStart, active };
  });
  return {
    staff: days.size,
    weeks,
    share: ratioOf(sumOf(weeks.map((w) => w.active)), days.size * weeks.length),
  };
}

/** Weekly active managers across companies: staff and staff-weeks added up, week by week. */
export function combineWeeklyActiveManagers(
  parts: readonly WeeklyActiveManagers[],
): WeeklyActiveManagers | null {
  if (parts.length === 0) return null;
  const byWeek = new Map<string, number>();
  for (const part of parts)
    for (const w of part.weeks) byWeek.set(w.weekStart, (byWeek.get(w.weekStart) ?? 0) + w.active);
  return {
    staff: sumOf(parts.map((p) => p.staff)),
    weeks: [...byWeek.keys()].sort().map((weekStart) => ({
      weekStart,
      active: byWeek.get(weekStart)!,
    })),
    share: ratioOf(
      sumOf(parts.map((p) => p.share.numerator)),
      sumOf(parts.map((p) => p.share.denominator)),
    ),
  };
}

// Tenant WhatsApp adoption.

/** A tenant of a company, as this metric reads it. */
export interface TenantForAdoption {
  readonly companyId: string;
  readonly tenantId: string;
  /** A lease active on any day of the month. */
  readonly activeLease: boolean;
  /** WhatsApp consent held (granted and not withdrawn) at the month's end (CM-09). */
  readonly whatsappConsent: boolean;
}

/** A WhatsApp message the tenant sent, or one of ours they read, on a business date. */
export interface TenantWhatsappUse {
  readonly companyId: string;
  readonly tenantId: string;
  readonly day: string;
}

export interface WhatsappAdoption {
  readonly tenantsWithActiveLease: number;
  readonly adopted: number;
  /** Never above 100%. */
  readonly share: Ratio;
}

const tenantKey = (t: { readonly companyId: string; readonly tenantId: string }) =>
  `${t.companyId}\u0000${t.tenantId}`;

/**
 * PRD section 19, decision 4: of the tenants with an active lease in the month, those with
 * WhatsApp consent who sent or read a WhatsApp message in it. A tenant renting from two landlords
 * is a tenant of each.
 */
export function whatsappAdoption(input: {
  readonly month: string;
  readonly tenants: readonly TenantForAdoption[];
  readonly uses: readonly TenantWhatsappUse[];
}): WhatsappAdoption {
  const range = reportMonth(input.month);
  const used = new Set<string>();
  for (const use of input.uses) if (inReportMonth(use.day, range)) used.add(tenantKey(use));
  const seen = new Set<string>();
  let tenantsWithActiveLease = 0;
  let adopted = 0;
  for (const tenant of input.tenants) {
    const key = tenantKey(tenant);
    if (seen.has(key))
      throw new DomainError('report.duplicate_tenant', 'Each tenant is listed once');
    seen.add(key);
    if (!tenant.activeLease) continue;
    tenantsWithActiveLease += 1;
    if (tenant.whatsappConsent && used.has(key)) adopted += 1;
  }
  return { tenantsWithActiveLease, adopted, share: ratioOf(adopted, tenantsWithActiveLease) };
}

/** WhatsApp adoption across companies: the counts added up. */
export function combineWhatsappAdoption(
  parts: readonly WhatsappAdoption[],
): WhatsappAdoption | null {
  if (parts.length === 0) return null;
  const tenantsWithActiveLease = sumOf(parts.map((p) => p.tenantsWithActiveLease));
  const adopted = sumOf(parts.map((p) => p.adopted));
  return { tenantsWithActiveLease, adopted, share: ratioOf(adopted, tenantsWithActiveLease) };
}

// Time to receipt delivered.

export interface TimeToReceiptDelivered {
  readonly receipts: number;
  readonly delivered: number;
  readonly withinTarget: number;
  /** Delivered within the target, against every receipt: one never delivered counts as late. */
  readonly share: Ratio;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
}

/**
 * Decision 4: PRD section 19's "payment confirmed to receipt delivered", beside `timeToReceipt`
 * (until sent), counted the same way. `latencyMs` runs from the payment's confirmation to the
 * receipt message's delivery report; null when it was never delivered. Across companies, call it
 * once over every company's latencies, as the M9 total does for `timeToReceipt`.
 */
export function timeToReceiptDelivered(
  receipts: readonly { readonly latencyMs: number | null }[],
  targetMs: number = RECEIPT_TARGET_MS,
): TimeToReceiptDelivered {
  const t = timeToReceipt(receipts, targetMs);
  return {
    receipts: t.receipts,
    delivered: t.sent,
    withinTarget: t.withinTarget,
    share: t.share,
    medianMs: t.medianMs,
    p95Ms: t.p95Ms,
  };
}

// Net revenue retention.

/** Net revenue retention is shown once a year of subscription invoices exists (decision 4). */
export const NRR_HISTORY_MONTHS = 12;

/** A company's subscription revenue for the month an invoice bills (PB-07). */
export interface SubscriptionRevenue {
  readonly companyId: string;
  /** The month billed, `YYYY-MM`. */
  readonly month: string;
  /** Net of credit notes; zero or more. */
  readonly amountMinor: number;
}

export interface NetRevenueRetention {
  readonly available: boolean;
  /** Whole months from the first month invoiced to this one. */
  readonly monthsOfHistory: number;
  /** Can pass 100%: growth counts. Null until available. */
  readonly share: Ratio | null;
}

const monthIndex = (month: string): number => {
  reportMonth(month);
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
};

/**
 * PRD section 19, decision 4: this month's subscription revenue from the companies that had
 * revenue 12 months earlier, over their revenue then; companies that left count nothing now, and
 * companies that joined since are left out. Available once 12 months have passed since the first
 * month invoiced; invoices for later months are ignored.
 */
export function netRevenueRetention(input: {
  readonly month: string;
  readonly invoices: readonly SubscriptionRevenue[];
}): NetRevenueRetention {
  const now = monthIndex(input.month);
  const baseMonth = toIsoDate(
    addMonths(parseBusinessDate(`${input.month}-01`), -NRR_HISTORY_MONTHS),
  ).slice(0, 7);
  let earliest: number | null = null;
  const then = new Map<string, number>();
  const current = new Map<string, number>();
  for (const invoice of input.invoices) {
    const amount = zeroOrMore(invoice.amountMinor, 'An invoice');
    const index = monthIndex(invoice.month);
    if (index > now) continue;
    earliest = earliest === null || index < earliest ? index : earliest;
    if (invoice.month === baseMonth)
      then.set(invoice.companyId, (then.get(invoice.companyId) ?? 0) + amount);
    if (invoice.month === input.month)
      current.set(invoice.companyId, (current.get(invoice.companyId) ?? 0) + amount);
  }
  const monthsOfHistory = earliest === null ? 0 : now - earliest;
  if (monthsOfHistory < NRR_HISTORY_MONTHS)
    return { available: false, monthsOfHistory, share: null };
  let numerator = 0;
  let denominator = 0;
  for (const [companyId, amount] of then) {
    if (amount === 0) continue;
    denominator += amount;
    numerator += current.get(companyId) ?? 0;
  }
  return { available: true, monthsOfHistory, share: ratioOf(numerator, denominator) };
}
