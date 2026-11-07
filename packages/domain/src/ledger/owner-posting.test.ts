import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BookKind } from './accounts';
import { managementFeeLines } from './fees';
import { balanceOf, checkEntry, type JournalLineDraft } from './journal';
import {
  feesTakenLines,
  ownerFundingLines,
  ownerPostingKeys,
  remittanceLines,
  remittanceProblems,
  suggestRemittance,
} from './owner-posting';
import { accrualLines, receiptLines, type LeaseDimensions } from './posting';
import { settlementLines } from './settlement-posting';
import { certificateLines, rentTaxLines, withholdingLines } from './tax-posting';

const OWNER = 'book-owner';
const kindOf = (): BookKind => 'owner';
const office: LeaseDimensions = {
  propertyId: 'osu',
  unitId: 'osu-1f-01',
  leaseId: 'lease-office',
  tenantId: 'tenant-company',
};

describe('AC-05 owner remittance (P16)', () => {
  it('pays the net to the owner and keeps the fees, out of the agent’s client account', () => {
    const lines = remittanceLines({
      bookId: OWNER,
      totalMinor: 833_000,
      netMinor: 733_000,
      feesRetainedMinor: 100_000,
    });
    checkEntry(lines, kindOf);
    expect(lines).toEqual([
      { bookId: OWNER, propertyId: null, accountCode: '1010', amountMinor: 733_000 },
      { bookId: OWNER, propertyId: null, accountCode: '2300', amountMinor: 100_000 },
      { bookId: OWNER, propertyId: null, accountCode: '1070', amountMinor: -833_000 },
    ]);
  });

  it('may retain no fees', () => {
    const lines = remittanceLines({
      bookId: OWNER,
      totalMinor: 50_000,
      netMinor: 50_000,
      feesRetainedMinor: 0,
    });
    checkEntry(lines, kindOf);
    expect(lines.map((l) => l.accountCode)).toEqual(['1010', '1070']);
  });

  it('refuses a net and fees that do not make the total, a negative amount, or nothing paid', () => {
    expect(() =>
      remittanceLines({ bookId: OWNER, totalMinor: 100, netMinor: 70, feesRetainedMinor: 20 }),
    ).toThrow(/must equal the total/);
    expect(() =>
      remittanceLines({ bookId: OWNER, totalMinor: 100, netMinor: 120, feesRetainedMinor: -20 }),
    ).toThrow(/zero or more/);
    expect(() =>
      remittanceLines({ bookId: OWNER, totalMinor: -100, netMinor: -100, feesRetainedMinor: 0 }),
    ).toThrow(/zero or more/);
    expect(() =>
      remittanceLines({ bookId: OWNER, totalMinor: 100, netMinor: 0, feesRetainedMinor: 100 }),
    ).toThrow(/fees taken on their own/);
    expect(() =>
      remittanceLines({ bookId: OWNER, totalMinor: 10.5, netMinor: 10.5, feesRetainedMinor: 0 }),
    ).toThrow(/zero or more/);
  });

  it('balances for any net and fees, and moves exactly the total out of 1070', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (net, fees) => {
          const lines = remittanceLines({
            bookId: OWNER,
            totalMinor: net + fees,
            netMinor: net,
            feesRetainedMinor: fees,
          });
          checkEntry(lines, kindOf);
          expect(balanceOf(lines, { accountCode: '1070' })).toBe(-(net + fees));
          expect(balanceOf(lines, { accountCode: '1010' })).toBe(net);
          expect(balanceOf(lines, { accountCode: '2300' })).toBe(fees);
          for (const line of lines)
            expect(line.accountCode === '1070' ? line.amountMinor < 0 : line.amountMinor > 0).toBe(
              true,
            );
        },
      ),
    );
  });

  it('worked example B ends with 1070 and 2300 back at zero', () => {
    const F = 17_000;
    const entries: JournalLineDraft[][] = [
      // 1 Nov: November's rent is charged.
      accrualLines({
        bookId: OWNER,
        lease: office,
        invoiceLineId: 'nov',
        chargeType: 'rent',
        amountMinor: 1_000_000,
        advance: [],
        draws: [],
      }),
      // 5 Nov: GH₵8,500 by the provider and GH₵1,500 withheld settle November's GH₵10,000.
      receiptLines({
        cash: { bookId: OWNER, account: '1050', provider: 'paystack' },
        bookId: OWNER,
        paymentId: 'pay-1',
        lease: office,
        allocations: [
          { lease: office, invoiceLineId: 'nov', postingClass: 'receivable', amountMinor: 850_000 },
        ],
        surplusMinor: 0,
      }),
      withholdingLines({
        bookId: OWNER,
        lease: office,
        paymentId: 'pay-1',
        lines: [{ invoiceLineId: 'nov', amountMinor: 150_000 }],
      }),
      rentTaxLines({
        bookId: OWNER,
        lease: office,
        paymentId: 'pay-1',
        lines: [{ invoiceLineId: 'nov', taxMinor: 150_000 }],
      }),
      managementFeeLines({
        bookId: OWNER,
        dims: { ...office, paymentId: 'pay-1' },
        amountMinor: 100_000,
      }),
      // 6 Nov: settled to the agency's client account, less the provider's fee.
      settlementLines({
        bookId: OWNER,
        to: '1070',
        provider: 'paystack',
        settlementId: 'set-1',
        settlementAccountId: null,
        payments: [{ paymentId: 'pay-1', amountMinor: 850_000 }],
        feesMinor: F,
        deductionsMinor: 0,
        netMinor: 850_000 - F,
      }),
      certificateLines({
        bookId: OWNER,
        lease: office,
        paymentId: 'pay-1',
        debit: '2200',
        amountMinor: 150_000,
      }),
      // 30 Nov: the agent remits GH₵7,500 − F and keeps its GH₵1,000.
      remittanceLines({
        bookId: OWNER,
        totalMinor: 850_000 - F,
        netMinor: 750_000 - F,
        feesRetainedMinor: 100_000,
      }),
    ];
    for (const entry of entries) checkEntry(entry, kindOf);
    const all = entries.flat();
    for (const code of ['1050', '1070', '1100', '1150', '2200', '2300'] as const)
      expect(balanceOf(all, { accountCode: code })).toBe(0);
    expect(balanceOf(all, { accountCode: '1010' })).toBe(750_000 - F);
    expect(balanceOf(all, { accountCode: '5100' })).toBe(100_000);
  });
});

