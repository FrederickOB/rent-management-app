import {
  addDays,
  businessDateOf,
  compareInstants,
  daysBetween,
  instantFrom,
  instantToDate,
  parseBusinessDate,
  startOfDay,
  type Instant,
} from '../dates';
import { DomainError } from '../errors';
import { NOTICE_TYPE_RULES, type NoticeType } from './types';

/**
 * When a notice's links stop working (LN-02; prd-issues 27; M7 decision 6). Every link of a
 * notice, reminders' fresh links included, expires at the same instant, worked out from the
 * issue, never from when the link was sent. A link is valid while `now` is before it.
 */
export const DEFAULT_NOTICE_LINK_EXPIRY_DAYS = 90;

/**
 * - A type without a notice period: the end of the day `noPeriodDays` after the issue date,
 *   company time (90 days by default, a company setting).
 * - A type with a period: the end of the effective date, company time, when the period ends;
 *   but never sooner than a type without one, so a short contractual period still leaves the
 *   ladder's links and a late signature after escalation working (plan 4.4). LN-02 requires
 *   only that a link outlive the period.
 */
export function noticeLinkExpiresAt(input: {
  readonly type: NoticeType;
  readonly issuedAt: Date | string | Instant;
  /** The type's effective date, for a type with a notice period. */
  readonly effectiveDate: string | null;
  readonly timeZone: string;
  readonly noPeriodDays: number;
}): Date {
  if (!Number.isInteger(input.noPeriodDays) || input.noPeriodDays < 1)
    throw new DomainError('notice.link_days_invalid', 'Link expiry is a whole number of days');
  const issueDate = businessDateOf(instantFrom(input.issuedAt), input.timeZone);
  const floor = startOfDay(addDays(issueDate, input.noPeriodDays + 1), input.timeZone);
  if (!NOTICE_TYPE_RULES[input.type].hasPeriod) return instantToDate(floor);
  if (!input.effectiveDate)
    throw new DomainError('notice.effective_date_required', 'The effective date is required');
  const periodEnd = startOfDay(addDays(parseBusinessDate(input.effectiveDate), 1), input.timeZone);
  return instantToDate(compareInstants(periodEnd, floor) >= 0 ? periodEnd : floor);
}

/** Whole days a notice has been outstanding, by company dates (LN-09). */
export function noticeDaysOutstanding(
  issuedAt: Date | string | Instant,
  now: Date | string | Instant,
  timeZone: string,
): number {
  return Math.max(
    0,
    daysBetween(
      businessDateOf(instantFrom(issuedAt), timeZone),
      businessDateOf(instantFrom(now), timeZone),
    ),
  );
}
