import type { Me, OwnerStatementDetail } from '@rent/contracts';
import { featuresOf } from '@rent/domain/settings';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { approvalActionLabel, approvalFacts, subjectHref } from './approvals';
import { complianceHref, dueText, sortCompliance } from './compliance';
import { bpsToPercent, feeTermsInput, feeTermsMessage, percentToBps, termsText } from './fee-terms';
import {
  ownerMoneyMessage,
  remittanceDraftOf,
  remittanceInput,
  remittanceWarning,
  simpleTransferInput,
  type RemittanceSuggestion,
} from './owner-money';
import { notOnPlanText } from './plan';
import {
  barParts,
  bpsText,
  dashboardQuery,
  durationText,
  expiryRows,
  exportNext,
  gate1Rows,
  monthsText,
  NO_FILTERS,
  unitTypeText,
  type Gate1,
} from './reporting';
import {
  accrualRows,
  agentRows,
  cashRows,
  draftableMonths,
  failedChecks,
  issueConfirmText,
  statementMessage,
  statementPages,
} from './statements';

const O1 = '019a3000-0000-7000-8000-000000000101';
const O2 = '019a3000-0000-7000-8000-000000000102';
const P1 = '019a3000-0000-7000-8000-000000000201';
const ratio = (numerator: number, denominator: number, bps: number | null) => ({
  numerator,
  denominator,
  bps,
});

describe('DA-01 and Gate 1 shares are shown from basis points, never divided on screen', () => {
  it('writes basis points as an exact percentage, and "—" with nothing to divide by', () => {
    expect(bpsText(8750)).toBe('87.5%');
    expect(bpsText(10_000)).toBe('100%');
    expect(bpsText(1234)).toBe('12.34%');
    expect(bpsText(5)).toBe('0.05%');
    expect(bpsText(0)).toBe('0%');
    expect(bpsText(null)).toBe('—');
  });

  it('draws a bar from basis points as flex weights, clamped to the whole', () => {
    expect(barParts(2500)).toEqual({ filled: 2500, empty: 7500 });
    expect(barParts(12_000)).toEqual({ filled: 10_000, empty: 0 });
    expect(barParts(null)).toBeNull();
  });

  it('says durations and months paid ahead plainly', () => {
    expect(durationText(850)).toBe('0.8 s');
    expect(durationText(45_000)).toBe('45.0 s');
    expect(durationText(125_000)).toBe('2 min 5 s');
    expect(durationText(null)).toBe('—');
    expect(monthsText(3)).toBe('3 months');
    expect(monthsText(1)).toBe('1 month');
    expect(monthsText(2.5)).toBe('2.5 months');
    expect(monthsText(null)).toBe('—');
    expect(unitTypeText('chamber_and_hall')).toBe('Chamber and hall');
    expect(unitTypeText('mystery')).toBe('mystery');
  });
});

describe('DA-06 dashboard filters send only values the API offered', () => {
  const options = {
    owners: [{ id: O1, name: 'Ama (demo)' }],
    properties: [{ id: P1, name: 'Legon (demo)' }],
    regions: ['Greater Accra'],
    unitTypes: ['shop'],
  };

  it('drops empty, unknown or malformed filters', () => {
    expect(dashboardQuery(NO_FILTERS, options)).toEqual({});
    expect(
      dashboardQuery(
        { ownerId: O1, propertyId: P1, region: 'Greater Accra', unitType: 'shop' },
        options,
      ),
    ).toEqual({ ownerId: O1, propertyId: P1, region: 'Greater Accra', unitType: 'shop' });
    expect(
      dashboardQuery({ ownerId: O2, propertyId: 'x', region: 'Volta', unitType: 'kiosk' }, options),
    ).toEqual({});
  });

  it('lists the expiry pipeline at 3, 6 and 12 months with those not yet offered a renewal', () => {
    expect(
      expiryRows([
        { withinMonths: 12, leases: 9, renewalOffered: 3, renewed: 1 },
        { withinMonths: 3, leases: 2, renewalOffered: 1, renewed: 0 },
      ]).map((r) => [r.withinMonths, r.notOffered]),
    ).toEqual([
      [3, 1],
      [12, 5],
    ]);
  });

  it('opens an export once it is ready, waits while a PDF renders, and says when it failed', () => {
    expect(exportNext({ status: 'ready', url: 'https://storage.example/x.xlsx' })).toBe('open');
    expect(exportNext({ status: 'rendering', url: null })).toBe('wait');
    expect(exportNext({ status: 'ready', url: null })).toBe('wait');
    expect(exportNext({ status: 'failed', url: null })).toBe('failed');
  });
});

