import { oc } from '@orpc/contract';
import { TAX_ITEM_KINDS, TAX_ITEM_STATUSES } from '@rent/domain/tax';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * Rent tax, withholding and VAT returns (TX-01 to TX-04, TX-08, P17 to P20, P24, P33; M5 plan
 * section 5). Amounts are integer pesewas in `*Minor` fields. Every figure is derived from the
 * ledger and the tax items; nothing is editable. Each rules row an amount used is named, and
 * staff see a warning while it is not verified (CLAUDE.md section 7). Money writes take an
 * `Idempotency-Key` header, as in M4a.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const isoMonth = z.string().regex(/^\d{4}-\d{2}(-01)?$/, 'Use a month such as 2026-10');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);
const verification = z.enum(['verified', 'from_prd', 'unverified']);
export const PAID_FROM = ['owner_account', 'agency_account'] as const;

const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});
const download = z.object({ url: z.string() });

/** A rules row an item used (rate, base, rounding, service charge, due days, alert days). */
const ruleRef = z.object({ ruleId: uuid, key: z.string(), verificationStatus: verification });

export const rentTaxItemSchema = z.object({
  id: uuid,
  /**
   * receipt: tax on money received; carry_over: credit carried to a renewal and applied to rent;
   * withholding: tax the tenant withheld (no alerts); reversal and withholding_offset: corrections
   * of an earlier item (negative), naming it in `reversesItemId`.
   */
  kind: z.enum(TAX_ITEM_KINDS),
  status: z.enum(TAX_ITEM_STATUSES),
  leaseId: uuid,
  propertyId: uuid,
  unitId: uuid,
  tenantId: uuid,
  ownerId: uuid,
  paymentId: uuid.nullable(),
  withholdingId: uuid.nullable(),
  reversesItemId: uuid.nullable(),
  /** When the rent was received (or withheld, or reversed). */
  valueDate: isoDate,
  /** The period it is reported in (a locked month's late entries move to the open one). */
  accountingDate: isoDate,
  /** TX-02: 30 days after the value date by the rule; null on a correction. */
  dueDate: isoDate.nullable(),
  baseMinor: minor,
  rateBps: z.number().int(),
  taxMinor: minor,
  leaseUse: z.enum(['residential', 'commercial']),
  unitCode: z.string(),
  tenantName: z.string(),
  receiptNumber: z.string().nullable(),
  /** Corrections so far (negative), GRA payments settled, and what is still to pay GRA. */
  correctedMinor: minor,
  paidMinor: minor,
  outstandingMinor: minor,
  withholdingWrittenOff: z.boolean(),
  rules: z.array(ruleRef),
  /** A rule it used is not verified: show the warning. */
  warning: z.boolean(),
  createdAt: iso,
});
export type RentTaxItemView = z.infer<typeof rentTaxItemSchema>;

export const rentTaxDueItemSchema = rentTaxItemSchema.extend({
  /** Days from today to the due date (negative once overdue). */
  daysToDue: z.number().int(),
  /** TX-02: the alert days (21, 28 by the rule) reached, and those already sent. */
  alertsReached: z.array(z.number().int()),
  alertsSent: z.array(z.number().int()),
});

export const graPaymentSchema = z.object({
  id: uuid,
  ownerId: uuid,
  ownerName: z.string(),
  paidOn: isoDate,
  accountingDate: isoDate,
  amountMinor: minor,
  graReceiptNumber: z.string(),
  receiptDocumentId: uuid,
  paidFrom: z.enum(PAID_FROM),
  note: z.string().nullable(),
  items: z.array(
    z.object({
      itemId: uuid,
      receiptNumber: z.string().nullable(),
      unitCode: z.string(),
      valueDate: isoDate,
      amountMinor: minor,
    }),
  ),
  createdAt: iso,
});

export const rentTaxReportSchema = z.object({
  ownerId: uuid,
  ownerName: z.string(),
  ownerTin: z.string().nullable(),
  from: isoDate,
  to: isoDate,
  /** Items whose accounting date is in the period, each as it stood at the period's end. */
  items: z.array(rentTaxItemSchema),
  graPayments: z.array(graPaymentSchema),
  totals: z.object({
    baseMinor: minor,
    taxMinor: minor,
    withheldMinor: minor,
    paidToGraMinor: minor,
    settledByCertificatesMinor: minor,
    /** Rent tax payable (2200) at the period's end, withheld tax awaiting certificates included. */
    outstandingMinor: minor,
  }),
  /** One line per rules row used that is not verified (CLAUDE.md section 7). */
  warnings: z.array(z.string()),
});

