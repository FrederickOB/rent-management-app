import { oc } from '@orpc/contract';
import { BILLING_BANDS } from '@rent/domain/portfolio';
import { PRICING_CATEGORIES } from '@rent/domain/messaging';
import { SUBSCRIPTION_TIERS, TIER_FEATURES } from '@rent/domain/settings';
import {
  COMPANY_ACCESS,
  DISCOUNT_KINDS,
  SUBSCRIPTION_INVOICE_STATUSES,
  SUBSCRIPTION_LINE_KINDS,
  SUBSCRIPTION_PAYMENT_CHANNELS,
  SUBSCRIPTION_PAYMENT_PURPOSES,
  SUBSCRIPTION_PAYMENT_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUPPORT_GRANT_MAX_HOURS,
} from '@rent/domain/subscription';
import { z } from 'zod';

/**
 * Subscription billing and the platform admin console (M10: AD-08, AD-10, PB-01 to PB-05, PB-07,
 * PB-08, PB-10, PB-11). Amounts are integer pesewas in `*Minor` fields; rates are pesewas per unit
 * per month and discounts in basis points; business dates are `YYYY-MM-DD` and months `YYYY-MM` in
 * the subscriber's time zone; instants are UTC. Subscription records belong to the platform company
 * (decision 1): a subscriber reads only its own. Money writes require an `Idempotency-Key`.
 *
 * Read-only (decision 11): while a company's `access` is `read_only`, staff changes outside the
 * allowlist answer 403 `SUBSCRIPTION_READ_ONLY`. Paying, reading, exporting and granting support
 * access always work, and nothing tenant-facing ever stops.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month such as 2026-10');
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);
const named = z.object({ id: uuid, name: z.string() });
const download = z.object({ url: z.string(), expiresAt: iso });
const tier = z.enum(SUBSCRIPTION_TIERS);
const band = z.enum(BILLING_BANDS);
const byBand = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ single_room: value, self_contained: value, commercial: value });

/** A price list version for a tier (PB-03, decision 3). */
export const priceListSchema = z.object({
  id: uuid,
  tier,
  /** Pesewas per billable unit per month, by band (PB-01). */
  ratesMinor: byBand(minor),
  /** The tier's monthly minimum (PB-05). */
  minimumMinor: minor,
  /** The annual prepayment discount (decision 7). */
  annualDiscountBps: minor,
  effectiveFrom: isoDate,
  /**
   * The first month it prices (BE-25): a month is priced with the list in force on its 1st, so
   * this is the first month whose 1st is on or after `effectiveFrom`.
   */
  appliesFromMonth: month,
  /** A placeholder until OQ-37 is answered: the console says so. */
  placeholder: z.boolean(),
  createdAt: iso,
});
export type PriceListView = z.infer<typeof priceListSchema>;

/** The subscription terms (decisions 2, 5, 11, 12 and 10), one version per change. */
export const subscriptionTermsSchema = z.object({
  id: uuid,
  effectiveFrom: isoDate,
  trialDays: minor,
  /** Days after an invoice's due date before read-only (OQ-34: 14). */
  graceDays: minor,
  /** The read-only switch (default on, OQ-34). */
  readOnlyEnabled: z.boolean(),
  /** Days from an invoice's issue to its due date. */
  dueDays: minor,
  /** Days staff keep read-only access after a cancellation. */
  retentionDaysAfterCancel: minor,
  /** Whether the platform is VAT-registered: off by default, so invoices carry no VAT (decision 10). */
  vatRegistered: z.boolean(),
  createdAt: iso,
});
export type SubscriptionTermsView = z.infer<typeof subscriptionTermsSchema>;

const featureSchema = z.object({
  feature: z.enum(TIER_FEATURES),
  name: z.string(),
  included: z.boolean(),
  /** The lowest tier that includes it: what a locked feature names (PB-04). */
  unlockTier: tier,
  /** A Portfolio P2 module: "coming soon" (decision 4). */
  comingSoon: z.boolean(),
});

