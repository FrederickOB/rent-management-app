import { oc } from '@orpc/contract';
import { AGE_BUCKETS } from '@rent/domain/billing';
import { FEE_KINDS, GRA_PAYERS, REMITTANCE_METHODS } from '@rent/domain/ledger';
import {
  AGENT_CASH_IN,
  AGENT_CASH_OUT,
  COLLECTION_METHODS,
  STATEMENT_CHECKS,
} from '@rent/domain/reporting';
import { z } from 'zod';

/**
 * Owner reporting (M9: AC-02 to AC-05, DA-01, DA-02, DA-06, the Gate 1 metrics and the compliance
 * list). Amounts are integer pesewas in `*Minor` fields; ratios are basis points (`bps`, null when
 * there is nothing to divide by); business dates are `YYYY-MM-DD` in the company's time zone and a
 * month is `YYYY-MM`; instants are UTC. Statements, fees and remittances are Growth only (decision
 * 13): a Starter company is refused with 403 `NOT_ON_PLAN`. The dashboard, compliance list and
 * Gate 1 metrics are on every plan. Owners and their advisers read within owner scope. Money
 * writes require an `Idempotency-Key`: a retry with it returns the first answer, the same key with
 * another body is refused (422).
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month such as 2026-10');
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);
const named = z.object({ id: uuid, name: z.string() });
const download = z.object({ url: z.string(), expiresAt: iso });
const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

/** A share: numerator over denominator, in basis points (null when the denominator is zero). */
export const ratioSchema = z.object({
  numerator: minor,
  denominator: minor,
  bps: minor.nullable(),
});

// Fee terms (AC-02; decision 1, and who pays GRA: founder decision, 2026-11-05) ------------------

export const feeTermsSchema = z.object({
  /** `none`, a percentage of the OQ-31 base per receipt, or a fixed amount per unit per month. */
  kind: z.enum(FEE_KINDS),
  /** For `percentage`: 1 to 10,000 basis points (8% = 800). */
  rateBps: minor.nullable(),
  /** For `fixed_per_unit`: pesewas per billable unit per month (D8). */
  fixedMinor: minor.nullable(),
  /** Who pays the owner's rent tax to GRA. When the agency does, its payable is held back. */
  graPaidBy: z.enum(GRA_PAYERS),
  effectiveFrom: isoDate,
});
export type FeeTermsView = z.infer<typeof feeTermsSchema>;

export const ownerFeeTermsSchema = z.object({
  owner: named,
  /** In force today; null when none was ever set (no fee, the owner pays GRA). */
  current: feeTermsSchema.nullable(),
  /** Approved, taking effect later. */
  upcoming: z.array(feeTermsSchema),
  /** Waiting for a second person (`management_fee_terms.change`). */
  pending: z.object({ approvalId: uuid, terms: feeTermsSchema }).nullable(),
  /** Properties the owner shares with another owner: no fixed fee is charged on them. */
  coOwnedProperties: z.array(named),
});

const feeTermsInput = z.object({
  ownerId: uuid,
  kind: z.enum(FEE_KINDS),
  rateBps: z.number().int().min(1).max(10_000).nullable().optional(),
  fixedMinor: positiveMinor.nullable().optional(),
  graPaidBy: z.enum(GRA_PAYERS),
  effectiveFrom: isoDate,
});

export const feeTermsContract = {
  get: oc
    .route({ method: 'GET', path: '/owners/{ownerId}/fee-terms' })
    .input(z.object({ ownerId: uuid }))
    .output(ownerFeeTermsSchema),
  request: oc
    .route({
      method: 'POST',
      path: '/owners/{ownerId}/fee-terms',
      summary:
        'Ask to change an agency-managed owner’s fee terms and who pays GRA from a date: a new version, approved by a second person (`management_fee_terms.change`). No backfill: receipts before it carry the terms then in force. 409 NOT_AN_AGENCY, 400 FEE_TERMS or EFFECTIVE_FROM_PAST',
    })
    .input(feeTermsInput)
    .output(ownerFeeTermsSchema),
};

// Owner statements (AC-04; decisions 5 to 7 and 15) ----------------------------------------------

