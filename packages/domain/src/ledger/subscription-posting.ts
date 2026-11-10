import { DomainError } from '../errors';
import { compactLines, reversalLines, type JournalLineDraft } from './journal';

/**
 * P26: the platform's own subscription money (M10 plan 4.2; architecture section 5), in the
 * platform book only. Rent never touches that book (D1), and these accounts (2020 prepaid credit,
 * 4600 subscription revenue) exist in no other kind of book. The sub-ledger keys are dimensions:
 * the subscription invoice id in `invoiceLineId` and the subscription payment id in `paymentId`
 * (in the platform book they must name subscription records, checked at commit by
 * `app.check_journal_line_refs`, migration 0061). An invoice's entry is dated the last day of the
 * month it bills, so its revenue falls in the month it covers (M10 review BE-9); the caller dates it.
 */

export interface SubscriptionAllocation {
  readonly invoiceId: string;
  readonly amountMinor: number;
}

export const subscriptionPostingKeys = {
  invoice: (invoiceId: string) => `P26:${invoiceId}`,
  payment: (paymentId: string) => `P26:${paymentId}`,
  prepaidDraw: (invoiceId: string) => `P26:${invoiceId}:prepaid`,
  paymentReversal: (paymentId: string) => `P26:${paymentId}:reversal`,
  creditNote: (creditNoteId: string) => `P26:${creditNoteId}`,
} as const;

function positive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError(
      'ledger.bad_amount',
      `${what} must be a positive whole number of pesewas`,
    );
  return value;
}

function nonNegative(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('ledger.bad_amount', `${what} must be zero or more pesewas`);
  return value;
}

function id(value: string, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new DomainError('ledger.missing_dimension', `${what} is required`);
  return value;
}

/** The allocations checked: positive, one per invoice, together no more than the payment. */
function checkAllocations(
  amountMinor: number,
  allocations: readonly SubscriptionAllocation[],
): number {
  const seen = new Set<string>();
  let allocated = 0;
  for (const a of allocations) {
    id(a.invoiceId, 'The invoice');
    if (seen.has(a.invoiceId))
      throw new DomainError(
        'ledger.duplicate_allocation',
        `Invoice ${a.invoiceId} is allocated twice`,
      );
    seen.add(a.invoiceId);
    allocated += positive(a.amountMinor, 'Each allocation');
    if (allocated > amountMinor)
      throw new DomainError(
        'ledger.over_allocated',
        'A payment cannot be allocated beyond its amount',
      );
  }
  return allocated;
}

/** P26 invoice: Dr 1100 total; Cr 4600 net; Cr 2210 VAT and levies when charged. Key `P26:<invoiceId>`. */
export function subscriptionInvoiceLines(input: {
  readonly bookId: string;
  readonly invoiceId: string;
  readonly netMinor: number;
  readonly vatMinor: number;
}): JournalLineDraft[] {
  const net = nonNegative(input.netMinor, 'The net amount');
  const vat = nonNegative(input.vatMinor, 'VAT and levies');
  const total = net + vat;
  if (!Number.isSafeInteger(total) || total === 0)
    throw new DomainError('ledger.bad_amount', 'An invoice of nothing posts nothing');
  const dims = {
    bookId: id(input.bookId, 'The book'),
    invoiceLineId: id(input.invoiceId, 'The invoice'),
  };
  return compactLines([
    { ...dims, accountCode: '1100', amountMinor: total },
    { ...dims, accountCode: '4600', amountMinor: -net },
    { ...dims, accountCode: '2210', amountMinor: -vat },
  ]);
}

/**
 * P26 credit note (founder answer Q2): the reversal of that part of the invoice's entry. Dr 4600
 * net; Dr 2210 VAT and levies; Cr 1100 what the invoice still owed; Cr 2020 the rest, when the
 * invoice was already paid (prepaid credit, drawn on the next invoice). Key `P26:<creditNoteId>`.
 */
export function subscriptionCreditNoteLines(input: {
  readonly bookId: string;
  readonly invoiceId: string;
  readonly netMinor: number;
  readonly vatMinor: number;
  readonly toReceivableMinor: number;
  readonly toCreditMinor: number;
}): JournalLineDraft[] {
  const net = nonNegative(input.netMinor, 'The net amount');
  const vat = nonNegative(input.vatMinor, 'VAT and levies');
  const receivable = nonNegative(input.toReceivableMinor, 'What the invoice still owed');
  const credit = nonNegative(input.toCreditMinor, 'The credit');
  if (net + vat === 0)
    throw new DomainError('ledger.bad_amount', 'A credit note of nothing posts nothing');
  if (receivable + credit !== net + vat)
    throw new DomainError(
      'ledger.credit_does_not_add_up',
      'What a credit note clears and credits must equal its amount',
    );
  const dims = {
    bookId: id(input.bookId, 'The book'),
    invoiceLineId: id(input.invoiceId, 'The invoice'),
  };
  return compactLines([
    { ...dims, accountCode: '4600', amountMinor: net },
    { ...dims, accountCode: '2210', amountMinor: vat },
    { ...dims, accountCode: '1100', amountMinor: -receivable },
    { ...dims, accountCode: '2020', amountMinor: -credit },
  ]);
}