const GATE1: Gate1 = {
  month: '2026-10',
  collectionRate: {
    dueMinor: 1_000_000,
    collectedMinor: 875_000,
    rate: ratio(875_000, 1_000_000, 8750),
  },
  digitalShare: {
    byMethod: { momo: 500_000, card: 0, bank_transfer: 100_000, cash: 200_000, cheque: 0, test: 0 },
    digitalMinor: 600_000,
    totalMinor: 800_000,
    share: ratio(600_000, 800_000, 7500),
  },
  autoMatch: {
    provider: { automatic: 9, byPerson: 1, unmatched: 0, rate: ratio(9, 10, 9000) },
    directTransfers: { againstLease: 0, unmatched: 0, rate: ratio(0, 0, null) },
  },
  timeToReceipt: {
    receipts: 20,
    sent: 20,
    withinTarget: 19,
    share: ratio(19, 20, 9500),
    medianMs: 4_000,
    p95Ms: 58_000,
  },
  noticeAcknowledgement: { met: 3, missed: 1, pending: 2, rate: ratio(3, 4, 7500) },
  repairResponse: { met: 0, missed: 0, pending: 0, rate: ratio(0, 0, null) },
  computedAt: '2026-11-05T04:00:00.000Z',
};

describe('Gate 1 (PRD section 19) shows each share with what is behind it', () => {
  it('has the six measures, with "—" where nothing happened', () => {
    const rows = gate1Rows(GATE1);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['collection', '87.5%'],
      ['digital', '75%'],
      ['auto_match', '90%'],
      ['direct', '—'],
      ['receipt', '95%'],
      ['notice', '75%'],
      ['repair', '—'],
    ]);
    expect(rows[0]!.detail).toBe('GH₵8,750.00 collected of GH₵10,000.00 due');
    expect(rows[4]!.detail).toBe('19 of 20 receipts; median 4.0 s, 95th percentile 58.0 s');
  });
});

// Statements (AC-04) ------------------------------------------------------------------------

const page = (propertyId: string | null) => ({
  propertyId,
  cash: {
    collectionsByMethod: {
      momo: 300_000,
      card: 0,
      bank_transfer: 0,
      cash: 50_000,
      cheque: 0,
      test: 0,
    },
    collectionsMinor: 350_000,
    expensesByCategory: [{ category: 'Repairs and maintenance', amountMinor: 20_000 }],
    expensesMinor: 20_000,
    feesMinor: 28_000,
    rentTaxAccruedMinor: 28_000,
    rentTaxPaidMinor: 0,
  },
  accrual: {
    rentEarnedMinor: 300_000,
    serviceChargeEarnedMinor: 20_000,
    earnedMinor: 320_000,
    unearnedRentMinor: 600_000,
    unearnedServiceChargeMinor: 0,
    unearnedMinor: 600_000,
    depositsHeldMinor: 100_000,
    arrearsByBucket: { '0_30': 10_000, '31_60': 0, '61_90': 0, '90_plus': 5_000 },
    arrearsMinor: 15_000,
  },
  occupancy: {
    units: 4,
    lettable: 4,
    occupied: 3,
    vacant: 1,
    available: 1,
    reserved: 0,
    underRepair: 0,
    notLettable: 0,
    rate: ratio(3, 4, 7500),
  },
});

const DETAIL = {
  id: O1,
  owner: { id: O1, name: 'Ama Owner-London (demo)' },
  month: '2026-10',
  properties: [{ id: P1, name: 'Legon compound (demo)' }],
  figures: {
    ownerId: O1,
    month: '2026-10',
    firstDay: '2026-10-01',
    lastDay: '2026-10-31',
    properties: [page(P1)],
    summary: page(null),
    processingFeesMinor: 0,
    rentTaxPayable: null,
    agent: {
      openingMinor: 100_000,
      in: { collections: 350_000, owner_funding: 0, other_in: 0 },
      out: {
        expenses_paid: 20_000,
        fees_taken: 0,
        rent_tax_paid: 0,
        vat_paid: 0,
        refunds_paid: 0,
        remittances: 200_000,
        reversals: 0,
        other_out: 0,
      },
      inMinor: 350_000,
      outMinor: 220_000,
      closingMinor: 230_000,
      feesDueOpeningMinor: 0,
      feesChargedMinor: 28_000,
      feesTakenMinor: 0,
      feesSettledAtSourceMinor: 0,
      feesDueClosingMinor: 28_000,
      reserveMinor: 0,
      graPaidBy: 'agency' as const,
      rentTaxHeldBackMinor: 28_000,
      netRemittableMinor: 174_000,
      remittancesMadeMinor: 200_000,
    },
    checks: [
      {
        name: 'agent_cash' as const,
        scope: 'owner',
        expectedMinor: 230_000,
        actualMinor: 230_000,
        passed: true,
      },
      {
        name: 'rent_tax_receipts' as const,
        scope: P1,
        expectedMinor: 28_000,
        actualMinor: 27_999,
        passed: false,
      },
    ],
  },
} as unknown as OwnerStatementDetail;

