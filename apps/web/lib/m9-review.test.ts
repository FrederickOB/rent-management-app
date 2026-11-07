import type { Me } from '@rent/contracts';
import { featuresOf } from '@rent/domain/settings';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { complianceKeys } from './compliance';
import { bpsToPercent, feeTermsMessage, percentToBps, termsText } from './fee-terms';
import { INSUFFICIENT_AGENT_CASH_TEXT, moneyProblem } from './idempotency';
import {
  nonNegativeMinorOf,
  nothingToRemitText,
  remittanceDraftOf,
  remittanceInput,
  remittanceWarning,
  type RemittanceSuggestion,
} from './owner-money';
import { GATE1_LABELS } from './reporting';
import {
  draftableMonths,
  earlierMonthsLockText,
  expenseCategoryText,
  ISSUE_LOCKS_NOTE,
} from './statements';

// M9 review round: new tests beside the earlier ones, which stay as they passed.

const O1 = '019a3000-0000-7000-8000-000000000101';

const suggestion = (over: Partial<RemittanceSuggestion> = {}): RemittanceSuggestion => ({
  owner: { id: O1, name: 'Nana (demo)' },
  asOf: '2026-11-06',
  agentCashMinor: 100_000,
  feesDueMinor: 0,
  graPaidBy: 'owner',
  rentTaxHeldBackMinor: 0,
  totalMinor: 100_000,
  feesRetainedMinor: 0,
  netMinor: 100_000,
  // The review round's fields (M9 review contracts), as a plain remittance carries them.
  proposal: 'remit',
  rentTaxWithheldMinor: 0,
  feesOverTakenMinor: 0,
  ...over,
});

describe('AC-05 review WEB 1 a remittance with no fees due can be sent', () => {
  it('sends the suggestion as filled when no fees are retained', () => {
    const draft = {
      ...remittanceDraftOf(suggestion(), '2026-11-06'),
      method: 'bank' as const,
      reference: 'TRF-9',
    };
    expect(draft.feesRetained).toBe('0.00');
    expect(remittanceInput(draft, '2026-11-06')).toEqual({
      input: {
        on: '2026-11-06',
        method: 'bank',
        reference: 'TRF-9',
        netMinor: 100_000,
        feesRetainedMinor: 0,
      },
      errors: {},
    });
  });

  it('takes any zero, or a blank, as no fees retained', () => {
    for (const text of ['', ' ', '0', '0.0', '0.00', 'GH₵0.00'])
      expect(nonNegativeMinorOf(text)).toEqual({ value: 0, problem: null });
    expect(nonNegativeMinorOf('12.50')).toEqual({ value: 1_250, problem: null });
    expect(nonNegativeMinorOf('abc').problem).not.toBeNull();
  });

  it('warns past the suggestion, and says when there is nothing to remit', () => {
    expect(
      remittanceWarning(
        { netMinor: 90_000, feesRetainedMinor: 0 },
        suggestion({ netMinor: 80_000 }),
      ),
    ).toBe('This pays the owner GH₵900.00, more than the GH₵800.00 suggested from the ledger.');
    expect(
      remittanceWarning(
        { netMinor: 80_000, feesRetainedMinor: 0 },
        suggestion({ netMinor: 80_000 }),
      ),
    ).toBeNull();
    expect(nothingToRemitText(suggestion())).toBeNull();
    expect(nothingToRemitText(suggestion({ netMinor: 0, feesDueMinor: 100_000 }))).toBe(
      'Nothing to remit: the fees due take all of the GH₵1,000.00 that could be paid out.',
    );
    expect(
      nothingToRemitText(
        suggestion({ netMinor: 0, agentCashMinor: 5_000, rentTaxHeldBackMinor: 5_000 }),
      ),
    ).toBe(
      'Nothing to remit: the agency holds nothing for this owner beyond the rent tax held back.',
    );
  });
});

