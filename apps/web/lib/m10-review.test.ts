import { describe, expect, it } from 'vitest';
import { isReadOnlyRefusal, READ_ONLY_TEXT, toProblem } from './errors';
import {
  annualOfferText,
  bannerFor,
  billingStateText,
  cancelNoticeText,
  cancelPlan,
  chosenPurpose,
  creditableMinor,
  estimateRows,
  grantActiveAt,
  INVOICE_VAT_NOTE,
  pastRuleWarning,
  PORTFOLIO_COMING_SOON,
  PORTFOLIO_NOTE,
  priceMonthStarts,
  readOnlyNotice,
  subscriptionMessage,
  versionStates,
  type SubscriptionFacts,
} from './subscription';

// M10 review round (web): the wording and rules behind WEB-5 to WEB-10 and the smaller items.

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

describe('PB-11 and PB-10 review WEB-7 read-only says why: past due or ended', () => {
  it('tells an ended subscription from a past-due one on the subscription page', () => {
    expect(readOnlyNotice({ status: 'cancelled', readOnlyUntil: '2027-02-28' })).toEqual({
      title: 'The subscription has ended',
      body: 'Staff can read records and download documents until 28 Feb 2027, but not change them. Tenants are not affected by it.',
    });
    const past = readOnlyNotice({ status: 'read_only', readOnlyUntil: null });
    expect(past.title).toBe('Read-only for staff');
    expect(past.body).toContain('Paying restores full access at once.');
  });

  it('claims neither when only the refusal is known', () => {
    expect(READ_ONLY_TEXT).toContain('because the subscription is past due or has ended');
    expect(READ_ONLY_TEXT).toContain('If it is past due, paying restores full access at once.');
    const refused = { status: 403, data: { body: { code: 'subscription_read_only' } } };
    expect(isReadOnlyRefusal(refused)).toBe(true);
    expect(toProblem(refused).message).toBe(READ_ONLY_TEXT);
    expect(isReadOnlyRefusal({ status: 403, data: { body: { code: 'forbidden' } } })).toBe(false);
  });
});

describe('PB-11 review N10 money owed shows even when the subscription is ending or ended', () => {
  const today = '2026-11-18';

  it('shows past due while a cancellation is scheduled', () => {
    const banner = bannerFor(
      facts({ status: 'cancel_scheduled', oldestDueOn: '2026-11-08', pastDueMinor: 5_000 }),
      today,
    );
    expect(banner).toMatchObject({
      tone: 'warning',
      title: 'Your subscription invoice is overdue.',
    });
    expect(bannerFor(facts({ status: 'cancel_scheduled' }), today)).toBeNull();
  });

  it('asks an ended company to pay what it still owes', () => {
    const banner = bannerFor(
      facts({
        status: 'cancelled',
        access: 'read_only',
        oldestDueOn: '2026-11-08',
        pastDueMinor: 5_000,
      }),
      today,
    )!;
    expect(banner.title).toBe('The subscription has ended.');
    expect(banner.body).toContain('An invoice is still unpaid (GH₵50.00), due on 8 Nov 2026.');
    expect(banner.action).toBe('Pay now');
  });
});

describe('PB-10 review WEB-6 cancelling ends at the right day, and says what is billed', () => {
  it('ends a trial by its last day or the month’s end, whichever is first, with nothing billed', () => {
    expect(
      cancelPlan({ today: '2026-11-18', status: 'trialing', trialEndsOn: '2026-11-25' }),
    ).toEqual({ endsOn: '2026-11-25', inTrial: true, annual: false });
    expect(
      cancelPlan({ today: '2026-11-18', status: 'trialing', trialEndsOn: '2026-12-10' }),
    ).toEqual({ endsOn: '2026-11-30', inTrial: true, annual: false });
    expect(
      cancelNoticeText({ endsOn: '2026-11-25', inTrial: true, readAccessUntil: null }),
    ).toMatch(
      /^The subscription ends on 25 Nov 2026, within the free trial, so nothing is billed\./,
    );
  });

  it('ends an active subscription at the month’s end, billed as usual', () => {
    expect(cancelPlan({ today: '2026-11-18', status: 'active', trialEndsOn: null })).toEqual({
      endsOn: '2026-11-30',
      inTrial: false,
      annual: false,
    });
    expect(
      cancelNoticeText({ endsOn: '2026-11-30', inTrial: false, readAccessUntil: '2027-02-28' }),
    ).toContain('and this month is billed as usual. You can withdraw the cancellation until then.');
  });

  it('ends a year paid ahead when that year ends (founder, Q3)', () => {
    expect(
      cancelPlan({
        today: '2026-11-18',
        status: 'active',
        trialEndsOn: null,
        annualEndsOn: '2027-05-31',
      }),
    ).toEqual({ endsOn: '2027-05-31', inTrial: false, annual: true });
    expect(
      cancelNoticeText({
        endsOn: '2027-05-31',
        inTrial: false,
        annual: true,
        readAccessUntil: null,
      }),
    ).toMatch(/^Your service ends on 31 May 2027, when the year you paid for ends\./);
  });
});