const byKeys = <K extends readonly [string, ...string[]]>(keys: K) =>
  z.object(Object.fromEntries(keys.map((k) => [k, minor])) as { [P in K[number]]: typeof minor });

const cashSection = z.object({
  collectionsByMethod: byKeys(COLLECTION_METHODS),
  collectionsMinor: minor,
  expensesByCategory: z.array(z.object({ category: z.string(), amountMinor: minor })),
  expensesMinor: minor,
  feesMinor: minor,
  rentTaxAccruedMinor: minor,
  rentTaxPaidMinor: minor,
});

const accrualSection = z.object({
  rentEarnedMinor: minor,
  serviceChargeEarnedMinor: minor,
  earnedMinor: minor,
  /**
   * Unearned rent, split by invoice (founder decision, 2026-11-07): money allocated to rent lines
   * whose charge period has not started, as of the month's end.
   */
  unearnedRentMinor: minor,
  /** The same for service-charge lines. */
  unearnedServiceChargeMinor: minor,
  /** "Paid ahead, not yet applied to a month": the rest of 2010. */
  creditMinor: minor,
  /** All of 2010: unearned rent + unearned service charge + credit. */
  unearnedMinor: minor,
  depositsHeldMinor: minor,
  arrearsByBucket: byKeys(AGE_BUCKETS),
  arrearsMinor: minor,
});

const occupancySummary = z.object({
  units: minor,
  lettable: minor,
  occupied: minor,
  vacant: minor,
  available: minor,
  reserved: minor,
  underRepair: minor,
  notLettable: minor,
  rate: ratioSchema,
});

const statementPage = z.object({
  /** Null for the summary page. */
  propertyId: uuid.nullable(),
  cash: cashSection,
  accrual: accrualSection,
  occupancy: occupancySummary,
});

/** The figures of a statement (`ownerStatementFigures` in `@rent/domain/reporting`). */
export const ownerStatementFiguresSchema = z.object({
  ownerId: uuid,
  month,
  firstDay: isoDate,
  lastDay: isoDate,
  properties: z.array(statementPage),
  summary: statementPage,
  processingFeesMinor: minor,
  rentTaxPayable: z
    .object({
      openingMinor: minor,
      accruedMinor: minor,
      paidMinor: minor,
      certifiedMinor: minor,
      closingMinor: minor,
    })
    .nullable(),
  /** Null for an owner whose rent the agent does not hold (a self-managing landlord). */
  agent: z
    .object({
      openingMinor: minor,
      in: byKeys(AGENT_CASH_IN),
      out: byKeys(AGENT_CASH_OUT),
      inMinor: minor,
      outMinor: minor,
      closingMinor: minor,
      feesDueOpeningMinor: minor,
      feesChargedMinor: minor,
      feesTakenMinor: minor,
      feesSettledAtSourceMinor: minor,
      feesDueClosingMinor: minor,
      reserveMinor: minor,
      graPaidBy: z.enum(GRA_PAYERS).nullable(),
      rentTaxHeldBackMinor: minor,
      netRemittableMinor: minor,
      remittancesMadeMinor: minor,
    })
    .nullable(),
  checks: z.array(
    z.object({
      name: z.enum(STATEMENT_CHECKS),
      scope: z.string(),
      expectedMinor: minor,
      actualMinor: minor,
      passed: z.boolean(),
    }),
  ),
});
export type OwnerStatementFiguresView = z.infer<typeof ownerStatementFiguresSchema>;

export const OWNER_STATEMENT_STATUSES = ['draft', 'issued'] as const;

