import { describe, expect, it } from 'vitest';
import {
  feesOverTakenText,
  nothingToRemitText,
  ownerMoneyMessage,
  reversalReasonProblem,
  type RemittanceSuggestion,
} from './owner-money';
import {
  dashboardTimesText,
  gate1StatusText,
  refreshProblemText,
  unearnedDetailText,
} from './reporting';
import { accrualRows, statementEmailText, type StatementPage } from './statements';

// M9 review round: the backend's review contracts, wired on the screens. New tests; the earlier
// ones stay as they passed.

const time = (iso: string) => `[${iso}]`;
const TZ = 'Europe/London';

describe('AC-04 review the statement’s email is sent, delivered or not sent, and says why', () => {
  it('tells sent and delivered apart', () => {
    expect(
      statementEmailText({ sentAt: null, deliveredAt: null, emailNotSentReason: null }, TZ),
    ).toBe('Not emailed yet.');
    expect(
      statementEmailText(
        { sentAt: '2026-11-06T09:00:00.000Z', deliveredAt: null, emailNotSentReason: null },
        TZ,
      ),
    ).toMatch(/^Emailed: sent .*; delivery not yet confirmed\.$/);
    expect(
      statementEmailText(
        {
          sentAt: '2026-11-06T09:00:00.000Z',
          deliveredAt: '2026-11-06T09:01:00.000Z',
          emailNotSentReason: null,
        },
        TZ,
      ),
    ).toMatch(/^Emailed: sent .*, delivered .*\.$/);
  });

  it('says why a statement was not emailed', () => {
    expect(
      statementEmailText({ sentAt: null, deliveredAt: null, emailNotSentReason: 'no_consent' }, TZ),
    ).toBe('Not emailed: the owner has not agreed to email.');
    expect(
      statementEmailText({ sentAt: null, deliveredAt: null, emailNotSentReason: 'opted_out' }, TZ),
    ).toBe('Not emailed: the owner unsubscribed from email.');
    expect(
      statementEmailText({ sentAt: null, deliveredAt: null, emailNotSentReason: 'no_email' }, TZ),
    ).toBe('Not emailed: there is no email address on record for the owner.');
  });

  it('shows rent, service charge and credit held for tenants as separate lines', () => {
    const page = {
      accrual: {
        rentEarnedMinor: 0,
        serviceChargeEarnedMinor: 0,
        earnedMinor: 0,
        unearnedRentMinor: 300,
        unearnedServiceChargeMinor: 20,
        creditMinor: 5,
        unearnedMinor: 325,
        depositsHeldMinor: 0,
        arrearsByBucket: { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
        arrearsMinor: 0,
      },
    } as unknown as StatementPage;
    const rows = accrualRows(page);
    expect(
      rows
        .filter((r) =>
          ['unearned', 'rent-unearned', 'service-unearned', 'credit-unearned'].includes(r.key),
        )
        .map((r) => [r.key, r.amountMinor]),
    ).toEqual([
      ['unearned', 325],
      ['rent-unearned', 300],
      ['service-unearned', 20],
      ['credit-unearned', 5],
    ]);
  });
});

const suggestion = (over: Partial<RemittanceSuggestion>): RemittanceSuggestion => ({
  owner: { id: '019a3000-0000-7000-8000-000000000101', name: 'Nana (demo)' },
  asOf: '2026-11-06',
  agentCashMinor: 50_000,
  feesDueMinor: 50_000,
  graPaidBy: 'owner',
  rentTaxHeldBackMinor: 0,
  totalMinor: 50_000,
  feesRetainedMinor: 50_000,
  netMinor: 0,
  proposal: 'take_fees',
  rentTaxWithheldMinor: 0,
  feesOverTakenMinor: 0,
  ...over,
});

describe('AC-05 review the suggestion’s proposal and its notes', () => {
  it('says there is nothing to remit when the fees take it all, or there is nothing', () => {
    expect(nothingToRemitText(suggestion({}))).toContain('the fees due take all');
    expect(
      nothingToRemitText(suggestion({ proposal: 'nothing', agentCashMinor: 0, feesDueMinor: 0 })),
    ).toBe(
      'Nothing to remit: the agency holds nothing for this owner beyond the rent tax held back.',
    );
    expect(nothingToRemitText(suggestion({ proposal: 'remit', netMinor: 1 }))).toBeNull();
  });

  it('flags fees taken past what was due, never clamping it', () => {
    expect(feesOverTakenText(suggestion({ feesOverTakenMinor: 1_200 }))).toBe(
      'More fees have been taken than were due: GH₵12.00 too much. Check the fees taken before recording more.',
    );
    expect(feesOverTakenText(suggestion({}))).toBeNull();
  });

  it('reverses with a reason, and names an earlier reversal', () => {
    expect(reversalReasonProblem('no')).toBe('Give the reason, at least 3 characters');
    expect(reversalReasonProblem('Recorded twice')).toBeNull();
    expect(ownerMoneyMessage({ status: 409, code: 'OWNER_MONEY_REVERSED' })).toBe(
      'This was already reversed, so nothing changed.',
    );
    // F3's words, under the code remittances kept.
    expect(ownerMoneyMessage({ status: 409, code: 'OVER_AGENT_CASH' })).toContain(
      'doesn’t hold enough of this owner’s cash',
    );
  });
});

describe('DA-01 and Gate 1 review live figures, snapshots and final months are labelled', () => {
  it('tells live figures from the snapshot', () => {
    const times = dashboardTimesText(
      { asOf: '2026-11-06T04:00:00.000Z', liveAt: '2026-11-06T10:00:00.000Z' },
      time,
    );
    expect(times.live).toBe(
      'Occupancy and the collection rate are live, as of [2026-11-06T10:00:00.000Z].',
    );
    expect(times.snapshot).toMatch(/^Figures as of \[2026-11-06T04:00:00.000Z\]: arrears/);
    expect(
      dashboardTimesText({ asOf: null, liveAt: '2026-11-06T10:00:00.000Z' }, time).snapshot,
    ).toContain('not been worked out yet');
  });

  it('marks a month final or provisional', () => {
    expect(
      gate1StatusText(
        {
          status: 'final',
          finalisedAt: '2026-11-01T06:00:00.000Z',
          computedAt: '2026-11-01T06:00:00.000Z',
        },
        time,
      ),
    ).toBe('Final, worked out [2026-11-01T06:00:00.000Z].');
    expect(
      gate1StatusText(
        { status: 'provisional', finalisedAt: null, computedAt: '2026-11-06T04:00:00.000Z' },
        time,
      ),
    ).toMatch(/^Provisional/);
  });

  it('says why a refresh was refused', () => {
    expect(refreshProblemText(403, 'x')).toBe(
      'Only agency admins, managers and landlords can refresh the figures.',
    );
    expect(refreshProblemText(429, 'x')).toContain('less than a minute ago');
    expect(refreshProblemText(500, 'Something went wrong.')).toBe('Something went wrong.');
  });
});

describe('DA-01 and AC-04 money paid ahead but not yet applied is named the same on both screens', () => {
  // Founder, 2026-11-07: creditMinor is "Paid ahead, not yet applied to a month", never "Credit".
  it('labels the statement’s held-for-tenants lines', () => {
    const page = {
      accrual: {
        rentEarnedMinor: 0,
        serviceChargeEarnedMinor: 0,
        earnedMinor: 0,
        unearnedRentMinor: 300,
        unearnedServiceChargeMinor: 20,
        creditMinor: 5,
        unearnedMinor: 325,
        depositsHeldMinor: 0,
        arrearsByBucket: { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
        arrearsMinor: 0,
      },
    } as unknown as StatementPage;
    const rows = accrualRows(page);
    const held = ['unearned', 'rent-unearned', 'service-unearned', 'credit-unearned'];
    expect(rows.filter((r) => held.includes(r.key)).map((r) => [r.key, r.label])).toEqual([
      ['unearned', 'Held for tenants: paid ahead'],
      ['rent-unearned', 'Rent paid ahead'],
      ['service-unearned', 'Service charge paid ahead'],
      ['credit-unearned', 'Paid ahead, not yet applied to a month'],
    ]);
    expect(rows.filter((r) => /credit/i.test(r.label))).toEqual([]);
  });

  it('names it the same way under the dashboard’s unearned rent figure', () => {
    const detail = unearnedDetailText({ unearnedServiceChargeMinor: 2_000, creditMinor: 500 });
    expect(detail).toContain('GH₵20.00 of service charge paid ahead');
    expect(detail).toContain('GH₵5.00 paid ahead, not yet applied to a month');
    expect(detail).toMatch(/^Paid and applied to rent for months that haven’t started\./);
    expect(detail).not.toMatch(/credit/i);
  });
});
