import {
  addDays,
  compareDates,
  daysBetween,
  parseBusinessDate,
  toIsoDate,
  type BusinessDate,
} from '../dates';
import { DomainError } from '../errors';
import { money, multiplyRatio } from '../money/money';
import { deadlineAfter } from './deadlines';
import { fullPeriodEnd, periodStart, rentOn, type LeaseTerms, type LeaseUse } from './lease-terms';
import type { LeaseStatus } from './lease-states';
import { holdingOverPeriods, rentSchedule, type ChargePeriod } from './schedule';

/**
 * Why a lease ended: a move-out was recorded, its renewal started, or the next lease on its unit
 * started (the tenant held over until then; review finding 3).
 */
export const LEASE_END_REASONS = ['moved_out', 'renewed', 'superseded'] as const;
export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];

/**
 * What the daily lease job does with a lease (M3 plan 4.7 and 4.10), as a pure decision: start a
 * signed lease on its start date, end a lease when its renewal (or the next lease on its unit)
 * has started, and hold a lease over once its end date passes with no renewal starting and no
 * move-out recorded (OQ-12). A lease whose successor leaves a gap after its end holds over for
 * the gap first, so no day goes uncharged; the job then ends it the day before the successor.
 */
export type ScheduledTransition =
  | { readonly to: 'active'; readonly activatedOn: string }
  | { readonly to: 'holding_over'; readonly holdingOverSince: string }
  | {
      readonly to: 'ended';
      readonly endReason: Exclude<LeaseEndReason, 'moved_out'>;
      readonly endedOn: string;
    };

export interface TransitionInput {
  readonly status: LeaseStatus;
  readonly startDate: string;
  readonly endDate: string;
  /** The start date of this lease's renewal, when the renewal is signed or active. */
  readonly renewalStart: string | null;
  /**
   * The start date of the next lease on the unit that does not renew this one, when it is signed
   * or has started.
   */
  readonly successorStart?: string | null;
}

export function scheduledTransition(
  lease: TransitionInput,
  today: string,
): ScheduledTransition | null {
  const now = parseBusinessDate(today);
  const end = parseBusinessDate(lease.endDate);
  const started = (date: string | null | undefined): date is string =>
    date !== null && date !== undefined && compareDates(parseBusinessDate(date), now) <= 0;
  const next: { start: string; reason: 'renewed' | 'superseded' } | null = started(
    lease.renewalStart,
  )
    ? { start: lease.renewalStart, reason: 'renewed' }
    : started(lease.successorStart)
      ? { start: lease.successorStart, reason: 'superseded' }
      : null;
  switch (lease.status) {
    case 'signed':
      return compareDates(parseBusinessDate(lease.startDate), now) <= 0
        ? { to: 'active', activatedOn: lease.startDate }
        : null;
    case 'active': {
      if (compareDates(end, now) >= 0) return null;
      const dayAfter = addDays(end, 1);
      // Its successor starts the day after its end: it ends on its end date, with no gap.
      if (next && compareDates(parseBusinessDate(next.start), dayAfter) <= 0)
        return {
          to: 'ended',
          endReason: next.reason,
          endedOn: endedBefore(next.start, lease.endDate),
        };
      return { to: 'holding_over', holdingOverSince: toIsoDate(dayAfter) };
    }
    case 'holding_over':
      return next
        ? { to: 'ended', endReason: next.reason, endedOn: endedBefore(next.start, today) }
        : null;
    case 'ending':
      // A lease ending past its end date with no move-out recorded holds over too.
      if (compareDates(end, now) >= 0 || !next) return null;
      return { to: 'ended', endReason: next.reason, endedOn: endedBefore(next.start, today) };
    default:
      return null;
  }
}

/** The last day of the old lease: the day before its successor starts, never after `latest`. */
function endedBefore(successorStart: string, latest: string): string {
  const dayBefore = toIsoDate(addDays(parseBusinessDate(successorStart), -1));
  return dayBefore < latest ? dayBefore : latest;
}

/**
 * Where a renewal starts (TL-09): the day after the old lease ends. When the old lease is already
 * holding over, at the start of its first rent period after the last day already charged
 * (`lastChargedDay`, the latest end of its schedule rows) and on or after today, so the renewal
 * follows on from the months held over without charging any day twice (review finding 3).
 */
