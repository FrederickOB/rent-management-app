import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ageBucket } from '../billing/walk';
import type { AccountCode } from '../ledger/accounts';
import { feeOnBaseMinor, managementFeeLines } from '../ledger/fees';
import { balanceOf, type JournalLineDraft } from '../ledger/journal';
import { ownerFundingLines, remittanceLines } from '../ledger/owner-posting';
import { accountingDateFor, monthOf } from '../ledger/periods';
import { accrualLines, receiptLines, type LeaseDimensions } from '../ledger/posting';
import { settlementLines } from '../ledger/settlement-posting';
import { graPaymentLines, rentTaxLines } from '../ledger/tax-posting';
import { money, multiplyBps } from '../money/money';
import type { CollectionMethod } from './gate1';
import { reportMonth } from './measures';
import {
  assertStatementChecks,
  diffStatementFigures,
  failedStatementChecks,
  flattenStatementFigures,
  ownerStatementFigures,
  type AgentCashIn,
  type AgentCashOut,
  type OwnerStatementInput,
  type StatementPropertyInput,
} from './statement';

const legon: StatementPropertyInput = {
  propertyId: 'acc-leg',
  collections: [
    { method: 'momo', amountMinor: 300_000 },
    { method: 'cash', amountMinor: 150_000 },
    { method: 'momo', amountMinor: 150_000 },
  ],
  expenses: [
    { category: 'repairs', amountMinor: 20_000 },
    { category: 'cleaning', amountMinor: 5_000 },
    { category: 'repairs', amountMinor: 7_500 },
  ],
  feesMinor: 60_000,
  rentTax: { accruedMinor: 48_000, paidMinor: 36_000, receiptItemsMinor: [24_000, 12_000, 12_000] },
  rentEarnedMinor: 600_000,
  serviceChargeEarnedMinor: 0,
  unearnedRentMinor: 1_650_000,
  depositsHeldMinor: 900_000,
  arrears: [
    { bucket: '31_60', amountMinor: 150_000 },
    { bucket: '90_plus', amountMinor: 300_000 },
  ],
  occupancy: { occupied: 9, vacant: 1, under_repair: 1, not_lettable: 1 },
};

const osu: StatementPropertyInput = {
  propertyId: 'acc-osu',
  collections: [{ method: 'bank_transfer', amountMinor: 1_000_000 }],
  expenses: [],
  feesMinor: 100_000,
  rentTax: { accruedMinor: 150_000, paidMinor: 0, receiptItemsMinor: [150_000] },
  rentEarnedMinor: 1_000_000,
  serviceChargeEarnedMinor: 100_000,
  unearnedRentMinor: 0,
  depositsHeldMinor: 2_000_000,
  arrears: [{ bucket: '0_30', amountMinor: 100_000 }],
  occupancy: { occupied: 4, vacant: 1 },
};

const agency: OwnerStatementInput = {
  ownerId: 'owner-ama',
  month: '2026-11',
  properties: [osu, legon],
  processingFeesMinor: 4_500,
  agent: {
    cash: {
      openingMinor: 500_000,
      in: [
        { kind: 'collections', amountMinor: 1_445_500 },
        { kind: 'owner_funding', amountMinor: 50_000 },
      ],
      out: [
        { kind: 'expenses_paid', amountMinor: 32_500 },
        { kind: 'rent_tax_paid', amountMinor: 36_000 },
        { kind: 'fees_taken', amountMinor: 40_000 },
        { kind: 'remittances', amountMinor: 460_000 },
      ],
      closingMinor: 1_427_000,
    },
    feesDue: { openingMinor: 40_000, closingMinor: 160_000 },
  },
};

