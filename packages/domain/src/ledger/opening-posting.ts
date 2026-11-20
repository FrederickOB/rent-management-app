import { DomainError } from '../errors';
import { compactLines, type JournalLineDraft } from './journal';
import type { AllocationPosting, LeaseDimensions } from './posting';

/**
 * P25: opening balances at a pilot company's cut-over (M11 decision 3; plan 4.2; architecture
 * section 5). One posting function per item of the Balances workbook: event in, lines out. Every
 * entry is dated the cut-over (the accounting date is its period, or the open period if that one
 * has since been locked) and posts against 3900, opening balances, never income. Opening amounts
 * post no rent tax (P17) and no management fee (P14): the money was received before the platform
 * (OQ-64). The ledger module's posting service writes each under `P25:<batch>:<item>`.
 */

const positive = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new DomainError('ledger.bad_amount', `${what} must be above zero`);
  return amount;
};

const CLASS_ACCOUNT = { receivable: '1100', prepayment: '2010', deposit: '2100' } as const;

/** Idempotency keys: one entry per workbook item (plan 4.2). */
export const openingBalanceKeys = {
  /** `P25:<batch>:<item>`: an item of the Balances workbook, or of an adjustment workbook. */
  item: (batchId: string, itemId: string): string => {
    if (!batchId || !itemId || batchId.includes(':') || itemId.includes(':'))
      throw new DomainError('ledger.bad_key', 'An opening item needs its batch and item ids');
    return `P25:${batchId}:${itemId}`;
  },
} as const;

/**
 * Opening arrears: a rent or service-charge line on an invoice of kind `opening`, at its original
 * period and due date, accrued at commit: the tenant owes it (Dr 1100 on the line) against opening
 * balances (Cr 3900), never income. The daily accrual skips it (`linesToAccrue`).
 */
export function openingArrearsLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'Opening arrears');
  const dims = { bookId: input.bookId, ...input.lease, invoiceLineId: input.invoiceLineId };
  return [
    { ...dims, accountCode: '1100', amountMinor: amount },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}

/**
 * The opening payment: money the tenant paid before the platform that is not yet used (an advance,
 * given as an amount or a paid-through date). A payment of source `opening_balance` that issues no
 * receipt and uses no receipt number. It is allocated as any payment is (BC-07, P03), oldest debt
 * first, so it pays what the lease owes at the cut-over (opening arrears) before it is held; its
 * surplus stays in 2010 as its credit, which later months draw on first in, first out. Dr 3900 on
 * the payment; Cr 1100 for lines owed, 2010 for lines not started and the surplus.
 */
export function openingPaymentLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string;
  readonly allocations: readonly AllocationPosting[];
  readonly surplusMinor: number;
}): JournalLineDraft[] {
  if (!Number.isSafeInteger(input.surplusMinor) || input.surplusMinor < 0)
    throw new DomainError('ledger.bad_amount', 'The surplus must be zero or more pesewas');
  const credits: JournalLineDraft[] = input.allocations.map((a) => {
    if (a.postingClass === 'deposit')
      throw new DomainError(
        'ledger.opening_deposit_by_payment',
        'A deposit held at the cut-over is its own opening item, never an opening payment',
      );
    return {
      bookId: input.bookId,
      ...a.lease,
      accountCode: CLASS_ACCOUNT[a.postingClass],
      amountMinor: -positive(a.amountMinor, 'An allocation'),
      invoiceLineId: a.invoiceLineId,
      paymentId: input.paymentId,
    };
  });
  if (input.surplusMinor > 0)
    credits.push({
      bookId: input.bookId,
      ...input.lease,
      accountCode: '2010',
      amountMinor: -input.surplusMinor,
      paymentId: input.paymentId,
    });
  const amount = -credits.reduce((sum, l) => sum + l.amountMinor, 0);
  if (amount === 0)
    throw new DomainError('ledger.empty_receipt', 'An opening payment needs an amount');
  return compactLines([
    {
      bookId: input.bookId,
      ...input.lease,
      accountCode: '3900',
      amountMinor: amount,
      paymentId: input.paymentId,
    },
    ...credits,
  ]);
}

