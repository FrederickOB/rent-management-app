import { taxLinesOn } from '../billing/invoicing';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  parseBusinessDate,
  toIsoDate,
  type BusinessDate,
} from '../dates';
import { DomainError } from '../errors';
import { monthOf } from '../ledger/periods';
import { add, format, money, multiplyBps, multiplyFraction } from '../money/money';
import { BILLING_BANDS, type BillingBand } from '../portfolio/unit-types';
import { isSubscriptionTier, TIER_LABELS, type SubscriptionTier } from '../settings/entitlements';
import type { SubscriptionLineKind } from './constants';

/**
 * The monthly subscription bill (M10 decisions 2, 3, 5, 6, 7, 8 and 10; PB-02, PB-03, PB-05).
 * Billing is monthly in arrears on calendar months in the subscriber's time zone. Each line is
 * rounded once, half up, in packages/domain/money (CLAUDE.md section 4). Rates, minimums,
 * discounts and VAT rates are inputs: the price list and the rules table, never constants here.
 */

/** A number per billing band: units, or pesewas per unit per month. */
export type BandCounts = Readonly<Record<BillingBand, number>>;

/** One tier's price list in force for the month (PB-03, decision 3). */
export interface PriceList {
  readonly tier: SubscriptionTier;
  /** Pesewas per billable unit per month, by band. */
  readonly ratesMinor: BandCounts;
  /** The tier's monthly minimum (PB-05): the floor, never discounted. */
  readonly minimumMinor: number;
  /** The annual prepayment discount (decision 7). */
  readonly annualDiscountBps: number;
}

/** The billed days of a month on one tier, inclusive ISO dates inside the month. */
export interface TierSpan {
  readonly tier: SubscriptionTier;
  readonly firstDay: string;
  readonly lastDay: string;
  readonly prices: PriceList;
}

/**
 * One invoice line. `units` lines carry the tier, band, units, rate per unit per month, days and
 * days in the month, and in `rateBps` the annual discount applied, if any. `minimum` lines carry
 * the tier, the monthly minimum in `rateMinor` and the days. `discount` lines carry the percentage
 * in `rateBps`, or the fixed monthly amount in `rateMinor`. VAT and levy lines carry their rate.
 */
export interface BillLine {
  readonly kind: SubscriptionLineKind;
  readonly description: string;
  readonly tier: SubscriptionTier | null;
  readonly band: BillingBand | null;
  readonly units: number | null;
  readonly rateMinor: number | null;
  readonly days: number | null;
  readonly daysInMonth: number | null;
  readonly rateBps: number | null;
  readonly amountMinor: number;
}

/** The terms of the discount code in force for the month (decision 8). */
export type DiscountTerms =
  | { readonly kind: 'percentage'; readonly percentBps: number; readonly code: string }
  | { readonly kind: 'fixed'; readonly amountMinor: number; readonly code: string };

/** VAT and levies on the subscription (decision 10): `vat.platform_subscription`, an input. */
export interface SubscriptionVatRates {
  readonly vatBps: number;
  readonly nhilBps: number;
  readonly getfundBps: number;
}

export interface MonthlyBill {
  readonly lines: BillLine[];
  /** The units and minimum lines. */
  readonly subtotalMinor: number;
  /** The discount line: zero or negative. */
  readonly discountMinor: number;
  readonly netMinor: number;
  readonly vatMinor: number;
  readonly totalMinor: number;
}

const BPS_WHOLE = 10_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Months (calendar months, `YYYY-MM`).

function checkMonth(month: string): string {
  if (typeof month !== 'string' || !MONTH.test(month))
    throw new DomainError('subscription.bad_month', `Not a month: ${String(month)}`);
  return month;
}

const firstOf = (month: string): BusinessDate => parseBusinessDate(`${checkMonth(month)}-01`);

/** The first and last day of a month. */
export function monthBounds(month: string): { first: string; last: string } {
  const first = firstOf(month);
  return { first: toIsoDate(first), last: toIsoDate(addDays(addMonths(first, 1), -1)) };
}

/** 28 to 31. */
export function daysInMonth(month: string): number {
  const first = firstOf(month);
  return daysBetween(first, addMonths(first, 1));
}

/** The month a business date falls in: '2026-11-07' -> '2026-11' (the ledger's own, re-exported). */
export { monthOf };

/** The month `months` calendar months after (or, negative, before) `month`. */
export function shiftMonth(month: string, months: number): string {
  if (!Number.isSafeInteger(months))
    throw new DomainError('subscription.bad_month', 'Months must be a whole number');
  return toIsoDate(addMonths(firstOf(month), months)).slice(0, 7);
}