const reportInput = z.object({ ownerId: uuid, from: isoDate, to: isoDate });

export const rentTaxContract = {
  items: oc
    .route({
      method: 'GET',
      path: '/rent-tax/items',
      summary: 'Rent tax items by owner, lease or payment and accounting dates (TX-01)',
    })
    .input(
      z.object({
        ownerId: uuid.optional(),
        leaseId: uuid.optional(),
        paymentId: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        status: z.enum(TAX_ITEM_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      }),
    )
    .output(z.array(rentTaxItemSchema)),
  due: oc
    .route({
      method: 'GET',
      path: '/rent-tax/due',
      summary:
        'Rent tax still to pay GRA, by due date, with the 21- and 28-day alerts (TX-02); withheld items never appear',
    })
    .input(z.object({ ownerId: uuid.optional() }))
    .output(z.array(rentTaxDueItemSchema)),
  report: oc
    .route({
      method: 'GET',
      path: '/rent-tax/report',
      summary: 'The per-owner rent tax report for a period, by accounting date (TX-03)',
    })
    .input(reportInput)
    .output(rentTaxReportSchema),
  reportCsv: oc
    .route({
      method: 'GET',
      path: '/rent-tax/report/csv',
      summary: 'The report as RFC 4180 CSV: the same period always gives the same bytes',
    })
    .input(reportInput)
    .output(
      z.object({ filename: z.string(), contentType: z.literal('text/csv'), content: z.string() }),
    ),
  requestReportPdf: oc
    .route({
      method: 'POST',
      path: '/rent-tax/report/pdf',
      summary: 'Queue the report as a PDF; poll its status',
    })
    .input(reportInput)
    .output(z.object({ renderRequestId: uuid })),
  reportPdf: oc
    .route({
      method: 'GET',
      path: '/rent-tax/report/pdf/{renderRequestId}',
      summary: 'A report PDF: rendering, or ready with its SHA-256 and a short-lived link',
    })
    .input(z.object({ renderRequestId: uuid }))
    .output(
      z.object({
        status: z.enum(['rendering', 'ready', 'failed']),
        documentId: uuid.nullable(),
        sha256: z.string().nullable(),
        url: z.string().nullable(),
      }),
    ),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/tax-uploads',
      summary: 'Upload GRA’s receipt (rent tax or VAT) or a withholding certificate (PDF or image)',
    })
    .input(
      z.object({
        purpose: z.enum(['gra_receipt', 'withholding_certificate']),
        contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
        sizeBytes: z.number().int().min(1).max(10_000_000),
      }),
    )
    .output(presignedUpload),
  graPayments: oc
    .route({ method: 'GET', path: '/gra-payments', summary: 'Rent tax paid to GRA (TX-03)' })
    .input(z.object({ ownerId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }))
    .output(z.array(graPaymentSchema)),
  recordGraPayment: oc
    .route({
      method: 'POST',
      path: '/gra-payments',
      summary:
        'Record rent tax paid to GRA with its receipt, settling items: oldest due first unless chosen (P18)',
    })
    .input(
      z.object({
        ownerId: uuid,
        paidOn: isoDate,
        amountMinor: positiveMinor,
        graReceiptNumber: z.string().trim().min(1).max(80),
        receiptUploadId: uuid,
        paidFrom: z.enum(PAID_FROM),
        /** The items it settles and how much of each; they add up to the amount. */
        items: z
          .array(z.object({ itemId: uuid, amountMinor: positiveMinor }))
          .max(500)
          .nullable()
          .optional(),
        note: optionalText(500),
      }),
    )
    .output(graPaymentSchema),
  file: oc
    .route({
      method: 'GET',
      path: '/tax-files/{documentId}/download',
      summary:
        'A short-lived link to a GRA receipt, a withholding certificate or a refund’s proof the person may see',
    })
    .input(z.object({ documentId: uuid }))
    .output(download),
};

// Withholding (TX-04) ---------------------------------------------------------------------------

export const WITHHOLDING_STATUSES = [
  'awaiting_certificate',
  'certificate_uploaded',
  'certified',
  'written_off',
] as const;

