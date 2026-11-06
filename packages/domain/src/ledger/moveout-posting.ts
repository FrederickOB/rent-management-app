import { DomainError } from '../errors';
import type { CashAccount } from './accounts';
import { compactLines, type JournalLineDraft } from './journal';
import type { LeaseDimensions } from './posting';

/**
 * Deposits at move-out and expenses (architecture section 5; M8 plan 4.8 and 4.9). One posting
 * function per rule: event in, lines out.
 */
const positive = (value: number, what: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError('ledger.bad_amount', `${what} must be above zero`);
  return value;
};

type OwnAccount = Extract<CashAccount, '1010' | '1070'>;

/** One deposit payment's share: deposits sit in 2100 per payment, first in, first out. */
export interface DepositShare {
  readonly paymentId: string | null;
  readonly amountMinor: number;
}

/**
 * P11: the deposit applied at move-out (approved; never more than the deposit held). Dr 2100, from
 * each deposit payment's share; Cr 1100 on each open line it pays (allocation source `deposit`, so
 * rent settled this way is rent received and P17 follows); Cr 4300 for the deductions retained.
 */
export function depositApplicationLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly shares: readonly DepositShare[];
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountMinor: number }[];
  readonly retainedMinor: number;
}): JournalLineDraft[] {
  const applied = input.lines.reduce((s, l) => s + positive(l.amountMinor, 'A line'), 0);
  const retained = input.retainedMinor;
  if (!Number.isSafeInteger(retained) || retained < 0)
    throw new DomainError('ledger.bad_amount', 'The deductions retained are zero or more');
  const shares = input.shares.reduce((s, d) => s + positive(d.amountMinor, 'A share'), 0);
  if (shares !== applied + retained)
    throw new DomainError(
      'ledger.deposit_mismatch',
      'The deposit taken must equal what it pays and keeps',
    );
  const dims = { bookId: input.bookId, ...input.lease };
  return compactLines([
    ...input.shares.map((s) => ({
      ...dims,
      accountCode: '2100' as const,
      amountMinor: s.amountMinor,
      paymentId: s.paymentId,
    })),
    ...input.lines.map((l) => ({
      ...dims,
      accountCode: '1100' as const,
      amountMinor: -l.amountMinor,
      invoiceLineId: l.invoiceLineId,
    })),
    ...(retained > 0 ? [{ ...dims, accountCode: '4300' as const, amountMinor: -retained }] : []),
  ]);
}

/** P12 approved: the deposit left becomes a refund payable. Dr 2100 per share, Cr 2400. */
export function depositRefundApprovedLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly shares: readonly DepositShare[];
}): JournalLineDraft[] {
  const amount = input.shares.reduce((s, d) => s + positive(d.amountMinor, 'A share'), 0);
  const dims = { bookId: input.bookId, ...input.lease };
  return compactLines([
    ...input.shares.map((s) => ({
      ...dims,
      accountCode: '2100' as const,
      amountMinor: s.amountMinor,
      paymentId: s.paymentId,
    })),
    { ...dims, accountCode: '2400', amountMinor: -amount },
  ]);
}

/**
 * P21b on a deposit a move-out already used (M8 review): a payment reversed after its deposit
 * share was settled (a provider chargeback) first takes that share back from where the settlement
 * put it, so the reversal that follows leaves no deposit below zero. Cr 2100 for the payment's
 * share; Dr 1100 on the lines its deposit paid (they are owed again), Dr 4300 for the deductions
 * it was kept for, Dr 2400 for the refund approved from it. The mirror of P11 and P12 for one
 * payment, built from its deposit applications.
 */
export function depositUnwindLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string;
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountMinor: number }[];
  readonly retainedMinor: number;
  readonly refundMinor: number;
}): JournalLineDraft[] {
  const applied = input.lines.reduce((s, l) => s + positive(l.amountMinor, 'A line'), 0);
  for (const [value, what] of [
    [input.retainedMinor, 'The deductions kept'],
    [input.refundMinor, 'The refund approved'],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError('ledger.bad_amount', `${what} are zero or more`);
  const total = applied + input.retainedMinor + input.refundMinor;
  if (total === 0) throw new DomainError('ledger.empty_unwind', 'Nothing of the deposit was used');
  const dims = { bookId: input.bookId, ...input.lease };
  return compactLines([
    { ...dims, accountCode: '2100', amountMinor: -total, paymentId: input.paymentId },
    ...input.lines.map((l) => ({
      ...dims,
      accountCode: '1100' as const,
      amountMinor: l.amountMinor,
      invoiceLineId: l.invoiceLineId,
    })),
    ...(input.retainedMinor > 0
      ? [{ ...dims, accountCode: '4300' as const, amountMinor: input.retainedMinor }]
      : []),
    ...(input.refundMinor > 0
      ? [{ ...dims, accountCode: '2400' as const, amountMinor: input.refundMinor }]
      : []),
  ]);
}

/**
 * P12 and P13 paid outside the platform (D1), with a reference and proof: Dr 2400, Cr 1010 (the
 * owner's account) or 1070 (held by the agent).
 */
export function tenantRefundPaidLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly from: OwnAccount;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The refund');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '2400', amountMinor: amount },
    { ...dims, accountCode: input.from, amountMinor: -amount },
  ];
}

/** Where an expense's money came from: the owner's account, the agent's, or not yet paid. */
export type ExpenseSource = '1010' | '1070' | '2500';

/**
 * P15: an expense (AC-03). Dr 5000 (repairs) or 5400 (other property expenses) on the property and
 * unit; Cr 2500 if unpaid, 1070 if the agent paid, 1010 if the owner paid.
 */
export function expenseLines(input: {
  readonly bookId: string;
  readonly account: '5000' | '5400';
  readonly from: ExpenseSource;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The expense');
  const dims = { bookId: input.bookId, propertyId: input.propertyId, unitId: input.unitId };
  return [
    { ...dims, accountCode: input.account, amountMinor: amount },
    { ...dims, accountCode: input.from, amountMinor: -amount },
  ];
}

/** P15, a payable paid later: Dr 2500, Cr 1070 or 1010. */
export function expensePaymentLines(input: {
  readonly bookId: string;
  readonly from: OwnAccount;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The payment');
  const dims = { bookId: input.bookId, propertyId: input.propertyId, unitId: input.unitId };
  return [
    { ...dims, accountCode: '2500', amountMinor: amount },
    { ...dims, accountCode: input.from, amountMinor: -amount },
  ];
}
