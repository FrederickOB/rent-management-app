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
  currency: z.literal('GHS'),
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
  oldestUnbankedOn: isoDate.nullable(),
});

export const unmatchedReceiptSchema = z.object({
  paymentId: uuid,
  amountMinor: minor,
  receivedOn: isoDate,
  receivedInto: z.enum(RECEIVING_ACCOUNTS),
  ownerId: uuid.nullable(),
  ownerName: z.string().nullable(),
  senderReference: z.string().nullable(),
  note: z.string().nullable(),
  proofDocumentId: uuid.nullable(),
  createdAt: iso,
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