describe('AC-04 the statement is laid out page by page, with its checks', () => {
  it('lists the pages by property name, then the summary', () => {
    expect(statementPages(DETAIL).map((p) => [p.key, p.title])).toEqual([
      [P1, 'Legon compound (demo)'],
      ['summary', 'Summary: every property'],
    ]);
  });

  it('shows the cash and accrual sections with their parts, leaving out methods not used', () => {
    expect(cashRows(DETAIL.figures.summary).map((r) => r.key)).toEqual([
      'collections',
      'collected-momo',
      'collected-cash',
      'expenses',
      'expense-Repairs and maintenance',
      'fees',
      'tax-accrued',
      'tax-paid',
    ]);
    const accrual = accrualRows(DETAIL.figures.summary);
    expect(accrual.find((r) => r.key === 'arrears')?.amountMinor).toBe(15_000);
    expect(accrual.filter((r) => r.key.startsWith('arrears-')).map((r) => r.label)).toEqual([
      '0–30 days',
      '31–60 days',
      '61–90 days',
      'Over 90 days',
    ]);
  });

  it('shows the agent’s side, with the rent tax held back when the agency pays GRA', () => {
    const rows = agentRows(DETAIL.figures.agent!);
    expect(rows.map((r) => [r.key, r.amountMinor])).toEqual([
      ['opening', 100_000],
      ['in-collections', 350_000],
      ['out-expenses_paid', -20_000],
      ['out-remittances', -200_000],
      ['closing', 230_000],
      ['fees-due', 28_000],
      ['tax-held', 28_000],
      ['net', 174_000],
      ['remitted', 200_000],
    ]);
  });

  it('names a failing check, and says issuing locks the month', () => {
    expect(failedChecks(DETAIL.figures).map((c) => c.name)).toEqual(['rent_tax_receipts']);
    expect(issueConfirmText(DETAIL)).toMatch(
      /^Issuing locks October 2026 for Ama Owner-London \(demo\)\./,
    );
    expect(statementMessage({ status: 409, code: 'MONTH_NOT_OVER' })).toContain('not over yet');
    expect(statementMessage({ status: 409, code: 'STATEMENT_UNBALANCED' })).toContain('checks');
    expect(statementMessage({ status: 409, code: 'OTHER' })).toBeNull();
    expect(draftableMonths('2026-01-15', 3)).toEqual(['2025-12', '2025-11', '2025-10']);
  });
});

// Remittances (AC-05) -----------------------------------------------------------------------

const SUGGESTION: RemittanceSuggestion = {
  owner: { id: O1, name: 'Ama (demo)' },
  asOf: '2026-11-05',
  agentCashMinor: 230_000,
  feesDueMinor: 28_000,
  graPaidBy: 'agency',
  rentTaxHeldBackMinor: 28_000,
  totalMinor: 202_000,
  feesRetainedMinor: 28_000,
  netMinor: 174_000,
};