/**
 * The deposit held at the cut-over: a deposit line on the opening invoice, settled at commit by an
 * allocation of source `opening_balance` (no payment), so move-out (P11, P12) and renewals (P29)
 * take it as any deposit. Dr 3900, Cr 2100 on the lease and line. Never income (BC-11).
 */
export function openingDepositLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The deposit held');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '3900', amountMinor: amount },
    { ...dims, accountCode: '2100', amountMinor: -amount, invoiceLineId: input.invoiceLineId },
  ];
}

/**
 * Withholding outstanding at the cut-over (TX-04): tax a corporate tenant withheld before the
 * platform whose certificate is still to come. GRA owes it to the owner (Dr 1150 on the lease)
 * against opening balances (Cr 3900). The certificate (P20) or a write-off (P24) clears it later.
 */
export function openingWithholdingLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'Withholding outstanding');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '1150', amountMinor: amount },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}

const ownerDims = (bookId: string, propertyId: string | null | undefined) => ({
  bookId,
  propertyId: propertyId ?? null,
});

/**
 * The owner's money the managing agent holds at the cut-over (AC-05): Dr 1070, Cr 3900, in the
 * owner's book at the owner's level, as P16 and P30 post it. Remittances (P16) then draw on it.
 */
export function openingAgentCashLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'Agent-held cash');
  const dims = ownerDims(input.bookId, input.propertyId);
  return [
    { ...dims, accountCode: '1070', amountMinor: amount },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}

/**
 * Rent tax still owed to GRA at the cut-over (TX-02): Dr 3900, Cr 2200, in the owner's book. The
 * rent tax item it belongs to keeps its own due date; P18 settles it as any item.
 */
export function openingRentTaxLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'Rent tax outstanding');
  const dims = ownerDims(input.bookId, input.propertyId);
  return [
    { ...dims, accountCode: '3900', amountMinor: amount },
    { ...dims, accountCode: '2200', amountMinor: -amount },
  ];
}

// Adjustments after commit (decision 3): signed changes. Raising an item adds an opening item (the
// functions above); lowering one is below. Lowering arrears is a credit note on the opening line
// (P27 with `chargedAccountOf` 3900: Dr 3900, Cr 1100 on its unpaid part; `creditNoteLines`).

/**
 * An advance lowered: the opening payment's credit, never what has been drawn from it, goes back
 * to opening balances. Dr 2010 on the payment, Cr 3900. The payment's amount for allocation is its
 * amount less its reductions, as with a refund.
 */
export function openingPaymentReductionLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The reduction');
  const dims = { bookId: input.bookId, ...input.lease, paymentId: input.paymentId };
  return [
    { ...dims, accountCode: '2010', amountMinor: amount },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}

/**
 * A deposit held lowered: the opening deposit line gives back what it still holds, never what a
 * move-out or a renewal has taken from it. Dr 2100 on the lease and line, Cr 3900; a negative
 * `opening_balance` allocation and a credit note of the same amount on the line record it.
 */
export function openingDepositReductionLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The reduction');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '2100', amountMinor: amount, invoiceLineId: input.invoiceLineId },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}

/** Withholding outstanding lowered, never below what its certificate or a write-off cleared: Dr 3900, Cr 1150. */
export function openingWithholdingReductionLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The reduction');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '3900', amountMinor: amount },
    { ...dims, accountCode: '1150', amountMinor: -amount },
  ];
}

/** Agent-held cash lowered, never below what the agent still holds for the owner: Dr 3900, Cr 1070. */
export function openingAgentCashReductionLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The reduction');
  const dims = ownerDims(input.bookId, input.propertyId);
  return [
    { ...dims, accountCode: '3900', amountMinor: amount },
    { ...dims, accountCode: '1070', amountMinor: -amount },
  ];
}

/** Rent tax outstanding lowered, never below what has been paid to GRA (P18): Dr 2200, Cr 3900. */
export function openingRentTaxReductionLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The reduction');
  const dims = ownerDims(input.bookId, input.propertyId);
  return [
    { ...dims, accountCode: '2200', amountMinor: amount },
    { ...dims, accountCode: '3900', amountMinor: -amount },
  ];
}
