import { addDays, addMonths, compareDates, parseBusinessDate, toIsoDate } from '../dates';

/**
 * Deadlines and reminder steps for the lease trackers (TX-05, OQ-45, OQ-44) and renewals
 * (TL-09). The periods themselves come from the rules table or company settings; nothing here
 * is a legal value. Each step has a stable key, so a daily job sends it exactly once.
 */
export interface ReminderStep {
  readonly key: string;
  readonly date: string;
}

/** A deadline a number of days or months after a date (for example signing + 14 days). */
export function deadlineAfter(date: string, period: { days?: number; months?: number }): string {
  let d = parseBusinessDate(date);
  if (period.months) d = addMonths(d, period.months);
  if (period.days) d = addDays(d, period.days);
  return toIsoDate(d);
}

/**
 * The reminder steps due by `today`: one for each number of days before the deadline, then one
 * a week after it while the tracker is still open.
 */
export function dueReminderSteps(
  deadline: string,
  daysBefore: readonly number[],
  today: string,
  options: { readonly weeklyAfter?: boolean } = {},
): ReminderStep[] {
  const end = parseBusinessDate(deadline);
  const now = parseBusinessDate(today);
  const steps: ReminderStep[] = [];
  for (const days of [...new Set(daysBefore)].sort((a, b) => b - a)) {
    const date = addDays(end, -days);
    if (compareDates(date, now) <= 0) steps.push({ key: `before-${days}`, date: toIsoDate(date) });
  }
  if (options.weeklyAfter !== false) {
    for (let week = 1; week <= 520; week += 1) {
      const date = addDays(end, week * 7);
      if (compareDates(date, now) > 0) break;
      steps.push({ key: `after-week-${week}`, date: toIsoDate(date) });
    }
  }
  return steps;
}

/** Renewal reminders (TL-09): the configured days before the lease ends that have arrived. */
export function dueRenewalReminders(
  endDate: string,
  daysBefore: readonly number[],
  today: string,
): ReminderStep[] {
  return dueReminderSteps(endDate, daysBefore, today, { weeklyAfter: false }).filter(
    (s) => compareDates(parseBusinessDate(s.date), parseBusinessDate(endDate)) < 0,
  );
}

/** Whether a lease ends within the next `days` days (the expiring-leases list, TL-09). */
export function endsWithin(endDate: string, today: string, days: number): boolean {
  const end = parseBusinessDate(endDate);
  const now = parseBusinessDate(today);
  return compareDates(end, now) >= 0 && compareDates(end, addDays(now, days)) <= 0;
}
