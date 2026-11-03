import type { ApiClient } from '@rent/contracts/client';
import type { ReceivingAccount } from './billing-format';
import { amountMinorOf, pastDateProblem, type Parsed } from './payment-form';
import { GRA_LIMITS, monthOf, monthPeriod } from './rent-tax';

// VAT returns (P32, P33; M5 plan 5.6). The API reports, per owner and month, the VAT, NHIL and
// GETFund charged at their tax points (the invoice or the payment, whichever came first), by
// invoice, with the rates' rules (unverified, OQ-20). VAT paid to GRA is recorded with the
// return's month and the GRA receipt. Filing and E-VAT invoicing are not built.

/** An invoice's VAT and levies at its tax point, as the report lists them. */
export interface VatInvoiceRow {
  readonly invoiceNumber: string;
  readonly taxPoint: string;
}

/**
 * The report's rows by tax point, then invoice number (P32: the tax point is the invoice or the
 * payment, whichever came first). The API's figures are shown as they come; nothing is added here.
 */
export function byTaxPoint<T extends VatInvoiceRow>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.taxPoint.localeCompare(b.taxPoint) || a.invoiceNumber.localeCompare(b.invoiceNumber),
  );
}

export interface VatPaymentDraft {
  /** The return's month, `2026-11`. */
  readonly month: string;
  readonly paidOn: string;
  readonly amount: string;
  readonly graReceiptNumber: string;
  readonly paidFrom: ReceivingAccount | '';
  readonly note: string;
}

export type VatPaymentField = keyof VatPaymentDraft;

export const emptyVatPayment = (
  month: string,
  today: string,
  agency: boolean,
): VatPaymentDraft => ({
  month,
  paidOn: today,
  amount: '',
  graReceiptNumber: '',
  paidFrom: agency ? '' : 'owner_account',
  note: '',
});

/** A VAT payment as `POST /vat-payments` takes it (P33), without the receipt, uploaded first. */
export type VatPaymentInput = Omit<
  Parameters<ApiClient['vat']['recordPayment']>[0],
  'receiptUploadId'
>;

/** The VAT payment form: the return's month, never one still to come, and the GRA receipt. */
export function vatPaymentForm(
  draft: VatPaymentDraft,
  ownerId: string | null,
  today: string,
): Parsed<VatPaymentInput, VatPaymentField | 'owner'> {
  const errors: Partial<Record<VatPaymentField | 'owner', string>> = {};
  if (!ownerId) errors.owner = 'Choose the owner';
  const period = monthPeriod(draft.month);
  if (!period) errors.month = 'Choose the month of the return';
  else if (draft.month > monthOf(today)) errors.month = 'The month cannot be in the future';
  const date = pastDateProblem(draft.paidOn, today, 'it was paid to GRA');
  if (date) errors.paidOn = date;
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const receipt = draft.graReceiptNumber.trim();
  if (!receipt) errors.graReceiptNumber = 'Enter the number on the GRA receipt';
  else if (receipt.length > GRA_LIMITS.receiptNumberMax)
    errors.graReceiptNumber = `Use at most ${GRA_LIMITS.receiptNumberMax} characters`;
  if (!draft.paidFrom) errors.paidFrom = 'Choose the account it was paid from';
  if (draft.note.trim().length > GRA_LIMITS.noteMax)
    errors.note = `Use at most ${GRA_LIMITS.noteMax} characters`;
  if (Object.keys(errors).length || !ownerId || !period || amount.value === null || !draft.paidFrom)
    return { input: null, errors };
  return {
    input: {
      ownerId,
      periodMonth: period.from,
      paidOn: draft.paidOn,
      amountMinor: amount.value,
      graReceiptNumber: receipt,
      paidFrom: draft.paidFrom,
      note: draft.note.trim() || null,
    },
    errors: {},
  };
}