describe('AC-04 owner statement figures', () => {
  it('has a page per property, in property order, and a summary that adds them up', () => {
    const s = ownerStatementFigures(agency);
    expect(s.firstDay).toBe('2026-11-01');
    expect(s.lastDay).toBe('2026-11-30');
    expect(s.properties.map((p) => p.propertyId)).toEqual(['acc-leg', 'acc-osu']);
    const leg = s.properties[0];
    expect(leg?.cash.collectionsByMethod).toEqual({
      momo: 450_000,
      card: 0,
      bank_transfer: 0,
      cash: 150_000,
      cheque: 0,
      test: 0,
    });
    expect(leg?.cash.collectionsMinor).toBe(600_000);
    expect(leg?.cash.expensesByCategory).toEqual([
      { category: 'cleaning', amountMinor: 5_000 },
      { category: 'repairs', amountMinor: 27_500 },
    ]);
    expect(leg?.accrual.arrearsByBucket).toEqual({
      '0_30': 0,
      '31_60': 150_000,
      '61_90': 0,
      '90_plus': 300_000,
    });
    expect(leg?.accrual.arrearsMinor).toBe(450_000);
    expect(leg?.occupancy.rate.bps).toBe(8_182);
    expect(s.summary.propertyId).toBeNull();
    expect(s.summary.cash.collectionsMinor).toBe(1_600_000);
    expect(s.summary.cash.feesMinor).toBe(160_000);
    expect(s.summary.cash.rentTaxAccruedMinor).toBe(198_000);
    expect(s.summary.accrual.earnedMinor).toBe(1_700_000);
    expect(s.summary.accrual.depositsHeldMinor).toBe(2_900_000);
    expect(s.summary.accrual.arrearsByBucket['0_30']).toBe(100_000);
    expect(s.summary.occupancy).toMatchObject({ units: 17, lettable: 16, occupied: 13, vacant: 3 });
    expect(s.processingFeesMinor).toBe(4_500);
  });

  it('shows the agent’s side: cash held, fees due, the net remittable and remittances made', () => {
    const agent = ownerStatementFigures(agency).agent;
    expect(agent).toMatchObject({
      openingMinor: 500_000,
      inMinor: 1_495_500,
      outMinor: 568_500,
      closingMinor: 1_427_000,
      feesDueOpeningMinor: 40_000,
      feesChargedMinor: 160_000,
      feesTakenMinor: 40_000,
      feesDueClosingMinor: 160_000,
      netRemittableMinor: 1_267_000,
      remittancesMadeMinor: 460_000,
    });
    expect(agent?.out.vat_paid).toBe(0);
  });

  it('passes its identities: agent cash, fees due, and rent tax per receipt', () => {
    const s = ownerStatementFigures(agency);
    expect(s.checks.map((c) => [c.name, c.scope, c.passed])).toEqual([
      ['agent_cash', 'owner', true],
      ['fees_due', 'owner', true],
      ['rent_tax_receipts', 'acc-leg', true],
      ['rent_tax_receipts', 'acc-osu', true],
      ['rent_tax_receipts', 'owner', true],
    ]);
    expect(failedStatementChecks(s)).toEqual([]);
    expect(() => assertStatementChecks(s)).not.toThrow();
  });

  it('fails the agent-cash identity when a movement is missing', () => {
    const missing: OwnerStatementInput = {
      ...agency,
      agent: {
        ...(agency.agent as NonNullable<OwnerStatementInput['agent']>),
        cash: {
          ...(agency.agent as NonNullable<OwnerStatementInput['agent']>).cash,
          in: [{ kind: 'collections', amountMinor: 1_445_500 }],
        },
      },
    };
    const s = ownerStatementFigures(missing);
    expect(failedStatementChecks(s)).toEqual([
      {
        name: 'agent_cash',
        scope: 'owner',
        expectedMinor: 1_377_000,
        actualMinor: 1_427_000,
        passed: false,
      },
    ]);
    expect(() => assertStatementChecks(s)).toThrow(
      /agent_cash \(owner\): expected 1377000, found 1427000/,
    );
  });

  it('fails the fees-due identity when fees are charged that 2300 does not hold', () => {
    const s = ownerStatementFigures({
      ...agency,
      properties: [{ ...osu, feesMinor: 100_001 }, legon],
    });
    expect(failedStatementChecks(s).map((c) => c.name)).toEqual(['fees_due']);
  });

  it('★ the rent tax on the statement equals the sum of the tax on each receipt in the month', () => {
    const s = ownerStatementFigures({
      ...agency,
      properties: [
        { ...legon, rentTax: { ...legon.rentTax, receiptItemsMinor: [24_000, 12_000] } },
        osu,
      ],
    });
    expect(failedStatementChecks(s)).toEqual([
      {
        name: 'rent_tax_receipts',
        scope: 'acc-leg',
        expectedMinor: 36_000,
        actualMinor: 48_000,
        passed: false,
      },
      {
        name: 'rent_tax_receipts',
        scope: 'owner',
        expectedMinor: 186_000,
        actualMinor: 198_000,
        passed: false,
      },
    ]);
  });

  it('has no agent side for a self-managing landlord, and checks only what it is given', () => {
    const s = ownerStatementFigures({
      ownerId: 'owner-kojo',
      month: '2026-11',
      agent: null,
      properties: [{ ...osu, rentTax: { accruedMinor: 150_000, paidMinor: 0 } }],
    });
    expect(s.agent).toBeNull();
    expect(s.checks).toEqual([]);
    expect(s.processingFeesMinor).toBe(0);
  });

  it('allows a month’s flows below zero, but no negative balance, bucket or count', () => {
    const reversed = ownerStatementFigures({
      ...agency,
      agent: null,
      properties: [
        { ...osu, collections: [{ method: 'cheque', amountMinor: -50_000 }], feesMinor: -5_000 },
      ],
    });
    expect(reversed.summary.cash.collectionsMinor).toBe(-50_000);
    expect(() =>
      ownerStatementFigures({ ...agency, properties: [{ ...osu, depositsHeldMinor: -1 }] }),
    ).toThrow(/Deposits held cannot be below zero/);
    expect(() =>
      ownerStatementFigures({
        ...agency,
        properties: [{ ...osu, arrears: [{ bucket: '0_30', amountMinor: -1 }] }],
      }),
    ).toThrow(/below zero/);
    expect(() =>
      ownerStatementFigures({
        ...agency,
        properties: [{ ...osu, arrears: [{ bucket: '120_plus' as '90_plus', amountMinor: 1 }] }],
      }),
    ).toThrow(/no line 120_plus/);
    expect(() => ownerStatementFigures({ ...agency, properties: [osu, osu] })).toThrow(
      /listed twice/,
    );
    expect(() => ownerStatementFigures({ ...agency, month: '2026-11-01' })).toThrow(/Not a month/);
  });
});

