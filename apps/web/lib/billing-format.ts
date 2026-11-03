import type {
  CASH_RECORD_STATUSES,
  InvoiceRow,
  LeaseBilling,
  MONEY_LOCATIONS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PaymentDetail,
  RECEIVING_ACCOUNTS,
  RECORDED_REVERSAL_REASONS,
  REVERSAL_REASONS,
} from '@rent/contracts';
import {
  AGE_BUCKET_LABELS,
  INVOICE_STATUS_LABELS,
  LINE_KIND_LABELS,
  type AgeBucket,
  type AllocationSource,
  type InvoiceStatus,
  type LineKind,
} from '@rent/domain/billing';
import { formatBusinessDate } from './business-dates';
import { formatMinor } from './tenancy-format';

// Words for the billing screens (M4a plan 4.19). What a figure is, and how it is worked out, is
// decided by the API and packages/domain; this file only says it. Amounts stay integer pesewas
// until they are formatted here, at the edge (CLAUDE.md section 4).

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type CashRecordStatus = (typeof CASH_RECORD_STATUSES)[number];
export type ReceivingAccount = (typeof RECEIVING_ACCOUNTS)[number];
export type ReversalReason = (typeof REVERSAL_REASONS)[number];
export type MoneyLocation = (typeof MONEY_LOCATIONS)[number];
export type InvoiceKind = InvoiceRow['kind'];

export const lineKindLabel = (kind: LineKind): string => LINE_KIND_LABELS[kind];
export const invoiceStatusLabel = (status: InvoiceStatus): string => INVOICE_STATUS_LABELS[status];
export const ageBucketLabel = (bucket: AgeBucket): string => AGE_BUCKET_LABELS[bucket];

export const INVOICE_KIND_LABELS: Record<InvoiceKind, string> = {
  cycle: 'Rent',
  deposit: 'Security deposit',
  one_off: 'Charge',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
  momo: 'Mobile money',
  card: 'Card',
  test: 'Test payment',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  confirmed: 'Received',
  unmatched: 'Not matched to a lease',
  reversed: 'Reversed',
};

/**
 * A cash record waits for a second person before anything posts (BC-05). A landlord who works
 * alone confirms it themselves after 24 hours (M4a decision 7), so the label fits both.
 */
export const CASH_RECORD_STATUS_LABELS: Record<CashRecordStatus, string> = {
  awaiting_approval: 'Recorded, waiting for confirmation',
  approved: 'Confirmed and posted',
  rejected: 'Rejected: not posted',
  cancelled: 'Cancelled: not posted',
};

export const RECEIVING_ACCOUNT_LABELS: Record<ReceivingAccount, string> = {
  owner_account: 'The owner’s own account',
  agency_account: 'The agency’s account',
};

/** Where a payment's money went when it arrived (P03, P06, P28). */
export const RECEIVED_INTO_LABELS: Record<MoneyLocation, string> = {
  provider: 'The payment provider',
  collector: 'The person who collected it',
  ...RECEIVING_ACCOUNT_LABELS,
};

export const REVERSAL_REASON_LABELS: Record<ReversalReason, string> = {
  bounced_cheque: 'The cheque bounced',
  wrong_entry: 'It was recorded by mistake',
  wrong_lease: 'It was recorded against the wrong lease',
  other: 'Another reason',
};

/** Where a reversed payment's money is taken back from (P21b). */
export const MONEY_LOCATION_LABELS: Record<MoneyLocation, string> = {
  collector: 'Still with the person who collected it',
  owner_account: 'In the owner’s own account',
  agency_account: 'In the agency’s account',
  provider: 'With the payment provider',
};

export type RecordedReversalReason = (typeof RECORDED_REVERSAL_REASONS)[number];

/**
 * A reversal's reason as recorded (P21b; M4b plan 4.8): a person's, which a second person
 * approved, or the payment provider's own, which needs no approval.
 */
export const RECORDED_REVERSAL_LABELS: Record<RecordedReversalReason, string> = {
  ...REVERSAL_REASON_LABELS,
  chargeback: 'A chargeback: the payer disputed it with their bank or network',
  provider_refund: 'Refunded to the payer through the payment provider',
};

const PROVIDER_REVERSALS: ReadonlySet<RecordedReversalReason> = new Set([
  'chargeback',
  'provider_refund',
]);

/**
 * A reversed payment in words (P21b; plan 4.8): who reversed it and why, where the money was
 * taken back from, and what followed. A chargeback or provider refund is deducted from a later
 * settlement, with a credit receipt and an alert to managers; it needs no approval.
 */
export function reversalSummary(reversal: NonNullable<PaymentDetail['reversal']>): {
  readonly title: string;
  readonly byProvider: boolean;
  readonly lines: readonly string[];
} {
  const byProvider = PROVIDER_REVERSALS.has(reversal.reason);
  const on = formatBusinessDate(reversal.valueDate);
  return {
    title: byProvider
      ? reversal.reason === 'chargeback'
        ? 'Reversed by a chargeback'
        : 'Refunded through the payment provider'
      : 'Reversed, with a second person’s approval',
    byProvider,
    lines: [
      `${RECORDED_REVERSAL_LABELS[reversal.reason]}, on ${on}.`,
      reversal.note.trim() ? `Note: ${reversal.note.trim()}` : null,
      byProvider
        ? 'The provider took the money back, so it comes off a later settlement. Its receipt stays, a credit receipt was issued and managers were alerted.'
        : `Where the money was: ${MONEY_LOCATION_LABELS[reversal.moneyNowIn].toLowerCase()}. Its receipt stays, and a credit receipt was issued.`,
    ].filter((line): line is string => line !== null),
  };
}