export const withholdingSchema = z.object({
  id: uuid,
  leaseId: uuid,
  paymentId: uuid.nullable(),
  ownerId: uuid,
  unitCode: z.string(),
  tenantName: z.string(),
  valueDate: isoDate,
  amountMinor: minor,
  /** The rate the rule gives (`withholding_tax.rate.*`, unverified), for comparison. */
  rateBps: z.number().int(),
  rule: ruleRef,
  /** The amount differs from the rate on its lines: shown, not refused (the tenant decides). */
  differsFromRate: z.boolean(),
  note: z.string().nullable(),
  lines: z.array(
    z.object({
      lineId: uuid,
      invoiceNumber: z.string(),
      periodStart: isoDate.nullable(),
      periodEnd: isoDate.nullable(),
      lineAmountMinor: minor,
      withheldMinor: minor,
    }),
  ),
  status: z.enum(WITHHOLDING_STATUSES),
  certificate: z
    .object({
      id: uuid,
      status: z.enum(['awaiting_confirmation', 'confirmed']),
      documentId: uuid,
      certificateNumber: z.string().nullable(),
      issuedOn: isoDate.nullable(),
      uploadedBy: uuid,
      uploadedByName: z.string().nullable().optional(),
      decidedBy: uuid.nullable(),
      decidedByName: z.string().nullable().optional(),
      decidedAt: iso.nullable(),
      rejectReason: z.string().nullable(),
      /** 2200 (settles the owner's rent tax) or 1160 (a credit for a letting business). */
      debitAccount: z.enum(['2200', '1160']).nullable(),
      /** Whether you may confirm or reject it (a user for the owner, never its uploader). */
      mayDecide: z.boolean(),
    })
    .nullable(),
  rejectedCertificates: z.number().int(),
  writeOff: z.object({ id: uuid, reason: z.string(), valueDate: isoDate }).nullable(),
  openWriteOffApprovalId: uuid.nullable(),
  createdAt: iso,
});
export type WithholdingView = z.infer<typeof withholdingSchema>;

/** What the withholding form needs for a lease (TX-04): its open months and the rule's rate. */
export const withholdingOptionsSchema = z.object({
  leaseId: uuid,
  valueDate: isoDate,
  /** `withholding_tax.rate.*` for the lease's use as of the day (unverified): a suggestion only. */
  rate: z.object({
    bps: z.number().int(),
    ruleId: uuid,
    key: z.string(),
    verificationStatus: verification,
    /** Show the warning: the rule is not verified. */
    warning: z.boolean(),
  }),
  /** Rent and service-charge months that have started and are still owed. */
  lines: z.array(
    z.object({
      lineId: uuid,
      invoiceId: uuid,
      invoiceNumber: z.string(),
      kind: z.enum(['rent', 'service_charge']),
      periodStart: isoDate,
      periodEnd: isoDate,
      netMinor: minor,
      outstandingMinor: minor,
      /** The rate on the line's amount, at most what is still owed. */
      suggestedMinor: minor,
    }),
  ),
  /** The lease's recent live payments, for "paid net with". */
  payments: z.array(
    z.object({
      paymentId: uuid,
      receivedOn: isoDate,
      amountMinor: minor,
      receiptNumber: z.string().nullable(),
    }),
  ),
});