describe('F3 money never leaves the agency account past what it holds for the owner', () => {
  it('says INSUFFICIENT_AGENT_CASH in plain words on every money form', () => {
    const refusal = {
      status: 409,
      data: { body: { code: 'INSUFFICIENT_AGENT_CASH', message: 'x' } },
    };
    expect(moneyProblem(refusal)).toBe(INSUFFICIENT_AGENT_CASH_TEXT);
    expect(INSUFFICIENT_AGENT_CASH_TEXT).toMatch(/^Nothing was recorded/);
    expect(INSUFFICIENT_AGENT_CASH_TEXT).toContain('doesn’t hold enough of this owner’s cash');
    expect(INSUFFICIENT_AGENT_CASH_TEXT).toContain('Record the owner’s funding first');
  });
});

describe('AC-02 review WEB 7 fee rates with a decimal are read exactly', () => {
  it('reads 9.5% and 9.05% without floating point', () => {
    expect(percentToBps('9.5')).toBe(950);
    expect(percentToBps('9.05')).toBe(905);
    expect(percentToBps('9.50')).toBe(950);
    expect(bpsToPercent(905)).toBe('9.05');
    expect(bpsToPercent(950)).toBe('9.5');
    expect(
      termsText({ kind: 'percentage', rateBps: 905, fixedMinor: null, graPaidBy: 'owner' }),
    ).toBe('9.05% of rent and service charge settled, per receipt; the owner pays GRA');
  });

  it('names a change already waiting', () => {
    expect(feeTermsMessage({ status: 409, code: 'APPROVAL_OPEN' })).toContain('already waiting');
  });
});

describe('AC-04 F1 issuing locks the month and every earlier one', () => {
  it('says so on the draft form and in the confirmation', () => {
    expect(ISSUE_LOCKS_NOTE).toContain('every earlier month');
    expect(
      earlierMonthsLockText({ month: '2026-10', owner: { id: O1, name: 'Nana (demo)' } }),
    ).toBe(
      'It also locks every month before October 2026 for Nana (demo), issued or not: anything recorded later for those months lands in the first open month.',
    );
  });

  it('counts months back through the domain’s dates, across a year', () => {
    expect(draftableMonths('2026-02-28', 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(draftableMonths('2026-03-31', 1)).toEqual(['2026-02']);
  });

  it('labels expense categories as M8 does', () => {
    expect(expenseCategoryText('repairs')).toBe('Repairs and maintenance');
    expect(expenseCategoryText('rates')).toBe('Property rates');
    expect(expenseCategoryText('Something else')).toBe('Something else');
  });
});

describe('decision 14 review WEB 5 each compliance item has its own key', () => {
  it('keeps keys unique when two items are otherwise the same', () => {
    const item = {
      kind: 'vat_return' as const,
      owner: { id: O1, name: 'Nana' },
      property: null,
      lease: null,
      dueDate: '2026-11-30',
      description: 'VAT for October',
    };
    const keys = complianceKeys([item, item, { ...item, dueDate: '2026-12-31' }]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[1]).toBe(`${keys[0]}#2`);
  });
});

describe('Gate 1 review WEB 8 the platform table has its columns before any figures', () => {
  it('names the seven columns', () => {
    expect(GATE1_LABELS.map((l) => l.key)).toEqual([
      'collection',
      'digital',
      'auto_match',
      'direct',
      'receipt',
      'notice',
      'repair',
    ]);
  });
});

function member(kind: 'agency' | 'landlord', role: string): Me {
  return {
    personId: O1,
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: 'password_totp',
    sessionExpiresAt: '2026-11-06T13:00:00.000Z',
    actorKind: 'staff',
    activeCompanyId: O1,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId: O1,
        companyName: 'Demo company',
        companyKind: kind,
        role,
        nominatedApprover: false,
      },
    ],
  };
}

describe('AC-05 review WEB 8 a landlord who manages their own property has no remittances menu', () => {
  it('shows Remittances in an agency only', () => {
    const labels = (me: Me) => navFor(me, featuresOf('growth')).map((i) => i.label);
    expect(labels(member('agency', 'property_manager'))).toContain('Remittances');
    expect(labels(member('landlord', 'owner'))).not.toContain('Remittances');
    expect(labels(member('landlord', 'owner'))).toContain('Owner statements');
  });
});