/** The subscriber's view of its subscription (Settings → Subscription). */
export const subscriptionSchema = z.object({
  company: named,
  tier,
  status: z.enum(SUBSCRIPTION_STATUSES),
  access: z.enum(COMPANY_ACCESS),
  /**
   * The last day of the trial: while trialing, and while a cancellation made within the trial
   * waits (it ends by that day, unbilled).
   */
  trialEndsOn: isoDate.nullable(),
  /** A downgrade waiting for the 1st of next month (decision 6). */
  pendingTier: z.object({ tier, from: isoDate }).nullable(),
  /** A cancellation scheduled for the end of this month (decision 12). */
  cancelsOn: isoDate.nullable(),
  /** After a cancellation: staff keep read-only access until this day. */
  readOnlyUntil: isoDate.nullable(),
  /** The day read-only starts if the oldest past-due invoice stays unpaid (decision 11). */
  readOnlyFrom: isoDate.nullable(),
  /** An annual prepayment (decision 7): its term and the prepaid credit left (2020). */
  annual: z
    .object({ startsOn: isoDate, endsOn: isoDate, creditMinor: minor, discountBps: minor })
    .nullable(),
  /** Prepaid credit (2020) outside any annual term. */
  creditMinor: minor,
  discount: z.object({ code: z.string(), description: z.string(), monthsLeft: minor }).nullable(),
  /**
   * This month so far, from live leases (D8): an estimate, not an invoice. The parts add up:
   * `unitsMinor + minimumTopUpMinor + discountMinor + vatMinor = totalMinor`. The top-up is what
   * brings the units up to the tier's prorated minimum (zero when the units reach it); the tier's
   * own minimum is in `tiers`. `discountMinor` is zero or negative.
   */
  estimate: z.object({
    month,
    billableUnits: byBand(minor),
    unitsMinor: minor,
    minimumTopUpMinor: minor,
    discountMinor: minor,
    vatMinor: minor,
    totalMinor: minor,
  }),
  /** What every open invoice still owes, past due or not: what "pay" charges. */
  openMinor: minor,
  /**
   * The price of 12 months up front (decision 7), when it may be paid (`actions.payAnnual`): a
   * full month at the current tier from the units let now, less the annual discount, floored at
   * 12 minimums, VAT on top when charged; the term is the 12 billing months from this one.
   */
  annualPrice: z
    .object({
      netMinor: minor,
      vatMinor: minor,
      totalMinor: minor,
      discountBps: minor,
      firstMonth: month,
      lastMonth: month,
    })
    .nullable(),
  /**
   * Whether billing is on (founder answer Q1). Before a platform admin turns it on, nothing is
   * invoiced and a trial has no end yet (`trialEndsOn` null); from that day every trial runs.
   */
  billing: z.object({ on: z.boolean(), startsOn: isoDate.nullable() }),
  /** Open invoices past their due date. */
  arrears: z.object({ pastDueMinor: minor, oldestDueOn: isoDate }).nullable(),
  features: z.array(featureSchema),
  /** Every tier with its price list in force, for the change-tier choice. */
  tiers: z.array(
    z.object({
      tier,
      ratesMinor: byBand(minor),
      minimumMinor: minor,
      placeholder: z.boolean(),
    }),
  ),
  actions: z.object({
    pay: z.boolean(),
    payAnnual: z.boolean(),
    changeTier: z.boolean(),
    applyCode: z.boolean(),
    cancel: z.boolean(),
    withdrawCancel: z.boolean(),
    export: z.boolean(),
    grantSupport: z.boolean(),
  }),
});
export type SubscriptionView = z.infer<typeof subscriptionSchema>;