export const withholdingContract = {
  options: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/withholding-options',
      summary:
        'The months a tenant can withhold on and the rate the rule gives, with its version and status (TX-04)',
    })
    .input(z.object({ leaseId: uuid, valueDate: isoDate.optional() }))
    .output(withholdingOptionsSchema),
  list: oc
    .route({
      method: 'GET',
      path: '/withholding',
      summary: 'Tax withheld by corporate tenants, with certificates (TX-04)',
    })
    .input(
      z.object({
        leaseId: uuid.optional(),
        paymentId: uuid.optional(),
        ownerId: uuid.optional(),
        status: z.enum(WITHHOLDING_STATUSES).optional(),
      }),
    )
    .output(z.array(withholdingSchema)),
  get: oc
    .route({ method: 'GET', path: '/withholding/{withholdingId}' })
    .input(z.object({ withholdingId: uuid }))
    .output(withholdingSchema),
  record: oc
    .route({
      method: 'POST',
      path: '/withholding',
      summary:
        'Record tax a corporate tenant withheld, pinned to the months it was withheld on (P19); its rent tax becomes the amount withheld',
    })
    .input(
      z.object({
        leaseId: uuid,
        /** The payment the tenant paid net with, when there is one. */
        paymentId: uuid.nullable().optional(),
        valueDate: isoDate,
        /** Rent and service-charge lines of months that have started. */
        lines: z
          .array(z.object({ lineId: uuid, amountMinor: positiveMinor }))
          .min(1)
          .max(60),
        note: optionalText(500),
      }),
    )
    .output(withholdingSchema),
  uploadCertificate: oc
    .route({
      method: 'POST',
      path: '/withholding/{withholdingId}/certificates',
      summary: 'Upload the withholding certificate; a user for the owner confirms it (decision 3)',
    })
    .input(
      z.object({
        withholdingId: uuid,
        uploadId: uuid,
        certificateNumber: optionalText(80),
        issuedOn: isoDate.nullable().optional(),
      }),
    )
    .output(withholdingSchema),
  confirmCertificate: oc
    .route({
      method: 'POST',
      path: '/withholding-certificates/{certificateId}/confirm',
      summary:
        'Confirm a certificate (P20): a user for the owner, or an agency admin for an owner with none; never its uploader',
    })
    .input(z.object({ certificateId: uuid }))
    .output(withholdingSchema),
  rejectCertificate: oc
    .route({
      method: 'POST',
      path: '/withholding-certificates/{certificateId}/reject',
      summary: 'Reject a certificate (the same people as confirm)',
    })
    .input(z.object({ certificateId: uuid, reason: z.string().trim().min(5).max(500) }))
    .output(withholdingSchema),
  requestWriteOff: oc
    .route({
      method: 'POST',
      path: '/withholding/{withholdingId}/write-off-requests',
      summary:
        'Ask to write off withholding whose certificate never came; a second person approves (P24)',
    })
    .input(z.object({ withholdingId: uuid, reason: z.string().trim().min(5).max(500) }))
    .output(z.object({ approval: approvalSchema })),
};

// VAT returns (P33) -------------------------------------------------------------------------------

export const vatPaymentSchema = z.object({
  id: uuid,
  ownerId: uuid,
  periodMonth: isoDate,
  paidOn: isoDate,
  accountingDate: isoDate,
  amountMinor: minor,
  graReceiptNumber: z.string(),
  receiptDocumentId: uuid,
  paidFrom: z.enum(PAID_FROM),
  note: z.string().nullable(),
  createdAt: iso,
});

export const vatReportSchema = z.object({
  ownerId: uuid,
  ownerName: z.string(),
  ownerTin: z.string().nullable(),
  month: isoDate,
  invoices: z.array(
    z.object({
      invoiceId: uuid,
      invoiceNumber: z.string(),
      unitCode: z.string(),
      tenantName: z.string(),
      tenantTin: z.string().nullable(),
      /** The tax point: the invoice, or the payment that made it issue (P32). */
      taxPoint: isoDate,
      vatMinor: minor,
      nhilMinor: minor,
      getfundMinor: minor,
      /** Credit notes on VAT and levy lines in the month (negative). */
      adjustmentsMinor: minor,
      totalMinor: minor,
    }),
  ),
  totals: z.object({
    vatMinor: minor,
    nhilMinor: minor,
    getfundMinor: minor,
    adjustmentsMinor: minor,
    totalMinor: minor,
    paidMinor: minor,
    outstandingMinor: minor,
  }),
  payments: z.array(vatPaymentSchema),
  warnings: z.array(z.string()),
});

export const vatContract = {
  report: oc
    .route({
      method: 'GET',
      path: '/vat/report',
      summary: 'VAT, NHIL and GETFund an owner charged in a month, by invoice and tax point (P32)',
    })
    .input(z.object({ ownerId: uuid, month: isoMonth }))
    .output(vatReportSchema),
  payments: oc
    .route({ method: 'GET', path: '/vat-payments', summary: 'VAT paid to GRA (P33)' })
    .input(z.object({ ownerId: uuid.optional(), periodMonth: isoMonth.optional() }))
    .output(z.array(vatPaymentSchema)),
  recordPayment: oc
    .route({
      method: 'POST',
      path: '/vat-payments',
      summary: 'Record VAT and levies paid to GRA with a return, and GRA’s receipt (P33)',
    })
    .input(
      z.object({
        ownerId: uuid,
        periodMonth: isoMonth,
        paidOn: isoDate,
        amountMinor: positiveMinor,
        graReceiptNumber: z.string().trim().min(1).max(80),
        receiptUploadId: uuid,
        paidFrom: z.enum(PAID_FROM),
        note: optionalText(500),
      }),
    )
    .output(vatPaymentSchema),
};
