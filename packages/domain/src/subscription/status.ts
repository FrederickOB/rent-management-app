import { addDays, compareDates, parseBusinessDate, toIsoDate, type BusinessDate } from '../dates';
import { DomainError } from '../errors';
import { SUBSCRIPTION_STATUSES, type CompanyAccess, type SubscriptionStatus } from './constants';
import { monthBounds, monthOf } from './pricing';

/**
 * The subscription's status and the company's access (M10 decisions 5, 11 and 12; PB-08, PB-10,
 * PB-11). Both are derived from facts each time; the server records an event when the status
 * changes. There is no Expired state: billing is in arrears, so nothing is owed when a trial ends
 * and the subscription simply becomes Active (decision 5).
 */

export interface SubscriptionFacts {
  readonly today: string;
  /** The trial's last day; null when there was none. */
  readonly trialEndsOn: string | null;
  /** The last day of service when a cancellation is scheduled; null otherwise. */
  readonly cancelsOn: string | null;
  /** The due date of the oldest open invoice; null when nothing is open. */
  readonly oldestUnpaidDueOn: string | null;
  /** Days after the due date before read-only (OQ-34: 14). */
  readonly graceDays: number;
  /** The read-only switch (default on, OQ-34). */
  readonly readOnlyEnabled: boolean;
}

function checkDays(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('subscription.bad_days', `${what} must be a whole number of days`);
  return value;
}

interface Arrears {
  readonly pastDue: boolean;
  readonly readOnlyFrom: BusinessDate | null;
  readonly readOnly: boolean;
}

/**
 * Past due from the day after the due date; read-only from the due date plus the grace days (at
 * the earliest the first day past due, so a grace of 0 never makes an invoice read-only on the day
 * it is due), and only while the switch is on.
 */
function arrearsOf(f: SubscriptionFacts, today: BusinessDate): Arrears {
  const grace = checkDays(f.graceDays, 'The grace period');
  if (f.oldestUnpaidDueOn === null) return { pastDue: false, readOnlyFrom: null, readOnly: false };
  const due = parseBusinessDate(f.oldestUnpaidDueOn);
  const pastDue = compareDates(today, due) > 0;
  const readOnlyFrom = pastDue && f.readOnlyEnabled ? addDays(due, Math.max(grace, 1)) : null;
  return {
    pastDue,
    readOnlyFrom,
    readOnly: readOnlyFrom !== null && compareDates(today, readOnlyFrom) >= 0,
  };
}

/**
 * The status, in this order: cancelled (today > cancelsOn) > cancel_scheduled > trialing (today <=
 * trialEndsOn) > read_only (switch on and today >= due + grace) > past_due (today > due) > active.
 */
export function subscriptionStatus(f: SubscriptionFacts): SubscriptionStatus {
  const today = parseBusinessDate(f.today);
  const arrears = arrearsOf(f, today);
  if (f.cancelsOn !== null)
    return compareDates(today, parseBusinessDate(f.cancelsOn)) > 0
      ? 'cancelled'
      : 'cancel_scheduled';
  if (f.trialEndsOn !== null && compareDates(today, parseBusinessDate(f.trialEndsOn)) <= 0)
    return 'trialing';
  if (arrears.readOnly) return 'read_only';
  if (arrears.pastDue) return 'past_due';
  return 'active';
}

/**
 * The company's access (decision 11). 'read_only' once cancelled (staff keep read access for the
 * retention period, decision 12), or while an invoice is past due beyond the grace with the switch
 * on. Judged on the arrears whatever the status, so neither scheduling a cancellation nor an
 * extended trial lifts read-only: paying does. `readOnlyFrom` is due + grace while something is
 * past due and the switch is on, else null.
 */
export function subscriptionAccess(f: SubscriptionFacts): {
  access: CompanyAccess;
  readOnlyFrom: string | null;
} {
  const today = parseBusinessDate(f.today);
  const arrears = arrearsOf(f, today);
  const status = subscriptionStatus(f);
  return {
    access: status === 'cancelled' || arrears.readOnly ? 'read_only' : 'full',
    readOnlyFrom: arrears.readOnlyFrom === null ? null : toIsoDate(arrears.readOnlyFrom),
  };
}