export const subscriptionInvoiceLineSchema = z.object({
  kind: z.enum(SUBSCRIPTION_LINE_KINDS),
  description: z.string(),
  /** For a `units` line: the tier and band it prices, how many units and for how many days. */
  tier: tier.nullable(),
  band: band.nullable(),
  units: minor.nullable(),
  rateMinor: minor.nullable(),
  days: minor.nullable(),
  daysInMonth: minor.nullable(),
  amountMinor: minor,
});

export const subscriptionInvoiceSchema = z.object({
  id: uuid,
  /** Gap-free: `SUB-2026-000001`. */
  number: z.string(),
  month,
  status: z.enum(SUBSCRIPTION_INVOICE_STATUSES),
  issuedOn: isoDate,
  dueOn: isoDate,
  totalMinor: minor,
  /** Settled from prepaid credit (2020). */
  prepaidMinor: minor,
  paidMinor: minor,
  /** Credit notes on it (BE-6): what they took off the total. */
  creditedMinor: minor,
  outstandingMinor: minor,
  pastDue: z.boolean(),
  snapshotId: uuid,
  hasDocument: z.boolean(),
});
export type SubscriptionInvoiceView = z.infer<typeof subscriptionInvoiceSchema>;

/** A credit note on a subscription invoice (founder answer Q2): gap-free `SUBC-2026-000001`. */
export const subscriptionCreditNoteSchema = z.object({
  id: uuid,
  number: z.string(),
  invoiceId: uuid,
  invoiceNumber: z.string(),
  issuedOn: isoDate,
  netMinor: minor,
  vatMinor: minor,
  amountMinor: minor,
  reason: z.string(),
  hasDocument: z.boolean(),
});

export const subscriptionInvoiceDetailSchema = subscriptionInvoiceSchema.extend({
  lines: z.array(subscriptionInvoiceLineSchema),
  /** Whether VAT lines read an unverified rule (decision 10): the console warns. */
  vatUnverified: z.boolean(),
  creditNotes: z.array(subscriptionCreditNoteSchema),
});

/** The month's billable units (PB-02, D8), frozen for audit and dispute. */
export const billingSnapshotSchema = z.object({
  id: uuid,
  month,
  takenAt: iso,
  countsByBand: byBand(minor),
  units: z.array(
    z.object({
      unitId: uuid,
      unitCode: z.string(),
      band,
      leaseId: uuid,
      /** Days of the month the unit was leased. */
      daysLeased: minor,
    }),
  ),
});

export const subscriptionReceiptSchema = z.object({
  id: uuid,
  /** Gap-free: `SUBR-2026-000001`. */
  number: z.string(),
  paidOn: isoDate,
  amountMinor: minor,
  channel: z.enum(SUBSCRIPTION_PAYMENT_CHANNELS),
  purpose: z.enum(SUBSCRIPTION_PAYMENT_PURPOSES),
  invoiceNumbers: z.array(z.string()),
  hasDocument: z.boolean(),
});

export const subscriptionPaymentSchema = z.object({
  id: uuid,
  /** `SUB-…`: routed to subscriptions, never to rent (decision 9). */
  reference: z.string(),
  purpose: z.enum(SUBSCRIPTION_PAYMENT_PURPOSES),
  channel: z.enum(SUBSCRIPTION_PAYMENT_CHANNELS),
  amountMinor: minor,
  status: z.enum(SUBSCRIPTION_PAYMENT_STATUSES),
  /** For a card: the provider's checkout page. */
  checkoutUrl: z.string().nullable(),
  /** For MoMo: what the wallet's phone shows next, in plain words. */
  message: z.string().nullable(),
  receiptId: uuid.nullable(),
});

export const supportGrantSchema = z.object({
  id: uuid,
  reason: z.string(),
  grantedBy: z.object({ personId: uuid, name: z.string() }),
  from: iso,
  until: iso,
  revokedAt: iso.nullable(),
  revokedByName: z.string().nullable(),
  active: z.boolean(),
  /** Each request a platform admin made under it (audited in the company's chain). */
  sessions: z.array(
    z.object({ at: iso, adminName: z.string(), route: z.string(), record: z.string().nullable() }),
  ),
});

