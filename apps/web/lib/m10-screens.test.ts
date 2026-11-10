import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { notOnPlanText, planLabel, unlockSentence } from './plan';
import {
  bandRows,
  bannerFor,
  checkoutLink,
  firstOfNextMonth,
  invoiceLineText,
  invoiceStateText,
  lastDayOfMonth,
  paymentNext,
  ruleValueOf,
  ruleValueText,
  SUBSCRIPTION_MESSAGES,
  subscriptionMessage,
  termsRows,
  versionStates,
  wholeNumberOf,
  type SubscriptionFacts,
} from './subscription';

// M10 screens: the wording and rules the subscription page, the banner and the console use.

function member(
  role: string,
  kind: 'agency' | 'landlord' | 'platform' = 'agency',
  actorKind: Me['actorKind'] = 'staff',
): Me {
  const companyId = '019a3000-0000-7000-8000-000000000001';
  return {
    personId: '019a3000-0000-7000-8000-0000000000aa',
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: 'password_totp',
    sessionExpiresAt: '2026-11-07T13:00:00.000Z',
    actorKind,
    activeCompanyId: companyId,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId,
        companyName: 'Demo company',
        companyKind: kind,
        role,
        nominatedApprover: false,
      },
    ],
  };
}

const facts = (over: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  status: 'active',
  access: 'full',
  trialEndsOn: null,
  readOnlyFrom: null,
  oldestDueOn: null,
  pastDueMinor: null,
  canPay: true,
  ...over,
});

describe('PB-11 the staff banner follows the company’s subscription', () => {
  const today = '2026-11-18';

  it('shows nothing for an active subscription or the platform company', () => {
    expect(bannerFor(facts({}), today)).toBeNull();
    expect(bannerFor(null, today)).toBeNull();
    expect(bannerFor(undefined, today)).toBeNull();
  });

  it('warns while past due, with the amount only for those who may see it', () => {
    const past = facts({
      status: 'past_due',
      oldestDueOn: '2026-11-08',
      readOnlyFrom: '2026-11-22',
      pastDueMinor: 15_000,
    });
    expect(bannerFor(past, today)).toMatchObject({
      tone: 'warning',
      title: 'Your subscription invoice is overdue.',
      action: 'Pay now',
    });
    expect(bannerFor(past, today)!.body).toMatch(/^GH₵150.00 was due on 8 Nov 2026\./);
    const hidden = bannerFor({ ...past, pastDueMinor: null, canPay: false }, today)!;
    expect(hidden.body).toMatch(/^It was due on 8 Nov 2026\./);
    expect(hidden.body).not.toContain('GH₵');
    expect(hidden.action).toBeNull();
  });

  it('says read-only is for staff only, and that tenants are not affected', () => {
    const banner = bannerFor(
      facts({ status: 'read_only', access: 'read_only', oldestDueOn: '2026-11-08' }),
      today,
    )!;
    expect(banner.tone).toBe('error');
    expect(banner.title).toBe('Your company is read-only for staff.');
    expect(banner.body).toContain('Tenants are not affected');
    expect(banner.body).toContain('Paying restores full access at once.');
  });

  it('tells an ended subscription apart from an unpaid one', () => {
    const banner = bannerFor(facts({ status: 'cancelled', access: 'read_only' }), today)!;
    expect(banner.title).toBe('The subscription has ended.');
    expect(banner.body).not.toContain('unpaid');
  });

  it('shows the trial only to those who can pay', () => {
    const trial = facts({ status: 'trialing', trialEndsOn: '2026-11-30' });
    expect(bannerFor(trial, today)).toMatchObject({ tone: 'info', action: 'See your plan' });
    expect(bannerFor(trial, today)!.body).toMatch(/^Free trial: 12 days left/);
    expect(bannerFor({ ...trial, canPay: false }, today)).toBeNull();
  });
});

describe('PB-04 a locked feature names the plan that unlocks it', () => {
  it('names Growth, or Portfolio’s coming-soon modules', () => {
    expect(`${notOnPlanText('inbox', 'starter')} ${unlockSentence('inbox')}`).toBe(
      'The inbox is not on the Starter plan. Growth includes it.',
    );
    expect(unlockSentence('owner_reporting')).toBe('Growth includes it.');
    expect(unlockSentence('accounting_export')).toBe('It is coming soon on Portfolio.');
    expect(notOnPlanText('accounting_export', 'growth')).toBe(
      'Accounting exports are not on the Growth plan.',
    );
    expect(planLabel('portfolio')).toBe('Portfolio');
  });
});

describe('AD-08 and AD-10 the API’s refusals in plain words', () => {
  it('has words for every refusal the subscription and the console send', () => {
    for (const code of [
      'SUPPORT_NO_GRANT',
      'NOTHING_TO_PAY',
      'TIER_UNCHANGED',
      'SUBSCRIPTION_CANCELLED',
      'DISCOUNT_UNKNOWN',
      'DISCOUNT_EXPIRED',
      'DISCOUNT_USED_UP',
      'DISCOUNT_ALREADY_APPLIED',
      'ALREADY_CANCELLING',
      'NOT_CANCELLING',
      'NOT_TRIALING',
      'DISCOUNT_CODE_TAKEN',
      'EFFECTIVE_FROM_PAST',
      'RULE_VALUE',
    ])
      expect(SUBSCRIPTION_MESSAGES[code], code).toBeTruthy();
    expect(subscriptionMessage({ status: 403, data: { body: { code: 'support_no_grant' } } })).toBe(
      SUBSCRIPTION_MESSAGES.SUPPORT_NO_GRANT,
    );
    expect(subscriptionMessage({ status: 409, code: 'SOMETHING_ELSE' })).toBeNull();
  });
});