describe('AC-04 a regenerated statement gives the same figures', () => {
  it('gives an identical statement for the same figures in any order', () => {
    const shuffled = <T>(items: readonly T[]) =>
      fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
    fc.assert(
      fc.property(
        shuffled(agency.properties),
        shuffled(legon.collections),
        shuffled(legon.expenses),
        shuffled(legon.arrears),
        shuffled((agency.agent as NonNullable<OwnerStatementInput['agent']>).cash.out),
        (properties, collections, expenses, arrears, out) => {
          const again = ownerStatementFigures({
            ...agency,
            properties: properties.map((p) =>
              p.propertyId === legon.propertyId ? { ...legon, collections, expenses, arrears } : p,
            ),
            agent: {
              ...(agency.agent as NonNullable<OwnerStatementInput['agent']>),
              cash: { ...(agency.agent as NonNullable<OwnerStatementInput['agent']>).cash, out },
            },
          });
          expect(again).toEqual(ownerStatementFigures(agency));
          expect(
            diffStatementFigures(
              flattenStatementFigures(ownerStatementFigures(agency)),
              flattenStatementFigures(again),
            ),
          ).toEqual([]);
        },
      ),
    );
  });

  it('stores every figure under a stable key, in a fixed order', () => {
    const rows = flattenStatementFigures(ownerStatementFigures(agency));
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 7)).toEqual([
      'property.acc-leg.cash.collections.momo',
      'property.acc-leg.cash.collections.card',
      'property.acc-leg.cash.collections.bank_transfer',
      'property.acc-leg.cash.collections.cash',
      'property.acc-leg.cash.collections.cheque',
      'property.acc-leg.cash.collections.test',
      'property.acc-leg.cash.collections',
    ]);
    expect(rows).toContainEqual({ key: 'property.acc-leg.cash.expenses.repairs', value: 27_500 });
    expect(rows).toContainEqual({ key: 'summary.accrual.arrears.90_plus', value: 300_000 });
    expect(rows).toContainEqual({ key: 'agent.net_remittable', value: 1_267_000 });
    expect(rows.at(-1)).toEqual({ key: 'agent.remittances_made', value: 460_000 });
  });

  it('names each figure that changed, appeared or disappeared', () => {
    const issued = flattenStatementFigures(ownerStatementFigures(agency));
    const changed = flattenStatementFigures(
      ownerStatementFigures({
        ...agency,
        properties: [
          { ...osu, expenses: [{ category: 'insurance', amountMinor: 9_000 }] },
          { ...legon, expenses: [{ category: 'repairs', amountMinor: 27_500 }] },
        ],
      }),
    );
    expect(diffStatementFigures(issued, changed)).toEqual(
      expect.arrayContaining([
        { key: 'property.acc-leg.cash.expenses.cleaning', issued: 5_000, regenerated: null },
        { key: 'property.acc-osu.cash.expenses.insurance', issued: null, regenerated: 9_000 },
        { key: 'summary.cash.expenses', issued: 32_500, regenerated: 36_500 },
      ]),
    );
    expect(() => diffStatementFigures([...issued, issued[0] as never], issued)).toThrow(/twice/);
  });
});