export const subscriptionExportSchema = z.object({
  id: uuid,
  status: z.enum(['preparing', 'ready', 'failed']),
  url: z.string().nullable(),
  expiresAt: iso.nullable(),
});

export const subscriptionContract = {
  get: oc
    .route({
      method: 'GET',
      path: '/subscription',
      summary: 'The company’s subscription: tier, status, trial, estimate, arrears and actions',
    })
    .output(subscriptionSchema),
  invoices: oc
    .route({ method: 'GET', path: '/subscription/invoices', summary: 'Invoices, newest first' })
    .output(z.array(subscriptionInvoiceSchema)),
  invoice: oc
    .route({ method: 'GET', path: '/subscription/invoices/{invoiceId}' })
    .input(z.object({ invoiceId: uuid }))
    .output(subscriptionInvoiceDetailSchema),
  invoiceDocument: oc
    .route({
      method: 'GET',
      path: '/subscription/invoices/{invoiceId}/document',
      summary: 'A 5-minute link to the invoice PDF. 409 DOCUMENT_RENDERING while it renders',
    })
    .input(z.object({ invoiceId: uuid }))
    .output(download),
  snapshot: oc
    .route({ method: 'GET', path: '/subscription/snapshots/{snapshotId}' })
    .input(z.object({ snapshotId: uuid }))
    .output(billingSnapshotSchema),
  receipts: oc
    .route({ method: 'GET', path: '/subscription/receipts', summary: 'Receipts, newest first' })
    .output(z.array(subscriptionReceiptSchema)),
  receiptDocument: oc
    .route({ method: 'GET', path: '/subscription/receipts/{receiptId}/document' })
    .input(z.object({ receiptId: uuid }))
    .output(download),
  creditNoteDocument: oc
    .route({
      method: 'GET',
      path: '/subscription/credit-notes/{creditNoteId}/document',
      summary: 'A 5-minute link to a credit note’s PDF. 409 DOCUMENT_RENDERING while it renders',
    })
    .input(z.object({ creditNoteId: uuid }))
    .output(download),
  pay: oc
    .route({
      method: 'POST',
      path: '/subscription/payments',
      summary:
        'Pay every open invoice (`invoices`, what `openMinor` says), or 12 months up front (`annual`, what `annualPrice` says), by card (checkout) or MoMo (a prompt on the wallet’s phone). A charge for the same purpose still waiting is returned rather than started again. 409 NOTHING_TO_PAY, OPEN_INVOICES (pay those before a year ahead), ANNUAL_ALREADY_PAID, SUBSCRIPTION_CANCELLED. Requires an Idempotency-Key',
    })
    .input(
      z
        .object({
          purpose: z.enum(SUBSCRIPTION_PAYMENT_PURPOSES),
          channel: z.enum(SUBSCRIPTION_PAYMENT_CHANNELS),
          /** For MoMo, required: the wallet's phone in E.164 (+233…) and its network. */
          momoPhone: z
            .string()
            .regex(/^\+[1-9][0-9]{6,14}$/, 'Use the number in full, such as +233241234567')
            .optional(),
          momoProvider: z.enum(['mtn', 'vodafone', 'airteltigo']).optional(),
        })
        .refine((p) => p.channel !== 'momo' || (!!p.momoPhone && !!p.momoProvider), {
          message: 'MoMo needs the wallet’s phone number and network',
          path: ['momoPhone'],
        }),
    )
    .output(subscriptionPaymentSchema),
  payment: oc
    .route({
      method: 'GET',
      path: '/subscription/payments/{paymentId}',
      summary: 'A payment’s status: the page polls it until it succeeds or fails',
    })
    .input(z.object({ paymentId: uuid }))
    .output(subscriptionPaymentSchema),
  changeTier: oc
    .route({
      method: 'POST',
      path: '/subscription/tier',
      summary:
        'Change tier: an upgrade takes effect today (prorated by days), a downgrade on the 1st of next month (decision 6). 409 TIER_UNCHANGED, SUBSCRIPTION_CANCELLED',
    })
    .input(z.object({ tier }))
    .output(subscriptionSchema),
  applyCode: oc
    .route({
      method: 'POST',
      path: '/subscription/discount',
      summary:
        'Apply a discount code (decision 8): one at a time. 409 DISCOUNT_UNKNOWN, DISCOUNT_EXPIRED, DISCOUNT_USED_UP, DISCOUNT_ALREADY_APPLIED',
    })
    .input(z.object({ code: z.string().trim().min(2).max(40) }))
    .output(subscriptionSchema),
  cancel: oc
    .route({
      method: 'POST',
      path: '/subscription/cancel',
      summary:
        'Cancel at the end of this month (decision 12); billed for the month in arrears; can be withdrawn until then. 409 ALREADY_CANCELLING',
    })
    .input(z.object({ reason: z.string().trim().max(500).optional() }))
    .output(subscriptionSchema),
  withdrawCancel: oc
    .route({
      method: 'POST',
      path: '/subscription/cancel/withdraw',
      summary: 'Withdraw a scheduled cancellation. 409 NOT_CANCELLING',
    })
    .output(subscriptionSchema),
  exportCreate: oc
    .route({
      method: 'POST',
      path: '/subscription/export',
      summary:
        'Export the company’s data (decision 12): properties, units, tenants (no ID numbers), leases, invoices, payments and receipts, as an Excel workbook',
    })
    .output(subscriptionExportSchema),
  exportGet: oc
    .route({ method: 'GET', path: '/subscription/export/{exportId}' })
    .input(z.object({ exportId: uuid }))
    .output(subscriptionExportSchema),
};