export const ownerStatementSchema = z.object({
  id: uuid,
  owner: named,
  month,
  status: z.enum(OWNER_STATEMENT_STATUSES),
  /** When these figures were worked out (a draft is worked out again on each read). */
  generatedAt: iso,
  issuedAt: iso.nullable(),
  issuedBy: z.object({ personId: uuid, name: z.string() }).nullable(),
  /** SHA-256 of the issued PDF; null for a draft, or while its PDF renders. */
  sha256: z.string().nullable(),
  /** The owner's time zone, in which times are shown (decision 5; DO-04). */
  ownerTimeZone: z.string(),
  /** The company's: the month is a calendar month there. */
  companyTimeZone: z.string(),
  /** When the email with the PDF was queued (`owner_statement` purpose); null until then. */
  sentAt: iso.nullable(),
  /** When the email provider reported it delivered; null until it does. */
  deliveredAt: iso.nullable(),
  /** Why no email went: no address on record, no email consent, or an opt-out (CM-09). */
  emailNotSentReason: z.enum(['no_email', 'no_consent', 'opted_out']).nullable(),
});
export type OwnerStatementView = z.infer<typeof ownerStatementSchema>;

export const ownerStatementDetailSchema = ownerStatementSchema.extend({
  figures: ownerStatementFiguresSchema,
  /** Property names for the pages. */
  properties: z.array(named),
  /** Expenses of the month, each with its receipt flag (M8 F3: "No receipt"). */
  expenses: z.array(
    z.object({
      id: uuid,
      propertyId: uuid,
      category: z.string(),
      supplierName: z.string(),
      expenseDate: isoDate,
      amountMinor: minor,
      noReceipt: z.boolean(),
    }),
  ),
  /**
   * For an issued statement: whether working the month out again still gives the issued figures
   * (AC-04 ★). Null for a draft.
   */
  matchesIssued: z.boolean().nullable(),
  actions: z.object({ issue: z.boolean(), regenerate: z.boolean() }),
});
export type OwnerStatementDetail = z.infer<typeof ownerStatementDetailSchema>;

export const ownerStatementsContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/owner-statements',
      summary:
        'Owner statements, newest month first; an owner and their adviser see their own only',
    })
    .input(
      z.object({
        ownerId: uuid.optional(),
        month: month.optional(),
        status: z.enum(OWNER_STATEMENT_STATUSES).optional(),
      }),
    )
    .output(z.array(ownerStatementSchema)),
  get: oc
    .route({ method: 'GET', path: '/owner-statements/{statementId}' })
    .input(z.object({ statementId: uuid }))
    .output(ownerStatementDetailSchema),
  draft: oc
    .route({
      method: 'POST',
      path: '/owner-statements',
      summary:
        'Draft (or work out again) an owner’s statement for a past month; one per owner and month. 409 STATEMENT_ISSUED once issued, MONTH_NOT_OVER for this month or later',
    })
    .input(z.object({ ownerId: uuid, month }))
    .output(ownerStatementDetailSchema),
  issue: oc
    .route({
      method: 'POST',
      path: '/owner-statements/{statementId}/issue',
      summary:
        'Issue a drafted statement (managers, agency admins, accountants): its figures are frozen, its month is locked for the owner’s book, its PDF is rendered and fingerprinted, and it is emailed to the owner’s contacts with email consent. 409 STATEMENT_ISSUED, STATEMENT_UNBALANCED',
    })
    .input(z.object({ statementId: uuid }))
    .output(ownerStatementDetailSchema),
  document: oc
    .route({
      method: 'GET',
      path: '/owner-statements/{statementId}/document',
      summary:
        'A 5-minute link to the issued statement’s PDF. 409 STATEMENT_RENDERING while it renders',
    })
    .input(z.object({ statementId: uuid }))
    .output(download),
};

// Remittances, fees taken and owner funding (AC-05; decision 8) ----------------------------------

export const OWNER_MONEY_KINDS = ['remittance', 'fees_taken', 'owner_funding'] as const;

export const ownerMoneySchema = z.object({
  id: uuid,
  kind: z.enum(OWNER_MONEY_KINDS),
  owner: named,
  /** The date of the transfer. */
  on: isoDate,
  /** For a remittance: what the owner received (net); for fees taken and funding: the amount. */
  amountMinor: minor,
  /** For a remittance: the fees retained out of it (P16). */
  feesRetainedMinor: minor,
  method: z.enum(REMITTANCE_METHODS).nullable(),
  reference: z.string().nullable(),
  hasProof: z.boolean(),
  recordedAt: iso,
  recordedByName: z.string().nullable(),
  /** Set once reversed (P21a): the record stays, with its reversal. */
  reversed: z
    .object({ at: iso, on: isoDate, reason: z.string(), byName: z.string().nullable() })
    .nullable(),
});
export type OwnerMoneyView = z.infer<typeof ownerMoneySchema>;