describe('PB-05 and PB-07 invoices, lines and payments', () => {
  const line = {
    kind: 'units' as const,
    description: 'Units',
    tier: null,
    band: 'single_room' as const,
    units: 12,
    rateMinor: 800,
    days: null,
    daysInMonth: null,
  };

  it('writes units lines out, with the tier and days when prorated', () => {
    expect(invoiceLineText(line)).toBe('12 single rooms × GH₵8.00');
    expect(invoiceLineText({ ...line, tier: 'growth', days: 12, daysInMonth: 30 })).toBe(
      'Growth: 12 single rooms × GH₵8.00 × 12 of 30 days',
    );
    expect(
      invoiceLineText({
        ...line,
        kind: 'vat',
        description: 'VAT 15%',
        band: null,
        units: null,
        rateMinor: null,
      }),
    ).toBe('VAT 15%');
  });

  it('says what is left to pay, and when it is past due', () => {
    expect(invoiceStateText({ status: 'paid', pastDue: false, outstandingMinor: 0 })).toBe('Paid');
    expect(invoiceStateText({ status: 'open', pastDue: false, outstandingMinor: 15_000 })).toBe(
      'GH₵150.00 to pay',
    );
    expect(invoiceStateText({ status: 'open', pastDue: true, outstandingMinor: 15_000 })).toBe(
      'Past due: GH₵150.00 to pay',
    );
  });

  it('keeps asking until the payment succeeds or fails', () => {
    expect(paymentNext('initiated')).toBe('wait');
    expect(paymentNext('pending')).toBe('wait');
    expect(paymentNext('succeeded')).toBe('paid');
    expect(paymentNext('failed')).toBe('failed');
    expect(paymentNext('reversed')).toBe('failed');
  });

  it('opens only a web address as the card checkout', () => {
    expect(checkoutLink('https://checkout.paystack.com/abc')).toBe(
      'https://checkout.paystack.com/abc',
    );
    expect(checkoutLink('javascript:alert(1)')).toBeNull();
    expect(checkoutLink(null)).toBeNull();
  });

  it('lists the bands in order', () => {
    expect(
      bandRows({ single_room: 3, self_contained: 1, commercial: 0 }).map((r) => [r.label, r.value]),
    ).toEqual([
      ['Single room', 3],
      ['Self-contained flat or house', 1],
      ['Commercial', 0],
    ]);
  });

  it('finds next month’s 1st and this month’s last day through the domain’s dates', () => {
    expect(firstOfNextMonth('2026-12-18')).toBe('2027-01-01');
    expect(lastDayOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-11-18')).toBe('2026-11-30');
  });
});

describe('PB-03 and AD-10 versions in the console are never edited, only replaced', () => {
  const row = (
    id: string,
    tier: string,
    effectiveFrom: string,
    createdAt = '2026-10-01T00:00:00Z',
  ) => ({
    id,
    tier,
    effectiveFrom,
    createdAt,
  });

  it('marks the version in force per tier, later ones as future and earlier ones replaced', () => {
    const states = versionStates(
      [
        row('a', 'starter', '2026-01-01'),
        row('b', 'starter', '2026-11-01'),
        row('c', 'starter', '2026-12-01'),
        row('d', 'growth', '2026-01-01'),
      ],
      (r) => r.tier,
      '2026-11-18',
    );
    expect(Object.fromEntries(states)).toEqual({
      a: 'replaced',
      b: 'in_force',
      c: 'future',
      d: 'in_force',
    });
  });

  it('writes the terms in words', () => {
    expect(
      termsRows({
        trialDays: 30,
        graceDays: 14,
        readOnlyEnabled: true,
        dueDays: 7,
        retentionDaysAfterCancel: 90,
        vatRegistered: false,
      }).map((r) => r.value),
    ).toEqual([
      '30 days',
      '7 days after it is issued',
      'On, 14 days after the due date',
      '90 days',
      'Not charged',
    ]);
  });

  it('reads whole numbers and rules values as typed', () => {
    expect(wholeNumberOf('14', 1, 365)).toEqual({ value: 14, problem: null });
    expect(wholeNumberOf('1.5', 1, 365).problem).toBe('Enter a whole number.');
    expect(wholeNumberOf('400', 1, 365).problem).toBe('Enter a number from 1 to 365.');
    expect(ruleValueOf('800')).toEqual({ value: 800, problem: null });
    expect(ruleValueOf('{"vat":1500}').value).toEqual({ vat: 1500 });
    expect(ruleValueOf('eight hundred').problem).toMatch(/^Enter the value as JSON/);
    expect(ruleValueText({ vat: 1500 })).toBe('{"vat":1500}');
    expect(ruleValueText(null)).toBe('None');
  });
});

describe('AD-08 and AD-10 the menu: the subscription for its readers, the console for platform admins', () => {
  const labels = (me: Me) => navFor(me, []).map((item) => item.label);

  it('shows the subscription to the agency admin, the landlord and the accountant only', () => {
    expect(labels(member('agency_admin'))).toContain('Subscription');
    expect(labels(member('owner', 'landlord'))).toContain('Subscription');
    expect(labels(member('accountant'))).toContain('Subscription');
    expect(labels(member('property_manager'))).not.toContain('Subscription');
    expect(labels(member('owner'))).not.toContain('Subscription');
  });

  it('gives platform admins the console, and no company’s subscription', () => {
    const admin = labels(member('platform_admin', 'platform', 'platform_admin'));
    expect(admin.filter((label) => label !== 'Home' && label !== 'My security')).toEqual([
      'WhatsApp numbers',
      'Gate 1 metrics',
      'Companies',
      'Plans and billing',
      'Support access',
      'Messaging costs',
      'System health',
      'Rules',
    ]);
  });
});