export const supportGrantsContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/support-grants',
      summary: 'Support access the company granted, with each request made under it (AD-10)',
    })
    .output(z.array(supportGrantSchema)),
  grant: oc
    .route({
      method: 'POST',
      path: '/support-grants',
      summary:
        'Let the platform’s support read the company, read-only, for a reason and a time (24 hours by default, at most 7 days)',
    })
    .input(
      z.object({
        reason: z.string().trim().min(5).max(500),
        hours: z.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS).optional(),
      }),
    )
    .output(supportGrantSchema),
  revoke: oc
    .route({ method: 'POST', path: '/support-grants/{grantId}/revoke' })
    .input(z.object({ grantId: uuid }))
    .output(supportGrantSchema),
};

// The platform admin console (AD-10) -------------------------------------------------------------

export const platformCompanySchema = z.object({
  company: named,
  kind: z.enum(['landlord', 'agency']),
  tier,
  status: z.enum(SUBSCRIPTION_STATUSES),
  access: z.enum(COMPANY_ACCESS),
  trialEndsOn: isoDate.nullable(),
  /** Last month's billable units (the snapshot), all bands. */
  billableUnits: minor,
  /** Last month's invoice total. */
  monthlyRevenueMinor: minor,
  arrearsMinor: minor,
  supportGrantActive: z.boolean(),
  createdAt: iso,
});

const usageSchema = z.object({
  company: named,
  month,
  units: minor,
  billableUnits: byBand(minor),
  invoicedMinor: minor,
  paidMinor: minor,
  arrearsMinor: minor,
  messages: z.object({ sms: minor, whatsapp: minor, email: minor, push: minor }),
  /** As recorded per message. */
  smsCostMinor: minor,
  /** From the editable rate table: labelled "estimated" (decision 15). */
  whatsappCostEstimatedMinor: minor,
});