/**
 * Allowed transitions. The status is derived, so the table admits every change the facts can
 * produce, and refuses the rest:
 *
 * | From             | To               | When                                                        |
 * | ---------------- | ---------------- | ----------------------------------------------------------- |
 * | trialing         | active           | the trial ends; billing starts (decision 5)                 |
 * | trialing         | past_due         | an extended trial ends while an earlier invoice is past due |
 * | trialing         | read_only        | the same, beyond the grace with the switch on               |
 * | trialing         | cancel_scheduled | the landlord cancels during the trial (decision 12)         |
 * | active           | past_due         | an invoice is unpaid the day after its due date             |
 * | active           | read_only        | past due and the grace ends on the same day (grace of 1),   |
 * |                  |                  | or a day the lifecycle job did not run                      |
 * | active           | trialing         | a platform admin extends a trial that had ended (decision 5)|
 * | active           | cancel_scheduled | the landlord cancels                                        |
 * | past_due         | active           | paid                                                        |
 * | past_due         | read_only        | the grace ends with the switch on (decision 11)             |
 * | past_due         | trialing         | a platform admin extends an ended trial                     |
 * | past_due         | cancel_scheduled | the landlord cancels (read-only still follows the arrears)  |
 * | read_only        | active           | paid: full access at once                                   |
 * | read_only        | past_due         | the oldest invoice is paid and a newer one is past due      |
 * |                  |                  | within its grace, or the switch is turned off               |
 * | read_only        | trialing         | a platform admin extends an ended trial                     |
 * | read_only        | cancel_scheduled | the landlord cancels (access stays read-only while unpaid)  |
 * | cancel_scheduled | cancelled        | the last day of service has passed                          |
 * | cancel_scheduled | trialing, active, past_due, read_only | the cancellation is withdrawn          |
 * | cancelled        | (none)           | final: a new subscription is a new record                   |
 *
 * A status never "changes" to itself, and only cancel_scheduled leads to cancelled.
 */
const TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  trialing: ['active', 'past_due', 'read_only', 'cancel_scheduled'],
  active: ['past_due', 'read_only', 'trialing', 'cancel_scheduled'],
  past_due: ['active', 'read_only', 'trialing', 'cancel_scheduled'],
  read_only: ['active', 'past_due', 'trialing', 'cancel_scheduled'],
  cancel_scheduled: ['cancelled', 'trialing', 'active', 'past_due', 'read_only'],
  cancelled: [],
};

export const canTransition = (from: SubscriptionStatus, to: SubscriptionStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

/** Throws 'subscription.bad_transition' unless the table allows the change. */
export function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!SUBSCRIPTION_STATUSES.includes(from) || !SUBSCRIPTION_STATUSES.includes(to))
    throw new DomainError(
      'subscription.bad_transition',
      `Not a subscription status: ${String(from)} or ${String(to)}`,
    );
  if (!canTransition(from, to))
    throw new DomainError(
      'subscription.bad_transition',
      `A subscription cannot go from ${from} to ${to}`,
    );
}

/**
 * The last day of service when cancelling now (decision 12): the end of this month (billed for the
 * month in arrears); during a trial, the earlier of the trial's last day and the month's end, so
 * nothing is billed after it. Never before today. Throws 'subscription.already_cancelling' or
 * 'subscription.cancelled'.
 */
export function cancelEffectiveOn(f: {
  readonly today: string;
  readonly status: SubscriptionStatus;
  readonly trialEndsOn: string | null;
}): string {
  if (f.status === 'cancelled')
    throw new DomainError('subscription.cancelled', 'This subscription has already ended');
  if (f.status === 'cancel_scheduled')
    throw new DomainError(
      'subscription.already_cancelling',
      'A cancellation is already scheduled for this subscription',
    );
  const today = parseBusinessDate(f.today);
  let last = parseBusinessDate(monthBounds(monthOf(f.today)).last);
  if (f.status === 'trialing' && f.trialEndsOn !== null) {
    const trialLast = parseBusinessDate(f.trialEndsOn);
    if (compareDates(trialLast, last) < 0) last = trialLast;
  }
  return toIsoDate(compareDates(last, today) < 0 ? today : last);
}

/** The trial's last day: creation date + trialDays − 1 (a 30-day trial counts the creation day). */
export function trialEndsOn(createdOn: string, trialDays: number): string {
  return toIsoDate(
    addDays(parseBusinessDate(createdOn), checkDays(trialDays, 'The trial length') - 1),
  );
}

/** The first billable day after a trial (`tierSpans`' billFrom); null when there was no trial. */
export function billingStartsOn(trialLastDay: string | null): string | null {
  return trialLastDay === null ? null : toIsoDate(addDays(parseBusinessDate(trialLastDay), 1));
}

/** After a cancellation, staff keep read-only access until this day (decision 12). */
export function readOnlyUntil(cancelsOn: string, retentionDays: number): string {
  return toIsoDate(
    addDays(parseBusinessDate(cancelsOn), checkDays(retentionDays, 'The retention period')),
  );
}
