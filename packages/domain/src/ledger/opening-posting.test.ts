import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { INCOME_ACCOUNTS } from './accounts';
import { balanceOf, checkEntry, type JournalLineDraft } from './journal';
import {
  openingAgentCashLines,
  openingAgentCashReductionLines,
  openingArrearsLines,
  openingBalanceKeys,
  openingDepositLines,
  openingDepositReductionLines,
  openingPaymentLines,
  openingPaymentReductionLines,
  openingRentTaxLines,
  openingRentTaxReductionLines,
  openingWithholdingLines,
  openingWithholdingReductionLines,
} from './opening-posting';
import { creditNoteLines, type LeaseDimensions } from './posting';

const book = 'book-owner';
const lease: LeaseDimensions = {
  propertyId: 'property-1',
  unitId: 'unit-1',
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
};
const owner = () => 'owner' as const;
const accounts = (lines: readonly JournalLineDraft[]) =>
  lines.map((l) => [l.accountCode, l.amountMinor]);

describe('P25 opening balances: one posting function per item', () => {
  it('arrears: Dr 1100 on the opening line, Cr 3900, never income', () => {
    const lines = openingArrearsLines({
      bookId: book,
      lease,
      invoiceLineId: 'line-1',
      amountMinor: 150_000,
    });
    checkEntry(lines, owner);
    expect(accounts(lines)).toEqual([
      ['1100', 150_000],
      ['3900', -150_000],
    ]);
    expect(lines.every((l) => l.invoiceLineId === 'line-1' && l.leaseId === 'lease-1')).toBe(true);
    expect(lines.some((l) => INCOME_ACCOUNTS.includes(l.accountCode))).toBe(false);
  });

  it('an opening payment: Dr 3900 on the payment, Cr 1100 for debt it pays, Cr 2010 for the rest', () => {
    const lines = openingPaymentLines({
      bookId: book,
      lease,
      paymentId: 'pay-1',
      allocations: [
        { lease, invoiceLineId: 'line-1', postingClass: 'receivable', amountMinor: 50_000 },
        { lease, invoiceLineId: 'line-2', postingClass: 'prepayment', amountMinor: 20_000 },
      ],
      surplusMinor: 30_000,
    });
    checkEntry(lines, owner);
    expect(accounts(lines)).toEqual([
      ['3900', 100_000],
      ['1100', -50_000],
      ['2010', -20_000],
      ['2010', -30_000],
    ]);
    expect(lines.every((l) => l.paymentId === 'pay-1')).toBe(true);
    // An advance alone is Dr 3900, Cr 2010.
    expect(
      accounts(
        openingPaymentLines({
          bookId: book,
          lease,
          paymentId: 'pay-1',
          allocations: [],
          surplusMinor: 30_000,
        }),
      ),
    ).toEqual([
      ['3900', 30_000],
      ['2010', -30_000],
    ]);
  });

  it('BC-11 an opening payment never pays a deposit, and is never empty', () => {
    expect(() =>
      openingPaymentLines({
        bookId: book,
        lease,
        paymentId: 'pay-1',
        allocations: [{ lease, invoiceLineId: 'd', postingClass: 'deposit', amountMinor: 1 }],
        surplusMinor: 0,
      }),
    ).toThrow(/its own opening item/);
    expect(() =>
      openingPaymentLines({
        bookId: book,
        lease,
        paymentId: 'p',
        allocations: [],
        surplusMinor: 0,
      }),
    ).toThrow(/needs an amount/);
    expect(() =>
      openingPaymentLines({
        bookId: book,
        lease,
        paymentId: 'p',
        allocations: [],
        surplusMinor: -1,
      }),
    ).toThrow(/zero or more/);
  });

  it('BC-11 a deposit held: Dr 3900, Cr 2100 on the lease and its opening line, never income', () => {
    const lines = openingDepositLines({
      bookId: book,
      lease,
      invoiceLineId: 'dep-1',
      amountMinor: 300_000,
    });
    checkEntry(lines, owner);
    expect(accounts(lines)).toEqual([
      ['3900', 300_000],
      ['2100', -300_000],
    ]);
    expect(balanceOf(lines, { accountCode: '2100', leaseId: 'lease-1', paymentId: null })).toBe(
      -300_000,
    );
  });

  it('TX-04 withholding outstanding: Dr 1150 on the lease, Cr 3900, its certificate to come', () => {
    const lines = openingWithholdingLines({ bookId: book, lease, amountMinor: 12_000 });
    checkEntry(lines, owner);
    expect(accounts(lines)).toEqual([
      ['1150', 12_000],
      ['3900', -12_000],
    ]);
  });

  it('AC-05 and TX-02 owner items: agent-held cash Dr 1070, rent tax outstanding Cr 2200', () => {
    const cash = openingAgentCashLines({ bookId: book, amountMinor: 500_000 });
    const tax = openingRentTaxLines({ bookId: book, amountMinor: 40_000 });
    for (const lines of [cash, tax]) checkEntry(lines, owner);
    expect(accounts(cash)).toEqual([
      ['1070', 500_000],
      ['3900', -500_000],
    ]);
    expect(accounts(tax)).toEqual([
      ['3900', 40_000],
      ['2200', -40_000],
    ]);
    expect([...cash, ...tax].every((l) => l.leaseId === undefined && l.propertyId === null)).toBe(
      true,
    );
  });

  it('every item is above zero', () => {
    const bad = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2];
    for (const amountMinor of bad) {
      expect(() =>
        openingArrearsLines({ bookId: book, lease, invoiceLineId: 'l', amountMinor }),
      ).toThrow();
      expect(() =>
        openingDepositLines({ bookId: book, lease, invoiceLineId: 'l', amountMinor }),
      ).toThrow();
      expect(() => openingWithholdingLines({ bookId: book, lease, amountMinor })).toThrow();
      expect(() => openingAgentCashLines({ bookId: book, amountMinor })).toThrow();
      expect(() => openingRentTaxLines({ bookId: book, amountMinor })).toThrow();
    }
  });

  it('keys are P25:<batch>:<item>', () => {
    expect(openingBalanceKeys.item('batch-1', 'item-7')).toBe('P25:batch-1:item-7');
    expect(() => openingBalanceKeys.item('', 'item')).toThrow();
    expect(() => openingBalanceKeys.item('b:1', 'item')).toThrow();
  });
});

