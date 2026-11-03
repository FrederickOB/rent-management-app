import { DomainError } from '../errors';
import { allocate, money } from '../money/money';
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

/** One payment's part of a settlement in a book: its gross and its share of the fees. */
export interface SettledShare {
  readonly paymentId: string;
  readonly grossMinor: number;
  readonly feesMinor: number;
}

/**
 * Shares a book's settlement fees across its payments by gross, largest remainder (CLAUDE.md
 * section 4), so the shares add up to the fees exactly and each payment knows its own.
 */
export function shareSettlementFees(
  payments: readonly PaymentAmount[],
  feesMinor: number,
): SettledShare[] {
  if (!Number.isSafeInteger(feesMinor) || feesMinor < 0)
    throw new DomainError('ledger.bad_amount', 'Fees must be zero or more pesewas');
  const gross = payments.reduce((sum, p) => sum + p.amountMinor, 0);
  if (feesMinor > gross)
    throw new DomainError('ledger.bad_amount', 'Fees cannot exceed the payments settled');
  const shares =
    payments.length === 0 || feesMinor === 0
      ? payments.map(() => 0)
      : allocate(
          money(feesMinor),
          payments.map((p) => p.amountMinor),
        ).map((m) => m.amountMinor);
  return payments.map((p, i) => ({
    paymentId: p.paymentId,
    grossMinor: p.amountMinor,
    feesMinor: shares[i] ?? 0,
  }));
}

/**
 * P22, one entry per settlement per book, payment by payment (M4b plan 4.8): each settled payment
 * leaves provider clearing (Cr 1050), its share of the fees is an expense (Dr 5200) and the rest
 * reaches the account it was paid into (Dr 1010 or 1070), each line naming the payment, so money
 * matched later across books moves with its own net and fee (P23). Chargebacks and refunds the
 * provider deducted clear the 1050 debts their reversals left, out of the same account.
 */
export function settlementEntryLines(input: {
  readonly bookId: string;
  readonly to: Extract<CashAccount, '1010' | '1070'>;
  readonly provider: string;
  readonly settlementId: string;
  readonly settlementAccountId: string | null;
  readonly shares: readonly SettledShare[];
  readonly deductions: readonly PaymentAmount[];
}): JournalLineDraft[] {
  const dims = {
    bookId: input.bookId,
    provider: input.provider,
    settlementId: input.settlementId,
    settlementAccountId: input.settlementAccountId,
  };
  const lines: JournalLineDraft[] = [];
  for (const share of input.shares) {
    if (!Number.isSafeInteger(share.grossMinor) || share.grossMinor <= 0)
      throw new DomainError('ledger.bad_amount', 'Each settled payment is a positive amount');
    if (!Number.isSafeInteger(share.feesMinor) || share.feesMinor < 0)
      throw new DomainError('ledger.bad_amount', 'Fees must be zero or more pesewas');
    if (share.feesMinor > share.grossMinor)
      throw new DomainError('ledger.bad_amount', 'A fee cannot exceed its payment');
    const payment = { ...dims, paymentId: share.paymentId };
    lines.push(
      { ...payment, accountCode: '1050', amountMinor: -share.grossMinor },
      { ...payment, accountCode: '5200', amountMinor: share.feesMinor },
      { ...payment, accountCode: input.to, amountMinor: share.grossMinor - share.feesMinor },
    );
  }
  for (const d of input.deductions) {
    if (!Number.isSafeInteger(d.amountMinor) || d.amountMinor <= 0)
      throw new DomainError('ledger.bad_amount', 'Each deduction is a positive amount');
    const payment = { ...dims, paymentId: d.paymentId };
    lines.push(
      { ...payment, accountCode: '1050', amountMinor: d.amountMinor },
      { ...payment, accountCode: input.to, amountMinor: -d.amountMinor },
    );
  }
  return compactLines(lines);
}
