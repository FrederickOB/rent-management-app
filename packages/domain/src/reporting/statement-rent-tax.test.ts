import { describe, expect, it } from 'vitest';
import { managementFeeLines } from '../ledger/fees';
import { balanceOf, type JournalLineDraft } from '../ledger/journal';
import type { GraPayer } from '../ledger/owner-posting';
import { monthOf } from '../ledger/periods';
import type { LeaseDimensions } from '../ledger/posting';
import { settlementLines } from '../ledger/settlement-posting';
import { certificateLines, graPaymentLines, rentTaxLines } from '../ledger/tax-posting';
import {
  failedStatementChecks,
  flattenStatementFigures,
  ownerStatementFigures,
  type OwnerStatementInput,
  type StatementPropertyInput,
} from './statement';

const OWNER = 'book-owner';
const leg: LeaseDimensions = {
  propertyId: 'acc-leg',
  unitId: 'leg-b1-01',
  leaseId: 'l-leg',
  tenantId: 't-1',
};

/** A month of the owner's book: each entry with its accounting date and how 1070 moved. */
interface Posted {
  readonly accountingDate: string;
  readonly rule: 'P14' | 'P17' | 'P18' | 'P20' | 'P22';
  readonly lines: readonly JournalLineDraft[];
}

const ledger: Posted[] = [];
const post = (accountingDate: string, rule: Posted['rule'], lines: readonly JournalLineDraft[]) =>
  ledger.push({ accountingDate, rule, lines });

const receipt = (date: string, paymentId: string) => {
  post(
    date,
    'P17',
    rentTaxLines({
      bookId: OWNER,
      lease: leg,
      paymentId,
      lines: [{ invoiceLineId: null, taxMinor: 12_000 }],
    }),
  );
  post(
    date,
    'P14',
    managementFeeLines({ bookId: OWNER, dims: { ...leg, paymentId }, amountMinor: 15_000 }),
  );
  post(
    date,
    'P22',
    settlementLines({
      bookId: OWNER,
      to: '1070',
      provider: 'paystack',
      settlementId: `set-${paymentId}`,
      settlementAccountId: null,
      payments: [{ paymentId, amountMinor: 150_000 }],
      feesMinor: 1_500,
      deductionsMinor: 0,
      netMinor: 148_500,
    }),
  );
};

// October: a receipt, and GH₵1,500 withheld by a corporate tenant, accrued as rent tax (P17).
receipt('2026-10-03', 'pay-1');
post(
  '2026-10-05',
  'P17',
  rentTaxLines({
    bookId: OWNER,
    lease: leg,
    paymentId: 'pay-w',
    lines: [{ invoiceLineId: null, taxMinor: 150_000 }],
  }),
);
// November: a receipt, October's tax paid to GRA by the agency, and the certificate confirmed.
receipt('2026-11-02', 'pay-2');
post(
  '2026-11-20',
  'P18',
  graPaymentLines({
    bookId: OWNER,
    from: '1070',
    items: [{ paymentId: 'pay-1', amountMinor: 12_000, lease: leg }],
    propertyId: 'acc-leg',
  }),
);
post(
  '2026-11-21',
  'P20',
  certificateLines({
    bookId: OWNER,
    lease: leg,
    paymentId: 'pay-w',
    debit: '2200',
    amountMinor: 150_000,
  }),
);

function novemberInput(graPaidBy: GraPayer | undefined): OwnerStatementInput {
  const inMonth = ledger.filter((e) => monthOf(e.accountingDate) === '2026-11');
  const before = ledger.filter((e) => e.accountingDate < '2026-11-01');
  const toEnd = ledger.filter((e) => e.accountingDate <= '2026-11-30');
  const sum = (entries: readonly Posted[], filter: Parameters<typeof balanceOf>[1]) =>
    balanceOf(
      entries.flatMap((e) => e.lines),
      filter,
    );
  const of = (rule: Posted['rule']) => inMonth.filter((e) => e.rule === rule);
  const property: StatementPropertyInput = {
    propertyId: 'acc-leg',
    collections: [{ method: 'momo', amountMinor: 150_000 }],
    expenses: [],
    feesMinor: sum(inMonth, { accountCode: '5100', propertyId: 'acc-leg' }),
    rentTax: {
      accruedMinor: sum(inMonth, { accountCode: '5300', propertyId: 'acc-leg' }),
      paidMinor: sum(of('P18'), { accountCode: '2200', propertyId: 'acc-leg' }),
      receiptItemsMinor: of('P17').map((e) => balanceOf(e.lines, { accountCode: '5300' })),
    },
    rentEarnedMinor: 0,
    serviceChargeEarnedMinor: 0,
    unearnedRentMinor: 0,
    depositsHeldMinor: 0,
    arrears: [],
    occupancy: { occupied: 1 },
  };
  return {
    ownerId: 'owner-ama',
    month: '2026-11',
    properties: [property],
    rentTaxPayable: {
      openingMinor: -sum(before, { accountCode: '2200' }),
      closingMinor: -sum(toEnd, { accountCode: '2200' }),
      certifiedMinor: sum(of('P20'), { accountCode: '2200' }),
    },
    agent: {
      cash: {
        openingMinor: sum(before, { accountCode: '1070' }),
        closingMinor: sum(toEnd, { accountCode: '1070' }),
        in: [{ kind: 'collections', amountMinor: sum(of('P22'), { accountCode: '1070' }) }],
        out: [{ kind: 'rent_tax_paid', amountMinor: -sum(of('P18'), { accountCode: '1070' }) }],
      },
      feesDue: {
        openingMinor: -sum(before, { accountCode: '2300' }),
        closingMinor: -sum(toEnd, { accountCode: '2300' }),
      },
      ...(graPaidBy ? { graPaidBy } : {}),
    },
  };
}