// A month of postings in the owner's book, as the ledger holds them, and the statement inputs a
// server reads from them by accounting date.

describe('AC-04 statement figures from the ledger, across a period lock', () => {
  const OWNER = 'book-owner';
  const leg: LeaseDimensions = {
    propertyId: 'acc-leg',
    unitId: 'leg-b1-01',
    leaseId: 'l-leg',
    tenantId: 't-1',
  };
  const osuLease: LeaseDimensions = {
    propertyId: 'acc-osu',
    unitId: 'osu-g-01',
    leaseId: 'l-osu',
    tenantId: 't-2',
  };

  type Cash = AgentCashIn | AgentCashOut;
  interface Posted {
    readonly valueDate: string;
    readonly accountingDate: string;
    readonly rule: 'P02' | 'P03' | 'P14' | 'P15' | 'P16' | 'P17' | 'P18' | 'P22' | 'P28' | 'P30';
    readonly lines: readonly JournalLineDraft[];
    /** How its 1070 line counts on the agent's side. */
    readonly cash?: Cash;
    readonly payment?: {
      readonly propertyId: string;
      readonly method: CollectionMethod;
      readonly amountMinor: number;
    };
    readonly category?: string;
  }

  const ledger: Posted[] = [];
  const locked = new Set<string>();
  const dueDates = new Map<string, string>();
  const post = (valueDate: string, entry: Omit<Posted, 'valueDate' | 'accountingDate'>) =>
    ledger.push({ ...entry, valueDate, accountingDate: accountingDateFor(valueDate, locked) });

  const rentFor = (lease: LeaseDimensions, line: string, start: string, amount: number) => {
    dueDates.set(line, start);
    post(start, {
      rule: 'P02',
      lines: accrualLines({
        bookId: OWNER,
        lease,
        invoiceLineId: line,
        chargeType: 'rent',
        amountMinor: amount,
        advance: [],
        draws: [],
      }),
    });
  };
  const providerReceipt = (
    lease: LeaseDimensions,
    paymentId: string,
    line: string,
    date: string,
    amount: number,
    taxRateBps: number,
  ) => {
    const payment = { propertyId: lease.propertyId, method: 'momo' as const, amountMinor: amount };
    post(date, {
      rule: 'P03',
      payment,
      lines: receiptLines({
        cash: { bookId: OWNER, account: '1050', provider: 'paystack' },
        bookId: OWNER,
        paymentId,
        lease,
        allocations: [
          { lease, invoiceLineId: line, postingClass: 'receivable', amountMinor: amount },
        ],
        surplusMinor: 0,
      }),
    });
    post(date, {
      rule: 'P17',
      lines: rentTaxLines({
        bookId: OWNER,
        lease,
        paymentId,
        lines: [
          { invoiceLineId: line, taxMinor: multiplyBps(money(amount), taxRateBps).amountMinor },
        ],
      }),
    });
    post(date, {
      rule: 'P14',
      lines: managementFeeLines({
        bookId: OWNER,
        dims: { ...lease, paymentId },
        amountMinor: feeOnBaseMinor(amount, 1_000),
      }),
    });
  };
  const settle = (date: string, paymentId: string, gross: number, fee: number) =>
    post(date, {
      rule: 'P22',
      cash: 'collections',
      lines: settlementLines({
        bookId: OWNER,
        to: '1070',
        provider: 'paystack',
        settlementId: `set-${paymentId}`,
        settlementAccountId: null,
        payments: [{ paymentId, amountMinor: gross }],
        feesMinor: fee,
        deductionsMinor: 0,
        netMinor: gross - fee,
      }),
    });

  const sum = (entries: readonly Posted[], filter: Parameters<typeof balanceOf>[1]) =>
    balanceOf(
      entries.flatMap((e) => e.lines),
      filter,
    );

  /** What the server's queries return for one month, every one selected by accounting date. */
  function inputFor(month: string): OwnerStatementInput {
    const { firstDay, lastDay } = reportMonth(month);
    const inMonth = ledger.filter((e) => monthOf(e.accountingDate) === month);
    const toEnd = ledger.filter((e) => e.accountingDate <= lastDay);
    const before = ledger.filter((e) => e.accountingDate < firstDay);
    const by = (code: AccountCode, propertyId: string, entries = inMonth) =>
      sum(entries, { accountCode: code, propertyId });
    const properties = ['acc-leg', 'acc-osu'].map((propertyId): StatementPropertyInput => {
      const receivable = toEnd
        .flatMap((e) => e.lines)
        .filter((l) => l.accountCode === '1100' && l.propertyId === propertyId);
      const open = new Map<string, number>();
      for (const l of receivable)
        open.set(
          l.invoiceLineId as string,
          (open.get(l.invoiceLineId as string) ?? 0) + l.amountMinor,
        );
      return {
        propertyId,
        collections: inMonth.flatMap((e) =>
          e.payment?.propertyId === propertyId ? [e.payment] : [],
        ),
        expenses: inMonth
          .filter((e) => e.rule === 'P15')
          .flatMap((e) =>
            e.lines
              .filter((l) => l.accountCode === '5000' && l.propertyId === propertyId)
              .map((l) => ({ category: e.category as string, amountMinor: l.amountMinor })),
          ),
        feesMinor: by('5100', propertyId),
        rentTax: {
          accruedMinor: by('5300', propertyId),
          paidMinor: sum(
            inMonth.filter((e) => e.rule === 'P18'),
            { accountCode: '2200', propertyId },
          ),
          receiptItemsMinor: inMonth
            .filter((e) => e.rule === 'P17')
            .map((e) => balanceOf(e.lines, { accountCode: '5300', propertyId }))
            .filter((t) => t !== 0),
        },
        rentEarnedMinor: -by('4000', propertyId),
        serviceChargeEarnedMinor: -by('4100', propertyId),
        unearnedRentMinor: -by('2010', propertyId, toEnd),
        depositsHeldMinor: -by('2100', propertyId, toEnd),
        arrears: [...open].flatMap(([line, amountMinor]) => {
          const bucket = ageBucket(dueDates.get(line) as string, lastDay);
          return amountMinor > 0 && bucket ? [{ bucket, amountMinor }] : [];
        }),
        occupancy: { occupied: 1 },
      };
    });
    const cashIn: { kind: AgentCashIn; amountMinor: number }[] = [];
    const cashOut: { kind: AgentCashOut; amountMinor: number }[] = [];
    for (const e of inMonth) {
      if (e.rule === 'P16') {
        cashOut.push({
          kind: 'fees_taken',
          amountMinor: balanceOf(e.lines, { accountCode: '2300' }),
        });
        cashOut.push({
          kind: 'remittances',
          amountMinor: balanceOf(e.lines, { accountCode: '1010' }),
        });
        continue;
      }
      const moved = balanceOf(e.lines, { accountCode: '1070' });
      if (moved > 0) cashIn.push({ kind: e.cash as AgentCashIn, amountMinor: moved });
      if (moved < 0) cashOut.push({ kind: e.cash as AgentCashOut, amountMinor: -moved });
    }
    return {
      ownerId: 'owner-ama',
      month,
      properties,
      processingFeesMinor: sum(inMonth, { accountCode: '5200' }),
      agent: {
        cash: {
          openingMinor: sum(before, { accountCode: '1070' }),
          closingMinor: sum(toEnd, { accountCode: '1070' }),
          in: cashIn,
          out: cashOut,
        },
        feesDue: {
          openingMinor: -sum(before, { accountCode: '2300' }),
          closingMinor: -sum(toEnd, { accountCode: '2300' }),
        },
      },
    };
  }

  // October: rent at Legon paid by MoMo and settled to the agency; a deposit at Osu by transfer.
  rentFor(leg, 'leg-oct', '2026-10-01', 150_000);
  rentFor(osuLease, 'osu-oct', '2026-10-01', 1_000_000);
  providerReceipt(leg, 'pay-1', 'leg-oct', '2026-10-03', 150_000, 800);
  settle('2026-10-04', 'pay-1', 150_000, 1_500);
  post('2026-10-05', {
    rule: 'P28',
    cash: 'collections',
    payment: { propertyId: 'acc-osu', method: 'bank_transfer', amountMinor: 2_000_000 },
    lines: [
      {
        bookId: OWNER,
        ...osuLease,
        accountCode: '1070',
        amountMinor: 2_000_000,
        paymentId: 'pay-dep',
      },
      {
        bookId: OWNER,
        ...osuLease,
        accountCode: '2100',
        amountMinor: -2_000_000,
        paymentId: 'pay-dep',
        invoiceLineId: 'osu-dep',
      },
    ],
  });
  const october = ownerStatementFigures(inputFor('2026-10'));
  const issuedOctober = flattenStatementFigures(october);
  locked.add('2026-10'); // the October statement is issued

  // November, and a transfer for October's Osu rent found late: its value date is in October.
  rentFor(leg, 'leg-nov', '2026-11-01', 150_000);
  rentFor(osuLease, 'osu-nov', '2026-11-01', 1_000_000);
  providerReceipt(leg, 'pay-2', 'leg-nov', '2026-11-02', 150_000, 800);
  settle('2026-11-03', 'pay-2', 150_000, 1_500);
  post('2026-10-20', {
    rule: 'P28',
    cash: 'collections',
    payment: { propertyId: 'acc-osu', method: 'bank_transfer', amountMinor: 1_000_000 },
    lines: receiptLines({
      cash: { bookId: OWNER, account: '1070' },
      bookId: OWNER,
      paymentId: 'pay-late',
      lease: osuLease,
      allocations: [
        {
          lease: osuLease,
          invoiceLineId: 'osu-oct',
          postingClass: 'receivable',
          amountMinor: 1_000_000,
        },
      ],
      surplusMinor: 0,
    }),
  });
  post('2026-10-20', {
    rule: 'P17',
    lines: rentTaxLines({
      bookId: OWNER,
      lease: osuLease,
      paymentId: 'pay-late',
      lines: [{ invoiceLineId: 'osu-oct', taxMinor: 150_000 }],
    }),
  });
  post('2026-10-20', {
    rule: 'P14',
    lines: managementFeeLines({
      bookId: OWNER,
      dims: { ...osuLease, paymentId: 'pay-late' },
      amountMinor: 100_000,
    }),
  });
  post('2026-11-10', {
    rule: 'P15',
    cash: 'expenses_paid',
    category: 'repairs',
    lines: [
      {
        bookId: OWNER,
        propertyId: 'acc-leg',
        unitId: leg.unitId,
        accountCode: '5000',
        amountMinor: 20_000,
      },
      { bookId: OWNER, propertyId: 'acc-leg', accountCode: '1070', amountMinor: -20_000 },
    ],
  });
  post('2026-11-15', {
    rule: 'P30',
    cash: 'owner_funding',
    lines: ownerFundingLines({ bookId: OWNER, amountMinor: 50_000 }),
  });
  post('2026-11-20', {
    rule: 'P18',
    cash: 'rent_tax_paid',
    lines: graPaymentLines({
      bookId: OWNER,
      from: '1070',
      items: [{ paymentId: 'pay-1', amountMinor: 12_000, lease: leg }],
      propertyId: 'acc-leg',
    }),
  });
  post('2026-11-28', {
    rule: 'P16',
    lines: remittanceLines({
      bookId: OWNER,
      totalMinor: 1_000_000,
      netMinor: 985_000,
      feesRetainedMinor: 15_000,
    }),
  });

  it('every posting lands in an open month, the late transfer on 1 November', () => {
    expect(ledger.filter((e) => e.valueDate === '2026-10-20').map((e) => e.accountingDate)).toEqual(
      ['2026-11-01', '2026-11-01', '2026-11-01'],
    );
  });

  it('passes every identity in both months', () => {
    expect(failedStatementChecks(october)).toEqual([]);
    const november = ownerStatementFigures(inputFor('2026-11'));
    expect(failedStatementChecks(november)).toEqual([]);
    expect(november.checks.length).toBe(5);
  });

  it('★ regenerates the locked month identically after the late correction', () => {
    const regenerated = flattenStatementFigures(ownerStatementFigures(inputFor('2026-10')));
    expect(diffStatementFigures(issuedOctober, regenerated)).toEqual([]);
    // Had October been read by value date, the late transfer would have changed it.
    expect(october.summary.accrual.arrearsMinor).toBe(1_000_000);
  });

  it('shows the late transfer, its tax and its fee in November', () => {
    const november = ownerStatementFigures(inputFor('2026-11'));
    const osuPage = november.properties.find((p) => p.propertyId === 'acc-osu');
    expect(osuPage?.cash.collectionsByMethod.bank_transfer).toBe(1_000_000);
    expect(osuPage?.cash.rentTaxAccruedMinor).toBe(150_000);
    expect(osuPage?.cash.feesMinor).toBe(100_000);
    expect(november.agent).toMatchObject({
      openingMinor: 2_148_500,
      closingMinor: 2_148_500 + 148_500 + 1_000_000 + 50_000 - 20_000 - 12_000 - 1_000_000,
      feesDueOpeningMinor: 15_000,
      feesDueClosingMinor: 15_000 + 15_000 + 100_000 - 15_000,
      remittancesMadeMinor: 985_000,
    });
    expect(november.agent?.netRemittableMinor).toBe((november.agent?.closingMinor ?? 0) - 115_000);
    expect(november.processingFeesMinor).toBe(1_500);
  });
});