describe('PB-07 review WEB-5 the pay form submits only what is offered', () => {
  it('keeps the pick while offered, and falls back to what is', () => {
    expect(chosenPurpose(null, { invoices: true, annual: true })).toBe('invoices');
    expect(chosenPurpose('annual', { invoices: true, annual: true })).toBe('annual');
    expect(chosenPurpose('invoices', { invoices: false, annual: true })).toBe('annual');
    expect(chosenPurpose('annual', { invoices: true, annual: false })).toBe('invoices');
    expect(chosenPurpose('invoices', { invoices: false, annual: false })).toBeNull();
  });
});

describe('PB-03 review WEB-9 a price list starts on the 1st of a month', () => {
  it('offers the 1st of each of the next twelve months', () => {
    const starts = priceMonthStarts('2026-11-18');
    expect(starts).toHaveLength(12);
    expect(starts[0]).toBe('2026-12-01');
    expect(starts[1]).toBe('2027-01-01');
    expect(starts.every((date) => date.endsWith('-01'))).toBe(true);
    expect(priceMonthStarts('2026-11-01')[0]).toBe('2026-12-01');
  });
});

describe('PB-04 review WEB-10 Portfolio’s extras are coming soon', () => {
  it('names every module and what Portfolio includes today', () => {
    for (const name of PORTFOLIO_COMING_SOON)
      expect(PORTFOLIO_NOTE.toLowerCase()).toContain(name.toLowerCase());
    expect(PORTFOLIO_NOTE).toContain('Until they arrive, Portfolio includes what Growth includes');
  });
});

describe('AD-08 and AD-10 review N4 and N7', () => {
  it('keeps open questions out of what subscribers read', () => {
    expect(INVOICE_VAT_NOTE).not.toMatch(/OQ-/);
  });

  it('ends a grant on screen at its expiry, as well as on revocation', () => {
    const grant = { active: true, until: '2026-11-09T12:00:00.000Z', revokedAt: null };
    expect(grantActiveAt(grant, Date.parse('2026-11-09T11:59:00.000Z'))).toBe(true);
    expect(grantActiveAt(grant, Date.parse('2026-11-09T12:00:00.000Z'))).toBe(false);
    expect(
      grantActiveAt(
        { ...grant, revokedAt: '2026-11-09T10:00:00.000Z' },
        Date.parse('2026-11-09T11:00:00.000Z'),
      ),
    ).toBe(false);
    expect(grantActiveAt({ ...grant, active: false }, Date.parse('2026-11-09T11:00:00.000Z'))).toBe(
      false,
    );
  });
});

describe('PB-05 review WEB-1 the estimate’s parts add up to its total', () => {
  it('labels the top-up as a top-up, names the plan’s minimum, and adds discount and VAT', () => {
    const rows = estimateRows(
      {
        unitsMinor: 3_000,
        minimumTopUpMinor: 2_000,
        discountMinor: -500,
        vatMinor: 900,
        totalMinor: 5_400,
      },
      5_000,
    );
    expect(rows.map((r) => r.key)).toEqual(['units', 'top-up', 'discount', 'vat', 'total']);
    expect(rows[1]!.label).toBe(
      'Top-up to the plan’s minimum of GH₵50.00 a month (less for a part month)',
    );
    const parts = rows.filter((r) => r.key !== 'total').reduce((sum, r) => sum + r.amountMinor, 0);
    expect(parts).toBe(rows.at(-1)!.amountMinor);
    expect(
      estimateRows(
        {
          unitsMinor: 6_000,
          minimumTopUpMinor: 0,
          discountMinor: 0,
          vatMinor: 0,
          totalMinor: 6_000,
        },
        null,
      ).map((r) => r.key),
    ).toEqual(['units', 'top-up', 'total']);
  });
});

