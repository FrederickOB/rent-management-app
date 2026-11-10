import { BILLING_BAND_LABELS, BILLING_BANDS, type BillingBand } from '@rent/domain/portfolio';
import {
  addDays,
  addMonths,
  daysBetween,
  epochMillisOf,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import {
  PLAN_FEATURE_NAMES,
  SUBSCRIPTION_TIERS,
  tierUnlocking,
  type PlanFeature,
  type SubscriptionTier,
} from '@rent/domain/settings';
import {
  cancelEffectiveOn,
  SUPPORT_GRANT_MAX_HOURS as MAX_HOURS,
  type SubscriptionInvoiceStatus,
  type SubscriptionPaymentPurpose,
  type SubscriptionPaymentStatus,
  type SubscriptionStatus,
} from '@rent/domain/subscription';
import { formatBusinessDate } from './business-dates';
import { monthLabel } from './rent-tax';
import { errorCode } from './errors';
import { bpsText } from './reporting';
import { formatMinor } from './tenancy-format';

// M10 (plan 2 and 4.8): words for the subscription screens and the platform console. The inputs
// are plain values; the screens pass the API's fields (packages/contracts subscription).

// Tiers (PB-04, decision 4) ------------------------------------------------------------------

/** The tiers, lowest first (PRD section 21; the domain's `SUBSCRIPTION_TIERS`). */
export const TIERS = SUBSCRIPTION_TIERS;
export type Tier = SubscriptionTier;

export const TIER_LABELS: Record<Tier, string> = {
  starter: 'Starter',
  growth: 'Growth',
  portfolio: 'Portfolio',
};

/** A tier's name; a profile that sends none is on Growth, as before M6 (lib/plan). */
export function tierLabel(tier: string | null | undefined): string {
  if (tier === null || tier === undefined) return TIER_LABELS.growth;
  return (TIER_LABELS as Record<string, string>)[tier] ?? tier;
}

/**
 * Portfolio's modules that are P2 (decision 4, prd-issues 31): listed on the tier, each marked
 * "coming soon", never offered as working.
 */
export const PORTFOLIO_COMING_SOON: readonly string[] = [
  'Commercial tenant portal',
  'Caretaker field app',
  'Diaspora owner view',
  'Compliance dashboard',
  'Accounting export',
  'Priority support',
];

export const COMING_SOON = 'Coming soon';

/** The lowest tier whose features include this one, by the domain's own table. */
export function lowestTierWith(feature: PlanFeature): Tier | null {
  return tierUnlocking(feature) ?? null;
}

/** A locked feature names the tier that unlocks it (PB-04): "Growth includes the inbox." */
export function unlockText(feature: PlanFeature): string | null {
  const tier = lowestTierWith(feature);
  if (!tier) return null;
  const name = PLAN_FEATURE_NAMES[feature];
  return `${TIER_LABELS[tier]} includes ${name.charAt(0).toLowerCase()}${name.slice(1)}.`;
}

// Status (decisions 5, 11 and 12) -------------------------------------------------------------

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionStatus, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Past due',
  read_only: 'Read-only',
  cancel_scheduled: 'Ending this month',
  cancelled: 'Cancelled',
};

/** "Free trial: 12 days left, ends 30 Nov 2026." */
export function trialText(trialEndsOn: string, today: string): string {
  const left = daysBetween(parseBusinessDate(today), parseBusinessDate(trialEndsOn));
  const ends = formatBusinessDate(trialEndsOn);
  if (left < 0) return `The free trial ended on ${ends}.`;
  if (left === 0) return `Free trial: it ends today, ${ends}. Billing starts tomorrow.`;
  return `Free trial: ${left} ${left === 1 ? 'day' : 'days'} left, ends ${ends}. No card is needed; you can cancel any time before.`;
}

/**
 * The staff banner for an unpaid subscription (PB-11, decision 11). Never shown to tenants: what
 * they use never changes, whatever the subscription's state.
 */