describe('AC-05 the remittance starts from the suggestion and needs its proof', () => {
  it('fills the net and the fees retained from the suggestion', () => {
    expect(remittanceDraftOf(SUGGESTION, '2026-11-05')).toEqual({
      net: '1740.00',
      feesRetained: '280.00',
      on: '2026-11-05',
      method: '',
      reference: '',
    });
  });

  it('takes integer pesewas, a method and a reference, never a future date', () => {
    const draft = {
      ...remittanceDraftOf(SUGGESTION, '2026-11-05'),
      method: 'bank' as const,
      reference: 'TRF-1',
    };
    expect(remittanceInput(draft, '2026-11-05').input).toEqual({
      on: '2026-11-05',
      method: 'bank',
      reference: 'TRF-1',
      netMinor: 174_000,
      feesRetainedMinor: 28_000,
    });
    expect(
      remittanceInput(
        { ...draft, net: '', on: '2026-11-06', method: '', reference: 'x' },
        '2026-11-05',
      ).errors,
    ).toEqual({
      net: 'Enter the amount',
      on: 'The date cannot be in the future',
      method: 'Choose how it was paid',
      reference: 'Enter the transfer, MoMo or cheque reference',
    });
  });

  it('warns before reaching into the rent tax held back or past the fees due', () => {
    expect(
      remittanceWarning({ netMinor: 174_000, feesRetainedMinor: 28_000 }, SUGGESTION),
    ).toBeNull();
    expect(
      remittanceWarning({ netMinor: 200_000, feesRetainedMinor: 28_000 }, SUGGESTION),
    ).toContain('rent tax held back');
    expect(remittanceWarning({ netMinor: 1, feesRetainedMinor: 30_000 }, SUGGESTION)).toContain(
      'more than the',
    );
  });

  it('says the API’s refusals in plain words', () => {
    expect(ownerMoneyMessage({ status: 409, code: 'OVER_AGENT_CASH' })).toContain(
      'more than the agency holds',
    );
    expect(ownerMoneyMessage({ status: 409, code: 'FEES_OVER_DUE' })).toContain(
      'more than the fees due',
    );
    expect(ownerMoneyMessage({ status: 409, code: 'INTO_RENT_TAX' })).toContain(
      'rent tax held back',
    );
    expect(ownerMoneyMessage({ status: 409, code: 'CONFLICT' })).toBeNull();
    expect(
      simpleTransferInput({ amount: '50', on: '2026-11-05', reference: '' }, '2026-11-05', {
        needsMethod: false,
        needsReference: false,
      }).input,
    ).toEqual({ amountMinor: 5_000, on: '2026-11-05', reference: null, method: null });
  });
});

// Fee terms (AC-02) -------------------------------------------------------------------------

describe('AC-02 fee terms are typed as a percentage and sent as basis points, exactly', () => {
  it('reads a percentage without floating point', () => {
    expect(percentToBps('8')).toBe(800);
    expect(percentToBps('8.5')).toBe(850);
    expect(percentToBps('12.25%')).toBe(1225);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps('0')).toBeNull();
    expect(percentToBps('100.5')).toBeNull();
    expect(percentToBps('8.125')).toBeNull();
    expect(bpsToPercent(850)).toBe('8.5');
  });

  it('describes the terms, and checks a change before it goes for approval', () => {
    expect(
      termsText({ kind: 'percentage', rateBps: 800, fixedMinor: null, graPaidBy: 'agency' }),
    ).toBe('8% of rent and service charge settled, per receipt; the agency pays GRA');
    expect(
      termsText({ kind: 'fixed_per_unit', rateBps: null, fixedMinor: 5_000, graPaidBy: 'owner' }),
    ).toBe('GH₵50.00 per billable unit per month; the owner pays GRA');
    const ok = feeTermsInput(
      {
        kind: 'percentage',
        percent: '8',
        fixed: '',
        graPaidBy: 'agency',
        effectiveFrom: '2026-12-01',
      },
      '2026-11-05',
    );
    expect(ok.input).toEqual({
      kind: 'percentage',
      rateBps: 800,
      fixedMinor: null,
      graPaidBy: 'agency',
      effectiveFrom: '2026-12-01',
    });
    expect(
      feeTermsInput(
        { kind: 'percentage', percent: '0', fixed: '', graPaidBy: '', effectiveFrom: '2026-11-01' },
        '2026-11-05',
      ).errors,
    ).toEqual({
      percent: 'Enter a percentage from 0.01 to 100, such as 8 or 8.5',
      graPaidBy: 'Choose who pays the owner’s rent tax to GRA',
      effectiveFrom:
        'It takes effect today or later: earlier receipts keep the terms then in force',
    });
    expect(feeTermsMessage({ status: 409, code: 'NOT_AN_AGENCY' })).toContain('Only an agency');
  });

  it('shows a fee-terms request on the Approvals card as the terms now and asked for', () => {
    const payload = {
      ownerId: O1,
      ownerName: 'Ama (demo)',
      kind: 'percentage',
      rateBps: 1000,
      fixedMinor: null,
      graPaidBy: 'agency',
      effectiveFrom: '2026-12-01',
      current: {
        kind: 'percentage',
        rateBps: 800,
        fixedMinor: null,
        graPaidBy: 'owner',
        effectiveFrom: '2026-01-01',
      },
    };
    expect(approvalActionLabel('management_fee_terms.change')).toBe(
      'Change an owner’s management fee',
    );
    expect(
      approvalFacts('management_fee_terms.change', payload).map((f) => [f.label, f.value]),
    ).toEqual([
      ['Owner', 'Ama (demo)'],
      ['Terms now', '8% of rent and service charge settled, per receipt; the owner pays GRA'],
      [
        'Terms asked for',
        '10% of rent and service charge settled, per receipt; the agency pays GRA',
      ],
      ['From', '1 Dec 2026'],
    ]);
    expect(subjectHref({ subjectType: 'owner', subjectId: O1, payload })).toBe(`/owners/${O1}`);
  });
});