export const ALLOCATION_SOURCE_LABELS: Record<AllocationSource, string> = {
  payment: 'Payment',
  deposit: 'Deposit',
  withholding: 'Withholding tax',
  credit_note: 'Credit note',
  write_off: 'Write-off',
};

export const RECEIPT_KIND_LABELS: Record<'receipt' | 'credit_receipt', string> = {
  receipt: 'Receipt',
  credit_receipt: 'Credit receipt',
};

/** The file behind a money record (BC-05, P07, P28), which a person opens to check it. */
export type EvidenceKind = 'receipt_photo' | 'cheque_photo' | 'transfer_proof' | 'banking_slip';

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  receipt_photo: 'Open the receipt-book photo',
  cheque_photo: 'Open the cheque photo',
  transfer_proof: 'Open the transfer proof',
  banking_slip: 'Open the banking slip',
};

/** The file a payment of this method was recorded with: a photo for cash or a cheque, else a proof. */
export function evidenceOfMethod(method: PaymentMethod): EvidenceKind {
  const photos: Partial<Record<PaymentMethod, EvidenceKind>> = {
    cash: 'receipt_photo',
    cheque: 'cheque_photo',
  };
  return photos[method] ?? 'transfer_proof';
}

/** A rate in basis points as a percentage, without floating point: 1500 is `15%`, 250 `2.5%`. */
export function rateLabel(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = Math.abs(bps % 100);
  const fraction = rest === 0 ? '' : `.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
  return `${whole}${fraction}%`;
}

/** `1 Nov 2026 to 30 Nov 2026`, or null when a line has no period (a deposit, a one-off charge). */
export function periodLabel(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  return `${formatBusinessDate(from)} to ${formatBusinessDate(to)}`;
}

/** AR-02 partial cover, as prd-issues 17 words it: `plus GH₵450.00 towards the month starting …`. */
export function partialCoverLabel(partial: NonNullable<LeaseBilling['partial']>): string {
  return `plus ${formatMinor(partial.amountMinor)} towards the month starting ${formatBusinessDate(partial.monthStart)}`;
}

/**
 * Paid-until on the lease page (AR-02): the last day of the last whole month paid for, and what
 * has been paid towards the next month, when that month is only partly covered.
 */
export function paidUntilParts(billing: Pick<LeaseBilling, 'paidUntil' | 'partial'>): {
  readonly date: string;
  readonly partial: string | null;
} {
  if (billing.paidUntil)
    return {
      date: formatBusinessDate(billing.paidUntil),
      partial: billing.partial ? partialCoverLabel(billing.partial) : null,
    };
  if (billing.partial)
    return {
      date: 'Not a whole month yet',
      partial: `${formatMinor(billing.partial.amountMinor)} towards the month starting ${formatBusinessDate(billing.partial.monthStart)}`,
    };
  return { date: 'No rent paid yet', partial: null };
}

/** The whole paid-until line in one sentence, for a summary or a screen reader. */
export function paidUntilLabel(billing: Pick<LeaseBilling, 'paidUntil' | 'partial'>): string {
  const parts = paidUntilParts(billing);
  if (!parts.partial) return parts.date;
  return billing.paidUntil ? `${parts.date}, ${parts.partial}` : `${parts.date}: ${parts.partial}`;
}

/** Why a lease is not billed (M4a decision 5 and the lease's state). */
export const NOT_BILLED_LABELS: Record<NonNullable<LeaseBilling['notBilledReason']>, string> = {
  joint_owners:
    'This lease is not billed: its property has more than one owner. Record joint owners as one owner; statements will split by share later (PR-07).',
  not_signed: 'This lease is not billed yet: billing starts once it is signed.',
};

export interface MoneyFact {
  /** Stable, for tests and keys. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** A second line under the value, such as partial cover. */
  readonly detail?: string | null;
  readonly hint: string;
}

/**
 * The lease's money card (plan 4.19), every figure derived by the API from the ledger and its
 * sub-ledgers. "Overdue invoices" is what the invoices ask for; "Earned and unpaid" is what the
 * ledger holds as owed (plan 4.12), so a multi-month invoice does not confuse anyone.
 */
export function moneyFacts(billing: LeaseBilling): MoneyFact[] {
  const paid = paidUntilParts(billing);
  return [
    {
      key: 'due-now',
      label: 'Due now',
      value: formatMinor(billing.dueNowMinor),
      hint: 'Due today or earlier, and not yet paid.',
    },
    {
      key: 'overdue',
      label: 'Overdue invoices',
      value: formatMinor(billing.overdueMinor),
      hint: 'What invoices asked for by a date that has passed, still unpaid.',
    },
    {
      key: 'earned-unpaid',
      label: 'Earned and unpaid',
      value: formatMinor(billing.earnedUnpaidMinor),
      hint: 'Rent and charges for periods that have started, still unpaid.',
    },
    {
      key: 'paid-until',
      label: 'Paid until',
      value: paid.date,
      detail: paid.partial,
      hint: 'The last day of the last whole month paid for.',
    },
    {
      key: 'unearned-rent',
      label: 'Unearned rent',
      value: formatMinor(billing.unearnedRentMinor),
      hint: 'Rent paid ahead for months that have not started.',
    },
    {
      key: 'deposit-held',
      label: 'Deposit held',
      value: formatMinor(billing.depositHeldMinor),
      hint: 'Held for the tenant, never counted as income.',
    },
    {
      key: 'credit',
      label: 'Credit',
      value: formatMinor(billing.creditMinor),
      hint: 'Paid, and not yet used for any charge.',
    },
  ];
}
