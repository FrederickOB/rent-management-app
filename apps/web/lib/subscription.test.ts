import { PLAN_FEATURES } from '@rent/domain/settings';
import { describe, expect, it } from 'vitest';
import { toProblem } from './errors';
import { planLabel } from './plan';
import {
  CONSOLE_SECTIONS,
  consoleSectionsFor,
  consoleTab,
  type ConsoleAction,
} from './platform-console';
import {
  annualText,
  cancellationText,
  discountLimitsText,
  discountText,
  grantHoursProblem,
  grantStateText,
  lowestTierWith,
  minimumText,
  PLACEHOLDER_PRICE_TEXT,
  PORTFOLIO_COMING_SOON,
  rateText,
  READ_ONLY_TEXT,
  subscriptionBanner,
  tierChangeText,
  tierLabel,
  trialText,
  unitLineText,
  unlockText,
  vatStatusText,
} from './subscription';

// M10 web preparation: words for the subscription screens and the console, ahead of the contracts.

const time = (iso: string) => `[${iso}]`;

describe('PB-04 tiers, and locked features naming the tier that unlocks them', () => {
  it('names the three tiers, and keeps Growth for a profile with no plan', () => {
    expect(['starter', 'growth', 'portfolio'].map(tierLabel)).toEqual([
      'Starter',
      'Growth',
      'Portfolio',
    ]);
    expect(tierLabel(undefined)).toBe('Growth');
    expect(planLabel('portfolio')).toBe('Portfolio');
    expect(planLabel('starter')).toBe('Starter');
    expect(planLabel(undefined)).toBe('Growth');
  });

  it('names the lowest tier that has each feature', () => {
    for (const feature of PLAN_FEATURES) expect(lowestTierWith(feature)).toBe('growth');
    expect(unlockText('inbox')).toBe('Growth includes the inbox.');
    expect(unlockText('notices')).toBe('Growth includes legal notices.');
    expect(unlockText('bot_full_menu')).toBe('Growth includes the full WhatsApp menu.');
  });

  it('lists Portfolio’s P2 modules, to be shown as coming soon', () => {
    expect(PORTFOLIO_COMING_SOON).toEqual([
      'Commercial tenant portal',
      'Caretaker field app',
      'Diaspora owner view',
      'Compliance dashboard',
      'Accounting export',
      'Priority support',
    ]);
  });
});

describe('PB-08 the trial says how long is left', () => {
  it('counts the days to the trial’s end', () => {
    expect(trialText('2026-11-30', '2026-11-18')).toBe(
      'Free trial: 12 days left, ends 30 Nov 2026. No card is needed; you can cancel any time before.',
    );
    expect(trialText('2026-11-19', '2026-11-18')).toMatch(/^Free trial: 1 day left/);
    expect(trialText('2026-11-18', '2026-11-18')).toBe(
      'Free trial: it ends today, 18 Nov 2026. Billing starts tomorrow.',
    );
    expect(trialText('2026-11-01', '2026-11-18')).toBe('The free trial ended on 1 Nov 2026.');
  });
});

