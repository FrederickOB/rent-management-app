import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { balanceOf, checkEntry, type JournalLineDraft } from './journal';
import { settlementLines } from './settlement-posting';
import {
  allocateSubscriptionPayment,
  subscriptionPaymentLines,
  subscriptionPaymentReversalLines,
} from './subscription-posting';

/**
 * M10 review BE-26: P26's payment, its reversal and the platform's settlement carry the provider
 * on provider clearing (1050), as rent's do, so the platform's clearing can be compared with what
 * the provider still holds for the platform (CLAUDE.md section 8, daily reconciliation).
 */
const PLATFORM = 'book-platform';
const balanced = (lines: readonly JournalLineDraft[]) => checkEntry(lines, () => 'platform');

describe('PB-07 P26 provider clearing carries its provider (review BE-26)', () => {
  it('puts the provider on the 1050 line of a payment and of its reversal, and nowhere else', () => {
    const input = {
      bookId: PLATFORM,
      paymentId: 'pay-1',
      amountMinor: 30_000,
      allocations: [{ invoiceId: 'inv-1', amountMinor: 18_000 }],
      provider: 'paystack',
    };
    const payment = subscriptionPaymentLines(input);
    expect(payment.map((l) => [l.accountCode, l.provider ?? null, l.amountMinor])).toEqual([
      ['1050', 'paystack', 30_000],
      ['1100', null, -18_000],
      ['2020', null, -12_000],
    ]);
    balanced(payment);
    const reversal = subscriptionPaymentReversalLines(input);
    expect(reversal.map((l) => [l.accountCode, l.provider ?? null, l.amountMinor])).toEqual([
      ['1050', 'paystack', -30_000],
      ['1100', null, 18_000],
      ['2020', null, 12_000],
    ]);
    balanced(reversal);
    expect(
      balanceOf([...payment, ...reversal], { accountCode: '1050', provider: 'paystack' }),
    ).toBe(0);
  });

  it('leaves the lines as they were when no provider is given, and refuses an empty one', () => {
    const lines = subscriptionPaymentLines({
      bookId: PLATFORM,
      paymentId: 'pay-2',
      amountMinor: 5_000,
      allocations: [],
    });
    expect(lines.every((l) => !('provider' in l))).toBe(true);
    expect(() =>
      subscriptionPaymentLines({
        bookId: PLATFORM,
        paymentId: 'pay-2',
        amountMinor: 5_000,
        allocations: [],
        provider: '',
      }),
    ).toThrow(/provider is required/);
  });

  it('★ clears the provider’s 1050 to zero once its payments are paid out, whatever the mix', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 6 }),
        fc.nat(5_000),
        fc.array(fc.integer({ min: 1, max: 200_000 }), { maxLength: 4 }),
        (amounts, fees, owed) => {
          const all: JournalLineDraft[] = [];
          const open = owed.map((outstandingMinor, i) => ({
            invoiceId: `inv-${i}`,
            issuedOn: '2026-11-01',
            number: `SUB-2026-${String(i + 1).padStart(6, '0')}`,
            outstandingMinor,
          }));
          amounts.forEach((amount, p) => {
            const { allocations } = allocateSubscriptionPayment(amount, open);
            for (const a of allocations) {
              const invoice = open.find((i) => i.invoiceId === a.invoiceId)!;
              invoice.outstandingMinor -= a.amountMinor;
            }
            const lines = subscriptionPaymentLines({
              bookId: PLATFORM,
              paymentId: `pay-${p}`,
              amountMinor: amount,
              allocations,
              provider: 'paystack',
            });
            balanced(lines);
            all.push(...lines);
          });
          const gross = amounts.reduce((a, b) => a + b, 0);
          const fee = Math.min(fees, gross);
          const payout = settlementLines({
            bookId: PLATFORM,
            to: '1010',
            provider: 'paystack',
            settlementId: 'stl-1',
            settlementAccountId: null,
            payments: amounts.map((amountMinor, p) => ({ paymentId: `pay-${p}`, amountMinor })),
            feesMinor: fee,
            deductionsMinor: 0,
            netMinor: gross - fee,
          });
          balanced(payout);
          all.push(...payout);
          expect(balanceOf(all, { accountCode: '1050', provider: 'paystack' })).toBe(0);
          expect(balanceOf(all, { accountCode: '1050' })).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