export const previousMonth = (month: string): string => shiftMonth(month, -1);
export const nextMonth = (month: string): string => shiftMonth(month, 1);

/** Whole months from `from` to `to`: '2026-11' to '2027-01' is 2; negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const index = (month: string): number =>
    Number(checkMonth(month).slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  return index(to) - index(from);
}

export function compareMonths(a: string, b: string): -1 | 0 | 1 {
  checkMonth(a);
  checkMonth(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Days from `first` to `last`, both counted. */
export const daysInclusive = (first: string, last: string): number =>
  daysBetween(parseBusinessDate(first), parseBusinessDate(last)) + 1;

const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (compareDates(a, b) >= 0 ? a : b);
const earlier = (a: BusinessDate, b: BusinessDate): BusinessDate =>
  compareDates(a, b) <= 0 ? a : b;

// Checks.

function checkAmount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('subscription.bad_amount', `${what} must be zero or more pesewas`);
  return value;
}

function checkBps(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > BPS_WHOLE)
    throw new DomainError(
      'subscription.bad_rate',
      `${what} must be whole basis points from 0 to 10,000`,
    );
  return value;
}

/** Units per band: whole numbers, zero or more, for every band. */
export function checkBandCounts(counts: BandCounts, what = 'Units'): BandCounts {
  const out = {} as Record<BillingBand, number>;
  for (const band of BILLING_BANDS) {
    const value = counts[band];
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError(
        'subscription.bad_count',
        `${what} for ${band} must be a whole number, zero or more`,
      );
    out[band] = value;
  }
  return out;
}

/** A price list for a tier: rates and the minimum in pesewas, the annual discount in bps. */
export function checkPriceList(prices: PriceList, tier: SubscriptionTier = prices.tier): PriceList {
  if (!isSubscriptionTier(prices.tier) || prices.tier !== tier)
    throw new DomainError(
      'subscription.price_list_mismatch',
      `The price list is for ${String(prices.tier)}, not ${tier}`,
    );
  const ratesMinor = {} as Record<BillingBand, number>;
  for (const band of BILLING_BANDS)
    ratesMinor[band] = checkAmount(prices.ratesMinor[band], `The ${band} rate`);
  return {
    tier,
    ratesMinor,
    minimumMinor: checkAmount(prices.minimumMinor, 'The minimum'),
    annualDiscountBps: checkBps(prices.annualDiscountBps, 'The annual discount'),
  };
}

export function checkDiscountTerms(terms: DiscountTerms): DiscountTerms {
  if (typeof terms.code !== 'string' || terms.code.trim() === '')
    throw new DomainError('discount.invalid', 'A discount needs its code');
  if (terms.kind === 'percentage')
    return {
      kind: 'percentage',
      percentBps: checkBps(terms.percentBps, 'A percentage discount'),
      code: terms.code,
    };
  if (terms.kind === 'fixed')
    return {
      kind: 'fixed',
      amountMinor: checkAmount(terms.amountMinor, 'A fixed discount'),
      code: terms.code,
    };
  throw new DomainError('discount.invalid', 'A discount is a percentage or a fixed amount');
}

