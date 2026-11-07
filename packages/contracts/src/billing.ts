import { oc } from '@orpc/contract';
import {
  AGE_BUCKETS,
  ALLOCATION_SOURCES,
  INVOICE_STATUSES,
  LINE_KINDS,
} from '@rent/domain/billing';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * The ledger and billing (AC-01, BC-01, BC-05, BC-07, BC-08, BC-11, AR-01 to AR-03, CT-04; M4a
 * plan 4.18). Amounts are integer pesewas in `*Minor` fields; every balance is derived from the
 * ledger and its sub-ledgers. Money writes take an `Idempotency-Key` header (plan 4.15): a retry
 * with the same key and body returns the first response, and the same key with another body is
 * refused with 422.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);

export const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'momo', 'card', 'test'] as const;
export const PAYMENT_STATUSES = ['confirmed', 'unmatched', 'reversed'] as const;
export const CASH_RECORD_STATUSES = [
  'awaiting_approval',
  'approved',
  'rejected',
  'cancelled',
] as const;
/** Where money sits: the owner's own account, or the agency's client account. */
export const RECEIVING_ACCOUNTS = ['owner_account', 'agency_account'] as const;
export const REVERSAL_REASONS = ['bounced_cheque', 'wrong_entry', 'wrong_lease', 'other'] as const;
/** M4b: a reversal's reason as recorded, including those the provider causes (no request). */
export const RECORDED_REVERSAL_REASONS = [
  ...REVERSAL_REASONS,
  'chargeback',
  'provider_refund',
] as const;
/** M4b: why a pay link cannot be sent for a lease now (BC-04; plan 4.2). */
export const PAY_LINK_PROBLEMS = [
  'no_agreement',
  'no_active_account',
  'no_subaccount',
  'joint_owners',
  'not_billed',
  'nothing_due',
  'no_consent',
] as const;
/** Where a reversed payment's money is taken back from (P21b): see the payment's options. */
export const MONEY_LOCATIONS = [
  'collector',
  'owner_account',
  'agency_account',
  'provider',
] as const;

const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

const download = z.object({ url: z.string() });

/** A rule an amount was calculated with; staff see a warning while it is unverified (section 7). */
export const ruleUsedSchema = z.object({
  ruleId: uuid,
  key: z.string(),
  verificationStatus: z.enum(['verified', 'from_prd', 'unverified']),
});

const partial = z.object({ monthStart: isoDate, amountMinor: minor }).nullable();

export const invoiceLineSchema = z.object({
  id: uuid,
  kind: z.enum(LINE_KINDS),
  label: z.string(),
  /** For a VAT or levy line, the line it is charged on. */
  baseLineId: uuid.nullable(),
  rateBps: z.number().int().nullable(),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  dueDate: isoDate,
  amountMinor: minor,
  netMinor: minor,
  settledMinor: minor,
  creditedMinor: minor,
  writtenOffMinor: minor,
  outstandingMinor: minor,
  /** The most a credit note may take off this line now (P27, the domain's rule); 0 when none. */
  creditableMinor: minor,
  /** The most a write-off may take off this line now (P24: accrued and one-off lines); 0 when none. */
  writeOffableMinor: minor,
  /** Rent and service charge: income since its period started (P02). */
  accrued: z.boolean(),
  rule: ruleUsedSchema.nullable(),
});
export type InvoiceLineView = z.infer<typeof invoiceLineSchema>;

export const allocationSchema = z.object({
  id: uuid,
  invoiceLineId: uuid,
  invoiceId: uuid,
  invoiceNumber: z.string(),
  lineLabel: z.string(),
  source: z.enum(ALLOCATION_SOURCES),
  paymentId: uuid.nullable(),
  receiptNumber: z.string().nullable(),
  amountMinor: minor,
  valueDate: isoDate,
  accountingDate: isoDate,
  createdAt: iso,
});