export const remittanceSuggestionSchema = z.object({
  owner: named,
  asOf: isoDate,
  /** The owner's money held by the agent (1070). */
  agentCashMinor: minor,
  /** Fees charged and not yet taken (2300). */
  feesDueMinor: minor,
  graPaidBy: z.enum(GRA_PAYERS),
  /** Rent tax payable held back when the agency pays GRA (2200). */
  rentTaxHeldBackMinor: minor,
  /** The suggestion (`suggestRemittance`): total out of 1070, fees retained, net to the owner. */
  totalMinor: minor,
  feesRetainedMinor: minor,
  netMinor: minor,
  /**
   * What to record: a remittance (`remit`), fees taken on their own when the fees due use up
   * everything remittable (`take_fees`), or nothing at all (`nothing`: "Nothing to remit").
   */
  proposal: z.enum(['remit', 'take_fees', 'nothing']),
  /**
   * Rent tax in 2200 the tenant withheld, waiting for its certificate (1150): not paid to GRA by
   * the agency, so not held back (architecture worked example B).
   */
  rentTaxWithheldMinor: minor,
  /** More fees taken than were charged (2300 above zero): flagged, never clamped silently. */
  feesOverTakenMinor: minor,
});

const transfer = z.object({
  ownerId: uuid,
  on: isoDate,
  method: z.enum(REMITTANCE_METHODS),
  reference: z.string().trim().min(2).max(120),
  /** Proof of the transfer (POST /owner-money-uploads). */
  proofUploadId: uuid,
});