export function renewalStartDate(
  terms: Pick<LeaseTerms, 'startDate' | 'endDate'>,
  today: string,
  lastChargedDay?: string | null,
): string {
  const end = parseBusinessDate(terms.endDate);
  const now = parseBusinessDate(today);
  const charged =
    lastChargedDay && compareDates(parseBusinessDate(lastChargedDay), end) > 0
      ? parseBusinessDate(lastChargedDay)
      : end;
  const dayAfter = addDays(end, 1);
  if (compareDates(charged, end) <= 0 && compareDates(dayAfter, now) >= 0)
    return toIsoDate(dayAfter);
  const start = parseBusinessDate(terms.startDate);
  for (let k = 0; k < 1200; k += 1) {
    const next = periodStart(start, k);
    if (compareDates(next, charged) > 0 && compareDates(next, now) >= 0) return toIsoDate(next);
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
 * The next lease on the unit, as seen by a lease held over (review finding 3): it holds the unit
 * from `start`, so the tenancy held over charges no day from then on. `started` once that lease
 * has begun (it can no longer be recalled or cancelled).
 */
export interface HoldingOverSuccessor {
  readonly start: string;
  readonly started: boolean;
}

/**
 * The schedule of a tenancy held over, up to `today` (OQ-12: month to month at the last rate).
 * After a short final period the rest of that month comes first, charged as the exact complement
 * of the final period so the two add up to one month's rent; then whole months anchored on the
 * lease start. Sequences continue after the schedule and do not depend on `today`, so inserting
 * the rows again changes nothing.
 *
 * The next lease on the unit stops it (no two leases charge a unit for the same day): nothing is
 * charged from the successor's start on. The period the successor cuts short is charged only once
 * the successor has started, prorated by days and rounded half up once (CLAUDE.md sections 4 and
 * 11); until then it waits, because the schedule is append-only and a successor still waiting
 * for signatures, or signed but not started, may yet be recalled or cancelled.
 */
export function holdingOverSchedule(
  terms: LeaseTerms,
  today: string,
  successor: HoldingOverSuccessor | null = null,
): ChargePeriod[] {
  const start = parseBusinessDate(terms.startDate);
  const end = parseBusinessDate(terms.endDate);
  const now = parseBusinessDate(today);
  const cap = successor ? parseBusinessDate(successor.start) : null;
  const final = successor?.started === true;
  const lastIndex = terms.periodCount - 1;
  const lastFullEnd = fullPeriodEnd(start, lastIndex);
  const lastRent = rentOn(terms, terms.endDate);
  const monthly = (type: ChargePeriod['chargeType']) =>
    type === 'rent' ? lastRent : (terms.serviceChargeMonthlyMinor ?? 0);
  /** The last day a period from `from` to `fullTo` may charge, or null if it must wait. */
  const chargedTo = (from: BusinessDate, fullTo: BusinessDate): BusinessDate | null => {
    if (!cap || compareDates(cap, fullTo) > 0) return fullTo;
    if (compareDates(cap, from) <= 0 || !final) return null;
    return addDays(cap, -1);
  };
  const rows: ChargePeriod[] = [];
  let sequence = terms.periodCount;
  if (compareDates(lastFullEnd, end) > 0) {
    const from = addDays(end, 1);
    const to = compareDates(from, now) <= 0 ? chargedTo(from, lastFullEnd) : null;
    if (to) {
      // With the short final period, the days to `to` make the month prorated to that day.
      const periodFrom = periodStart(start, lastIndex);
      const length = daysBetween(periodFrom, lastFullEnd) + 1;
      const upTo = daysBetween(periodFrom, to) + 1;
      for (const last of rentSchedule(terms).filter((r) => r.sequence === lastIndex)) {
        const whole = monthly(last.chargeType);
        const rest =
          (upTo === length ? whole : multiplyRatio(money(whole), upTo, length).amountMinor) -
          last.amountMinor;
        if (rest > 0)
          rows.push({
            sequence,
            chargeType: last.chargeType,
            periodStart: toIsoDate(from),
            periodEnd: toIsoDate(to),
            amountMinor: rest,
            prorated: true,
          });
      }
    }
    sequence += 1;
  }
  for (let k = terms.periodCount; k < terms.periodCount + 1200; k += 1) {
    const from = periodStart(start, k);
    if (compareDates(from, now) > 0) break;
    const fullTo = fullPeriodEnd(start, k);
    const to = chargedTo(from, fullTo);
    if (!to) break;
    if (compareDates(to, fullTo) === 0) {
      for (const row of holdingOverPeriods(terms, k)) rows.push({ ...row, sequence });
      sequence += 1;
      continue;
    }
    // Cut short by the successor: prorated by days, then nothing more.
    const used = daysBetween(from, to) + 1;
    const length = daysBetween(from, fullTo) + 1;
    for (const type of ['rent', 'service_charge'] as const) {
      const whole = monthly(type);
      const amount = whole > 0 ? multiplyRatio(money(whole), used, length).amountMinor : 0;
      if (amount > 0)
        rows.push({
          sequence,
          chargeType: type,
          periodStart: toIsoDate(from),
          periodEnd: toIsoDate(to),
          amountMinor: amount,
          prorated: true,
        });
    }
    break;
  }
  return rows;
}
