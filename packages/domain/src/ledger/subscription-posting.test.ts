import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, accountAllowedIn, BOOK_KINDS, type BookKind } from './accounts';
import { balanceOf, checkEntry, type JournalLineDraft } from './journal';
import { settlementLines } from './settlement-posting';
import {
  allocateSubscriptionPayment,
  prepaidDrawLines,
  subscriptionInvoiceLines,
  subscriptionPaymentLines,
  subscriptionPaymentReversalLines,
  subscriptionPostingKeys,
} from './subscription-posting';

declare global {
  interface ImportMeta {
    /** Vite's static glob import (vitest runs on Vite); only the form this file uses. */
    glob(
      patterns: string[],
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const PLATFORM = 'book-platform';
const platformBook = (): BookKind => 'platform';
const balanced = (lines: readonly JournalLineDraft[]) => checkEntry(lines, platformBook);
const total = (lines: readonly JournalLineDraft[]) => lines.reduce((t, l) => t + l.amountMinor, 0);

describe('P26 subscription invoice', () => {
  it('debits receivables and credits subscription revenue, keyed by the invoice', () => {
    const lines = subscriptionInvoiceLines({
      bookId: PLATFORM,
      invoiceId: 'inv-1',
      netMinor: 18_000,
      vatMinor: 0,
    });
    expect(lines).toEqual([
      { bookId: PLATFORM, invoiceLineId: 'inv-1', accountCode: '1100', amountMinor: 18_000 },
      { bookId: PLATFORM, invoiceLineId: 'inv-1', accountCode: '4600', amountMinor: -18_000 },
    ]);
    balanced(lines);
    expect(subscriptionPostingKeys.invoice('inv-1')).toBe('P26:inv-1');
  });

  it('credits VAT and levies payable (2210) in the platform book when charged', () => {
    const lines = subscriptionInvoiceLines({
      bookId: PLATFORM,
      invoiceId: 'inv-1',
      netMinor: 14_400,
      vatMinor: 2_880,
    });
    expect(lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['1100', 17_280],
      ['4600', -14_400],
      ['2210', -2_880],
    ]);
    balanced(lines);
    expect(accountAllowedIn('2210', 'platform')).toBe(true);
    expect(accountAllowedIn('2210', 'owner')).toBe(true);
    expect(accountAllowedIn('2210', 'company')).toBe(false);
  });

  it('refuses an invoice of nothing, a negative amount and a missing id', () => {
    expect(() =>
      subscriptionInvoiceLines({ bookId: PLATFORM, invoiceId: 'i', netMinor: 0, vatMinor: 0 }),
    ).toThrow(/nothing/);
    expect(() =>
      subscriptionInvoiceLines({ bookId: PLATFORM, invoiceId: 'i', netMinor: -1, vatMinor: 0 }),
    ).toThrow(/zero or more/);
    expect(() =>
      subscriptionInvoiceLines({ bookId: PLATFORM, invoiceId: '', netMinor: 1, vatMinor: 0 }),
    ).toThrow(/required/);
  });
});

describe('P26 subscription payment', () => {
  it('debits provider clearing, settles invoices and holds the rest as prepaid credit (2020)', () => {
    const lines = subscriptionPaymentLines({
      bookId: PLATFORM,
      paymentId: 'pay-1',
      amountMinor: 20_000,
      allocations: [{ invoiceId: 'inv-1', amountMinor: 18_000 }],
    });
    expect(lines).toEqual([
      { bookId: PLATFORM, paymentId: 'pay-1', accountCode: '1050', amountMinor: 20_000 },
      {
        bookId: PLATFORM,
        paymentId: 'pay-1',
        accountCode: '1100',
        amountMinor: -18_000,
        invoiceLineId: 'inv-1',
      },
      { bookId: PLATFORM, paymentId: 'pay-1', accountCode: '2020', amountMinor: -2_000 },
    ]);
    balanced(lines);
    expect(subscriptionPostingKeys.payment('pay-1')).toBe('P26:pay-1');
  });

  it('posts annual prepayment wholly to prepaid credit, and a payment in full with no credit line', () => {
    const annual = subscriptionPaymentLines({
      bookId: PLATFORM,
      paymentId: 'pay-2',
      amountMinor: 194_400,
      allocations: [],
    });
    expect(annual.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['1050', 194_400],
      ['2020', -194_400],
    ]);
    const exact = subscriptionPaymentLines({
      bookId: PLATFORM,
      paymentId: 'pay-3',
      amountMinor: 18_000,
      allocations: [{ invoiceId: 'inv-1', amountMinor: 18_000 }],
    });
    expect(exact.map((l) => l.accountCode)).toEqual(['1050', '1100']);
  });

  it('refuses an allocation beyond the payment, twice to one invoice, or of nothing', () => {
    const pay = (allocations: { invoiceId: string; amountMinor: number }[]) =>
      subscriptionPaymentLines({
        bookId: PLATFORM,
        paymentId: 'p',
        amountMinor: 1_000,
        allocations,
      });
    expect(() => pay([{ invoiceId: 'a', amountMinor: 1_001 }])).toThrow(/beyond/);
    expect(() =>
      pay([
        { invoiceId: 'a', amountMinor: 600 },
        { invoiceId: 'b', amountMinor: 401 },
      ]),
    ).toThrow(/beyond/);
    expect(() =>
      pay([
        { invoiceId: 'a', amountMinor: 100 },
        { invoiceId: 'a', amountMinor: 100 },
      ]),
    ).toThrow(/twice/);
    expect(() => pay([{ invoiceId: 'a', amountMinor: 0 }])).toThrow(/positive/);
    expect(() =>
      subscriptionPaymentLines({
        bookId: PLATFORM,
        paymentId: 'p',
        amountMinor: 0,
        allocations: [],
      }),
    ).toThrow(/positive/);
  });

  it('draws a month’s invoice from prepaid credit', () => {
    const lines = prepaidDrawLines({ bookId: PLATFORM, invoiceId: 'inv-2', amountMinor: 16_200 });
    expect(lines).toEqual([
      { bookId: PLATFORM, invoiceLineId: 'inv-2', accountCode: '2020', amountMinor: 16_200 },
      { bookId: PLATFORM, invoiceLineId: 'inv-2', accountCode: '1100', amountMinor: -16_200 },
    ]);
    balanced(lines);
    expect(subscriptionPostingKeys.prepaidDraw('inv-2')).toBe('P26:inv-2:prepaid');
    expect(() =>
      prepaidDrawLines({ bookId: PLATFORM, invoiceId: 'inv-2', amountMinor: 0 }),
    ).toThrow(/positive/);
  });

  it('reverses a payment from its allocations as they stand now (P21 style)', () => {
    const invoiceA = subscriptionInvoiceLines({
      bookId: PLATFORM,
      invoiceId: 'A',
      netMinor: 18_000,
      vatMinor: 0,
    });
    const invoiceB = subscriptionInvoiceLines({
      bookId: PLATFORM,
      invoiceId: 'B',
      netMinor: 15_000,
      vatMinor: 0,
    });
    const payment = subscriptionPaymentLines({
      bookId: PLATFORM,
      paymentId: 'pay-1',
      amountMinor: 30_000,
      allocations: [{ invoiceId: 'A', amountMinor: 18_000 }],
    });
    // Next month 10,000 of its credit is drawn onto B, and the server attributes it to pay-1.
    const draw = prepaidDrawLines({ bookId: PLATFORM, invoiceId: 'B', amountMinor: 10_000 });
    const reversal = subscriptionPaymentReversalLines({
      bookId: PLATFORM,
      paymentId: 'pay-1',
      amountMinor: 30_000,
      allocations: [
        { invoiceId: 'A', amountMinor: 18_000 },
        { invoiceId: 'B', amountMinor: 10_000 },
      ],
    });
    expect(reversal.map((l) => [l.accountCode, l.invoiceLineId ?? null, l.amountMinor])).toEqual([
      ['1050', null, -30_000],
      ['1100', 'A', 18_000],
      ['1100', 'B', 10_000],
      ['2020', null, 2_000],
    ]);
    balanced(reversal);
    const all = [...invoiceA, ...invoiceB, ...payment, ...draw, ...reversal];
    // Both invoices are owed again in full; no credit and no provider money remain.
    expect(balanceOf(all, { accountCode: '1100', invoiceLineId: 'A' })).toBe(18_000);
    expect(balanceOf(all, { accountCode: '1100', invoiceLineId: 'B' })).toBe(15_000);
    expect(balanceOf(all, { accountCode: '2020' })).toBe(0);
    expect(balanceOf(all, { accountCode: '1050' })).toBe(0);
    expect(balanceOf(all, { accountCode: '4600' })).toBe(-33_000);
  });

  it('allocates oldest first, by issue date then number, and keeps the rest as credit', () => {
    const open = [
      {
        invoiceId: 'c',
        issuedOn: '2026-12-01',
        number: 'SUB-2026-000009',
        outstandingMinor: 15_000,
      },
      {
        invoiceId: 'b',
        issuedOn: '2026-11-01',
        number: 'SUB-2026-000005',
        outstandingMinor: 15_000,
      },
      {
        invoiceId: 'a',
        issuedOn: '2026-11-01',
        number: 'SUB-2026-000004',
        outstandingMinor: 5_000,
      },
      { invoiceId: 'z', issuedOn: '2026-10-01', number: 'SUB-2026-000001', outstandingMinor: 0 },
    ];
    expect(allocateSubscriptionPayment(25_000, open)).toEqual({
      allocations: [
        { invoiceId: 'a', amountMinor: 5_000 },
        { invoiceId: 'b', amountMinor: 15_000 },
        { invoiceId: 'c', amountMinor: 5_000 },
      ],
      creditMinor: 0,
    });
    expect(allocateSubscriptionPayment(40_000, open)).toEqual({
      allocations: [
        { invoiceId: 'a', amountMinor: 5_000 },
        { invoiceId: 'b', amountMinor: 15_000 },
        { invoiceId: 'c', amountMinor: 15_000 },
      ],
      creditMinor: 5_000,
    });
    expect(allocateSubscriptionPayment(7_000, [])).toEqual({ allocations: [], creditMinor: 7_000 });
    expect(() => allocateSubscriptionPayment(7_000, [open[0]!, open[0]!])).toThrow(/twice/);
  });
});

describe('P26 the platform book (D1)', () => {
  it('holds only platform accounts: 2020 and 4600 nowhere else, and no rent accounts', () => {
    const platformAccounts = ACCOUNTS.filter((a) => accountAllowedIn(a.code, 'platform')).map(
      (a) => a.code,
    );
    expect(platformAccounts).toEqual(['1010', '1050', '1100', '2020', '2210', '4600', '5200']);
    for (const kind of BOOK_KINDS) {
      expect(accountAllowedIn('2020', kind)).toBe(kind === 'platform');
      expect(accountAllowedIn('4600', kind)).toBe(kind === 'platform');
    }
    // A subscription entry cannot be posted to an owner's or a company's book.
    const invoice = subscriptionInvoiceLines({
      bookId: 'b',
      invoiceId: 'i',
      netMinor: 100,
      vatMinor: 0,
    });
    for (const kind of ['owner', 'company'] as const)
      expect(() => checkEntry(invoice, () => kind)).toThrow(/cannot be used/);
  });

  it('names 2020 and 4600 in no other posting code of the domain', () => {
    // The domain's source as text (not its tests), through the bundler: no file I/O here.
    const sources = import.meta.glob(['../**/*.ts', '!../**/*.test.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const files = Object.keys(sources);
    expect(files).toContain('./subscription-posting.ts');
    expect(files).toContain('./posting.ts');
    expect(files).toContain('../billing/invoicing.ts');
    expect(files).toContain('../subscription/pricing.ts');
    const naming = files.filter((file) => /['"](2020|4600)['"]/.test(sources[file]!)).sort();
    expect(naming).toEqual(['./accounts.ts', './subscription-posting.ts']);
  });

  it('settles the platform’s own Paystack balance with the settlement rule, to its bank account', () => {
    const lines = settlementLines({
      bookId: PLATFORM,
      to: '1010',
      provider: 'paystack',
      settlementId: 'set-1',
      settlementAccountId: null,
      payments: [
        { paymentId: 'pay-1', amountMinor: 20_000 },
        { paymentId: 'pay-2', amountMinor: 15_000 },
      ],
      feesMinor: 525,
      deductionsMinor: 0,
      netMinor: 34_475,
    });
    balanced(lines);
    expect([...new Set(lines.map((l) => l.accountCode))].sort()).toEqual(['1010', '1050', '5200']);
    expect(balanceOf(lines, { accountCode: '1050', paymentId: 'pay-1' })).toBe(-20_000);
    expect(balanceOf(lines, { accountCode: '1010' })).toBe(34_475);
  });
});

// Property-based: P26 entries balance in the platform book, whatever the payments and allocations.

const openInvoicesArb = fc.uniqueArray(
  fc.record({
    invoiceId: fc.integer({ min: 0, max: 999 }).map((n) => `inv-${n}`),
    issuedOn: fc.constantFrom('2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'),
    number: fc.integer({ min: 1, max: 999 }).map((n) => `SUB-2026-${String(n).padStart(6, '0')}`),
    outstandingMinor: fc.nat(500_000),
  }),
  { selector: (i) => i.invoiceId, maxLength: 8 },
);

describe('P26 entries balance (property-based)', () => {
  it('allocates no more than each invoice owes, oldest first, and the payment entry balances', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3_000_000 }), openInvoicesArb, (amount, open) => {
        const { allocations, creditMinor } = allocateSubscriptionPayment(amount, open);
        expect(allocations.reduce((t, a) => t + a.amountMinor, 0) + creditMinor).toBe(amount);
        const owed = new Map(open.map((i) => [i.invoiceId, i.outstandingMinor]));
        for (const a of allocations) {
          expect(a.amountMinor).toBeGreaterThan(0);
          expect(a.amountMinor).toBeLessThanOrEqual(owed.get(a.invoiceId)!);
        }
        // Credit is left only when every invoice is settled in full.
        if (creditMinor > 0)
          for (const i of open)
            expect(allocations.find((a) => a.invoiceId === i.invoiceId)?.amountMinor ?? 0).toBe(
              i.outstandingMinor,
            );
        const lines = subscriptionPaymentLines({
          bookId: PLATFORM,
          paymentId: 'p',
          amountMinor: amount,
          allocations,
        });
        balanced(lines);
        expect(balanceOf(lines, { accountCode: '2020' }) + creditMinor).toBe(0);
        const reversal = subscriptionPaymentReversalLines({
          bookId: PLATFORM,
          paymentId: 'p',
          amountMinor: amount,
          allocations,
        });
        balanced(reversal);
        expect(total([...lines, ...reversal])).toBe(0);
        for (const code of ['1050', '1100', '2020'] as const)
          expect(balanceOf([...lines, ...reversal], { accountCode: code })).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('balances every entry of a subscription’s life: invoices, payments, draws and reversals', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ net: fc.nat(400_000), vat: fc.nat(80_000) }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.integer({ min: 1, max: 600_000 }), { minLength: 1, maxLength: 4 }),
        (invoices, payments) => {
          const all: JournalLineDraft[] = [];
          const owed = new Map<string, number>();
          invoices.forEach((inv, i) => {
            if (inv.net + inv.vat === 0) return;
            const lines = subscriptionInvoiceLines({
              bookId: PLATFORM,
              invoiceId: `inv-${i}`,
              netMinor: inv.net,
              vatMinor: inv.vat,
            });
            balanced(lines);
            all.push(...lines);
            owed.set(`inv-${i}`, inv.net + inv.vat);
          });
          let credit = 0;
          payments.forEach((amount, p) => {
            const open = [...owed].map(([invoiceId, outstandingMinor], k) => ({
              invoiceId,
              issuedOn: '2026-11-01',
              number: `SUB-2026-${String(k).padStart(6, '0')}`,
              outstandingMinor,
            }));
            const { allocations, creditMinor } = allocateSubscriptionPayment(amount, open);
            const lines = subscriptionPaymentLines({
              bookId: PLATFORM,
              paymentId: `pay-${p}`,
              amountMinor: amount,
              allocations,
            });
            balanced(lines);
            all.push(...lines);
            for (const a of allocations)
              owed.set(a.invoiceId, owed.get(a.invoiceId)! - a.amountMinor);
            credit += creditMinor;
          });
          // Draw what credit there is onto what is still owed.
          for (const [invoiceId, outstanding] of owed) {
            const draw = Math.min(credit, outstanding);
            if (draw === 0) continue;
            const lines = prepaidDrawLines({ bookId: PLATFORM, invoiceId, amountMinor: draw });
            balanced(lines);
            all.push(...lines);
            owed.set(invoiceId, outstanding - draw);
            credit -= draw;
          }
          expect(total(all)).toBe(0);
          for (const [invoiceId, outstanding] of owed)
            expect(balanceOf(all, { accountCode: '1100', invoiceLineId: invoiceId })).toBe(
              outstanding,
            );
          expect(balanceOf(all, { accountCode: '2020' }) + credit).toBe(0);
          expect(balanceOf(all, { accountCode: '1050' })).toBe(payments.reduce((a, b) => a + b, 0));
        },
      ),
      { numRuns: 300 },
    );
  });
});