export const invoiceRowSchema = z.object({
  id: uuid,
  number: z.string(),
  kind: z.enum(['cycle', 'deposit', 'one_off']),
  leaseId: uuid,
  tenantId: uuid,
  tenantName: z.string(),
  unitId: uuid,
  unitCode: z.string(),
  propertyId: uuid,
  propertyName: z.string(),
  ownerId: uuid,
  ownerName: z.string(),
  issueDate: isoDate,
  dueDate: isoDate,
  periodFrom: isoDate.nullable(),
  periodTo: isoDate.nullable(),
  totalMinor: minor,
  settledMinor: minor,
  outstandingMinor: minor,
  status: z.enum(INVOICE_STATUSES),
  overdue: z.boolean(),
  hasVat: z.boolean(),
  /** A line used a rules row that is not verified yet (VAT, CT-04). */
  unverifiedRules: z.boolean(),
  paymentReference: z.string(),
});
export type InvoiceRow = z.infer<typeof invoiceRowSchema>;

export const invoiceDetailSchema = invoiceRowSchema.extend({
  lines: z.array(invoiceLineSchema),
  allocations: z.array(allocationSchema),
  /** Snapshots taken when it was issued (CT-04): the tenant's and owner's names and TINs. */
  billedTo: z.object({ name: z.string(), tin: z.string().nullable() }),
  billedFrom: z.object({ name: z.string(), tin: z.string().nullable() }),
  documentId: uuid.nullable(),
  /** Why it was cancelled, for a system credit note (a lease that ended early). */
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  /** M4b (BC-09): each reminder ladder step recorded for this invoice, sent or skipped as missed. */
  reminders: z
    .array(
      z.object({
        offsetDays: z.number().int(),
        status: z.enum(['sent', 'skipped']),
        stepDate: isoDate,
        createdAt: iso,
      }),
    )
    .optional(),
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;

/** The lease's money card (plan 4.19), all derived. */
export const leaseBillingSchema = z.object({
  leaseId: uuid,
  paymentReference: z.string().nullable(),
  billingStartDate: isoDate.nullable(),
  /** Why the lease is not billed, if it is not: a property with more than one owner (decision 5). */
  notBilledReason: z.enum(['joint_owners', 'not_signed']).nullable(),
  dueNowMinor: minor,
  overdueMinor: minor,
  earnedUnpaidMinor: minor,
  paidUntil: isoDate.nullable(),
  partial,
  unearnedRentMinor: minor,
  depositHeldMinor: minor,
  creditMinor: minor,
  /**
   * Lines charged for periods after the lease's last day (a move-out recorded late): they stay
   * owed until a credit note is asked for and a second person approves it (P27).
   */
  chargedAfterEnd: z.array(
    z.object({
      lineId: uuid,
      invoiceId: uuid,
      invoiceNumber: z.string(),
      label: z.string(),
      periodStart: isoDate,
      periodEnd: isoDate,
      netMinor: minor,
      outstandingMinor: minor,
      creditableMinor: minor,
    }),
  ),
  currency: z.literal('GHS'),
  /**
   * M4b (BC-04): whether a pay link can be sent for the lease now, and if not, why: where the
   * owner's rent goes is not set, no usable settlement account, nothing due, no consented channel.
   */
  payLink: z
    .object({
      available: z.boolean(),
      reason: z.enum(PAY_LINK_PROBLEMS).nullable(),
      /** The reason in plain words. */
      text: z.string().nullable(),
      /** The oldest invoice with something to pay, the one a link would be sent for. */
      invoiceId: uuid.nullable(),
    })
    .optional(),
});
export type LeaseBilling = z.infer<typeof leaseBillingSchema>;

export const paymentRowSchema = z.object({
  id: uuid,
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(PAYMENT_STATUSES),
  amountMinor: minor,
  receivedOn: isoDate,
  leaseId: uuid.nullable(),
  tenantName: z.string().nullable(),
  unitCode: z.string().nullable(),
  propertyName: z.string().nullable(),
  ownerName: z.string().nullable(),
  /** Whose book it is in: the owner, or null for money waiting in the company book (P23). */
  ownerId: uuid.nullable(),
  /** Where the money went (P03, P06, P28): what a reversal and a match need to know. */
  receivedInto: z.enum(['provider', 'collector', 'owner_account', 'agency_account']),
  receiptId: uuid.nullable(),
  receiptNumber: z.string().nullable(),
  /** Its credit: what it has not paid towards any line yet. */
  creditMinor: minor,
  collectorName: z.string().nullable(),
  recordedByName: z.string().nullable(),
  payerName: z.string().nullable(),
  reference: z.string().nullable(),
  createdAt: iso,
});
export type PaymentRow = z.infer<typeof paymentRowSchema>;

export const receiptSchema = z.object({
  id: uuid,
  number: z.string(),
  kind: z.enum(['receipt', 'credit_receipt']),
  paymentId: uuid,
  amountMinor: minor,
  issuedAt: iso,
  documentId: uuid.nullable(),
  tenantName: z.string().nullable(),
  unitCode: z.string().nullable(),
  /**
   * M4b (BC-06): the receipt on its way to the tenant: queued, sent, not sent (no consent or no
   * address) or failed; the channel and the time from the payment's confirmation to the send.
   */
  delivery: z
    .object({
      status: z.enum(['queued', 'sent', 'not_sent', 'failed']),
      /** M6: the channel it went by, push and WhatsApp included (plan 4.9). */
      channel: z.enum(['push', 'whatsapp', 'sms', 'email']).nullable(),
      sentAt: iso.nullable(),
      latencyMs: z.number().int().nullable(),
    })
    .nullable()
    .optional(),
});

export const paymentDetailSchema = paymentRowSchema.extend({
  allocations: z.array(allocationSchema),
  receipts: z.array(receiptSchema),
  /** Paid-until on the lease after this payment, as its receipt shows it. */
  paidUntilAfter: isoDate.nullable(),
  chequeNumber: z.string().nullable(),
  chequeBank: z.string().nullable(),
  note: z.string().nullable(),
  proofDocumentId: uuid.nullable(),
  /** Where the money can be taken back from if it is reversed (P21b). */
  reversalOptions: z.array(z.enum(MONEY_LOCATIONS)),
  openApprovalId: uuid.nullable(),
  /**
   * M4b: where a provider payment settles, the owner's account or the agency's, as the unmatched
   * queue's `settlesInto` says; null for other money. Lets the match picker narrow to the owner.
   */
  settlesInto: z.enum(RECEIVING_ACCOUNTS).nullable().optional(),
  /** M4b: the reversal, once reversed: by a person (with approval) or by the provider (chargeback). */
  reversal: z
    .object({
      reason: z.enum(RECORDED_REVERSAL_REASONS),
      note: z.string(),
      moneyNowIn: z.enum(MONEY_LOCATIONS),
      valueDate: isoDate,
      approvalId: uuid.nullable(),
      createdAt: iso,
    })
    .nullable()
    .optional(),
});
export type PaymentDetail = z.infer<typeof paymentDetailSchema>;

export const cashRecordSchema = z.object({
  id: uuid,
  status: z.enum(CASH_RECORD_STATUSES),
  method: z.enum(['cash', 'cheque']),
  amountMinor: minor,
  receivedOn: isoDate,
  leaseId: uuid,
  tenantName: z.string(),
  unitCode: z.string(),
  payerName: z.string(),
  collectorPersonId: uuid,
  collectorName: z.string(),
  chequeNumber: z.string().nullable(),
  chequeBank: z.string().nullable(),
  photoDocumentId: uuid.nullable(),
  approvalId: uuid.nullable(),
  paymentId: uuid.nullable(),
  recordedByName: z.string(),
  createdAt: iso,
});

const awaiting = z.object({ approval: approvalSchema });

export const collectorCashSchema = z.object({
  collectorPersonId: uuid,
  collectorName: z.string(),
  ownerId: uuid,
  ownerName: z.string(),
  /** Undeposited cash and cheques (1060 for this collector in the owner's book). */
  heldMinor: minor,
  /** Banking waiting for approval: it still counts as held until approved. */
  bankingPendingMinor: minor,
  /** What a new banking may ask for now: what is held less banking waiting for approval. */
  bankableMinor: minor,
  oldestUnbankedOn: isoDate.nullable(),
});

export const unmatchedReceiptSchema = z.object({
  paymentId: uuid,
  amountMinor: minor,
  receivedOn: isoDate,
  /** M4b adds `provider`: money a payment provider holds until it settles (P23). */
  receivedInto: z.enum([...RECEIVING_ACCOUNTS, 'provider']),
  ownerId: uuid.nullable(),
  ownerName: z.string().nullable(),
  senderReference: z.string().nullable(),
  note: z.string().nullable(),
  proofDocumentId: uuid.nullable(),
  createdAt: iso,
  // M4b (BC-12), optional so clients written before M4b keep their types.
  method: z.enum(PAYMENT_METHODS).optional(),
  provider: z.string().nullable().optional(),
  providerReference: z.string().nullable().optional(),
  /** Where provider money settles: the owner's account or the agency's. */
  settlesInto: z.enum(RECEIVING_ACCOUNTS).nullable().optional(),
  payerName: z.string().nullable().optional(),
  /** The paying phone, masked; never the full number. */
  payerPhoneMasked: z.string().nullable().optional(),
  /** A refund to the payer already asked for (P31). */
  openRefund: z
    .object({
      refundId: uuid,
      approvalId: uuid,
      status: z.enum(['awaiting_approval', 'approved']),
    })
    .nullable()
    .optional(),
});

export const arrearsRowSchema = z.object({
  /** The tenant, property or owner id. */
  key: uuid,
  label: z.string(),
  buckets: z.record(z.enum(AGE_BUCKETS), minor),
  totalMinor: minor,
  oldestDueDate: isoDate,
  leaseIds: z.array(uuid),
});

export const arrearsSchema = z.object({
  asOf: isoDate,
  by: z.enum(['tenant', 'property', 'owner']),
  rows: z.array(arrearsRowSchema),
  totals: z.record(z.enum(AGE_BUCKETS), minor),
  totalMinor: minor,
});
export type Arrears = z.infer<typeof arrearsSchema>;

export const invoicesContract = {
  list: oc
    .route({ method: 'GET', path: '/invoices', summary: 'Invoices this person may see (BC-01)' })
    .input(
      z.object({
        status: z.enum(INVOICE_STATUSES).optional(),
        overdue: z.stringbool().optional(),
        leaseId: uuid.optional(),
        tenantId: uuid.optional(),
        propertyId: uuid.optional(),
        ownerId: uuid.optional(),
        dueFrom: isoDate.optional(),
        dueTo: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    )
    .output(z.array(invoiceRowSchema)),
  get: oc
    .route({ method: 'GET', path: '/invoices/{invoiceId}' })
    .input(z.object({ invoiceId: uuid }))
    .output(invoiceDetailSchema),
  document: oc
    .route({
      method: 'GET',
      path: '/invoices/{invoiceId}/document',
      summary: 'A short-lived link to the invoice PDF',
    })
    .input(z.object({ invoiceId: uuid }))
    .output(download),
  leaseBilling: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/billing',
      summary:
        'The lease’s money: due, overdue, paid-until, unearned rent, deposit held, credit and its payment reference (AR-02, AR-03)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(leaseBillingSchema),
  creditNote: oc
    .route({
      method: 'POST',
      path: '/invoice-lines/{lineId}/credit-notes',
      summary: 'Ask for a credit note on a line; a second person approves (P27)',
    })
    .input(
      z.object({
        lineId: uuid,
        amountMinor: positiveMinor,
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .output(awaiting),
  writeOff: oc
    .route({
      method: 'POST',
      path: '/invoice-lines/{lineId}/write-offs',
      summary: 'Ask to write off what is owed on a line; a second person approves (P24)',
    })
    .input(
      z.object({
        lineId: uuid,
        amountMinor: positiveMinor,
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .output(awaiting),
};

export const paymentsContract = {
  createUpload: oc
    .route({
      method: 'POST',
      path: '/payment-uploads',
      summary:
        'Upload a photo of a receipt-book page or cheque, a transfer proof or a banking slip (JPEG, PNG or PDF)',
    })
    .input(
      z.object({
        purpose: z.enum(['cash_photo', 'transfer_proof', 'banking_slip']),
        contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
        sizeBytes: z.number().int().min(1).max(10_000_000),
      }),
    )
    .output(presignedUpload),
  recordCash: oc
    .route({
      method: 'POST',
      path: '/cash-records',
      summary:
        'Record cash or a cheque received; nothing posts until a second person approves (BC-05, P06)',
    })
    .input(
      z.object({
        leaseId: uuid,
        method: z.enum(['cash', 'cheque']),
        amountMinor: positiveMinor,
        receivedOn: isoDate,
        payerName: z.string().trim().min(2).max(160),
        /** Who holds the money now; the person recording it when left out. */
        collectorPersonId: uuid.optional(),
        chequeNumber: optionalText(40),
        chequeBank: optionalText(80),
        photoUploadId: uuid,
        note: optionalText(500),
      }),
    )
    .output(z.object({ cashRecord: cashRecordSchema, approval: approvalSchema })),
  cashRecords: oc
    .route({
      method: 'GET',
      path: '/cash-records',
      summary: 'Cash and cheques recorded: a caretaker sees their own',
    })
    .input(
      z.object({
        status: z.enum(CASH_RECORD_STATUSES).optional(),
        leaseId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    )
    .output(z.array(cashRecordSchema)),
  recordTransfer: oc
    .route({
      method: 'POST',
      path: '/direct-receipts',
      summary:
        'Record a transfer straight into the owner’s or the agency’s account, with proof; a second person approves (P28). Without a lease it waits as unmatched (P23).',
    })
    .input(
      z.object({
        leaseId: uuid.nullable().optional(),
        receivedInto: z.enum(RECEIVING_ACCOUNTS),
        /** Whose account, when it went to an owner and no lease is given. */
        ownerId: uuid.nullable().optional(),
        amountMinor: positiveMinor,
        receivedOn: isoDate,
        senderReference: optionalText(80),
        proofUploadId: uuid,
        note: optionalText(500),
      }),
    )
    .output(awaiting),
  recordBanking: oc
    .route({
      method: 'POST',
      path: '/cash-bankings',
      summary:
        'Record a collector’s cash banked into the owner’s account or handed to the agency, with the slip; a second person approves (P07)',
    })
    .input(
      z.object({
        collectorPersonId: uuid,
        ownerId: uuid,
        bankedInto: z.enum(RECEIVING_ACCOUNTS),
        amountMinor: positiveMinor,
        bankedOn: isoDate,
        slipUploadId: uuid,
        note: optionalText(500),
      }),
    )
    .output(awaiting),
  collectorsCash: oc
    .route({
      method: 'GET',
      path: '/collectors/cash',
      summary: 'Undeposited cash per collector and owner; a caretaker sees their own (BC-05)',
    })
    .output(z.array(collectorCashSchema)),
  list: oc
    .route({ method: 'GET', path: '/payments' })
    .input(
      z.object({
        leaseId: uuid.optional(),
        tenantId: uuid.optional(),
        propertyId: uuid.optional(),
        ownerId: uuid.optional(),
        status: z.enum(PAYMENT_STATUSES).optional(),
        method: z.enum(PAYMENT_METHODS).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    )
    .output(z.array(paymentRowSchema)),
  get: oc
    .route({ method: 'GET', path: '/payments/{paymentId}' })
    .input(z.object({ paymentId: uuid }))
    .output(paymentDetailSchema),
  requestReversal: oc
    .route({
      method: 'POST',
      path: '/payments/{paymentId}/reversal-requests',
      summary:
        'Ask to reverse a payment (a bounced cheque, a wrong entry or a wrong lease); a second person approves (P21b)',
    })
    .input(
      z.object({
        paymentId: uuid,
        reason: z.enum(REVERSAL_REASONS),
        note: z.string().trim().min(5).max(500),
        moneyNowIn: z.enum(MONEY_LOCATIONS),
      }),
    )
    .output(awaiting),
  receipts: oc
    .route({ method: 'GET', path: '/receipts' })
    .input(
      z.object({
        leaseId: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    )
    .output(z.array(receiptSchema)),
  receiptDocument: oc
    .route({
      method: 'GET',
      path: '/receipts/{receiptId}/document',
      summary: 'A short-lived link to the receipt PDF',
    })
    .input(z.object({ receiptId: uuid }))
    .output(download),
  paymentFile: oc
    .route({
      method: 'GET',
      path: '/payment-files/{documentId}/download',
      summary:
        'A short-lived link to a cash or cheque photo, a transfer proof or a banking slip: for people who see billing, the approvers of its open request, and a caretaker for their own records (BC-05)',
    })
    .input(z.object({ documentId: uuid }))
    .output(download),
  unmatched: oc
    .route({
      method: 'GET',
      path: '/unmatched-receipts',
      summary: 'Money received before anyone knew its lease (P23)',
    })
    .output(z.array(unmatchedReceiptSchema)),
  match: oc
    .route({
      method: 'POST',
      path: '/unmatched-receipts/{paymentId}/match',
      summary: 'Match an unmatched receipt to a lease, which allocates it (P23)',
    })
    .input(z.object({ paymentId: uuid, leaseId: uuid }))
    .output(paymentDetailSchema),
};

export const arrearsContract = {
  get: oc
    .route({
      method: 'GET',
      path: '/arrears',
      summary: 'Overdue invoice lines aged by days past due, as of a date (BC-08)',
    })
    .input(
      z.object({
        asOf: isoDate.optional(),
        by: z.enum(['tenant', 'property', 'owner']).default('tenant'),
      }),
    )
    .output(arrearsSchema),
};

// M5: early termination (AR-04), advance rent (AR-05) and the paid-until prompt (AR-06) -------------

const termAmount = z.object({
  description: z.string().trim().min(2).max(120),
  amountMinor: positiveMinor,
});

/** The settlement step by step (plan 5.4): what staff see before asking, and the approver decides. */
export const earlyTerminationFiguresSchema = z.object({
  leaseId: uuid,
  lastDay: isoDate,
  endDate: isoDate,
  /** The break clause credits the unused days of the last month (prd-issues 36). */
  breakClauseCreditsUnusedDays: z.boolean(),
  creditBeforeMinor: minor,
  chargesMinor: minor,
  unusedDays: z.array(
    z.object({
      lineId: uuid,
      periodStart: isoDate.nullable(),
      periodEnd: isoDate.nullable(),
      unusedDays: z.number().int(),
      periodDays: z.number().int(),
      creditMinor: minor,
    }),
  ),
  unusedDaysCreditMinor: minor,
  /** The lease's credit applied to open lines, oldest first (P13). */
  appliedMinor: minor,
  /** What the credit paid on each open line, oldest first; deductions included. */
  appliedLines: z.array(
    z.object({
      lineId: uuid,
      invoiceNumber: z.string(),
      label: z.string(),
      periodStart: isoDate.nullable(),
      periodEnd: isoDate.nullable(),
      amountMinor: minor,
    }),
  ),
  /** Credit left after the open lines, before deductions. */
  creditLeftMinor: minor,
  deductionsMinor: minor,
  /** Refunded with two-person approval (P13), paid outside the platform. */
  refundMinor: minor,
  /** Still owed after the credit: arrears that stay on the lease (deposit at move-out, P24). */
  arrearsMinor: minor,
});

export const EARLY_TERMINATION_STATUSES = [
  'awaiting_approval',
  'settled',
  'refund_paid',
  'rejected',
] as const;

/**
 * An early termination asked for, with its settlement step by step as the request showed it (the
 * figures the approver decides on): charges, unused-day credit per line, the credit applied per
 * line, deductions, the refund and what is still owed.
 */
export const earlyTerminationSchema = earlyTerminationFiguresSchema.extend({
  id: uuid,
  status: z.enum(EARLY_TERMINATION_STATUSES),
  approvalId: uuid,
  charges: z.array(termAmount),
  deductions: z.array(termAmount),
  note: z.string().nullable(),
  settledOn: isoDate.nullable(),
  paid: z
    .object({
      paidOn: isoDate,
      paidFrom: z.enum(RECEIVING_ACCOUNTS),
      reference: z.string(),
      proofDocumentId: uuid,
    })
    .nullable(),
  createdAt: iso,
});

export const earlyTerminationContract = {
  preview: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/early-termination/preview',
      summary:
        'The early-termination settlement step by step, as it would be done now; nothing is kept (AR-04)',
    })
    .input(
      z.object({
        leaseId: uuid,
        charges: z.array(termAmount).max(20).default([]),
        deductions: z.array(termAmount).max(20).default([]),
      }),
    )
    .output(earlyTerminationFiguresSchema),
  request: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/early-termination',
      summary:
        'Ask for the settlement and its refund (lease.refund); a second person approves, and it is done then (P13)',
    })
    .input(
      z.object({
        leaseId: uuid,
        charges: z.array(termAmount).max(20).default([]),
        deductions: z.array(termAmount).max(20).default([]),
        note: optionalText(500),
      }),
    )
    .output(z.object({ termination: earlyTerminationSchema, approval: approvalSchema })),
  list: oc
    .route({ method: 'GET', path: '/early-terminations', summary: 'Early terminations (AR-04)' })
    .input(z.object({ leaseId: uuid.optional() }))
    .output(z.array(earlyTerminationSchema)),
  get: oc
    .route({
      method: 'GET',
      path: '/early-terminations/{terminationId}',
      summary: 'An early termination with its settlement step by step (AR-04)',
    })
    .input(z.object({ terminationId: uuid }))
    .output(earlyTerminationSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/refund-uploads',
      summary: 'Upload the proof a refund was paid (PDF or image)',
    })
    .input(
      z.object({
        contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
        sizeBytes: z.number().int().min(1).max(10_000_000),
      }),
    )
    .output(presignedUpload),
  recordRefundPaid: oc
    .route({
      method: 'POST',
      path: '/early-terminations/{terminationId}/refund-paid',
      summary:
        'Record the approved refund as paid outside the platform, with a reference and proof (P13). 409 INSUFFICIENT_AGENT_CASH when paid from the agency’s account beyond what it holds for the owner (record the owner’s funding first)',
    })
    .input(
      z.object({
        terminationId: uuid,
        paidOn: isoDate,
        paidFrom: z.enum(RECEIVING_ACCOUNTS),
        reference: z.string().trim().min(2).max(120),
        proofUploadId: uuid,
      }),
    )
    .output(earlyTerminationSchema),
};

const advanceRule = z.object({
  ruleId: uuid,
  key: z.string(),
  verificationStatus: z.enum(['verified', 'from_prd', 'unverified']),
});

const paymentAdvanceRow = z.object({
  paymentId: uuid,
  valueDate: isoDate,
  monthsAhead: z.number().int(),
  limitMonths: z.number().int().nullable(),
  ruleId: uuid.nullable(),
  policy: z.enum(['off', 'warn', 'block']),
  /** Over the limit for the lease's term (recorded under every policy). */
  overLimit: z.boolean(),
  /** Flagged for a person: over the limit under warn or block. */
  flagged: z.boolean(),
});

export const leaseAdvanceSchema = z.object({
  leaseId: uuid,
  /** The company's `advance_rent_policy`: off records only; warn flags; block refuses on forms. */
  policy: z.enum(['off', 'warn', 'block']),
  /** Whole months paid beyond the current one today, from the forward walk. */
  monthsAheadNow: z.number().int(),
  /** The limit for the lease's term (Act 220 s.25(5), unverified); null where none applies. */
  limitMonths: z.number().int().nullable(),
  rule: advanceRule.nullable(),
  overLimitNow: z.boolean(),
  /** Payments flagged over the limit under warn or block (AR-05). Never "compliant". */
  flaggedPayments: z.array(paymentAdvanceRow),
  /** Every payment's months paid ahead, as recorded when it was received (AR-05). */
  payments: z.array(paymentAdvanceRow),
});

/** AR-05 for one payment, as recorded when it arrived; null for money with no lease yet. */
export const paymentAdvanceSchema = z
  .object({
    paymentId: uuid,
    leaseId: uuid,
    valueDate: isoDate,
    monthsAhead: z.number().int(),
    policy: z.enum(['off', 'warn', 'block']),
    limitMonths: z.number().int().nullable(),
    overLimit: z.boolean(),
    flagged: z.boolean(),
    rule: advanceRule.nullable(),
  })
  .nullable();

export const advanceComplianceSchema = z.object({
  policy: z.enum(['off', 'warn', 'block']),
  rows: z.array(
    z.object({
      leaseId: uuid,
      unitCode: z.string(),
      propertyName: z.string(),
      tenantName: z.string(),
      paymentId: uuid,
      receivedOn: isoDate,
      monthsAhead: z.number().int(),
      limitMonths: z.number().int(),
      policy: z.enum(['warn', 'block']),
      rule: advanceRule.nullable(),
      createdAt: iso,
    }),
  ),
});

export const paidUntilEndingSchema = z.object({
  leaseId: uuid,
  unitCode: z.string(),
  propertyName: z.string(),
  tenantName: z.string(),
  endDate: isoDate,
  paidUntil: isoDate,
  daysLeft: z.number().int(),
  /** When AR-06's prompt went for this paid-until date; null if it has not. */
  promptedOn: isoDate.nullable(),
});

export const advanceRentContract = {
  compliance: oc
    .route({
      method: 'GET',
      path: '/compliance/advance-rent',
      summary:
        'Payments over the advance rent limit, flagged under warn or block, with the rule version (AR-05)',
    })
    .output(advanceComplianceSchema),
  payment: oc
    .route({
      method: 'GET',
      path: '/payments/{paymentId}/advance',
      summary:
        'Months a payment paid ahead, against the limit, as recorded when it arrived (AR-05)',
    })
    .input(z.object({ paymentId: uuid }))
    .output(paymentAdvanceSchema),
  lease: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/advance',
      summary: 'Months paid ahead, the limit and flagged payments for a lease (AR-05)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(leaseAdvanceSchema),
  paidUntilEnding: oc
    .route({
      method: 'GET',
      path: '/leases/paid-until-ending',
      summary:
        'Leases whose paid-until is within the renewal-prompt lead (90 days), with the prompt sent (AR-06)',
    })
    .input(z.object({ days: z.coerce.number().int().min(1).max(366).optional() }))
    .output(z.array(paidUntilEndingSchema)),
};
