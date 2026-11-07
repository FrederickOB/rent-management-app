import { oc } from '@orpc/contract';
import { TAX_ITEM_KINDS, TAX_ITEM_STATUSES, WITHHOLDING_TAX_TREATMENTS } from '@rent/domain/tax';
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
  /**
   * M5 review 8: the days its rules rows held (`rent_tax.due_days_after_receipt`,
   * `rent_tax.alert_days`), for text such as "due within N days"; never a hard-coded value.
   * Optional for clients written before.
   */
  dueDays: z.number().int().nullable().optional(),
  alertDays: z.array(z.number().int()).optional(),
  createdAt: iso,
});
export type RentTaxItemView = z.infer<typeof rentTaxItemSchema>;

/** Rent tax not assessed when the money posted (TX-08; M5 review 7), until a later run does. */
export const rentTaxNotAssessedSchema = z.object({
  /** The P17 key it is assessed on: `P17:<payment>`, `P17:<carry-over>` or `P17:<withholding>`. */
  eventKey: z.string(),
  event: z.enum(['receipt', 'carry_over', 'deposit_applied', 'withholding']),
  leaseId: uuid,
  ownerId: uuid,
  unitCode: z.string(),
  paymentId: uuid.nullable(),
  withholdingId: uuid.nullable(),
  valueDate: isoDate,
  /** `rule_missing`: no rules row in force; `rule_unsupported`: one this build cannot apply. */
  reason: z.enum(['rule_missing', 'rule_unsupported']),
  ruleKey: z.string().nullable(),
  message: z.string(),
  recordedAt: iso,
  /** A later run has assessed it (or left it for a person, when it had moved on). */
  assessed: z.boolean(),
});

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
    /**
     * M5 review 3: tax tenants withheld whose certificate is still awaited at the period's end.
     * The tenant pays it to GRA, so it is not in `outstandingMinor`. Optional for older clients.
     */
    withheldAwaitingCertificateMinor: minor.optional(),
    /** Rent tax the owner still owes GRA at the period's end (2200, less withheld tax awaiting certificates). */
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
  notAssessed: oc
    .route({
      method: 'GET',
      path: '/rent-tax/not-assessed',
      summary:
        'Receipts, carry-overs and withholdings whose rent tax was not assessed because a rules row was missing or unsupported (TX-08); a daily run assesses them once the rules allow',
    })
    .input(
      z.object({
        ownerId: uuid.optional(),
        /** true: only those still waiting; false: only those assessed since. */
        open: z.enum(['true', 'false']).optional(),
      }),
    )
    .output(z.array(rentTaxNotAssessedSchema)),
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
        'Record rent tax paid to GRA with its receipt, settling items: oldest due first unless chosen (P18). 409 INSUFFICIENT_AGENT_CASH when paid from the agency’s account beyond what it holds for the owner (record the owner’s funding first)',
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
  /**
   * M5 review 1: how its rent tax was treated when it was recorded, which the certificate (P20)
   * follows: `accrued` (settles 2200), `letting_business` (a tax credit, 1160) or `not_assessed`
   * (a rules row was missing). Null for withholding recorded before; optional for older clients.
   */
  rentTaxTreatment: z.enum(WITHHOLDING_TAX_TREATMENTS).nullable().optional(),
  /**
   * N1: what a person must act on, such as rent tax this withholding replaced that GRA was already
   * paid (the owner's rent tax is then overpaid). Optional for older clients.
   */
  warnings: z.array(z.string()).optional(),
  lines: z.array(
    z.object({
      lineId: uuid,
      invoiceNumber: z.string(),
      periodStart: isoDate.nullable(),
      periodEnd: isoDate.nullable(),
      lineAmountMinor: minor,
      withheldMinor: minor,
      /**
       * M5 decision 8: the month had not started, so the withholding is held as its advance and
       * drawn when the month starts. Optional for clients written before.
       */
      heldAsAdvance: z.boolean().optional(),
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
      /**
       * M5 decision 7 (OQ-29): in a single-user company the uploader confirms it themselves,
       * after the cooling-off, with a TOTP code, through this approval request
       * (`approvals.decide` with `self_confirm`). Null otherwise.
       */
      selfConfirmation: z
        .object({
          approvalId: uuid,
          status: z.enum([
            'pending',
            'cooling_off',
            'approved',
            'rejected',
            'cancelled',
            'expired',
          ]),
          coolingOffUntil: iso.nullable(),
        })
        .nullable()
        .optional(),
      /**
       * M5 review 4: the uploader's single-user request to withdraw it instead (rejected, nothing
       * posted), decided like `selfConfirmation`. Null otherwise; optional for older clients.
       */
      selfWithdrawal: z
        .object({
          approvalId: uuid,
          status: z.enum([
            'pending',
            'cooling_off',
            'approved',
            'rejected',
            'cancelled',
            'expired',
          ]),
          coolingOffUntil: iso.nullable(),
        })
        .nullable()
        .optional(),
      /**
       * M5 review 4: whether the person reading, its uploader, may raise a fresh request to
       * confirm or withdraw it (nobody else may decide it and no request is open).
       */
      mayRequestSelfDecision: z.boolean().optional(),
    })
    .nullable(),
  rejectedCertificates: z.number().int(),
  writeOff: z.object({ id: uuid, reason: z.string(), valueDate: isoDate }).nullable(),
  openWriteOffApprovalId: uuid.nullable(),
  createdAt: iso,
});
export type WithholdingView = z.infer<typeof withholdingSchema>;

/** What the withholding form needs for a lease (TX-04): its open months and the rule's rate. */
const withholdingOptionLine = z.object({
  lineId: uuid,
  invoiceId: uuid,
  invoiceNumber: z.string(),
  kind: z.enum(['rent', 'service_charge']),
  periodStart: isoDate,
  periodEnd: isoDate,
  /**
   * M5 decision 8: false for a month not yet started; its withholding is held as its
   * advance and drawn when the month starts. Optional for clients written before.
   */
  started: z.boolean().optional(),
  netMinor: minor,
  outstandingMinor: minor,
  /** The rate on the line's amount, at most what is still owed. */
  suggestedMinor: minor,
});

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
  /** Rent and service-charge months that have started and are still owed (P19 settles them). */
  lines: z.array(withholdingOptionLine),
  /**
   * M5 decision 8: invoiced months not yet started and still owed; withholding on them is held as
   * their advance (Dr 1150, Cr 2010) and drawn as each month starts. Optional for older clients.
   */
  advanceLines: z.array(withholdingOptionLine).optional(),
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
        /** Rent and service-charge lines; a month not yet started holds it as an advance (decision 8). */
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
  requestSelfDecision: oc
    .route({
      method: 'POST',
      path: '/withholding-certificates/{certificateId}/self-decision-requests',
      summary:
        'Its uploader asks to confirm or withdraw a certificate nobody else may decide, after the cooling-off with a TOTP code (decision 7, review 4)',
    })
    .input(z.object({ certificateId: uuid, decision: z.enum(['confirm', 'withdraw']) }))
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
      summary:
        'Record VAT and levies paid to GRA with a return, and GRA’s receipt (P33). 409 INSUFFICIENT_AGENT_CASH when paid from the agency’s account beyond what it holds for the owner (record the owner’s funding first)',
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