describe('PB-05 review WEB-4 the pay form states what a year ahead costs', () => {
  it('names the amount, the months and the discount', () => {
    expect(
      annualOfferText({
        totalMinor: 162_000,
        vatMinor: 0,
        discountBps: 1_000,
        firstMonth: '2026-11',
        lastMonth: '2027-10',
      }),
    ).toBe('GH₵1,620.00 for November 2026 to October 2027, 10% off.');
    expect(
      annualOfferText({
        totalMinor: 194_400,
        vatMinor: 32_400,
        discountBps: 1_000,
        firstMonth: '2026-11',
        lastMonth: '2027-10',
      }),
    ).toContain('VAT and levies of GH₵324.00 included');
  });
});

describe('AD-10 review WEB-16 and WEB-17 billing on or off, and crediting an invoice', () => {
  it('says billing is off and why, and when it went on', () => {
    expect(
      billingStateText({ on: false, startsOn: null, placeholderTiers: ['starter', 'growth'] }),
    ).toEqual({
      title: 'Billing is off',
      body: 'Nothing is invoiced, and free trials have not started: each runs from the day billing goes on. It cannot go on while Starter, Growth have placeholder prices: add real prices first.',
    });
    expect(billingStateText({ on: true, startsOn: '2026-12-01', placeholderTiers: [] }).body).toBe(
      'Subscriptions are billed from 1 Dec 2026; every trial that started before then ran from that day.',
    );
  });

  it('credits no more than the total less earlier credits, in plain words when refused', () => {
    expect(creditableMinor({ totalMinor: 15_000, creditedMinor: 5_000 })).toBe(10_000);
    expect(creditableMinor({ totalMinor: 15_000, creditedMinor: 15_000 })).toBe(0);
    for (const code of [
      'OPEN_INVOICES',
      'ANNUAL_ALREADY_PAID',
      'CREDIT_EXCEEDS_INVOICE',
      'INVOICE_VOID',
      'NOT_CANCELLED',
      'PLACEHOLDER_PRICES',
      'BILLING_ALREADY_ON',
    ])
      expect(subscriptionMessage({ status: 409, code }), code).toBeTruthy();
  });
});

describe('TX-08 review BE-25 a rule may start in the past, with a warning', () => {
  it('warns for a past date only', () => {
    expect(pastRuleWarning('2026-10-01', '2026-11-09')).toBe(
      'This applies from a past date. Records already made keep the rule they used; anything worked out from now on for dates from 1 Oct 2026 uses this value.',
    );
    expect(pastRuleWarning('2026-11-09', '2026-11-09')).toBeNull();
    expect(pastRuleWarning('2026-12-01', '2026-11-09')).toBeNull();
  });
});

describe('PB-03 review BE-25 a price list is in force by the first month it prices', () => {
  it('counts a list from the start it is given, not its raw date', () => {
    const rows = [
      { id: 'a', tier: 'starter', effectiveFrom: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', tier: 'starter', effectiveFrom: '2026-11-05', createdAt: '2026-10-01T00:00:00Z' },
    ];
    // Dated 5 November, it first prices December: on 9 November it is still to come.
    const firstMonth: Record<string, string> = { a: '2026-01-01', b: '2026-12-01' };
    expect(
      Object.fromEntries(
        versionStates(
          rows,
          (r) => r.tier,
          '2026-11-09',
          (r) => firstMonth[r.id]!,
        ),
      ),
    ).toEqual({ a: 'in_force', b: 'future' });
    expect(Object.fromEntries(versionStates(rows, (r) => r.tier, '2026-11-09'))).toEqual({
      a: 'replaced',
      b: 'in_force',
    });
  });
});