export function subscriptionBanner(input: {
  readonly state: 'past_due' | 'read_only';
  /** What is past due: null for people without `subscription.read`. */
  readonly amountDueMinor: number | null;
  /** The oldest unpaid invoice's due date. */
  readonly dueOn: string | null;
  /** When read-only starts; null when the platform's read-only switch is off. */
  readonly readOnlyFrom: string | null;
  /** May this person pay (`subscription.manage`)? */
  readonly canPay: boolean;
}): { readonly title: string; readonly body: string; readonly action: string | null } {
  const owed = input.amountDueMinor !== null ? formatMinor(input.amountDueMinor) : null;
  const due = input.dueOn ? formatBusinessDate(input.dueOn) : null;
  const who = input.canPay
    ? null
    : 'Ask your agency admin or the landlord to pay it in Settings, Subscription.';
  if (input.state === 'read_only') {
    const invoice = `The subscription invoice${owed ? ` of ${owed}` : ''}${due ? `, due on ${due},` : ''} is unpaid`;
    return {
      title: 'Your company is read-only for staff.',
      body: [
        `${invoice}, so staff can read records but not change them.`,
        'Tenants are not affected: they can still pay rent, get receipts and sign, and money received is still recorded.',
        'Paying restores full access at once.',
        who,
      ]
        .filter(Boolean)
        .join(' '),
      action: input.canPay ? 'Pay now' : null,
    };
  }
  return {
    title: 'Your subscription invoice is overdue.',
    body: [
      owed && due ? `${owed} was due on ${due}.` : due ? `It was due on ${due}.` : null,
      input.readOnlyFrom
        ? `Pay it before ${formatBusinessDate(input.readOnlyFrom)}, or staff can only read records from that day. Tenants are never affected.`
        : 'Tenants are never affected.',
      who,
    ]
      .filter(Boolean)
      .join(' '),
    action: input.canPay ? 'Pay now' : null,
  };
}

/** The company profile's subscription block (contracts company: `CompanyProfile.subscription`). */
export interface SubscriptionFacts {
  readonly status: SubscriptionStatus;
  readonly access: 'full' | 'read_only';
  readonly trialEndsOn: string | null;
  readonly readOnlyFrom: string | null;
  readonly oldestDueOn: string | null;
  readonly pastDueMinor: number | null;
  readonly canPay: boolean;
}

export type Banner = {
  readonly tone: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly body: string;
  /** "Pay now" or "See your plan", to Settings, Subscription; null when this person cannot act. */
  readonly action: string | null;
};

/**
 * The staff banner across the app (PB-11, decision 11): read-only, past due, an ended
 * subscription, or a trial (only to those who can pay). Null when there is nothing to say, and
 * for the platform company. Tenants never see it.
 */
export function bannerFor(
  facts: SubscriptionFacts | null | undefined,
  today: string,
): Banner | null {
  if (!facts) return null;
  const owed = facts.oldestDueOn !== null;
  if (facts.status === 'cancelled') {
    const unpaid = owed
      ? `An invoice is still unpaid${facts.pastDueMinor !== null ? ` (${formatMinor(facts.pastDueMinor)})` : ''}, due on ${formatBusinessDate(facts.oldestDueOn!)}.`
      : null;
    return {
      tone: 'warning',
      title: 'The subscription has ended.',
      body: [
        'Staff can read records and download documents for a time, but not change them. Pay links, receipts and notices already issued keep working for tenants.',
        unpaid,
      ]
        .filter(Boolean)
        .join(' '),
      action: facts.canPay ? (owed ? 'Pay now' : 'See your plan') : null,
    };
  }
  if (facts.access === 'read_only' || facts.status === 'read_only')
    return {
      tone: 'error',
      ...subscriptionBanner({
        state: 'read_only',
        amountDueMinor: facts.pastDueMinor,
        dueOn: facts.oldestDueOn,
        readOnlyFrom: facts.readOnlyFrom,
        canPay: facts.canPay,
      }),
    };
  // Review N10: money owed while a cancellation is scheduled still shows as past due.
  if (facts.status === 'past_due' || (facts.status === 'cancel_scheduled' && owed))
    return {
      tone: 'warning',
      ...subscriptionBanner({
        state: 'past_due',
        amountDueMinor: facts.pastDueMinor,
        dueOn: facts.oldestDueOn,
        readOnlyFrom: facts.readOnlyFrom,
        canPay: facts.canPay,
      }),
    };
  if (facts.status === 'trialing' && facts.trialEndsOn && facts.canPay)
    return {
      tone: 'info',
      title: 'Free trial',
      body: trialText(facts.trialEndsOn, today),
      action: 'See your plan',
    };
  return null;
}

/**
 * The read-only notice on the subscription page (review WEB-7): an ended subscription is not
 * past due, and paying does not restore it.
 */