export function checkVatRates(vat: SubscriptionVatRates): SubscriptionVatRates {
  for (const [value, what] of [
    [vat.vatBps, 'VAT'],
    [vat.nhilBps, 'NHIL'],
    [vat.getfundBps, 'GETFund'],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError('subscription.bad_vat', `${what} must be whole basis points`);
  return { vatBps: vat.vatBps, nhilBps: vat.nhilBps, getfundBps: vat.getfundBps };
}

// Words for people.

const BAND_NOUNS: Record<BillingBand, readonly [string, string]> = {
  single_room: ['single room', 'single rooms'],
  self_contained: ['self-contained unit', 'self-contained units'],
  commercial: ['commercial unit', 'commercial units'],
};

/** Basis points for people: 1000 -> "10%", 1250 -> "12.5%", 25 -> "0.25%". */
export function percentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`;
}

const cedis = (minor: number): string => format(money(minor));
const daysText = (days: number, inMonth: number): string => `${days} of ${inMonth} days`;

const TAX_NAMES = { vat: 'VAT', nhil: 'NHIL', getfund: 'GETFund levy' } as const;

// Tier spans (decisions 5, 6 and 12).

/**
 * The month's billed days split by tier. `changes` is the tier history (each tier from a date,
 * ascending; the first entry may start before the month). `billFrom` is the first billable day
 * (the day after the trial ends; null = whole month) and `billTo` the last (cancellation; null =
 * month end). Days outside [billFrom, billTo] are not billed, and neither are days before the
 * first entry (the subscription did not exist yet). Of two changes from the same day the later
 * listed wins; neighbouring spans on the same tier are one span. Returns [] when nothing in the
 * month is billable.
 */
export function tierSpans(input: {
  readonly month: string;
  readonly changes: readonly { readonly tier: SubscriptionTier; readonly from: string }[];
  readonly billFrom: string | null;
  readonly billTo: string | null;
  readonly pricesFor: (tier: SubscriptionTier) => PriceList;
}): TierSpan[] {
  const bounds = monthBounds(input.month);
  let from = parseBusinessDate(bounds.first);
  let to = parseBusinessDate(bounds.last);
  if (input.billFrom !== null) from = later(from, parseBusinessDate(input.billFrom));
  if (input.billTo !== null) to = earlier(to, parseBusinessDate(input.billTo));

  const changes = input.changes.map((change) => {
    if (!isSubscriptionTier(change.tier))
      throw new DomainError('subscription.bad_tier', `Not a tier: ${String(change.tier)}`);
    return { tier: change.tier, from: parseBusinessDate(change.from) };
  });
  changes.forEach((change, i) => {
    const prior = changes[i - 1];
    if (prior && compareDates(change.from, prior.from) < 0)
      throw new DomainError(
        'subscription.bad_tier_history',
        'Tier changes must be listed in date order',
      );
  });
  if (compareDates(from, to) > 0) return [];

  const prices = new Map<SubscriptionTier, PriceList>();
  const priceListOf = (tier: SubscriptionTier): PriceList => {
    let found = prices.get(tier);
    if (!found) {
      found = checkPriceList(input.pricesFor(tier), tier);
      prices.set(tier, found);
    }
    return found;
  };

  const spans: TierSpan[] = [];
  changes.forEach((change, i) => {
    const next = changes[i + 1];
    const start = later(change.from, from);
    const end = next ? earlier(addDays(next.from, -1), to) : to;
    if (compareDates(start, end) > 0) return;
    const prior = spans[spans.length - 1];
    if (
      prior &&
      prior.tier === change.tier &&
      compareDates(addDays(parseBusinessDate(prior.lastDay), 1), start) === 0
    ) {
      spans[spans.length - 1] = { ...prior, lastDay: toIsoDate(end) };
      return;
    }
    spans.push({
      tier: change.tier,
      firstDay: toIsoDate(start),
      lastDay: toIsoDate(end),
      prices: priceListOf(change.tier),
    });
  });
  return spans;
}

// The bill (decisions 2, 3, 6, 7, 8 and 10).

const plus = (a: number, b: number): number => add(money(a), money(b)).amountMinor;

/**
 * The month's invoice lines. For each span: one `units` line per band with units > 0: units ×
 * rate × days ÷ days in the month (× (1 − annual discount) when `annual`), rounded once; then a
 * `minimum` top-up line when the span's units lines are below the span's prorated minimum (minimum
 * × days ÷ days in the month, rounded once; never discounted: it is the floor). Then one negative
 * `discount` line (a percentage of the subtotal, or the fixed amount capped at the subtotal), then
 * VAT, NHIL and GETFund lines on the net after the discount, only when `vat` is not null. No zero
 * lines. A company with no billable units still owes the prorated minimum (PB-05). The estimate on
 * the subscription page is this bill for the units billable so far (`billableUnits` up to today)
 * over the month's tier spans.
 */
export function monthlyBill(input: {
  readonly month: string;
  readonly counts: BandCounts;
  readonly spans: readonly TierSpan[];
  readonly annual: boolean;
  readonly discount: DiscountTerms | null;
  readonly vat: SubscriptionVatRates | null;
}): MonthlyBill {
  const inMonth = daysInMonth(input.month);
  const bounds = monthBounds(input.month);
  const monthFirst = parseBusinessDate(bounds.first);
  const monthLast = parseBusinessDate(bounds.last);
  const counts = checkBandCounts(input.counts);
  const lines: BillLine[] = [];

  let previousLast: BusinessDate | null = null;
  for (const span of input.spans) {
    const prices = checkPriceList(span.prices, span.tier);
    const first = parseBusinessDate(span.firstDay);
    const last = parseBusinessDate(span.lastDay);
    if (
      compareDates(first, monthFirst) < 0 ||
      compareDates(last, monthLast) > 0 ||
      compareDates(first, last) > 0 ||
      (previousLast !== null && compareDates(first, previousLast) <= 0)
    )
      throw new DomainError(
        'subscription.bad_span',
        'Tier spans must lie inside the month, in order, without overlapping',
      );
    previousLast = last;
    const days = daysBetween(first, last) + 1;
    const tierName = TIER_LABELS[span.tier];
    const discountBps = input.annual ? prices.annualDiscountBps : 0;

    let unitsMinor = 0;
    for (const band of BILLING_BANDS) {
      const units = counts[band];
      if (units === 0) continue;
      const rateMinor = prices.ratesMinor[band];
      const amountMinor = multiplyFraction(
        money(rateMinor),
        [units, days, BPS_WHOLE - discountBps],
        [inMonth, BPS_WHOLE],
      ).amountMinor;
      if (amountMinor === 0) continue;
      unitsMinor = plus(unitsMinor, amountMinor);
      const noun = BAND_NOUNS[band][units === 1 ? 0 : 1];
      lines.push({
        kind: 'units',
        description:
          `${tierName}: ${units} ${noun}, ${daysText(days, inMonth)} at ${cedis(rateMinor)}` +
          (discountBps > 0 ? `, less the ${percentText(discountBps)} annual discount` : ''),
        tier: span.tier,
        band,
        units,
        rateMinor,
        days,
        daysInMonth: inMonth,
        rateBps: discountBps > 0 ? discountBps : null,
        amountMinor,
      });
    }

    const floorMinor = multiplyFraction(money(prices.minimumMinor), [days], [inMonth]).amountMinor;
    if (unitsMinor < floorMinor)
      lines.push({
        kind: 'minimum',
        description: `${tierName}: top-up to the ${cedis(prices.minimumMinor)} monthly minimum, ${daysText(days, inMonth)}`,
        tier: span.tier,
        band: null,
        units: null,
        rateMinor: prices.minimumMinor,
        days,
        daysInMonth: inMonth,
        rateBps: null,
        amountMinor: floorMinor - unitsMinor,
      });
  }

  const subtotalMinor = lines.reduce((total, line) => plus(total, line.amountMinor), 0);

  let discountMinor = 0;
  if (input.discount !== null) {
    const terms = checkDiscountTerms(input.discount);
    const off =
      terms.kind === 'percentage'
        ? multiplyBps(money(subtotalMinor), terms.percentBps).amountMinor
        : Math.min(terms.amountMinor, subtotalMinor);
    if (off > 0) {
      discountMinor = -off;
      lines.push({
        kind: 'discount',
        description:
          terms.kind === 'percentage'
            ? `Discount code ${terms.code}: ${percentText(terms.percentBps)} off`
            : `Discount code ${terms.code}: ${cedis(terms.amountMinor)} off` +
              (off < terms.amountMinor ? ', up to the amount billed' : ''),
        tier: null,
        band: null,
        units: null,
        rateMinor: terms.kind === 'fixed' ? terms.amountMinor : null,
        days: null,
        daysInMonth: null,
        rateBps: terms.kind === 'percentage' ? terms.percentBps : null,
        amountMinor: discountMinor,
      });
    }
  }
  const netMinor = plus(subtotalMinor, discountMinor);

  let vatMinor = 0;
  if (input.vat !== null) {
    for (const tax of taxLinesOn(netMinor, checkVatRates(input.vat))) {
      vatMinor = plus(vatMinor, tax.amountMinor);
      lines.push({
        kind: tax.kind,
        description: `${TAX_NAMES[tax.kind]} at ${percentText(tax.rateBps)}`,
        tier: null,
        band: null,
        units: null,
        rateMinor: null,
        days: null,
        daysInMonth: null,
        rateBps: tax.rateBps,
        amountMinor: tax.amountMinor,
      });
    }
  }

  return {
    lines,
    subtotalMinor,
    discountMinor,
    netMinor,
    vatMinor,
    totalMinor: plus(netMinor, vatMinor),
  };
}

/** The prorated minimum of a set of spans: what `monthlyBill`'s subtotal never falls below. */
export function proratedMinimumMinor(month: string, spans: readonly TierSpan[]): number {
  const inMonth = daysInMonth(month);
  return spans.reduce(
    (total, span) =>
      plus(
        total,
        multiplyFraction(
          money(checkPriceList(span.prices, span.tier).minimumMinor),
          [daysInclusive(span.firstDay, span.lastDay)],
          [inMonth],
        ).amountMinor,
      ),
    0,
  );
}