export const platformCompanyDetailSchema = platformCompanySchema.extend({
  subscription: subscriptionSchema,
  invoices: z.array(subscriptionInvoiceSchema),
  usage: z.array(usageSchema),
  supportGrants: z.array(supportGrantSchema),
  /** The subscription's history (append-only events). */
  events: z.array(z.object({ at: iso, kind: z.string(), detail: z.string() })),
});

export const discountCodeSchema = z.object({
  id: uuid,
  code: z.string(),
  kind: z.enum(DISCOUNT_KINDS),
  percentBps: minor.nullable(),
  amountMinor: minor.nullable(),
  months: minor,
  expiresOn: isoDate.nullable(),
  maxUses: minor.nullable(),
  uses: minor,
  createdAt: iso,
});

export const whatsappRateSchema = z.object({
  id: uuid,
  category: z.enum(PRICING_CATEGORIES),
  /** Pesewas per message: an estimate, never an invoice (decision 15). */
  rateMinor: minor,
  effectiveFrom: isoDate,
  createdAt: iso,
});

export const healthSchema = z.object({
  checkedAt: iso,
  queues: z.array(z.object({ name: z.string(), queued: minor, active: minor, failed24h: minor })),
  deadLettered24h: minor,
  failedWebhooks: minor,
  scheduledJobs: z.array(
    z.object({ name: z.string(), lastRunAt: iso.nullable(), lastState: z.string().nullable() }),
  ),
  auditChains: z.object({ checkedAt: iso.nullable(), broken: minor }),
  recentAlerts: z.array(
    z.object({
      at: iso,
      severity: z.enum(['info', 'warning', 'critical']),
      code: z.string(),
      message: z.string(),
      companyId: uuid.nullable(),
    }),
  ),
});

export const supportOverviewSchema = z.object({
  company: named,
  grant: z.object({ id: uuid, until: iso, reason: z.string() }),
  counts: z.object({
    properties: minor,
    units: minor,
    leases: minor,
    tenants: minor,
    openApprovals: minor,
  }),
  recentPayments: z.array(
    z.object({ id: uuid, receivedOn: isoDate, amountMinor: minor, method: z.string() }),
  ),
  recentAudit: z.array(z.object({ at: iso, action: z.string(), actorName: z.string().nullable() })),
});

/** Subscription billing on or off (founder answer Q1). */
export const billingStateSchema = z.object({
  on: z.boolean(),
  /** The day billing starts (or started); null while it is off. */
  startsOn: isoDate.nullable(),
  turnedOnAt: iso.nullable(),
  turnedOnByName: z.string().nullable(),
  /** The tiers whose price list in force today is a placeholder: billing cannot start on them. */
  placeholderTiers: z.array(tier),
});