describe('AC-05 fees taken and owner funding (P16, P30)', () => {
  it('takes fees without a remittance: Dr 2300, Cr 1070', () => {
    const lines = feesTakenLines({ bookId: OWNER, amountMinor: 25_000 });
    checkEntry(lines, kindOf);
    expect(balanceOf(lines, { accountCode: '2300' })).toBe(25_000);
    expect(balanceOf(lines, { accountCode: '1070' })).toBe(-25_000);
    expect(() => feesTakenLines({ bookId: OWNER, amountMinor: 0 })).toThrow(/above zero/);
  });

  it('records the owner funding the agent: Dr 1070, Cr 1010', () => {
    const lines = ownerFundingLines({ bookId: OWNER, amountMinor: 200_000, propertyId: 'leg' });
    checkEntry(lines, kindOf);
    expect(lines).toEqual([
      { bookId: OWNER, propertyId: 'leg', accountCode: '1070', amountMinor: 200_000 },
      { bookId: OWNER, propertyId: 'leg', accountCode: '1010', amountMinor: -200_000 },
    ]);
    expect(() => ownerFundingLines({ bookId: OWNER, amountMinor: -1 })).toThrow(/zero or more/);
    expect(() => ownerFundingLines({ bookId: OWNER, amountMinor: 0 })).toThrow(/above zero/);
  });

  it('keys each record by its rule', () => {
    expect(ownerPostingKeys.remittance('r-1')).toBe('P16:r-1');
    expect(ownerPostingKeys.feesTaken('f-1')).toBe('P16:f-1');
    expect(ownerPostingKeys.ownerFunding('o-1')).toBe('P30:o-1');
  });
});

describe('AC-05 the remittance against the ledger', () => {
  it('flags fees retained beyond those due, and a total beyond the cash held', () => {
    const balances = { agentHeldMinor: 500_000, feesDueMinor: 40_000 };
    expect(
      remittanceProblems({ ...balances, totalMinor: 500_000, feesRetainedMinor: 40_000 }),
    ).toEqual([]);
    expect(
      remittanceProblems({ ...balances, totalMinor: 500_001, feesRetainedMinor: 40_001 }),
    ).toEqual(['fees_over_due', 'over_agent_cash']);
    expect(
      remittanceProblems({
        agentHeldMinor: -10,
        feesDueMinor: -5,
        totalMinor: 1,
        feesRetainedMinor: 1,
      }),
    ).toEqual(['fees_over_due', 'over_agent_cash']);
  });

  it('suggests remitting what the agent holds, retaining the fees due', () => {
    expect(suggestRemittance({ agentHeldMinor: 833_000, feesDueMinor: 100_000 })).toEqual({
      totalMinor: 833_000,
      feesRetainedMinor: 100_000,
      netMinor: 733_000,
    });
    expect(
      suggestRemittance({ agentHeldMinor: 833_000, feesDueMinor: 100_000, reserveMinor: 150_000 }),
    ).toEqual({ totalMinor: 683_000, feesRetainedMinor: 100_000, netMinor: 583_000 });
  });

  it('never suggests a negative amount', () => {
    expect(suggestRemittance({ agentHeldMinor: 60_000, feesDueMinor: 100_000 })).toEqual({
      totalMinor: 60_000,
      feesRetainedMinor: 60_000,
      netMinor: 0,
    });
    expect(suggestRemittance({ agentHeldMinor: -5_000, feesDueMinor: 100_000 })).toEqual({
      totalMinor: 0,
      feesRetainedMinor: 0,
      netMinor: 0,
    });
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (held, due, reserve) => {
          const s = suggestRemittance({
            agentHeldMinor: held,
            feesDueMinor: due,
            reserveMinor: reserve,
          });
          expect(s.netMinor >= 0 && s.feesRetainedMinor >= 0).toBe(true);
          expect(s.netMinor + s.feesRetainedMinor).toBe(s.totalMinor);
          expect(s.totalMinor <= Math.max(0, held)).toBe(true);
          expect(s.feesRetainedMinor <= Math.max(0, due)).toBe(true);
        },
      ),
    );
  });
});