export function readOnlyNotice(input: {
  readonly status: SubscriptionStatus;
  readonly readOnlyUntil: string | null;
}): { readonly title: string; readonly body: string } {
  if (input.status === 'cancelled')
    return {
      title: 'The subscription has ended',
      body: input.readOnlyUntil
        ? `Staff can read records and download documents until ${formatBusinessDate(input.readOnlyUntil)}, but not change them. Tenants are not affected by it.`
        : 'Staff can read records and download documents for a time, but not change them. Tenants are not affected by it.',
    };
  return {
    title: 'Read-only for staff',
    body: 'The subscription is past due, so staff can read records but not change them. Tenants are not affected. Paying restores full access at once.',
  };
}

/** Plain words for the API's 403 `SUBSCRIPTION_READ_ONLY` (lib/errors uses it for every form). */
export { READ_ONLY_TEXT } from './errors';

// The bill (decisions 2, 3, 6 and 7) -----------------------------------------------------------

const BAND_PLURALS: Record<BillingBand, readonly [string, string]> = {
  single_room: ['single room', 'single rooms'],
  self_contained: ['self-contained flat or house', 'self-contained flats or houses'],
  commercial: ['commercial unit', 'commercial units'],
};

export const bandLabel = (band: BillingBand): string => BILLING_BAND_LABELS[band];

/** "GH₵5.00 a unit a month". */
export const rateText = (rateMinor: number): string => `${formatMinor(rateMinor)} a unit a month`;

/** "At least GH₵50.00 a month". */
export const minimumText = (minimumMinor: number): string =>
  `At least ${formatMinor(minimumMinor)} a month`;

/** "18 of 30 days": a tier's days in the month (decision 6), or the first month after a trial. */
export const daysText = (days: number, daysInMonth: number): string =>
  `${days} of ${daysInMonth} ${daysInMonth === 1 ? 'day' : 'days'}`;

/** An invoice's units line: "12 single rooms × GH₵5.00", with its days when it is prorated. */
export function unitLineText(input: {
  readonly band: BillingBand;
  readonly units: number;
  readonly rateMinor: number;
  readonly days?: number;
  readonly daysInMonth?: number;
}): string {
  const [one, many] = BAND_PLURALS[input.band];
  const base = `${input.units} ${input.units === 1 ? one : many} × ${formatMinor(input.rateMinor)}`;
  return input.days !== undefined &&
    input.daysInMonth !== undefined &&
    input.days < input.daysInMonth
    ? `${base} × ${daysText(input.days, input.daysInMonth)}`
    : base;
}

/** Shown on every placeholder price (decision 3, OQ-37) in the console. */
export const PLACEHOLDER_PRICE_TEXT =
  'Placeholder price: not a real rate yet. Real rates come from pricing research (OQ-37).';

/**
 * VAT on subscription invoices (decision 10, OQ-48): off until the platform's VAT registration is
 * recorded, and the rule stays unverified until the tax adviser confirms it.
 */
export function vatStatusText(input: {
  readonly charged: boolean;
  readonly verified: boolean;
}): string {
  const base = input.charged
    ? 'VAT and levies are charged on subscription invoices.'
    : 'No VAT is charged on subscription invoices: the platform’s VAT registration is not recorded.';
  return input.verified
    ? base
    : `${base} The VAT rule for subscriptions is not yet verified by the tax adviser (OQ-48).`;
}

/** A discount code's terms (decision 8): "10% off for 3 months". */
export function discountText(input: {
  readonly percentBps: number | null;
  readonly amountMinor: number | null;
  readonly months: number;
}): string {
  const span = `for ${input.months} ${input.months === 1 ? 'month' : 'months'}`;
  if (input.percentBps !== null) return `${bpsText(input.percentBps)} off ${span}`;
  return `${formatMinor(input.amountMinor ?? 0)} off a month ${span}`;
}

/** A code's limits: "Expires 31 Dec 2026; used 4 of 50 times." */
export function discountLimitsText(input: {
  readonly expiresOn: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
}): string {
  const expiry = input.expiresOn
    ? `Expires ${formatBusinessDate(input.expiresOn)}`
    : 'No expiry date';
  const uses =
    input.maxUses === null
      ? `used ${input.uses} ${input.uses === 1 ? 'time' : 'times'}`
      : `used ${input.uses} of ${input.maxUses} ${input.maxUses === 1 ? 'time' : 'times'}`;
  return `${expiry}; ${uses}.`;
}

/** The 1st of next month: when a downgrade or a cancellation takes effect (decisions 6 and 12). */
export const firstOfNextMonth = (today: string): string =>
  toIsoDate(addMonths(parseBusinessDate(`${today.slice(0, 7)}-01`), 1));

