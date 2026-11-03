import type { CompanyProfile } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { parseTenancySettings, TENANCY_DEFAULTS, tenancyValuesOf } from './tenancy-settings';

const M1: CompanyProfile['settings'] = {
  rentReminderOffsetsDays: [-7, 0, 3, 7, 14],
  noticeReminderOffsetsHours: [24, 72, 120, 168],
  renewalReminderDays: [90, 60, 30],
  advanceRentPolicy: 'off',
  approvalExpiryDays: 7,
  approvalCoolingOffHours: 24,
};

describe('decision 4, TX-05, OQ-45 and TL-07 the M3 company settings', () => {
  it('starts from the settings in force, and from the plan’s defaults when none are sent', () => {
    expect(
      tenancyValuesOf({
        ...M1,
        witnessRequired: false,
        rentControlCommercial: true,
        rentControlReminderDaysBefore: [10, 3],
        stampingReminderDaysBefore: [21],
        signingReminderHours: [12, 48],
      }),
    ).toEqual({
      witnessRequired: false,
      rentControlCommercial: true,
      rentControlReminderDaysBefore: '10, 3',
      stampingReminderDaysBefore: '21',
      signingReminderHours: '12, 48',
    });
    expect(tenancyValuesOf(M1)).toEqual({
      witnessRequired: true,
      rentControlCommercial: false,
      rentControlReminderDaysBefore: '7, 2, 0',
      stampingReminderDaysBefore: '30, 14, 7',
      signingReminderHours: '24, 72, 168',
    });
    expect(TENANCY_DEFAULTS.signingReminderHours).toBe('24, 72, 168');
  });

  it('saves lists the domain accepts', () => {
    const { settings, errors } = parseTenancySettings({
      witnessRequired: false,
      rentControlCommercial: true,
      rentControlReminderDaysBefore: '7 2 0',
      stampingReminderDaysBefore: '366, 30',
      signingReminderHours: '1, 720',
    });
    expect(errors).toEqual({});
    expect(settings).toEqual({
      witnessRequired: false,
      rentControlCommercial: true,
      rentControlReminderDaysBefore: [7, 2, 0],
      stampingReminderDaysBefore: [366, 30],
      signingReminderHours: [1, 720],
    });
  });

  it('refuses what the domain refuses: out of range, empty, too many or not numbers', () => {
    const { errors } = parseTenancySettings({
      witnessRequired: true,
      rentControlCommercial: false,
      rentControlReminderDaysBefore: '367',
      stampingReminderDaysBefore: '',
      signingReminderHours: '0, 24',
    });
    expect(errors).toEqual({
      rentControlReminderDaysBefore:
        'Enter 1 to 12 whole numbers of days, from 0 to 366, separated by commas.',
      stampingReminderDaysBefore:
        'Enter 1 to 12 whole numbers of days, from 0 to 366, separated by commas.',
      signingReminderHours:
        'Enter 1 to 12 whole numbers of hours, from 1 to 720 (30 days), separated by commas.',
    });
    const more = parseTenancySettings({
      witnessRequired: true,
      rentControlCommercial: false,
      rentControlReminderDaysBefore: Array.from({ length: 13 }, (_, i) => i).join(', '),
      stampingReminderDaysBefore: 'a week',
      signingReminderHours: '721',
    }).errors;
    expect(Object.keys(more).sort()).toEqual([
      'rentControlReminderDaysBefore',
      'signingReminderHours',
      'stampingReminderDaysBefore',
    ]);
  });
});
