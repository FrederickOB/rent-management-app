import { describe, expect, it } from 'vitest';
import {
  defaultCompanySettings,
  DEFAULT_INBOX_FIRST_RESPONSE_MINUTES,
  mergeCompanySettings,
  messagingSettingsOf,
} from './company-settings';
import {
  DEFAULT_INTERIM_PLAN,
  featuresOf,
  isInterimPlan,
  planHas,
  PLAN_FEATURES,
} from './entitlements';

describe('CM-03 and CM-05 plan entitlements (decision 9)', () => {
  it('gives Growth the inbox, broadcasts, groups, maintenance and the full menu; Starter none of them', () => {
    for (const feature of PLAN_FEATURES) {
      expect(planHas('growth', feature), feature).toBe(true);
      expect(planHas('starter', feature), feature).toBe(false);
    }
    expect(featuresOf('starter')).toEqual([]);
  });

  it('keeps companies without a plan on Growth, so nothing they had disappears', () => {
    expect(DEFAULT_INTERIM_PLAN).toBe('growth');
    expect(isInterimPlan('starter')).toBe(true);
    expect(isInterimPlan('portfolio')).toBe(false);
  });
});

describe('CM-06 messaging settings (decision 10)', () => {
  it('defaults the response target to 240 clock minutes and keeps stored settings valid', () => {
    expect(DEFAULT_INBOX_FIRST_RESPONSE_MINUTES).toBe(240);
    const settings = messagingSettingsOf(defaultCompanySettings());
    expect(settings.inboxFirstResponseMinutes).toBe(240);
    expect(settings.inboxTags.length).toBeGreaterThan(0);
  });

  it('accepts a company’s own target and tags, and refuses bad ones', () => {
    const merged = mergeCompanySettings(defaultCompanySettings(), {
      inboxFirstResponseMinutes: 120,
      inboxTags: ['water', 'noise'],
    });
    expect(messagingSettingsOf(merged)).toEqual({
      inboxFirstResponseMinutes: 120,
      inboxTags: ['water', 'noise'],
    });
    for (const patch of [
      { inboxFirstResponseMinutes: 5 },
      { inboxFirstResponseMinutes: 60 * 24 * 8 },
      { inboxTags: ['Water'] },
      { inboxTags: ['water', 'water'] },
      { inboxTags: [] },
      { interimPlan: 'starter' },
    ])
      expect(
        () => mergeCompanySettings(defaultCompanySettings(), patch),
        JSON.stringify(patch),
      ).toThrow();
  });
});