describe('AC-05 the net remittable holds back rent tax when the agency pays GRA (founder decision, 2026-11-05)', () => {
  it('holds back the rent tax payable at the month’s end, before the fees due', () => {
    const s = ownerStatementFigures(novemberInput('agency'));
    expect(s.rentTaxPayable).toEqual({
      openingMinor: 162_000,
      accruedMinor: 12_000,
      paidMinor: 12_000,
      certifiedMinor: 150_000,
      closingMinor: 12_000,
    });
    expect(s.agent).toMatchObject({
      closingMinor: 285_000,
      feesDueClosingMinor: 30_000,
      graPaidBy: 'agency',
      rentTaxHeldBackMinor: 12_000,
      netRemittableMinor: 243_000,
    });
  });

  it('holds back nothing when the owner pays GRA, or when the statement was not told', () => {
    const owner = ownerStatementFigures(novemberInput('owner')).agent;
    expect(owner).toMatchObject({
      graPaidBy: 'owner',
      rentTaxHeldBackMinor: 0,
      netRemittableMinor: 255_000,
    });
    const untold = ownerStatementFigures(novemberInput(undefined)).agent;
    expect(untold).toMatchObject({
      graPaidBy: null,
      rentTaxHeldBackMinor: 0,
      netRemittableMinor: 255_000,
    });
  });

  it('needs the rent tax payable when the agency pays GRA', () => {
    expect(() =>
      ownerStatementFigures({ ...novemberInput('agency'), rentTaxPayable: undefined }),
    ).toThrow(/needs the rent tax payable/);
    expect(() => ownerStatementFigures(novemberInput('landlord' as GraPayer))).toThrow(
      /agency or the owner/,
    );
  });

  it('stores the hold-back and the rent tax payable among the figures', () => {
    const rows = flattenStatementFigures(ownerStatementFigures(novemberInput('agency')));
    expect(rows).toContainEqual({ key: 'owner.rent_tax_payable.closing', value: 12_000 });
    expect(rows).toContainEqual({ key: 'owner.rent_tax_payable.certified', value: 150_000 });
    expect(rows).toContainEqual({ key: 'agent.rent_tax_held_back', value: 12_000 });
    expect(rows.at(-1)).toEqual({ key: 'agent.remittances_made', value: 0 });
  });
});

describe('AC-04 the statement’s rent tax payable identity', () => {
  it('rolls 2200 forward: opening, plus accrued, less paid and certified, is the closing', () => {
    const s = ownerStatementFigures(novemberInput('agency'));
    expect(s.checks.map((c) => [c.name, c.passed])).toEqual([
      ['agent_cash', true],
      ['fees_due', true],
      ['rent_tax_receipts', true],
      ['rent_tax_receipts', true],
      ['rent_tax_payable', true],
    ]);
  });

  it('fails when a GRA payment is missing from the month’s figures', () => {
    const input = novemberInput('agency');
    const property = input.properties[0] as StatementPropertyInput;
    const s = ownerStatementFigures({
      ...input,
      properties: [{ ...property, rentTax: { ...property.rentTax, paidMinor: 0 } }],
    });
    expect(failedStatementChecks(s)).toEqual([
      {
        name: 'rent_tax_payable',
        scope: 'owner',
        expectedMinor: 24_000,
        actualMinor: 12_000,
        passed: false,
      },
    ]);
  });

  it('is checked for a self-managing landlord too, who holds nothing back', () => {
    const input = novemberInput('owner');
    const s = ownerStatementFigures({ ...input, agent: null });
    expect(s.agent).toBeNull();
    expect(s.checks.map((c) => c.name)).toEqual([
      'rent_tax_receipts',
      'rent_tax_receipts',
      'rent_tax_payable',
    ]);
    expect(failedStatementChecks(s)).toEqual([]);
  });
});
