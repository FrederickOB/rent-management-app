import { describe, expect, it } from 'vitest';
import { paidUntilPrompt, promptWindowDays, type PaidUntilPromptInput } from './paid-until-prompt';

const lease: PaidUntilPromptInput = {
  paidUntil: '2027-01-31',
  leaseEnd: '2027-01-31',
  windowDays: 90,
  renewalOffered: false,
};

describe('AR-06 the renewal prompt when paid-until is 90 days away', () => {
  it('prompts within the window, and offers a renewal when paid to the end of the lease', () => {
    expect(paidUntilPrompt(lease, '2026-11-02')).toEqual({
      title: 'Paid until 31 Jan 2027: 90 days away',
      text: 'The rent is paid to the end of the lease. Offer the tenant a renewal now, so there is time to agree the new term and its advance.',
      daysAway: 90,
      offerRenewal: true,
    });
  });

  it('stays quiet before the window and once paid-until has passed', () => {
    expect(paidUntilPrompt(lease, '2026-11-01')).toBeNull();
    expect(paidUntilPrompt(lease, '2027-02-01')).toBeNull();
    expect(paidUntilPrompt({ ...lease, paidUntil: null }, '2026-12-01')).toBeNull();
  });

  it('says so on the day itself', () => {
    expect(paidUntilPrompt(lease, '2027-01-31')?.title).toBe('Paid until today, 31 Jan 2027');
  });

  it('asks about the next payment when the lease runs on past paid-until', () => {
    expect(paidUntilPrompt({ ...lease, leaseEnd: '2027-12-31' }, '2026-12-01')).toMatchObject({
      text: 'Talk to the tenant about the next payment before the paid months run out.',
      offerRenewal: false,
    });
  });

  it('follows up a renewal already offered instead of asking for one', () => {
    expect(paidUntilPrompt({ ...lease, renewalOffered: true }, '2026-12-01')).toMatchObject({
      offerRenewal: false,
      text: 'A renewal has been offered. Follow it up with the tenant, and the advance for the new term.',
    });
  });

  it('reads its window from the API', () => {
    expect(paidUntilPrompt({ ...lease, windowDays: 60 }, '2026-11-15')).toBeNull();
    expect(paidUntilPrompt({ ...lease, windowDays: 60 }, '2026-12-02')?.daysAway).toBe(60);
  });
});

describe('AR-06 the prompt’s window is the company’s setting, 90 days unless set', () => {
  it('reads the setting, and falls back to the PRD’s 90 days', () => {
    expect(promptWindowDays({ paidUntilPromptDays: 60 })).toBe(60);
    expect(promptWindowDays({})).toBe(90);
    expect(promptWindowDays(undefined)).toBe(90);
    expect(promptWindowDays({ paidUntilPromptDays: 'soon' })).toBe(90);
  });
});