/** The last day of this month: when a cancellation takes effect (decision 12). */
export const lastDayOfMonth = (today: string): string =>
  toIsoDate(addDays(parseBusinessDate(firstOfNextMonth(today)), -1));

/** Before cancelling: when it ends and what keeps working (decision 12). */
export function cancelConfirmText(endsOn: string): string {
  return `The subscription ends on ${formatBusinessDate(endsOn)}, and this month is billed as usual. You can withdraw the cancellation until then. Afterwards staff can still read records and download documents for a time, and pay links, receipts and notices already issued keep working for tenants.`;
}

export const ANNUAL_NOTE =
  'A full month at your plan’s rates for the units let now, twelve times, less the annual discount, and never below twelve months of the plan’s minimum. It is held as credit, and each month’s invoice is paid from it first; anything over is billed as usual.';

/** The price of a year ahead, as the API quotes it (BE-23, `annualPrice`; review WEB-4). */
export function annualOfferText(price: {
  readonly totalMinor: number;
  readonly vatMinor: number;
  readonly discountBps: number;
  readonly firstMonth: string;
  readonly lastMonth: string;
}): string {
  return `${formatMinor(price.totalMinor)} for ${monthLabel(price.firstMonth)} to ${monthLabel(price.lastMonth)}, ${bpsText(price.discountBps)} off${price.vatMinor > 0 ? `, VAT and levies of ${formatMinor(price.vatMinor)} included` : ''}.`;
}

/**
 * This month's estimate, part by part (review WEB-1): the parts add up to the total, as the API
 * promises (`unitsMinor + minimumTopUpMinor + discountMinor + vatMinor = totalMinor`).
 */
export function estimateRows(
  estimate: {
    readonly unitsMinor: number;
    readonly minimumTopUpMinor: number;
    readonly discountMinor: number;
    readonly vatMinor: number;
    readonly totalMinor: number;
  },
  tierMinimumMinor: number | null,
): { readonly key: string; readonly label: string; readonly amountMinor: number }[] {
  return [
    { key: 'units', label: 'Units at their rates', amountMinor: estimate.unitsMinor },
    {
      key: 'top-up',
      label:
        tierMinimumMinor === null
          ? 'Top-up to the plan’s minimum'
          : `Top-up to the plan’s minimum of ${formatMinor(tierMinimumMinor)} a month (less for a part month)`,
      amountMinor: estimate.minimumTopUpMinor,
    },
    ...(estimate.discountMinor !== 0
      ? [{ key: 'discount', label: 'Discount', amountMinor: estimate.discountMinor }]
      : []),
    ...(estimate.vatMinor !== 0
      ? [{ key: 'vat', label: 'VAT and levies', amountMinor: estimate.vatMinor }]
      : []),
    { key: 'total', label: 'Estimate for the month', amountMinor: estimate.totalMinor },
  ];
}

