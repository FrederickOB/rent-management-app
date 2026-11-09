/**
 * Subscription billing (M10; PRD section 21; plan sections 2 and 4). The values the contracts,
 * the server and the screens share. Rates, the minimum, the trial and the grace period are
 * configuration (the price list and the terms), never constants here.
 */

/** The subscription state machine (decisions 5, 11 and 12; architecture). No Expired state. */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'read_only',
  'cancel_scheduled',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `company.access`: read-only refuses staff changes outside the allowlist (decision 11). */
export const COMPANY_ACCESS = ['full', 'read_only'] as const;
export type CompanyAccess = (typeof COMPANY_ACCESS)[number];

/** The lines of a subscription invoice; each is rounded once (decisions 2, 6, 8 and 10). */
export const SUBSCRIPTION_LINE_KINDS = [
  'units',
  'minimum',
  'discount',
  'vat',
  'nhil',
  'getfund',
] as const;
export type SubscriptionLineKind = (typeof SUBSCRIPTION_LINE_KINDS)[number];

export const SUBSCRIPTION_INVOICE_STATUSES = ['open', 'paid', 'void'] as const;
export type SubscriptionInvoiceStatus = (typeof SUBSCRIPTION_INVOICE_STATUSES)[number];

/** How a subscriber pays (decision 9): the platform's own Paystack account, no subaccount. */
export const SUBSCRIPTION_PAYMENT_CHANNELS = ['card', 'momo'] as const;
export type SubscriptionPaymentChannel = (typeof SUBSCRIPTION_PAYMENT_CHANNELS)[number];

/** What a payment is for: open invoices, or 12 months up front (decision 7). */
export const SUBSCRIPTION_PAYMENT_PURPOSES = ['invoices', 'annual'] as const;
export type SubscriptionPaymentPurpose = (typeof SUBSCRIPTION_PAYMENT_PURPOSES)[number];

export const SUBSCRIPTION_PAYMENT_STATUSES = [
  'initiated',
  'pending',
  'succeeded',
  'failed',
  'reversed',
] as const;
export type SubscriptionPaymentStatus = (typeof SUBSCRIPTION_PAYMENT_STATUSES)[number];

/** Discount codes (decision 8). */
export const DISCOUNT_KINDS = ['percentage', 'fixed'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** Platform references start `SUB-` so webhooks and reconciliation never mix them with rent. */
export const SUBSCRIPTION_REFERENCE_PREFIX = 'SUB-';

/** Support access (AD-10, decision 13): 24 hours by default, at most 7 days. */
export const SUPPORT_GRANT_DEFAULT_HOURS = 24;
export const SUPPORT_GRANT_MAX_HOURS = 168;
