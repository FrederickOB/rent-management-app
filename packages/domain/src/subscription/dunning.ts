import { addDays, compareDates, daysBetween, parseBusinessDate } from '../dates';

/**
 * Subscription reminders (M10 decisions 5 and 11). Product settings, not law. The `subscription.
 * dunning` job sends them; the server dedupes by invoice and step key, so a day the job missed is
 * caught up with the latest step only.
 */

export type DunningStepKey = 'past_due' | 'day_3' | 'day_7' | 'day_13';

export interface DunningStep {
  readonly key: DunningStepKey;
  readonly daysAfterDue: number;
}

/**
 * Reminder steps by days after the due date: past due the day after it (1), then 3, 7 and 13 (the
 * last warning: read-only tomorrow when the grace is 14 days).
 */
export const DUNNING_STEPS: readonly DunningStep[] = [
  { key: 'past_due', daysAfterDue: 1 },
  { key: 'day_3', daysAfterDue: 3 },
  { key: 'day_7', daysAfterDue: 7 },
  { key: 'day_13', daysAfterDue: 13 },
];

/** The steps due by today for an invoice (each day on or before today), in order. */
export function dunningStepsDue(dueOn: string, today: string): DunningStep[] {
  const due = parseBusinessDate(dueOn);
  const day = parseBusinessDate(today);
  return DUNNING_STEPS.filter((step) => compareDates(addDays(due, step.daysAfterDue), day) <= 0);
}

/** The one step to send when several are due at once: the latest. Null before the first. */
export function latestStepDue(dueOn: string, today: string): DunningStep | null {
  return dunningStepsDue(dueOn, today).at(-1) ?? null;
}

/** Trial reminders 7 days and 1 day before the trial ends (decision 5). */
export const TRIAL_REMINDER_DAYS: readonly number[] = [7, 1];

/**
 * The trial reminder due today, `trialEndsOn` being the trial's last day: 7 from 7 days before it,
 * 1 from the day before it, up to and including the last day (a missed day is caught up; the
 * server dedupes by subscription, trial end and reminder, and words the message with the date).
 * Null outside those days and once the trial is over.
 */
export function trialReminderDue(trialEndsOn: string, today: string): 7 | 1 | null {
  const left = daysBetween(parseBusinessDate(today), parseBusinessDate(trialEndsOn));
  if (left < 0) return null;
  if (left <= 1) return 1;
  if (left <= 7) return 7;
  return null;
}