export const ownerMoneyContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/owner-money',
      summary: 'Remittances, fees taken and owner funding, newest first',
    })
    .input(z.object({ ownerId: uuid.optional(), kind: z.enum(OWNER_MONEY_KINDS).optional() }))
    .output(z.array(ownerMoneySchema)),
  suggestion: oc
    .route({ method: 'GET', path: '/owners/{ownerId}/remittance-suggestion' })
    .input(z.object({ ownerId: uuid }))
    .output(remittanceSuggestionSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/owner-money-uploads',
      summary: 'Upload proof of a transfer (PDF, JPEG, PNG or WebP; 10 MB)',
    })
    .input(
      z.object({
        contentType: z.string().max(100),
        sizeBytes: z.number().int().min(1).max(10_000_000),
      }),
    )
    .output(presignedUpload),
  remit: oc
    .route({
      method: 'POST',
      path: '/remittances',
      summary:
        'Record a remittance already made, with proof (P16: Dr 1010 net, Dr 2300 fees retained, Cr 1070). 409 OVER_AGENT_CASH (more than the agent holds for the owner: record the owner’s funding first), FEES_OVER_DUE, INTO_RENT_TAX. Requires an Idempotency-Key',
    })
    .input(transfer.extend({ netMinor: positiveMinor, feesRetainedMinor: minor.min(0) }))
    .output(ownerMoneySchema),
  takeFees: oc
    .route({
      method: 'POST',
      path: '/fees-taken',
      summary:
        'Record fees taken without a remittance (Dr 2300, Cr 1070). 409 FEES_OVER_DUE, OVER_AGENT_CASH (more than the agent holds for the owner). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        ownerId: uuid,
        on: isoDate,
        amountMinor: positiveMinor,
        reference: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .output(ownerMoneySchema),
  fund: oc
    .route({
      method: 'POST',
      path: '/owner-funding',
      summary:
        'Record money the owner sent the agent for the owner’s bills, with proof (P30: Dr 1070, Cr 1010). Requires an Idempotency-Key',
    })
    .input(transfer.extend({ amountMinor: positiveMinor }))
    .output(ownerMoneySchema),
  proof: oc
    .route({ method: 'GET', path: '/owner-money/{id}/proof' })
    .input(z.object({ id: uuid }))
    .output(download),
  reverse: oc
    .route({
      method: 'POST',
      path: '/owner-money/{id}/reversal',
      summary:
        'Reverse a remittance, fees taken or owner funding recorded in error (P21a: each line, sign flipped), with a reason. 409 OWNER_MONEY_REVERSED once reversed; INSUFFICIENT_AGENT_CASH when reversing owner funding would take more out of 1070 than the agent holds for the owner. Requires an Idempotency-Key',
    })
    .input(z.object({ id: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(ownerMoneySchema),
};

// Dashboards (DA-01, DA-02, DA-06; decisions 11 and 12) and Gate 1 -------------------------------

const dashboardFilters = z.object({
  ownerId: uuid.optional(),
  propertyId: uuid.optional(),
  region: z.string().trim().max(60).optional(),
  unitType: z.string().trim().max(40).optional(),
});

export const gate1Schema = z.object({
  month,
  /**
   * `final` once the month is over and its figures were worked out after its end (on the 1st);
   * `provisional` while the month runs or until then. Notices and repairs stay pending only while
   * their windows are open.
   */
  status: z.enum(['final', 'provisional']),
  finalisedAt: iso.nullable(),
  /**
   * F2: rent and service charge whose charge period starts in the month, whatever the billing
   * cycle; collected is the part of those lines settled by the month's end.
   */
  collectionRate: z.object({ dueMinor: minor, collectedMinor: minor, rate: ratioSchema }),
  digitalShare: z.object({
    byMethod: byKeys(COLLECTION_METHODS),
    digitalMinor: minor,
    totalMinor: minor,
    share: ratioSchema,
  }),
  autoMatch: z.object({
    provider: z.object({ automatic: minor, byPerson: minor, unmatched: minor, rate: ratioSchema }),
    directTransfers: z.object({ againstLease: minor, unmatched: minor, rate: ratioSchema }),
  }),
  timeToReceipt: z.object({
    receipts: minor,
    sent: minor,
    withinTarget: minor,
    share: ratioSchema,
    medianMs: minor.nullable(),
    p95Ms: minor.nullable(),
  }),
  noticeAcknowledgement: z.object({ met: minor, missed: minor, pending: minor, rate: ratioSchema }),
  repairResponse: z.object({ met: minor, missed: minor, pending: minor, rate: ratioSchema }),
  /** When these were worked out (the rollup at 04:00, or a refresh); for a total, the oldest. */
  computedAt: iso,
});
export type Gate1View = z.infer<typeof gate1Schema>;

export const dashboardSchema = z.object({
  /** The snapshot the money figures come from; null before the first rollup. */
  asOf: iso.nullable(),
  /** When the live figures (`occupancy` and `collectionRate`) were read: now. */
  liveAt: iso,
  date: isoDate,
  /** Live. */
  occupancy: occupancySummary,
  /** Live; F2's basis (rent and service charge whose period starts in the month). */
  collectionRate: z.object({ month, dueMinor: minor, collectedMinor: minor, rate: ratioSchema }),
  /**
   * Earned and unpaid (1100) past its due date, as the statement counts it. Months billed and
   * past due but not yet started (an annual invoice's) are not arrears: `dueNotStartedMinor`.
   */
  arrears: z.object({
    totalMinor: minor,
    byBucket: byKeys(AGE_BUCKETS),
    leases: minor,
    dueNotStartedMinor: minor,
  }),
  rentRoll: z.object({ rentMinor: minor, serviceChargeMinor: minor, totalMinor: minor }),
  /**
   * Unearned rent, split by invoice (founder decision, 2026-11-07): money allocated to rent lines
   * whose charge period has not started. The same split as the statement's.
   */
  unearnedRentMinor: minor,
  /** The same for service-charge lines. */
  unearnedServiceChargeMinor: minor,
  /** "Paid ahead, not yet applied to a month": the rest of 2010. */
  creditMinor: minor,
  depositsHeldMinor: minor,
  paidUntilCoverage: z.object({
    occupied: minor,
    covered: minor,
    rate: ratioSchema,
    medianMonthsPaidAhead: z.number().nullable(),
  }),
  /** DA-02: leases ending within 3, 6 and 12 months, by renewal status. */
  expiries: z.array(
    z.object({
      withinMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
      leases: minor,
      renewalOffered: minor,
      renewed: minor,
    }),
  ),
  /** This month's Gate 1 figures for the company, from the rollup; null before the first. */
  gate1: gate1Schema.nullable(),
  /** The values the filters offer, within the reader's scope. */
  filterOptions: z.object({
    owners: z.array(named),
    properties: z.array(named),
    regions: z.array(z.string()),
    unitTypes: z.array(z.string()),
  }),
});
export type DashboardView = z.infer<typeof dashboardSchema>;

export const DASHBOARD_EXPORT_FORMATS = ['pdf', 'xlsx'] as const;

export const dashboardExportSchema = z.object({
  id: uuid,
  format: z.enum(DASHBOARD_EXPORT_FORMATS),
  /** An Excel file is ready at once; a PDF renders first. */
  status: z.enum(['rendering', 'ready', 'failed']),
  url: z.string().nullable(),
  expiresAt: iso.nullable(),
});

export const dashboardContract = {
  get: oc
    .route({
      method: 'GET',
      path: '/dashboard',
      summary: 'The portfolio dashboard from the latest snapshot, with live counts (every plan)',
    })
    .input(dashboardFilters)
    .output(dashboardSchema),
  refresh: oc
    .route({
      method: 'POST',
      path: '/dashboard/refresh',
      summary:
        'Queue a fresh rollup for the company (agency admins, managers and landlords; once a minute at most); the dashboard shows when it was computed. 403 for anyone else',
    })
    .input(z.object({}))
    .output(z.object({ queued: z.boolean() })),
  exportCreate: oc
    .route({
      method: 'POST',
      path: '/dashboard/exports',
      summary: 'Export the dashboard as shown, with its filters: Excel at once, PDF once rendered',
    })
    .input(dashboardFilters.extend({ format: z.enum(DASHBOARD_EXPORT_FORMATS) }))
    .output(dashboardExportSchema),
  exportGet: oc
    .route({ method: 'GET', path: '/dashboard/exports/{exportId}' })
    .input(z.object({ exportId: uuid }))
    .output(dashboardExportSchema),
  gate1: oc
    .route({
      method: 'GET',
      path: '/metrics/gate1',
      summary: 'The company’s Gate 1 metrics for a month (default this month)',
    })
    .input(z.object({ month: month.optional() }))
    .output(gate1Schema.nullable()),
};

export const platformMetricsContract = {
  gate1: oc
    .route({
      method: 'GET',
      path: '/platform/metrics/gate1',
      summary:
        'Gate 1 across companies, for platform admins (`metrics.platform.read`), through a system path',
    })
    .input(z.object({ month: month.optional() }))
    .output(
      z.object({
        month,
        companies: z.array(z.object({ company: named, gate1: gate1Schema.nullable() })),
        total: gate1Schema.nullable(),
      }),
    ),
};

// The compliance list (decision 14) --------------------------------------------------------------

export const COMPLIANCE_KINDS = [
  'rent_tax_due',
  'rent_tax_overdue',
  'rent_control_registration',
  'withholding_certificate',
  'vat_return',
  'advance_over_cap',
] as const;

export const complianceItemSchema = z.object({
  /** Stable and unique within the list (a React key): kind plus the record it is about. */
  id: z.string(),
  kind: z.enum(COMPLIANCE_KINDS),
  owner: named.nullable(),
  property: named.nullable(),
  lease: z.object({ id: uuid, unitCode: z.string() }).nullable(),
  /** When it falls due; null when nothing sets a date. */
  dueDate: isoDate.nullable(),
  amountMinor: minor.nullable(),
  description: z.string(),
  /** Where it is dealt with in the web app. */
  link: z.object({
    screen: z.enum(['rent_tax', 'rent_control', 'withholding', 'vat', 'advance_rent', 'lease']),
    id: uuid.nullable(),
  }),
});

export const complianceContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/compliance',
      summary: 'What needs doing for tax and Rent Control, read-only, with links (every plan)',
    })
    .input(z.object({ ownerId: uuid.optional(), propertyId: uuid.optional() }))
    .output(z.array(complianceItemSchema)),
};
