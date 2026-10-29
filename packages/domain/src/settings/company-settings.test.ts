import { describe, expect, it } from 'vitest';
import { defaultCompanySettings, mergeCompanySettings } from './company-settings';

describe('AD-01 company settings', () => {
  it('uses the PRD defaults', () => {
    expect(defaultCompanySettings()).toEqual({
      rentReminderOffsetsDays: [-7, 0, 3, 7, 14],
      noticeReminderOffsetsHours: [24, 72, 120, 168],
      renewalReminderDays: [90, 60, 30],
      advanceRentPolicy: 'off',
      approvalExpiryDays: 7,
      approvalCoolingOffHours: 24,
    });
  });

  it('validates partial updates and refuses unknown keys', () => {
    const merged = mergeCompanySettings(defaultCompanySettings(), { advanceRentPolicy: 'warn' });
    expect(merged.advanceRentPolicy).toBe('warn');
    expect(merged.renewalReminderDays).toEqual([90, 60, 30]);
    expect(() =>
      mergeCompanySettings(defaultCompanySettings(), { advanceRentPolicy: 'maybe' }),
    ).toThrow();
    expect(() => mergeCompanySettings(defaultCompanySettings(), { madeUp: true })).toThrow();
  });

  it('never lets the cooling-off period drop below 24 hours (AD-05)', () => {
    expect(() =>
      mergeCompanySettings(defaultCompanySettings(), { approvalCoolingOffHours: 1 }),
    ).toThrow();
  });
});
