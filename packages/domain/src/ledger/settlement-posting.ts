import { DomainError } from '../errors';
import type { CashAccount } from './accounts';
import { compactLines, type JournalLineDraft } from './journal';
import type { CashSide, PaymentAmount } from './posting';

/**
 * Provider settlement and refunds of unmatched money (architecture section 5; M4b plan 4.5 and
 * 4.8). Settlement goes straight to the landlord's or agency's account (D1): the platform's own
 * book is never touched.
 */

/**
 * P22, one entry per settlement per book: the payments settled leave provider clearing (Cr 1050,
 * each on its payment), the net reaches the account it was paid into (1010 the owner's, 1070 the
 * agency's), the fee is an expense (5200), and chargebacks or refunds the provider deducted clear
 * the 1050 credits their reversals left.
 */
export function settlementLines(input: {
  readonly bookId: string;
  readonly to: Extract<CashAccount, '1010' | '1070'>;
  readonly provider: string;
  readonly settlementId: string;
  readonly settlementAccountId: string | null;
  readonly payments: readonly PaymentAmount[];
  readonly feesMinor: number;
  readonly deductionsMinor: number;
  readonly netMinor: number;
}): JournalLineDraft[] {
  const gross = input.payments.reduce((sum, p) => {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0)
      throw new DomainError('ledger.bad_amount', 'Each settled payment is a positive amount');
    return sum + p.amountMinor;
  }, 0);
  for (const [value, what] of [
    [input.feesMinor, 'Fees'],
    [input.deductionsMinor, 'Deductions'],
    [input.netMinor, 'The net amount'],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError('ledger.bad_amount', `${what} must be zero or more pesewas`);
  if (gross - input.feesMinor - input.deductionsMinor !== input.netMinor)
    throw new DomainError(
      'ledger.settlement_does_not_add_up',
      'Gross less fees and deductions must equal the net amount settled',
    );
  const dims = {
    bookId: input.bookId,
    provider: input.provider,
    settlementId: input.settlementId,
    settlementAccountId: input.settlementAccountId,
  };
  return compactLines([
    ...input.payments.map((p) => ({
      ...dims,
      accountCode: '1050' as const,
      amountMinor: -p.amountMinor,
      paymentId: p.paymentId,
    })),
    { ...dims, accountCode: '5200', amountMinor: input.feesMinor },
    { ...dims, accountCode: '1050', amountMinor: input.deductionsMinor },
    { ...dims, accountCode: input.to, amountMinor: input.netMinor },
  ]);
}

/**
 * P31: money that belongs to no lease is refunded to the payer (approval required), in the book
 * holding the suspense: out of 2090, and out of where the money sits (1050 for a provider refund).
 */
export function unmatchedRefundLines(input: {
  readonly from: CashSide;
  readonly paymentId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('ledger.bad_amount', 'Refund an amount above zero');
  return [
    {
      bookId: input.from.bookId,
      accountCode: '2090',
      amountMinor: input.amountMinor,
      paymentId: input.paymentId,
    },
    {
      bookId: input.from.bookId,
      accountCode: input.from.account,
      amountMinor: -input.amountMinor,
      paymentId: input.paymentId,
      provider: input.from.provider ?? null,
      settlementAccountId: input.from.settlementAccountId ?? null,
    },
  ];
}