export const platformAdminContract = {
  companies: oc
    .route({ method: 'GET', path: '/platform/companies', summary: 'Every subscriber company' })
    .output(z.array(platformCompanySchema)),
  createCompany: oc
    .route({
      method: 'POST',
      path: '/platform/companies',
      summary:
        'Onboard a company (decision 14): its subscription starts in trial (its trial runs once billing is on), and its first admin is invited by email. One transaction. An Idempotency-Key is optional: sent, a retry with it answers the first result and makes nothing twice (the web always sends one)',
    })
    .input(
      z.object({
        kind: z.enum(['landlord', 'agency']),
        name: z.string().trim().min(2).max(200),
        legalName: z.string().trim().max(200).optional(),
        timeZone: z.string().max(60).default('Africa/Accra'),
        tier,
        trialDays: z.number().int().min(0).max(365).optional(),
        adminName: z.string().trim().min(2).max(200),
        adminEmail: z.string().email(),
      }),
    )
    .output(platformCompanyDetailSchema),
  company: oc
    .route({ method: 'GET', path: '/platform/companies/{companyId}' })
    .input(z.object({ companyId: uuid }))
    .output(platformCompanyDetailSchema),
  setTier: oc
    .route({
      method: 'POST',
      path: '/platform/companies/{companyId}/tier',
      summary: 'Set a company’s tier directly, for example for a pilot, with an audited reason',
    })
    .input(z.object({ companyId: uuid, tier, reason: z.string().trim().min(5).max(500) }))
    .output(platformCompanyDetailSchema),
  extendTrial: oc
    .route({
      method: 'POST',
      path: '/platform/companies/{companyId}/trial',
      summary:
        'Extend a trial by some days, with an audited reason. 409 NOT_TRIALING. Requires an Idempotency-Key, so a retry adds nothing',
    })
    .input(
      z.object({
        companyId: uuid,
        days: z.number().int().min(1).max(365),
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .output(platformCompanyDetailSchema),
  applyCode: oc
    .route({ method: 'POST', path: '/platform/companies/{companyId}/discount' })
    .input(z.object({ companyId: uuid, code: z.string().trim().min(2).max(40) }))
    .output(platformCompanyDetailSchema),
  invoice: oc
    .route({
      method: 'GET',
      path: '/platform/companies/{companyId}/invoices/{invoiceId}',
      summary: 'A company’s invoice with its lines and credit notes (PB-02: audit and dispute)',
    })
    .input(z.object({ companyId: uuid, invoiceId: uuid }))
    .output(subscriptionInvoiceDetailSchema),
  snapshot: oc
    .route({
      method: 'GET',
      path: '/platform/companies/{companyId}/snapshots/{snapshotId}',
      summary: 'The billable units behind a company’s invoice (PB-02, D8)',
    })
    .input(z.object({ companyId: uuid, snapshotId: uuid }))
    .output(billingSnapshotSchema),
  creditInvoice: oc
    .route({
      method: 'POST',
      path: '/platform/companies/{companyId}/invoices/{invoiceId}/credit',
      summary:
        'Credit a subscription invoice in full or in part, with a reason (founder answer Q2). Never more than its total less earlier credits: 409 CREDIT_EXCEEDS_INVOICE; 409 INVOICE_VOID. Requires an Idempotency-Key',
    })
    .input(
      z.object({
        companyId: uuid,
        invoiceId: uuid,
        amountMinor: positiveMinor,
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .output(subscriptionCreditNoteSchema),
  creditNoteDocument: oc
    .route({
      method: 'GET',
      path: '/platform/companies/{companyId}/credit-notes/{creditNoteId}/document',
    })
    .input(z.object({ companyId: uuid, creditNoteId: uuid }))
    .output(download),
  reactivate: oc
    .route({
      method: 'POST',
      path: '/platform/companies/{companyId}/reactivate',
      summary:
        'Start a new subscription for a cancelled company (decision 12), on a tier, with an audited reason; its staff get full access again. 409 NOT_CANCELLED',
    })
    .input(
      z.object({
        companyId: uuid,
        tier,
        trialDays: z.number().int().min(0).max(365).optional(),
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .output(platformCompanyDetailSchema),
  billing: oc
    .route({
      method: 'GET',
      path: '/platform/billing',
      summary:
        'Whether subscription billing is on, from when, and what stops it (founder answer Q1)',
    })
    .output(billingStateSchema),
  turnOnBilling: oc
    .route({
      method: 'POST',
      path: '/platform/billing',
      summary:
        'Turn subscription billing on from a date (today or later). Every trial that started before then runs from that date. 409 PLACEHOLDER_PRICES while a price list in force on that date is a placeholder; 409 BILLING_ALREADY_ON. Requires an Idempotency-Key',
    })
    .input(z.object({ startsOn: isoDate, note: z.string().trim().max(500).optional() }))
    .output(billingStateSchema),
  invoiceDocument: oc
    .route({
      method: 'GET',
      path: '/platform/companies/{companyId}/invoices/{invoiceId}/document',
      summary:
        'A 5-minute link to a company’s subscription invoice PDF. 409 DOCUMENT_RENDERING while it renders',
    })
    .input(z.object({ companyId: uuid, invoiceId: uuid }))
    .output(download),
  priceLists: oc
    .route({
      method: 'GET',
      path: '/platform/price-lists',
      summary: 'Every price list version, by tier and effective date',
    })
    .output(z.array(priceListSchema)),
  addPriceList: oc
    .route({
      method: 'POST',
      path: '/platform/price-lists',
      summary:
        'A new price list version from a future date (rows are never edited). 400 EFFECTIVE_FROM_PAST',
    })
    .input(
      z.object({
        tier,
        ratesMinor: byBand(z.number().int().min(0)),
        minimumMinor: z.number().int().min(0),
        annualDiscountBps: z.number().int().min(0).max(10_000),
        effectiveFrom: isoDate,
      }),
    )
    .output(priceListSchema),
  terms: oc
    .route({ method: 'GET', path: '/platform/terms', summary: 'Every terms version' })
    .output(z.array(subscriptionTermsSchema)),
  addTerms: oc
    .route({
      method: 'POST',
      path: '/platform/terms',
      summary: 'A new terms version from today or later. 400 EFFECTIVE_FROM_PAST',
    })
    .input(
      z.object({
        effectiveFrom: isoDate,
        trialDays: z.number().int().min(0).max(365),
        graceDays: z.number().int().min(0).max(90),
        readOnlyEnabled: z.boolean(),
        dueDays: z.number().int().min(0).max(60),
        retentionDaysAfterCancel: z.number().int().min(0).max(3650),
        vatRegistered: z.boolean(),
      }),
    )
    .output(subscriptionTermsSchema),
  discountCodes: oc
    .route({ method: 'GET', path: '/platform/discount-codes' })
    .output(z.array(discountCodeSchema)),
  addDiscountCode: oc
    .route({
      method: 'POST',
      path: '/platform/discount-codes',
      summary: 'A discount code (decision 8). 409 DISCOUNT_CODE_TAKEN',
    })
    .input(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^[A-Z0-9-]{2,40}$/, 'Capital letters, digits and dashes'),
        kind: z.enum(DISCOUNT_KINDS),
        percentBps: z.number().int().min(1).max(10_000).optional(),
        amountMinor: positiveMinor.optional(),
        months: z.number().int().min(1).max(36),
        expiresOn: isoDate.optional(),
        maxUses: z.number().int().min(1).optional(),
      }),
    )
    .output(discountCodeSchema),
  whatsappRates: oc
    .route({ method: 'GET', path: '/platform/whatsapp-rates' })
    .output(z.array(whatsappRateSchema)),
  addWhatsappRate: oc
    .route({ method: 'POST', path: '/platform/whatsapp-rates' })
    .input(
      z.object({
        category: z.enum(PRICING_CATEGORIES),
        rateMinor: z.number().int().min(0),
        effectiveFrom: isoDate,
      }),
    )
    .output(whatsappRateSchema),
  usage: oc
    .route({
      method: 'GET',
      path: '/platform/usage',
      summary: 'Usage and messaging costs per company for a month (default last month)',
    })
    .input(z.object({ month: month.optional() }))
    .output(z.array(usageSchema)),
  health: oc
    .route({ method: 'GET', path: '/platform/health', summary: 'System health (decision 15)' })
    .output(healthSchema),
  supportGrants: oc
    .route({
      method: 'GET',
      path: '/platform/support-grants',
      summary: 'Active and recent support grants across companies, with their sessions',
    })
    .input(z.object({ activeOnly: z.union([z.boolean(), z.stringbool()]).optional() }))
    .output(z.array(supportGrantSchema.extend({ company: named }))),
  supportOverview: oc
    .route({
      method: 'GET',
      path: '/platform/support/{companyId}',
      summary:
        'Open a company read-only under its active grant (AD-10): audited in its chain. 403 SUPPORT_NO_GRANT without one',
    })
    .input(z.object({ companyId: uuid }))
    .output(supportOverviewSchema),
};
