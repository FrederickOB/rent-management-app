import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, parseBusinessDate, startOfDay, toIsoDate } from '../dates';
import { defaultCompanySettings, mergeCompanySettings, parseCompanySettings } from '../settings';
import { PRD_NOTICE_LADDER } from './ladder';
import {
  DEFAULT_NOTICE_LINK_EXPIRY_DAYS,
  noticeDaysOutstanding,
  noticeLinkExpiresAt,
} from './links';
import { formatNoticeNumber, parseNoticeNumber } from './numbers';
import { noticeLadderFor, noticeSettingsOf } from './settings';
import { NOTICE_TYPES, NOTICE_TYPE_RULES } from './types';

/** A fixed clock: Wednesday 4 November 2026, 10:00 UTC. */
const ISSUED = new Date('2026-11-04T10:00:00Z');

describe('LN-02 link expiry', () => {
  it('lasts 90 days after issue for a type without a notice period (prd-issues 27)', () => {
    expect(DEFAULT_NOTICE_LINK_EXPIRY_DAYS).toBe(90);
    for (const type of ['rent_demand', 'building_wide', 'entry', 'breach'] as const)
      expect(
        noticeLinkExpiresAt({
          type,
          issuedAt: ISSUED,
          effectiveDate: null,
          timeZone: 'Africa/Accra',
          noPeriodDays: 90,
        }).toISOString(),
      ).toBe('2027-02-03T00:00:00.000Z');
  });

  it('lasts until the end of the effective date, company time, for a type with a period', () => {
    expect(
      noticeLinkExpiresAt({
        type: 'notice_to_quit',
        issuedAt: ISSUED,
        effectiveDate: '2027-05-31',
        timeZone: 'Africa/Accra',
        noPeriodDays: 90,
      }).toISOString(),
    ).toBe('2027-06-01T00:00:00.000Z');
    expect(
      noticeLinkExpiresAt({
        type: 'non_renewal',
        issuedAt: ISSUED,
        effectiveDate: '2027-07-31',
        timeZone: 'Europe/London',
        noPeriodDays: 90,
      }).toISOString(),
    ).toBe('2027-07-31T23:00:00.000Z');
  });

  it('never expires sooner than a no-period link, so a short period keeps late signatures possible', () => {
    expect(
      noticeLinkExpiresAt({
        type: 'rent_review',
        issuedAt: ISSUED,
        effectiveDate: '2026-11-11',
        timeZone: 'Africa/Accra',
        noPeriodDays: 90,
      }).toISOString(),
    ).toBe('2027-02-03T00:00:00.000Z');
  });

  it('needs an effective date for a type with a period, and whole days', () => {
    expect(() =>
      noticeLinkExpiresAt({
        type: 'notice_to_quit',
        issuedAt: ISSUED,
        effectiveDate: null,
        timeZone: 'Africa/Accra',
        noPeriodDays: 90,
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.effective_date_required' }));
    expect(() =>
      noticeLinkExpiresAt({
        type: 'rent_demand',
        issuedAt: ISSUED,
        effectiveDate: null,
        timeZone: 'Africa/Accra',
        noPeriodDays: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.link_days_invalid' }));
  });

  it('expires only after the notice period ends, and never before the no-period days (property-based)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NOTICE_TYPES),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 30, max: 366 }),
        fc.constantFrom('Africa/Accra', 'Europe/London'),
        (type, issued, effectiveOffset, noPeriodDays, timeZone) => {
          const issuedAt = new Date(issued);
          const issueDay = parseBusinessDate(issuedAt.toISOString().slice(0, 10));
          const effectiveDate = toIsoDate(addDays(issueDay, effectiveOffset));
          const expires = noticeLinkExpiresAt({
            type,
            issuedAt,
            effectiveDate,
            timeZone,
            noPeriodDays,
          });
          // Valid through the whole effective date, in company time.
          if (NOTICE_TYPE_RULES[type].hasPeriod)
            expect(expires.getTime()).toBeGreaterThanOrEqual(
              startOfDay(addDays(parseBusinessDate(effectiveDate), 1), timeZone).epochMilliseconds,
            );
          // And for at least the no-period days after issue.
          expect(expires.getTime()).toBeGreaterThan(issued + (noPeriodDays - 1) * 86_400_000);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('counts days outstanding by company dates (LN-09)', () => {
    expect(noticeDaysOutstanding(ISSUED, new Date('2026-11-04T23:59:00Z'), 'Africa/Accra')).toBe(0);
    expect(noticeDaysOutstanding(ISSUED, new Date('2026-11-11T00:00:00Z'), 'Africa/Accra')).toBe(7);
    expect(noticeDaysOutstanding(ISSUED, new Date('2026-11-01T00:00:00Z'), 'Africa/Accra')).toBe(0);
  });
});

describe('LN-02 notice numbers (decision 15)', () => {
  it('formats gap-free numbers as N-000001', () => {
    expect(formatNoticeNumber(1)).toBe('N-000001');
    expect(formatNoticeNumber(42)).toBe('N-000042');
    expect(formatNoticeNumber(1_234_567)).toBe('N-1234567');
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => formatNoticeNumber(bad)).toThrow(
        expect.objectContaining({ code: 'notice.number_invalid' }),
      );
  });

  it('parses only canonical numbers, and round-trips (property-based)', () => {
    expect(parseNoticeNumber('N-000042')).toBe(42);
    expect(parseNoticeNumber(' n-000042 ')).toBe(42);
    expect(parseNoticeNumber('N-0000042')).toBeNull();
    expect(parseNoticeNumber('N-42')).toBeNull();
    expect(parseNoticeNumber('RC-000042')).toBeNull();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 ** 12 }), (n) => {
        expect(parseNoticeNumber(formatNoticeNumber(n))).toBe(n);
      }),
    );
  });
});

describe('LN-05 notice settings (plan 4.9)', () => {
  it('leaves the stored defaults unchanged and applies the notice defaults', () => {
    expect(Object.keys(defaultCompanySettings())).not.toContain('noticeLadders');
    const settings = noticeSettingsOf(defaultCompanySettings());
    expect(settings.sendWindow).toEqual({
      from: '07:00',
      to: '20:00',
      fromMinutes: 420,
      toMinutes: 1200,
    });
    expect(settings.linkExpiryDays).toBe(90);
    expect(settings.ladders.notice_to_quit).toEqual(PRD_NOTICE_LADDER);
    expect(settings.ladders.building_wide.escalationHours).toBeNull();
    expect(noticeLadderFor('tenant_originated', settings)).toEqual([]);
  });

  it('takes a company’s own ladder per type, window and link days', () => {
    const merged = mergeCompanySettings(defaultCompanySettings(), {
      noticeLadders: {
        rent_demand: { reminderHours: [48], inPersonHours: null, escalationHours: 240 },
      },
      noticeSendWindow: { from: '08:30', to: '18:00' },
      noticeLinkExpiryDays: 120,
    });
    const settings = noticeSettingsOf(merged);
    expect(noticeLadderFor('rent_demand', settings).map((s) => [s.key, s.afterHours])).toEqual([
      ['reminder_1', 48],
      ['escalate', 240],
    ]);
    expect(settings.ladders.breach).toEqual(PRD_NOTICE_LADDER);
    expect(settings.sendWindow).toMatchObject({ fromMinutes: 510, toMinutes: 1080 });
    expect(settings.linkExpiryDays).toBe(120);
  });

  it('refuses a ladder for a tenant’s notice, a backwards window and out-of-range days', () => {
    const base = defaultCompanySettings();
    expect(() =>
      mergeCompanySettings(base, {
        noticeLadders: {
          tenant_originated: { reminderHours: [24], inPersonHours: null, escalationHours: null },
        },
      }),
    ).toThrow();
    expect(() =>
      mergeCompanySettings(base, { noticeSendWindow: { from: '20:00', to: '07:00' } }),
    ).toThrow();
    expect(() => mergeCompanySettings(base, { noticeLinkExpiryDays: 29 })).toThrow();
    expect(() =>
      mergeCompanySettings(base, {
        noticeLadders: {
          breach: { reminderHours: [0], inPersonHours: null, escalationHours: null },
        },
      }),
    ).toThrow();
    expect(parseCompanySettings({ noticeLinkExpiryDays: 30 }).noticeLinkExpiryDays).toBe(30);
  });
});