describe('PB-11 the staff banner for an unpaid subscription leaves tenants out of it', () => {
  const owed = { amountDueMinor: 15_000, dueOn: '2026-11-08' };

  it('warns before read-only, with the day it starts', () => {
    const banner = subscriptionBanner({
      ...owed,
      state: 'past_due',
      readOnlyFrom: '2026-11-22',
      canPay: true,
    });
    expect(banner.title).toBe('Your subscription invoice is overdue.');
    expect(banner.body).toBe(
      'GH₵150.00 was due on 8 Nov 2026. Pay it before 22 Nov 2026, or staff can only read records from that day. Tenants are never affected.',
    );
    expect(banner.action).toBe('Pay now');
  });

  it('says read-only is for staff only, and that paying restores it at once', () => {
    const banner = subscriptionBanner({
      ...owed,
      state: 'read_only',
      readOnlyFrom: '2026-11-22',
      canPay: false,
    });
    expect(banner.title).toBe('Your company is read-only for staff.');
    expect(banner.body).toContain('Tenants are not affected: they can still pay rent');
    expect(banner.body).toContain('Paying restores full access at once.');
    expect(banner.body).toContain('Ask your agency admin or the landlord to pay it');
    expect(banner.action).toBeNull();
  });

  it('leaves out the read-only day when the switch is off', () => {
    const banner = subscriptionBanner({
      ...owed,
      state: 'past_due',
      readOnlyFrom: null,
      canPay: true,
    });
    expect(banner.body).toBe('GH₵150.00 was due on 8 Nov 2026. Tenants are never affected.');
  });

  it('puts the API’s read-only refusal into words on every form', () => {
    const refused = {
      status: 403,
      data: { body: { code: 'subscription_read_only', message: 'x' } },
    };
    expect(toProblem(refused).message).toBe(READ_ONLY_TEXT);
    expect(READ_ONLY_TEXT).toMatch(/^Nothing was changed: your company is read-only/);
    expect(
      toProblem({ status: 403, data: { body: { code: 'forbidden', message: 'No.' } } }).message,
    ).toBe('No.');
  });
});

describe('PB-03 and PB-05 prices, minimums, proration and discounts in words', () => {
  it('writes rates and the minimum per month, and labels placeholders', () => {
    expect(rateText(500)).toBe('GH₵5.00 a unit a month');
    expect(minimumText(5_000)).toBe('At least GH₵50.00 a month');
    expect(PLACEHOLDER_PRICE_TEXT).toMatch(/^Placeholder price: not a real rate yet\./);
  });

  it('writes an invoice’s unit lines, with the days only when prorated', () => {
    expect(unitLineText({ band: 'single_room', units: 12, rateMinor: 500 })).toBe(
      '12 single rooms × GH₵5.00',
    );
    expect(unitLineText({ band: 'commercial', units: 1, rateMinor: 2_000 })).toBe(
      '1 commercial unit × GH₵20.00',
    );
    expect(
      unitLineText({
        band: 'self_contained',
        units: 3,
        rateMinor: 1_500,
        days: 18,
        daysInMonth: 30,
      }),
    ).toBe('3 self-contained flats or houses × GH₵15.00 × 18 of 30 days');
    expect(
      unitLineText({
        band: 'self_contained',
        units: 3,
        rateMinor: 1_500,
        days: 30,
        daysInMonth: 30,
      }),
    ).toBe('3 self-contained flats or houses × GH₵15.00');
  });

  it('writes a code’s terms and limits', () => {
    expect(discountText({ percentBps: 1_000, amountMinor: null, months: 3 })).toBe(
      '10% off for 3 months',
    );
    expect(discountText({ percentBps: 1_250, amountMinor: null, months: 1 })).toBe(
      '12.5% off for 1 month',
    );
    expect(discountText({ percentBps: null, amountMinor: 2_000, months: 6 })).toBe(
      'GH₵20.00 off a month for 6 months',
    );
    expect(discountLimitsText({ expiresOn: '2026-12-31', maxUses: 50, uses: 4 })).toBe(
      'Expires 31 Dec 2026; used 4 of 50 times.',
    );
    expect(discountLimitsText({ expiresOn: null, maxUses: null, uses: 1 })).toBe(
      'No expiry date; used 1 time.',
    );
  });

  it('says when a tier change takes effect: an upgrade now, a downgrade next month', () => {
    expect(tierChangeText({ from: 'starter', to: 'growth', downgradeOn: '2026-12-01' })).toBe(
      'Growth starts now. This month’s invoice charges each tier for its days.',
    );
    expect(tierChangeText({ from: 'portfolio', to: 'growth', downgradeOn: '2026-12-01' })).toBe(
      'Growth starts on 1 Dec 2026. You keep Portfolio’s features until then.',
    );
  });

  it('explains annual prepayment as credit drawn each month', () => {
    expect(annualText({ amountMinor: 162_000, discountBps: 1_000 })).toMatch(
      /^Pay GH₵1,620.00 now for 12 months: twelve times last month’s bill, less 10%\./,
    );
  });
});

