import { describe, expect, it } from 'vitest';
import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import {
  DUNNING_STEPS,
  dunningStepsDue,
  latestStepDue,
  TRIAL_REMINDER_DAYS,
  trialReminderDue,
} from './dunning';
import { subscriptionStatus } from './status';

const plus = (date: string, days: number): string =>
  toIsoDate(addDays(parseBusinessDate(date), days));

describe('PB-11 subscription reminders (decision 11)', () => {
  const due = '2026-11-08';

  it('reminds the day after the due date, then at +3, +7 and +13 days', () => {
    expect(DUNNING_STEPS.map((s) => [s.key, s.daysAfterDue])).toEqual([
      ['past_due', 1],
      ['day_3', 3],
      ['day_7', 7],
      ['day_13', 13],
    ]);
    const keys = (today: string) => dunningStepsDue(due, today).map((s) => s.key);
    expect(keys('2026-11-08')).toEqual([]);
    expect(keys('2026-11-09')).toEqual(['past_due']);
    expect(keys('2026-11-11')).toEqual(['past_due', 'day_3']);
    expect(keys('2026-11-15')).toEqual(['past_due', 'day_3', 'day_7']);
    expect(keys('2026-11-21')).toEqual(['past_due', 'day_3', 'day_7', 'day_13']);
    expect(keys('2027-03-01')).toEqual(['past_due', 'day_3', 'day_7', 'day_13']);
  });

  it('sends only the latest step when several are due at once', () => {
    expect(latestStepDue(due, '2026-11-08')).toBeNull();
    expect(latestStepDue(due, '2026-11-12')?.key).toBe('day_3');
    expect(latestStepDue(due, '2026-11-30')?.key).toBe('day_13');
  });

  it('gives the last warning the day before read-only with the default grace of 14 days', () => {
    const last = plus(due, 13);
    expect(latestStepDue(due, last)?.key).toBe('day_13');
    const status = (today: string) =>
      subscriptionStatus({
        today,
        trialEndsOn: null,
        cancelsOn: null,
        oldestUnpaidDueOn: due,
        graceDays: 14,
        readOnlyEnabled: true,
      });
    expect(status(last)).toBe('past_due');
    expect(status(plus(last, 1))).toBe('read_only');
  });
});

describe('PB-08 trial reminders (decision 5)', () => {
  it('reminds 7 days and 1 day before the trial ends, catching up a missed day', () => {
    expect(TRIAL_REMINDER_DAYS).toEqual([7, 1]);
    const ends = '2026-11-30';
    expect(trialReminderDue(ends, '2026-11-22')).toBeNull();
    expect(trialReminderDue(ends, '2026-11-23')).toBe(7);
    expect(trialReminderDue(ends, '2026-11-28')).toBe(7);
    expect(trialReminderDue(ends, '2026-11-29')).toBe(1);
    expect(trialReminderDue(ends, '2026-11-30')).toBe(1);
    expect(trialReminderDue(ends, '2026-12-01')).toBeNull();
  });
});