describe('P25 adjustments: each lowering is the mirror of the item it lowers', () => {
  it('lowering undoes exactly what raising posted, and arrears lower through P27 against 3900', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), (amountMinor) => {
        const pairs: [JournalLineDraft[], JournalLineDraft[]][] = [
          [
            openingArrearsLines({ bookId: book, lease, invoiceLineId: 'l', amountMinor }),
            creditNoteLines({
              bookId: book,
              lease,
              invoiceLineId: 'l',
              chargedTo: '3900',
              unpaidMinor: amountMinor,
              released: [],
            }),
          ],
          [
            openingPaymentLines({
              bookId: book,
              lease,
              paymentId: 'p',
              allocations: [],
              surplusMinor: amountMinor,
            }),
            openingPaymentReductionLines({ bookId: book, lease, paymentId: 'p', amountMinor }),
          ],
          [
            openingDepositLines({ bookId: book, lease, invoiceLineId: 'd', amountMinor }),
            openingDepositReductionLines({ bookId: book, lease, invoiceLineId: 'd', amountMinor }),
          ],
          [
            openingWithholdingLines({ bookId: book, lease, amountMinor }),
            openingWithholdingReductionLines({ bookId: book, lease, amountMinor }),
          ],
          [
            openingAgentCashLines({ bookId: book, amountMinor }),
            openingAgentCashReductionLines({ bookId: book, amountMinor }),
          ],
          [
            openingRentTaxLines({ bookId: book, amountMinor }),
            openingRentTaxReductionLines({ bookId: book, amountMinor }),
          ],
        ];
        for (const [raise, lower] of pairs) {
          checkEntry(raise, owner);
          checkEntry(lower, owner);
          const both = [...raise, ...lower];
          for (const code of new Set(both.map((l) => l.accountCode)))
            for (const dims of [{}, { leaseId: 'lease-1' }, { paymentId: 'p' }])
              expect(balanceOf(both, { accountCode: code, ...dims })).toBe(0);
        }
      }),
    );
  });
});