/** Subscription billing on or off (founder, Q1; review WEB-16), for the console. */
export function billingStateText(state: {
  readonly on: boolean;
  readonly startsOn: string | null;
  readonly placeholderTiers: readonly Tier[];
}): { readonly title: string; readonly body: string } {
  if (state.on)
    return {
      title: 'Billing is on',
      body: state.startsOn
        ? `Subscriptions are billed from ${formatBusinessDate(state.startsOn)}; every trial that started before then ran from that day.`
        : 'Subscriptions are billed.',
    };
  return {
    title: 'Billing is off',
    body: [
      'Nothing is invoiced, and free trials have not started: each runs from the day billing goes on.',
      state.placeholderTiers.length > 0
        ? `It cannot go on while ${state.placeholderTiers.map((t) => TIER_LABELS[t]).join(', ')} ${state.placeholderTiers.length === 1 ? 'has' : 'have'} placeholder prices: add real prices first.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** The most a new credit note may take off an invoice: its total less earlier credits (Q2). */
export const creditableMinor = (invoice: {
  readonly totalMinor: number;
  readonly creditedMinor: number;
}): number => Math.max(0, invoice.totalMinor - invoice.creditedMinor);

export const ESTIMATE_NOTE =
  'An estimate from the leases in force this month, not an invoice. The invoice is made on the 1st of next month from the month’s snapshot: every unit with a lease on any day of the month is billed, and vacant units never are.';

/** What a tier change does and when (decision 6). */
export function tierChangeText(input: {
  readonly from: Tier;
  readonly to: Tier;
  /** The 1st of next month, for a downgrade. */
  readonly downgradeOn: string;
}): string {
  const up = TIERS.indexOf(input.to) > TIERS.indexOf(input.from);
  return up
    ? `${TIER_LABELS[input.to]} starts now. This month’s invoice charges each tier for its days.`
    : `${TIER_LABELS[input.to]} starts on ${formatBusinessDate(input.downgradeOn)}. You keep ${TIER_LABELS[input.from]}’s features until then.`;
}

/**
 * When cancelling now ends the subscription (decision 12): the month's end; during a trial the
 * earlier of the trial's last day and the month's end, with nothing billed (the domain's rule);
 * and during a year paid ahead, the year's last day (founder, Q3). Only for a subscription that
 * may still be cancelled.
 */
export function cancelPlan(input: {
  readonly today: string;
  readonly status: SubscriptionStatus;
  readonly trialEndsOn: string | null;
  /** The last day of a year paid ahead, while it runs. */
  readonly annualEndsOn?: string | null;
}): { readonly endsOn: string; readonly inTrial: boolean; readonly annual: boolean } {
  if (input.annualEndsOn && input.annualEndsOn >= input.today)
    return { endsOn: input.annualEndsOn, inTrial: false, annual: true };
  const endsOn = cancelEffectiveOn(input);
  return {
    endsOn,
    inTrial:
      input.status === 'trialing' && input.trialEndsOn !== null && endsOn <= input.trialEndsOn,
    annual: false,
  };
}

/** A cancellation, asked for or scheduled: when it ends, what is billed and what keeps working. */
export function cancelNoticeText(input: {
  readonly endsOn: string;
  readonly inTrial: boolean;
  readonly annual?: boolean;
  readonly readAccessUntil: string | null;
}): string {
  const ends = formatBusinessDate(input.endsOn);
  return [
    input.annual
      ? `Your service ends on ${ends}, when the year you paid for ends.`
      : input.inTrial
        ? `The subscription ends on ${ends}, within the free trial, so nothing is billed.`
        : `The subscription ends on ${ends}, and this month is billed as usual.`,
    'You can withdraw the cancellation until then.',
    input.readAccessUntil
      ? `After it, staff can read records and download documents until ${formatBusinessDate(input.readAccessUntil)}.`
      : 'After it, staff can still read records and download documents for a time.',
    'New rent invoices and automatic messages to tenants stop, but pay links for invoices already sent, receipts and notices already issued keep working.',
  ].join(' ');
}

/** The months a new price list may start: the 1st of each of the next `count` months (WEB-9). */
export function priceMonthStarts(today: string, count = 12): string[] {
  const first = parseBusinessDate(firstOfNextMonth(today));
  return Array.from({ length: count }, (_, i) => toIsoDate(addMonths(first, i)));
}

/** Portfolio today (decision 4, prd-issues 31): its extras are all still to come. */
export const PORTFOLIO_NOTE = `Portfolio’s extras are all coming soon: ${PORTFOLIO_COMING_SOON.map(
  (name) => name.charAt(0).toLowerCase() + name.slice(1),
).join(', ')}. Until they arrive, Portfolio includes what Growth includes, at Portfolio’s prices.`;

/** On a subscriber's invoice while the VAT rule is unverified (decision 10; review N4). */
export const INVOICE_VAT_NOTE =
  'The VAT and levy rates on this invoice are still to be confirmed by the platform’s tax adviser.';

/** Annual prepayment (decision 7): what it buys and how it is used. */
export function annualText(input: {
  readonly amountMinor: number;
  readonly discountBps: number;
}): string {
  return `Pay ${formatMinor(input.amountMinor)} now for 12 months: twelve times last month’s bill, less ${bpsText(input.discountBps)}. It is held as credit, and each month’s invoice is paid from it first; anything over is billed as usual.`;
}

/** Cancelling (decision 12): when it ends, and what keeps working. */
export function cancellationText(input: {
  readonly endsOn: string;
  readonly readAccessUntil: string;
}): string {
  return [
    `Your subscription ends on ${formatBusinessDate(input.endsOn)}, and this month is billed as usual. You can withdraw the cancellation until then.`,
    `After it, staff can read records and download documents until ${formatBusinessDate(input.readAccessUntil)}.`,
    'New rent invoices and automatic messages to tenants stop, but pay links for invoices already sent, receipts and notices already issued keep working.',
  ].join(' ');
}

// Support access (decision 13) -----------------------------------------------------------------

export { SUPPORT_GRANT_DEFAULT_HOURS, SUPPORT_GRANT_MAX_HOURS } from '@rent/domain/subscription';

export const SUPPORT_CONSENT_TEXT =
  'A platform administrator will be able to read your company’s records, but not change them, until the access ends. Every page they open is recorded in your audit log. You can end it at any time.';

/** The grant form's period: whole hours, 1 to 7 days' worth. */
export function grantHoursProblem(hours: number): string | null {
  if (!Number.isInteger(hours) || hours < 1) return 'Enter a whole number of hours, at least 1.';
  if (hours > MAX_HOURS) return 'Support access lasts at most 7 days (168 hours).';
  return null;
}

/** A grant's state: active until, ended, or revoked, with times in the company's time zone. */
export function grantStateText(
  grant: {
    readonly expiresAt: string;
    readonly revokedAt: string | null;
    readonly revokedByName?: string | null;
  },
  now: string,
  time: (iso: string) => string,
): { readonly active: boolean; readonly text: string } {
  if (grant.revokedAt)
    return {
      active: false,
      text: `Ended early ${time(grant.revokedAt)}${grant.revokedByName ? ` by ${grant.revokedByName}` : ''}.`,
    };
  if (epochMillisOf(grant.expiresAt) <= epochMillisOf(now))
    return { active: false, text: `Ended ${time(grant.expiresAt)}.` };
  return { active: true, text: `Active until ${time(grant.expiresAt)}.` };
}

/**
 * Whether a grant is active now (review N7): the server's word, ended at its expiry time as the
 * clock moves on, so a grant never shows active past `until`.
 */
export function grantActiveAt(
  grant: { readonly active: boolean; readonly until: string; readonly revokedAt: string | null },
  nowMillis: number,
): boolean {
  return grant.active && grant.revokedAt === null && epochMillisOf(grant.until) > nowMillis;
}

// Usage and messaging costs (decision 15) ------------------------------------------------------

export const SMS_COST_NOTE = 'SMS cost as the provider reported it for each message.';
export const WHATSAPP_COST_NOTE =
  'Estimated from the WhatsApp rate table by pricing category; Meta’s own bill may differ.';
export const ESTIMATED = 'Estimated';

// The API's refusals, in plain words (contracts subscription) ----------------------------------

export const SUBSCRIPTION_MESSAGES: Record<string, string> = {
  SUPPORT_NO_GRANT:
    'This company has not granted support access, or its access has ended. Ask its admin to grant it in Settings, Subscription.',
  NOTHING_TO_PAY: 'There is nothing to pay: every invoice is already paid.',
  TIER_UNCHANGED: 'The company is already on that plan.',
  SUBSCRIPTION_CANCELLED:
    'The subscription is cancelled or ending, so the plan cannot change. Withdraw the cancellation first.',
  DISCOUNT_UNKNOWN: 'There is no discount code like that. Check the spelling.',
  DISCOUNT_EXPIRED: 'That discount code has expired.',
  DISCOUNT_USED_UP: 'That discount code has been used as many times as it allows.',
  DISCOUNT_ALREADY_APPLIED:
    'A discount code is already applied. One code at a time: it can be replaced when it ends.',
  ALREADY_CANCELLING: 'The subscription is already set to end this month.',
  NOT_CANCELLING: 'The subscription is not set to end, so there is nothing to withdraw.',
  NOT_TRIALING: 'The company is not on a free trial, so there is no trial to extend.',
  DISCOUNT_CODE_TAKEN: 'A discount code with that name already exists. Choose another name.',
  EFFECTIVE_FROM_PAST: 'Choose a later date: prices, terms and rates never change in the past.',
  RULE_VALUE: 'The value does not fit this rule. Check its form against the rule in force.',
  OPEN_INVOICES: 'Pay the open invoices first; a year ahead can be paid once nothing is owed.',
  ANNUAL_ALREADY_PAID: 'A year ahead is already paid and still running.',
  CREDIT_EXCEEDS_INVOICE:
    'That is more than is left to credit on this invoice: its total less the credit notes already on it.',
  INVOICE_VOID: 'The invoice is void, so there is nothing to credit.',
  NOT_CANCELLED: 'The company’s subscription has not ended, so there is nothing to start again.',
  PLACEHOLDER_PRICES:
    'Billing cannot go on while a plan’s prices in force on that day are placeholders. Add real prices first.',
  BILLING_ALREADY_ON: 'Billing is already on.',
};

/** The plain words for a subscription or console refusal, or null to use the API's own. */
export function subscriptionMessage(error: unknown): string | null {
  return SUBSCRIPTION_MESSAGES[errorCode(error)] ?? null;
}

// Invoices, receipts and payments -------------------------------------------------------------

export const INVOICE_STATUS_LABELS: Record<SubscriptionInvoiceStatus, string> = {
  open: 'Open',
  paid: 'Paid',
  void: 'Void',
};

/** An invoice's state for people: paid, open, or past due with what is left. */
export function invoiceStateText(invoice: {
  readonly status: SubscriptionInvoiceStatus;
  readonly pastDue: boolean;
  readonly outstandingMinor: number;
}): string {
  if (invoice.status !== 'open') return INVOICE_STATUS_LABELS[invoice.status];
  return invoice.pastDue
    ? `Past due: ${formatMinor(invoice.outstandingMinor)} to pay`
    : `${formatMinor(invoice.outstandingMinor)} to pay`;
}

/** An invoice line: units lines are written out (with their tier when it changed in the month). */
export function invoiceLineText(line: {
  readonly kind: string;
  readonly description: string;
  readonly tier: Tier | null;
  readonly band: BillingBand | null;
  readonly units: number | null;
  readonly rateMinor: number | null;
  readonly days: number | null;
  readonly daysInMonth: number | null;
}): string {
  if (line.kind !== 'units' || !line.band || line.units === null || line.rateMinor === null)
    return line.description;
  const text = unitLineText({
    band: line.band,
    units: line.units,
    rateMinor: line.rateMinor,
    ...(line.days !== null && line.daysInMonth !== null
      ? { days: line.days, daysInMonth: line.daysInMonth }
      : {}),
  });
  return line.tier ? `${TIER_LABELS[line.tier]}: ${text}` : text;
}

/** The bands in order, with a value each: billable units, or a tier's rates. */
export function bandRows(
  values: Readonly<Record<BillingBand, number>>,
): { readonly band: BillingBand; readonly label: string; readonly value: number }[] {
  return BILLING_BANDS.map((band) => ({ band, label: bandLabel(band), value: values[band] }));
}

export const totalUnits = (counts: Readonly<Record<BillingBand, number>>): number =>
  BILLING_BANDS.reduce((sum, band) => sum + counts[band], 0);

export const PAYMENT_STATUS_LABELS: Record<SubscriptionPaymentStatus, string> = {
  initiated: 'Started',
  pending: 'Waiting for the payment',
  succeeded: 'Paid',
  failed: 'Failed',
  reversed: 'Reversed',
};

/** What the pay form does next: keep asking, show the receipt, or say it failed. */
export function paymentNext(status: SubscriptionPaymentStatus): 'wait' | 'paid' | 'failed' {
  if (status === 'succeeded') return 'paid';
  if (status === 'failed' || status === 'reversed') return 'failed';
  return 'wait';
}

/**
 * What the pay form submits (review WEB-5): the purpose the person picked if the API still offers
 * it, otherwise the first one offered; null when nothing is offered.
 */
export function chosenPurpose(
  picked: SubscriptionPaymentPurpose | null,
  offers: { readonly invoices: boolean; readonly annual: boolean },
): SubscriptionPaymentPurpose | null {
  const offered: SubscriptionPaymentPurpose[] = [
    ...(offers.invoices ? (['invoices'] as const) : []),
    ...(offers.annual ? (['annual'] as const) : []),
  ];
  return picked !== null && offered.includes(picked) ? picked : (offered[0] ?? null);
}

export const PAYMENT_POLL_MS = 3_000;
export const PAYMENT_POLL_TRIES = 60;

/** MoMo networks the provider prompts on (contracts: `momoProvider`). */
export const MOMO_PROVIDER_LABELS = {
  mtn: 'MTN MoMo',
  vodafone: 'Telecel Cash',
  airteltigo: 'AirtelTigo Money',
} as const;
export type MomoProvider = keyof typeof MOMO_PROVIDER_LABELS;

/** A card checkout page is opened only when it is a web address. */
export const checkoutLink = (url: string | null): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

// The console ---------------------------------------------------------------------------------

/** The terms' fields in words (decisions 2, 5, 10, 11 and 12). */
export function termsRows(terms: {
  readonly trialDays: number;
  readonly graceDays: number;
  readonly readOnlyEnabled: boolean;
  readonly dueDays: number;
  readonly retentionDaysAfterCancel: number;
  readonly vatRegistered: boolean;
}): { readonly key: string; readonly label: string; readonly value: string }[] {
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  return [
    { key: 'trial', label: 'Free trial', value: days(terms.trialDays) },
    { key: 'due', label: 'Invoice due', value: `${days(terms.dueDays)} after it is issued` },
    {
      key: 'read-only',
      label: 'Read-only for unpaid invoices',
      value: terms.readOnlyEnabled ? `On, ${days(terms.graceDays)} after the due date` : 'Off',
    },
    {
      key: 'retention',
      label: 'Read access after cancelling',
      value: days(terms.retentionDaysAfterCancel),
    },
    {
      key: 'vat',
      label: 'VAT on subscription invoices',
      value: terms.vatRegistered ? 'Charged (the platform is VAT-registered)' : 'Not charged',
    },
  ];
}

/** A whole number typed in a form, within limits; or why it is not one. */
export function wholeNumberOf(
  text: string,
  min: number,
  max: number,
): { readonly value: number | null; readonly problem: string | null } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { value: null, problem: 'Enter a whole number.' };
  const value = Number(trimmed);
  if (value < min || value > max)
    return { value: null, problem: `Enter a number from ${min} to ${max}.` };
  return { value, problem: null };
}

export const RULE_STATE_LABELS = {
  in_force: 'In force',
  superseded: 'Superseded',
  future: 'From a future date',
} as const;

export const VERIFICATION_LABELS = {
  verified: 'Verified',
  from_prd: 'From the PRD',
  unverified: 'Unverified',
} as const;

/**
 * A rule from a past date (BE-25): allowed, because a law can be published after it takes effect;
 * the form says what it changes. Null for today or later.
 */
export function pastRuleWarning(from: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from >= today) return null;
  return `This applies from a past date. Records already made keep the rule they used; anything worked out from now on for dates from ${formatBusinessDate(from)} uses this value.`;
}

/** A rules value for people: numbers, words, true or false, or its JSON. */
export function ruleValueText(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** A rules value typed as JSON (as `pnpm rules:add` takes it); or why it is not JSON. */
export function ruleValueOf(text: string): {
  readonly value: unknown;
  readonly problem: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined, problem: 'Enter the value.' };
  try {
    return { value: JSON.parse(trimmed) as unknown, problem: null };
  } catch {
    return {
      value: undefined,
      problem:
        'Enter the value as JSON: a number such as 800, true or false, "text" in quotes, or an object.',
    };
  }
}

/** System health alerts (decision 15). */
export const ALERT_SEVERITY_LABELS = {
  info: 'Information',
  warning: 'Warning',
  critical: 'Critical',
} as const;

/** Meta's pricing categories, for the WhatsApp rate table (decision 15). */
export const PRICING_CATEGORY_LABELS = {
  utility: 'Utility',
  marketing: 'Marketing',
  authentication: 'Authentication',
  service: 'Service (replies within 24 hours)',
  referral_conversion: 'Referral conversion',
} as const;

export type VersionState = 'in_force' | 'future' | 'replaced';

export const VERSION_STATE_LABELS: Record<VersionState, string> = {
  in_force: 'In force',
  future: 'From a future date',
  replaced: 'Replaced',
};

/**
 * Which version of a price list, the terms or a WhatsApp rate is in force today, per group (a
 * tier, a category): the latest that has started; later ones are future, earlier ones replaced.
 * Rows are never edited, so a change is always a new version (decision 3).
 */
export function versionStates<
  T extends { readonly id: string; readonly effectiveFrom: string; readonly createdAt: string },
>(
  rows: readonly T[],
  groupOf: (row: T) => string,
  today: string,
  /**
   * The day a version starts to count, `effectiveFrom` unless given: a price list counts from the
   * first month it prices (BE-25), so it passes the 1st of that month.
   */
  startOf: (row: T) => string = (row) => row.effectiveFrom,
): Map<string, VersionState> {
  const states = new Map<string, VersionState>();
  const current = new Map<string, T>();
  for (const row of rows) {
    const start = startOf(row);
    if (start > today) {
      states.set(row.id, 'future');
      continue;
    }
    const group = groupOf(row);
    const best = current.get(group);
    const bestStart = best ? startOf(best) : null;
    const later =
      !best ||
      bestStart === null ||
      start > bestStart ||
      (start === bestStart && row.createdAt > best.createdAt);
    if (later) current.set(group, row);
  }
  const inForce = new Set([...current.values()].map((row) => row.id));
  for (const row of rows)
    if (!states.has(row.id)) states.set(row.id, inForce.has(row.id) ? 'in_force' : 'replaced');
  return states;
}