/**
 * P26 payment: Dr 1050 amount; Cr 1100 per invoice allocated (oldest first, decided by the
 * caller); Cr 2020 for whatever is left (prepaid credit). Key `P26:<paymentId>`. With `provider`,
 * the 1050 line carries it, as rent's clearing lines do, so the platform's clearing can be compared
 * with the provider (M10 review BE-26); the reversal carries it too.
 */
export function subscriptionPaymentLines(input: {
  readonly bookId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly allocations: readonly SubscriptionAllocation[];
  /** The provider holding the money until it pays the platform out (1050's dimension). */
  readonly provider?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The payment');
  const allocated = checkAllocations(amount, input.allocations);
  const dims = {
    bookId: id(input.bookId, 'The book'),
    paymentId: id(input.paymentId, 'The payment'),
  };
  if (input.provider !== undefined && input.provider !== null) id(input.provider, 'The provider');
  const clearing = input.provider ? { provider: input.provider } : {};
  return compactLines([
    { ...dims, ...clearing, accountCode: '1050', amountMinor: amount },
    ...input.allocations.map((a) => ({
      ...dims,
      accountCode: '1100' as const,
      amountMinor: -a.amountMinor,
      invoiceLineId: a.invoiceId,
    })),
    { ...dims, accountCode: '2020', amountMinor: -(amount - allocated) },
  ]);
}

/** P26 monthly draw on prepaid credit: Dr 2020; Cr 1100 on the invoice. Key `P26:<invoiceId>:prepaid`. */
export function prepaidDrawLines(input: {
  readonly bookId: string;
  readonly invoiceId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The draw');
  const dims = {
    bookId: id(input.bookId, 'The book'),
    invoiceLineId: id(input.invoiceId, 'The invoice'),
  };
  return [
    { ...dims, accountCode: '2020', amountMinor: amount },
    { ...dims, accountCode: '1100', amountMinor: -amount },
  ];
}

/**
 * P26 reversal of a payment, built from its allocations as they stand now (P21 style), never by
 * mirroring the original entry: Cr 1050 the amount; Dr 1100 per allocation; Dr 2020 for the
 * credit still held. The allocations include the payment's credit since drawn onto invoices (the
 * caller attributes draws to payments), so what is left is the credit not yet used.
 */
export function subscriptionPaymentReversalLines(input: {
  readonly bookId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly allocations: readonly SubscriptionAllocation[];
  readonly provider?: string | null;
}): JournalLineDraft[] {
  return reversalLines(subscriptionPaymentLines(input));
}

/**
 * Allocate a payment to open invoices oldest first (by issue date, then number, then id); the rest
 * is prepaid credit. Invoices with nothing outstanding take nothing.
 */
export function allocateSubscriptionPayment(
  amountMinor: number,
  openInvoices: readonly {
    readonly invoiceId: string;
    readonly issuedOn: string;
    readonly number: string;
    readonly outstandingMinor: number;
  }[],
): { allocations: SubscriptionAllocation[]; creditMinor: number } {
  let left = positive(amountMinor, 'The payment');
  const seen = new Set<string>();
  for (const invoice of openInvoices) {
    id(invoice.invoiceId, 'The invoice');
    if (seen.has(invoice.invoiceId))
      throw new DomainError(
        'ledger.duplicate_allocation',
        `Invoice ${invoice.invoiceId} is listed twice`,
      );
    seen.add(invoice.invoiceId);
    nonNegative(invoice.outstandingMinor, 'What an invoice owes');
  }
  const key = (i: (typeof openInvoices)[number]): string =>
    `${i.issuedOn}\u0000${i.number}\u0000${i.invoiceId}`;
  const oldestFirst = [...openInvoices].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  const allocations: SubscriptionAllocation[] = [];
  for (const invoice of oldestFirst) {
    if (left === 0) break;
    const take = Math.min(left, invoice.outstandingMinor);
    if (take === 0) continue;
    allocations.push({ invoiceId: invoice.invoiceId, amountMinor: take });
    left -= take;
  }
  return { allocations, creditMinor: left };
}