describe('decision 10 VAT on subscriptions is labelled while unverified', () => {
  it('says whether VAT is charged, and that the rule is unverified', () => {
    expect(vatStatusText({ charged: false, verified: false })).toBe(
      'No VAT is charged on subscription invoices: the platform’s VAT registration is not recorded. The VAT rule for subscriptions is not yet verified by the tax adviser (OQ-48).',
    );
    expect(vatStatusText({ charged: true, verified: true })).toBe(
      'VAT and levies are charged on subscription invoices.',
    );
  });
});

describe('PB-10 cancelling says when it ends and what keeps working', () => {
  it('names the end, the read-only months and what tenants keep', () => {
    const text = cancellationText({ endsOn: '2026-11-30', readAccessUntil: '2027-02-28' });
    expect(text).toContain('Your subscription ends on 30 Nov 2026');
    expect(text).toContain('until 28 Feb 2027');
    expect(text).toContain(
      'pay links for invoices already sent, receipts and notices already issued keep working',
    );
  });
});

describe('AD-10 support access is bounded and its state is plain', () => {
  it('takes 1 hour to 7 days', () => {
    expect(grantHoursProblem(24)).toBeNull();
    expect(grantHoursProblem(168)).toBeNull();
    expect(grantHoursProblem(0)).toMatch(/at least 1/);
    expect(grantHoursProblem(1.5)).toMatch(/whole number/);
    expect(grantHoursProblem(169)).toBe('Support access lasts at most 7 days (168 hours).');
  });

  it('says whether a grant is active, ended or ended early', () => {
    const now = '2026-11-07T12:00:00.000Z';
    expect(
      grantStateText({ expiresAt: '2026-11-08T12:00:00.000Z', revokedAt: null }, now, time),
    ).toEqual({
      active: true,
      text: 'Active until [2026-11-08T12:00:00.000Z].',
    });
    expect(
      grantStateText({ expiresAt: '2026-11-07T11:00:00.000Z', revokedAt: null }, now, time),
    ).toEqual({
      active: false,
      text: 'Ended [2026-11-07T11:00:00.000Z].',
    });
    expect(
      grantStateText(
        {
          expiresAt: '2026-11-08T12:00:00.000Z',
          revokedAt: '2026-11-07T10:00:00.000Z',
          revokedByName: 'Esi (demo)',
        },
        now,
        time,
      ),
    ).toEqual({ active: false, text: 'Ended early [2026-11-07T10:00:00.000Z] by Esi (demo).' });
  });
});

describe('AD-10 the console’s sections, in the PRD’s order', () => {
  it('lists companies, plans and billing, support, messaging costs, health and rules first', () => {
    expect(CONSOLE_SECTIONS.map((s) => s.label)).toEqual([
      'Companies',
      'Plans and billing',
      'Support access',
      'Messaging costs',
      'System health',
      'Rules',
      'WhatsApp numbers',
      'Gate 1 metrics',
    ]);
    expect(CONSOLE_SECTIONS.map((s) => s.href)).not.toContain('/platform/company-plans');
  });

  it('shows only the sections the policy allows', () => {
    const only =
      (...actions: ConsoleAction[]) =>
      (action: ConsoleAction) =>
        actions.includes(action);
    expect(consoleSectionsFor(only('discount.manage', 'rules.view')).map((s) => s.label)).toEqual([
      'Plans and billing',
      'Rules',
    ]);
    expect(consoleSectionsFor(only())).toEqual([]);
  });

  it('opens the named tab, or the first', () => {
    const billing = CONSOLE_SECTIONS.find((s) => s.label === 'Plans and billing')!;
    expect(billing.tabs.map((t) => t.label)).toEqual([
      'Price lists',
      'Terms',
      'Discount codes',
      'WhatsApp rates',
    ]);
    expect(consoleTab(billing.tabs, 'codes')?.label).toBe('Discount codes');
    expect(consoleTab(billing.tabs, 'nonsense')?.label).toBe('Price lists');
    expect(consoleTab([], 'codes')).toBeNull();
  });
});
