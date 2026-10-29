import { addDays, compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { deadlineAfter } from './deadlines';
import { fullPeriodEnd, periodStart, rentOn, type LeaseTerms, type LeaseUse } from './lease-terms';
import type { LeaseStatus } from './lease-states';
import { holdingOverPeriods, rentSchedule, type ChargePeriod } from './schedule';

/**
 * What the daily lease job does with a lease (M3 plan 4.7 and 4.10), as a pure decision: start a
 * signed lease on its start date, end a lease when its renewal has started, and hold a lease over
 * once its end date passes with no renewal starting and no move-out recorded (OQ-12).
 */
export type ScheduledTransition =
  | { readonly to: 'active'; readonly activatedOn: string }
  | { readonly to: 'holding_over'; readonly holdingOverSince: string }
  | { readonly to: 'ended'; readonly endReason: 'renewed'; readonly endedOn: string };

export interface TransitionInput {
  readonly status: LeaseStatus;
  readonly startDate: string;
  readonly endDate: string;
  /** The start date of this lease's renewal, when the renewal is signed or active. */
  readonly renewalStart: string | null;
}

export function scheduledTransition(
  lease: TransitionInput,
  today: string,
): ScheduledTransition | null {
  const now = parseBusinessDate(today);
  const end = parseBusinessDate(lease.endDate);
  const renewalStarted =
    lease.renewalStart !== null && compareDates(parseBusinessDate(lease.renewalStart), now) <= 0;
  switch (lease.status) {
    case 'signed':
      return compareDates(parseBusinessDate(lease.startDate), now) <= 0
        ? { to: 'active', activatedOn: lease.startDate }
        : null;
    case 'active':
      if (compareDates(end, now) >= 0) return null;
      if (renewalStarted)
        return { to: 'ended', endReason: 'renewed', endedOn: endedBefore(lease, lease.endDate) };
      return { to: 'holding_over', holdingOverSince: toIsoDate(addDays(end, 1)) };
    case 'holding_over':
      return renewalStarted
        ? { to: 'ended', endReason: 'renewed', endedOn: endedBefore(lease, today) }
        : null;
    default:
      return null;
  }
}

/** The last day of the old lease: the day before its renewal starts, never after `latest`. */
function endedBefore(lease: TransitionInput, latest: string): string {
  const dayBefore = toIsoDate(addDays(parseBusinessDate(lease.renewalStart!), -1));
  return dayBefore < latest ? dayBefore : latest;
}

/**
 * Where a renewal starts (TL-09): the day after the old lease ends. When the old lease is already
 * holding over, at the start of its next rent period on or after today, so the renewal follows on
 * from the months held over without overlapping them.
 */
export function renewalStartDate(
  terms: Pick<LeaseTerms, 'startDate' | 'endDate'>,
  today: string,
): string {
  const dayAfter = addDays(parseBusinessDate(terms.endDate), 1);
  const now = parseBusinessDate(today);
  if (compareDates(dayAfter, now) >= 0) return toIsoDate(dayAfter);
  const start = parseBusinessDate(terms.startDate);
  for (let k = 0; k < 1200; k += 1) {
    const next = periodStart(start, k);
    if (compareDates(next, now) >= 0) return toIsoDate(next);
  }
  throw new DomainError('lease.renewal_start', 'Choose the renewal’s start date');
}

/**
 * The compliance trackers a lease gets when it is signed (TX-05, OQ-45, OQ-44; plan 4.11). The
 * periods come from the rules table; a missing rule leaves that tracker without a deadline. None
 * of them ever blocks the lease or rent collection.
 */
export interface TrackerRules {
  /** `rent_control.registration_days` (14, unverified). */
  readonly rentControlDays: number | null;
  /** `stamp_duty.deadline_months` (2, unverified). */
  readonly stampDutyMonths: number | null;
  /** `lease.writing_exemption_max_years` (3, unverified). */
  readonly writingExemptionMaxYears: number | null;
}

export interface LeaseTrackers {
  readonly rentControl: { readonly applies: boolean; readonly deadline: string | null };
  readonly stamping: { readonly deadline: string | null };
  readonly formalLease: { readonly required: boolean };
}

export function leaseTrackers(
  input: {
    /** The business date of signing: the deadlines count from it (OQ-52, OQ-45). */
    readonly signedOn: string;
    readonly use: LeaseUse;
    readonly periodCount: number;
    /** The company tracks Rent Control for commercial leases too (OQ-52). */
    readonly rentControlCommercial: boolean;
  },
  rules: TrackerRules,
): LeaseTrackers {
  const applies = input.use === 'residential' || input.rentControlCommercial;
  return {
    rentControl: {
      applies,
      deadline:
        applies && rules.rentControlDays !== null
          ? deadlineAfter(input.signedOn, { days: rules.rentControlDays })
          : null,
    },
    stamping: {
      deadline:
        rules.stampDutyMonths !== null
          ? deadlineAfter(input.signedOn, { months: rules.stampDutyMonths })
          : null,
    },
    formalLease: {
      required:
        rules.writingExemptionMaxYears !== null &&
        input.periodCount > rules.writingExemptionMaxYears * 12,
    },
  };
}

/** One reminder to send now, out of the steps that are due: the latest, once (catch-up safe). */
export function reminderToSend<T extends { readonly key: string }>(
  due: readonly T[],
  sent: ReadonlySet<string>,
): { readonly send: T | null; readonly skip: readonly T[] } {
  const unsent = due.filter((s) => !sent.has(s.key));
  if (unsent.length === 0) return { send: null, skip: [] };
  return { send: unsent.at(-1)!, skip: unsent.slice(0, -1) };
}

/**
 * The schedule of a tenancy held over, up to `today` (OQ-12: month to month at the last rate).
 * After a short final period the rest of that month comes first, charged as the exact complement
 * of the final period so the two add up to one month's rent; then whole months anchored on the
 * lease start. Sequences continue after the schedule and do not depend on `today`, so inserting
 * the rows again changes nothing.
 */
export function holdingOverSchedule(terms: LeaseTerms, today: string): ChargePeriod[] {
  const start = parseBusinessDate(terms.startDate);
  const end = parseBusinessDate(terms.endDate);
  const now = parseBusinessDate(today);
  const lastIndex = terms.periodCount - 1;
  const lastFullEnd = fullPeriodEnd(start, lastIndex);
  const rows: ChargePeriod[] = [];
  let sequence = terms.periodCount;
  if (compareDates(lastFullEnd, end) > 0) {
    const from = addDays(end, 1);
    if (compareDates(from, now) <= 0) {
      const monthly = (type: ChargePeriod['chargeType']) =>
        type === 'rent' ? rentOn(terms, terms.endDate) : (terms.serviceChargeMonthlyMinor ?? 0);
      for (const last of rentSchedule(terms).filter((r) => r.sequence === lastIndex)) {
        const rest = monthly(last.chargeType) - last.amountMinor;
        if (rest > 0)
          rows.push({
            sequence,
            chargeType: last.chargeType,
            periodStart: toIsoDate(from),
            periodEnd: toIsoDate(lastFullEnd),
            amountMinor: rest,
            prorated: true,
          });
      }
    }
    sequence += 1;
  }
  for (let k = terms.periodCount; k < terms.periodCount + 1200; k += 1) {
    if (compareDates(periodStart(start, k), now) > 0) break;
    for (const row of holdingOverPeriods(terms, k)) rows.push({ ...row, sequence });
    sequence += 1;
  }
  return rows;
}