// The compliance list (decision 14) ---------------------------------------------------------

describe('decision 14 the compliance list links to the screens that exist', () => {
  it('puts overdue rent tax first, then by date, undated last', () => {
    const sorted = sortCompliance([
      { kind: 'vat_return' as const, dueDate: null },
      { kind: 'rent_tax_due' as const, dueDate: '2026-11-20' },
      { kind: 'rent_tax_overdue' as const, dueDate: '2026-11-01' },
      { kind: 'rent_control_registration' as const, dueDate: '2026-11-10' },
    ]);
    expect(sorted.map((i) => i.kind)).toEqual([
      'rent_tax_overdue',
      'rent_control_registration',
      'rent_tax_due',
      'vat_return',
    ]);
    expect(dueText({ kind: 'rent_tax_overdue', dueDate: '2026-11-01' })).toBe(
      'Overdue since 1 Nov 2026',
    );
    expect(dueText({ kind: 'vat_return', dueDate: null })).toBeNull();
  });

  it('opens the right screen', () => {
    expect(complianceHref({ link: { screen: 'rent_tax', id: null }, lease: null })).toBe(
      '/tax/rent',
    );
    expect(complianceHref({ link: { screen: 'advance_rent', id: null }, lease: null })).toBe(
      '/compliance/advance-rent',
    );
    expect(complianceHref({ link: { screen: 'rent_control', id: P1 }, lease: null })).toBe(
      `/leases/${P1}`,
    );
    expect(
      complianceHref({
        link: { screen: 'withholding', id: null },
        lease: { id: P1, unitCode: 'X' },
      }),
    ).toBe(`/leases/${P1}`);
    expect(complianceHref({ link: { screen: 'lease', id: null }, lease: null })).toBeNull();
  });
});

// Navigation (plan 4.8; decision 13) --------------------------------------------------------

const PLATFORM = '019a3000-0000-7000-8000-000000000003';

function member(role: string, landlord = false, platform = false): Me {
  const actorKind: Me['actorKind'] = platform ? 'platform_admin' : 'staff';
  const companyId = platform ? PLATFORM : landlord ? O2 : O1;
  return {
    personId: P1,
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: 'password_totp',
    sessionExpiresAt: '2026-11-05T13:00:00.000Z',
    actorKind,
    activeCompanyId: companyId,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId,
        companyName: 'Demo company',
        companyKind: platform ? 'platform' : landlord ? 'landlord' : 'agency',
        role,
        nominatedApprover: false,
      },
    ],
  };
}

const M9 = ['Owner statements', 'Remittances', 'Compliance list', 'Gate 1 metrics'];
const labels = (me: Me, plan: 'growth' | 'starter' = 'growth') =>
  navFor(me, featuresOf(plan))
    .map((item) => item.label)
    .filter((label) => M9.includes(label));

describe('decision 13 statements and remittances are Growth only; the compliance list everywhere', () => {
  it('gives managers, accountants and owners their statements, remittances and the compliance list', () => {
    expect(labels(member('property_manager'))).toEqual([
      'Owner statements',
      'Remittances',
      'Compliance list',
    ]);
    expect(labels(member('accountant'))).toEqual([
      'Owner statements',
      'Remittances',
      'Compliance list',
    ]);
    expect(labels(member('owner'))).toEqual(['Owner statements', 'Remittances', 'Compliance list']);
  });

  it('keeps statements off Starter and away from caretakers', () => {
    expect(labels(member('owner', true), 'starter')).toEqual(['Compliance list']);
    expect(labels(member('caretaker'))).toEqual([]);
    expect(notOnPlanText('owner_reporting', 'starter')).toBe(
      'Owner statements are not on the Starter plan.',
    );
  });

  it('shows Gate 1 across companies to platform admins only', () => {
    expect(labels(member('platform_admin', false, true), 'growth')).toEqual(['Gate 1 metrics']);
  });
});
