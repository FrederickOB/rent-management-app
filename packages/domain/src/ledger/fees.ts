import type { LineKind } from '../billing/lines';
import { addDays, addMonths, compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { allocate, money, multiplyBps } from '../money/money';
import { compactLines, type JournalLineDraft, type LineDimensions } from './journal';
import type { PaymentAmount } from './posting';

/**
 * Management fees (AC-02; P14; M9 plan decisions 1 to 3 and section 4.2). The agency's fee is an
 * expense of the owner (Dr 5100) and owed to the agent until it is taken (Cr 2300). Agency-managed
 * owners only: a self-managing landlord has no fee terms. Fees post gross, with no VAT, until the
 * tax adviser answers OQ-60 (M9 decision 4).
 */

// Fee terms (decision 1).

export const FEE_KINDS = ['none', 'percentage', 'fixed_per_unit'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

/**
 * The fee terms of a management agreement: a percentage of the OQ-31 base per receipt, in basis
 * points, or a fixed amount per billable unit per month, in pesewas.
 */
export type FeeTerms =
  | { readonly kind: 'none' }
  | { readonly kind: 'percentage'; readonly rateBps: number }
  | { readonly kind: 'fixed_per_unit'; readonly amountMinor: number };

/** One version of the terms, from its effective date (a change is a new version, never an edit). */
export interface FeeTermsVersion {
  readonly effectiveFrom: string;
  readonly terms: FeeTerms;
}

/** A fee of 100% of the base is the ceiling: a fee can never take more than the rent itself. */
export const MAX_FEE_RATE_BPS = 10_000;

export function checkFeeTerms(terms: FeeTerms): FeeTerms {
  switch (terms.kind) {
    case 'none':
      return { kind: 'none' };
    case 'percentage':
      if (
        !Number.isSafeInteger(terms.rateBps) ||
        terms.rateBps <= 0 ||
        terms.rateBps > MAX_FEE_RATE_BPS
      )
        throw new DomainError(
          'fees.rate_invalid',
          'A percentage fee is a whole number of basis points from 1 to 10,000',
        );
      return { kind: 'percentage', rateBps: terms.rateBps };
    case 'fixed_per_unit':
      if (!Number.isSafeInteger(terms.amountMinor) || terms.amountMinor <= 0)
        throw new DomainError(
          'fees.amount_invalid',
          'A fixed fee per unit is a positive amount in pesewas',
        );
      return { kind: 'fixed_per_unit', amountMinor: terms.amountMinor };
    default:
      throw new DomainError('fees.kind_invalid', 'Choose no fee, a percentage or a fixed fee');
  }
}

/**
 * The version in force on a business date: the latest effective on or before it; of two with the
 * same date, the later one listed (versions are listed in the order they were made). Null before
 * the first version: there is no backfill, so money received earlier carries no fee (decision 2).
 */
export function feeTermsOn(
  versions: readonly FeeTermsVersion[],
  date: string,
): FeeTermsVersion | null {
  const day = parseBusinessDate(date);
  let found: FeeTermsVersion | null = null;
  for (const version of versions) {
    const from = parseBusinessDate(version.effectiveFrom);
    if (compareDates(from, day) > 0) continue;
    if (found === null || compareDates(from, parseBusinessDate(found.effectiveFrom)) >= 0)
      found = version;
  }
  return found;
}

// The fee base (OQ-31, decision 2).

/**
 * Where the money that settles a line came from: cash as it arrives (`payment`), a deposit applied
 * at move-out (P11), tax withheld (P19), or a payment's credit drawn onto a month later
 * (`credit_draw`; founder decision, 2026-11-05).
 */
export const FEE_BASE_SOURCES = ['payment', 'deposit', 'withholding', 'credit_draw'] as const;
export type FeeBaseSource = (typeof FEE_BASE_SOURCES)[number];

/** The line kinds whose settlement carries a fee (OQ-31): rent and service charge. */
export const FEE_BEARING_KINDS: readonly LineKind[] = ['rent', 'service_charge'];

/**
 * One part of the money an event settles: the kind of line it settles, or `surplus` for what a
 * payment leaves unallocated (P05), and where the money came from. Surplus carries no fee when it
 * arrives; when its credit later pays a month, that draw is a part of the month's kind with source
 * `credit_draw` (founder decision, 2026-11-05).
 */
export interface FeeBasePart {
  readonly kind: LineKind | 'surplus';
  readonly source: FeeBaseSource;
  readonly amountMinor: number;
}

const nonNegative = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new DomainError('fees.bad_amount', `${what} must be zero or more pesewas`);
  return amount;
};

/**
 * The fee base of one event (OQ-31): the rent and service charge it settles, whether the period
 * has started or is paid in advance, and whether the money is cash, a deposit applied at move-out,
 * tax withheld or credit drawn onto the month. Deposits paid in, VAT and levies, one-off charges
 * and surplus not yet applied are never in it.
 */
export function feeBaseOf(parts: readonly FeeBasePart[]): number {
  let base = 0;
  for (const part of parts) {
    nonNegative(part.amountMinor, 'A part of the fee base');
    if (!(FEE_BASE_SOURCES as readonly string[]).includes(part.source))
      throw new DomainError('fees.bad_source', `Money from ${part.source} carries no fee`);
    if (part.kind !== 'surplus' && FEE_BEARING_KINDS.includes(part.kind)) base += part.amountMinor;
  }
  return base;
}

/**
 * The lease's position, so an event is never charged on money the lease's fees already cover.
 * Withholding recorded after the tenant's cash paid the month (P19, M5 review 2) returns that cash
 * to credit, and a credit note releases paid money to credit: when that credit is drawn onto a
 * month again, it was charged once already. With the guard on every event, no event takes the base
 * charged on the lease above the rent and service charge settled on it. Measured after the event.
 */
export interface FeeBaseGuard {
  /**
   * Rent and service charge settled on the lease, by payments (credit drawn included), deposits
   * and withholding, net of reversals.
   */
  readonly settledMinor: number;
  /** The base of the lease's fees before this event, net of their reversals. */
  readonly chargedBaseMinor: number;
}

/**
 * The base an event is charged on: its own fee base, never more than the lease's settled rent and
 * service charge its fees do not cover yet. Without the guard, the event's own base.
 */
export function chargeableFeeBase(eventBaseMinor: number, guard?: FeeBaseGuard | null): number {
  nonNegative(eventBaseMinor, 'The fee base');
  if (!guard) return eventBaseMinor;
  nonNegative(guard.settledMinor, 'Settled rent');
  nonNegative(guard.chargedBaseMinor, 'The base already charged');
  return Math.max(0, Math.min(eventBaseMinor, guard.settledMinor - guard.chargedBaseMinor));
}

/** The fee on a base: the rate in basis points, rounded half up to the pesewa once (ADR-004). */
export function feeOnBaseMinor(baseMinor: number, rateBps: number): number {
  nonNegative(baseMinor, 'The fee base');
  checkFeeTerms({ kind: 'percentage', rateBps });
  return multiplyBps(money(baseMinor), rateBps).amountMinor;
}

export interface PercentageFee {
  readonly baseMinor: number;
  readonly rateBps: number;
  readonly feeMinor: number;
}

/**
 * P14 per receipt (decision 2): with percentage terms in force on the event's value date, the
 * rate on its chargeable base, rounded once. Null when the terms are not a percentage (no fee, a
 * fixed fee, or no agreement yet). A zero fee posts nothing.
 */
export function percentageFee(input: {
  readonly terms: FeeTerms | null;
  readonly parts: readonly FeeBasePart[];
  readonly guard?: FeeBaseGuard | null;
}): PercentageFee | null {
  if (input.terms === null) return null;
  const terms = checkFeeTerms(input.terms);
  if (terms.kind !== 'percentage') return null;
  const baseMinor = chargeableFeeBase(feeBaseOf(input.parts), input.guard);
  return { baseMinor, rateBps: terms.rateBps, feeMinor: feeOnBaseMinor(baseMinor, terms.rateBps) };
}

// Credit drawn onto a month (founder decision, 2026-11-05).

/** A payment's part of a credit draw's fee, so a reversal of that payment can mirror it (P21b). */
export interface DrawFeeShare {
  readonly paymentId: string;
  readonly baseMinor: number;
  readonly feeMinor: number;
}

export interface CreditDrawFee extends PercentageFee {
  /** By payment, in the draws' order; payments whose part of the base is zero are left out. */
  readonly shares: readonly DrawFeeShare[];
}

/**
 * P14 on credit drawn onto rent or service charge (founder decision, 2026-11-05). An overpayment
 * carries no fee when it arrives; when its credit later pays a month, the amount it settles is
 * rent settled like any other (OQ-31). The draws are P02's surplus applied as a period starts, the
 * credit draw after a correction (architecture section 6, allocation 5), and P13's credit applied
 * to open lines. Not the line's own advance allocations, a late draw or a withholding draw: that
 * money was charged when it arrived.
 *
 * The fee is the rate on the chargeable base, rounded once, and split across the payments whose
 * credit was drawn by largest remainder. Pass the guard: credit a credit note or withholding
 * released was charged once already. Null when the terms are not a percentage.
 */
export function creditDrawFee(input: {
  readonly terms: FeeTerms | null;
  /** The kind of line the credit pays: only rent and service charge carry a fee. */
  readonly kind: LineKind;
  readonly draws: readonly PaymentAmount[];
  readonly guard?: FeeBaseGuard | null;
}): CreditDrawFee | null {
  const fee = percentageFee({
    terms: input.terms,
    parts: input.draws.map((d) => ({
      kind: input.kind,
      source: 'credit_draw' as const,
      amountMinor: d.amountMinor,
    })),
    guard: input.guard,
  });
  if (fee === null) return null;
  if (fee.baseMinor === 0) return { ...fee, shares: [] };
  const bases = allocate(
    money(fee.baseMinor),
    input.draws.map((d) => d.amountMinor),
  ).map((m) => m.amountMinor);
  const fees = allocate(money(fee.feeMinor), bases).map((m) => m.amountMinor);
  return {
    ...fee,
    shares: input.draws.flatMap((d, i) =>
      (bases[i] ?? 0) > 0
        ? [{ paymentId: d.paymentId, baseMinor: bases[i] ?? 0, feeMinor: fees[i] ?? 0 }]
        : [],
    ),
  };
}

/** A credit draw's fee lines: Dr 5100, Cr 2300 per payment drawn, on the month's lease and line. */
export function creditDrawFeeLines(input: {
  readonly bookId: string;
  readonly dims: FeeDimensions;
  readonly fee: Pick<CreditDrawFee, 'shares'>;
}): JournalLineDraft[] {
  return compactLines(
    input.fee.shares.flatMap((share) =>
      managementFeeLines({
        bookId: input.bookId,
        dims: { ...input.dims, paymentId: share.paymentId },
        amountMinor: share.feeMinor,
      }),
    ),
  );
}

// Fixed fees per billable unit (decision 2, D8).

/** A lease on the unit that became active: its first day and last billable day (null while it runs). */
export interface TenancySpan {
  readonly startDate: string;
  readonly lastDay: string | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthDays(month: string): { readonly first: string; readonly last: string } {
  if (!MONTH.test(month)) throw new DomainError('fees.bad_month', `Not a month: ${month}`);
  const first = parseBusinessDate(`${month}-01`);
  return { first: toIsoDate(first), last: toIsoDate(addDays(addMonths(first, 1), -1)) };
}

/**
 * D8: a unit is billable for a month if it had an active lease on any day of it. `fromDate`
 * narrows the month to the days on or after it (an agreement that starts mid-month).
 */
export function billableInMonth(
  spans: readonly TenancySpan[],
  month: string,
  fromDate?: string | null,
): boolean {
  const days = monthDays(month);
  let first = parseBusinessDate(days.first);
  const last = parseBusinessDate(days.last);
  if (fromDate) {
    const from = parseBusinessDate(fromDate);
    if (compareDates(from, first) > 0) first = from;
  }
  if (compareDates(first, last) > 0) return false;
  return spans.some((span) => {
    const start = parseBusinessDate(span.startDate);
    if (span.lastDay !== null && compareDates(parseBusinessDate(span.lastDay), start) < 0)
      throw new DomainError('fees.bad_span', 'A lease cannot end before it starts');
    return (
      compareDates(start, last) <= 0 &&
      (span.lastDay === null || compareDates(parseBusinessDate(span.lastDay), first) >= 0)
    );
  });
}

export interface FixedFeeUnit {
  readonly propertyId: string;
  readonly unitId: string;
  readonly leases: readonly TenancySpan[];
}

export interface FixedFee {
  /** `P14:<owner>:<unit>:<month>` (plan 4.2). */
  readonly key: string;
  readonly propertyId: string;
  readonly unitId: string;
  readonly amountMinor: number;
}

/**
 * P14 fixed fees for one owner and month (`reporting.fixed-fees`, at the month's end): the terms
 * in force on the month's last day, when they are a fixed fee, charged once for each of the
 * owner's units billable that month (D8) on or after those terms took effect. Units in key order.
 */
export function fixedFeesForMonth(input: {
  readonly ownerId: string;
  readonly month: string;
  readonly versions: readonly FeeTermsVersion[];
  readonly units: readonly FixedFeeUnit[];
}): FixedFee[] {
  const { last } = monthDays(input.month);
  const version = feeTermsOn(input.versions, last);
  if (version === null) return [];
  const terms = checkFeeTerms(version.terms);
  if (terms.kind !== 'fixed_per_unit') return [];
  const seen = new Set<string>();
  const fees: FixedFee[] = [];
  for (const unit of input.units) {
    if (seen.has(unit.unitId))
      throw new DomainError('fees.duplicate_unit', `Unit ${unit.unitId} is listed twice`);
    seen.add(unit.unitId);
    if (!billableInMonth(unit.leases, input.month, version.effectiveFrom)) continue;
    fees.push({
      key: managementFeeKeys.fixed(input.ownerId, unit.unitId, input.month),
      propertyId: unit.propertyId,
      unitId: unit.unitId,
      amountMinor: terms.amountMinor,
    });
  }
  const order = (a: FixedFee): string => `${a.propertyId}\u0000${a.unitId}`;
  return fees.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

// Reversals (decisions 2 and 3).

/**
 * The fee to take back when a refund returns part of a receipt's fee base (decision 3: the fee
 * follows the money the owner keeps). The fee is split between the base refunded so far and the
 * base kept by largest remainder (half up, once), and this refund takes the growth of the refunded
 * share. However the base is refunded, in one go or in parts, the reversals add up to the fee
 * exactly when all of it is refunded, and never more. A payment whose credit was later drawn onto
 * a month bears a second fee (`creditDrawFee`): each fee is taken back against its own base.
 */
export function refundFeeReversalMinor(input: {
  /** The fee the receipt posted, before any reversal. */
  readonly feeMinor: number;
  /** The base it was charged on. */
  readonly baseMinor: number;
  /** Base returned by earlier refunds of the same receipt. */
  readonly refundedBaseBeforeMinor: number;
  /** Base this refund returns. */
  readonly refundedBaseMinor: number;
}): number {
  const fee = nonNegative(input.feeMinor, 'The fee');
  const base = nonNegative(input.baseMinor, 'The fee base');
  const before = nonNegative(input.refundedBaseBeforeMinor, 'The base refunded before');
  const now = nonNegative(input.refundedBaseMinor, 'The base refunded');
  if (before + now > base)
    throw new DomainError('fees.refund_over_base', 'More cannot be refunded than the fee base');
  if (fee === 0 || now === 0) return 0;
  const refundedShare = (refunded: number): number =>
    allocate(money(fee), [refunded, base - refunded])[0]?.amountMinor ?? 0;
  return refundedShare(before + now) - refundedShare(before);
}

/**
 * How much of a refund paid out of a receipt's credit returns its fee base (decision 3). After an
 * early end, the receipt's credit holds its advance released from cancelled periods, which bore
 * the fee, and any surplus, which never did. The released advance is taken as refunded first, so
 * the agent never keeps a fee on rent the owner gave back.
 */
export function refundedFeeBaseMinor(input: {
  /** The receipt's fee base. */
  readonly baseMinor: number;
  /** What of the receipt's money still settles rent and service charge, before this refund. */
  readonly keptBaseMinor: number;
  readonly refundedBaseBeforeMinor: number;
  /** What this refund pays back out of the receipt's credit. */
  readonly refundMinor: number;
}): number {
  const base = nonNegative(input.baseMinor, 'The fee base');
  const kept = nonNegative(input.keptBaseMinor, 'The base kept');
  const before = nonNegative(input.refundedBaseBeforeMinor, 'The base refunded before');
  const refund = nonNegative(input.refundMinor, 'The refund');
  const released = Math.max(0, base - kept - before);
  return Math.min(refund, released);
}

// Lines and keys.

/** Every fee line names its property (the owner statement's pages); a receipt's also its lease and payment. */
export interface FeeDimensions extends LineDimensions {
  readonly propertyId: string;
}

function feePair(
  bookId: string,
  dims: FeeDimensions,
  amountMinor: number,
  direction: 1 | -1,
): JournalLineDraft[] {
  if (!dims.propertyId)
    throw new DomainError('fees.no_property', 'A management fee names its property');
  const amount = nonNegative(amountMinor, 'A management fee');
  return compactLines([
    { ...dims, bookId, accountCode: '5100', amountMinor: direction * amount },
    { ...dims, bookId, accountCode: '2300', amountMinor: -direction * amount },
  ]);
}

/** P14: the fee is the owner's expense (Dr 5100) and owed to the agent (Cr 2300). Zero posts nothing. */
export function managementFeeLines(input: {
  readonly bookId: string;
  readonly dims: FeeDimensions;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  return feePair(input.bookId, input.dims, input.amountMinor, 1);
}

/** A fee taken back (P21 mirror, or a refund in proportion): Dr 2300, Cr 5100, on the fee's dimensions. */
export function managementFeeReversalLines(input: {
  readonly bookId: string;
  readonly dims: FeeDimensions;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  return feePair(input.bookId, input.dims, input.amountMinor, -1);
}

/**
 * P21(b) mirrors the payment's fees (architecture P21): what is left of each, net of reversals
 * already posted (a refund's), taken back on its own dimensions.
 */
export function feeMirrorLines(input: {
  readonly bookId: string;
  readonly fees: readonly { readonly dims: FeeDimensions; readonly netMinor: number }[];
}): JournalLineDraft[] {
  return compactLines(
    input.fees.flatMap((f) =>
      managementFeeReversalLines({ bookId: input.bookId, dims: f.dims, amountMinor: f.netMinor }),
    ),
  );
}

/**
 * Idempotency keys (plan 4.2). An event's percentage fee is keyed on the record that settles the
 * rent: the payment, a deposit application or withholding recorded on its own, or a credit draw.
 */
export const managementFeeKeys = {
  /** `P14:<payment>`, or the deposit application or withholding behind the event. */
  event: (recordId: string): string => `P14:${recordId}`,
  /**
   * A credit draw's fee: `P14:<draw key>`, where the draw key is the key of the entry that posted
   * the draw (`P02:<line>` gives `P14:P02:<line>`; P13's `P13:<termination>:<key>` gives
   * `P14:P13:<termination>:<key>`), so each draw is charged once.
   */
  creditDraw: (drawKey: string): string => `P14:${drawKey}`,
  /** `P14:<owner>:<unit>:<month>`. */
  fixed: (ownerId: string, unitId: string, month: string): string =>
    `P14:${ownerId}:${unitId}:${month}`,
  /** The mirror on a payment reversal, beside the reversal's own `P21:<payment>`. */
  paymentReversal: (paymentId: string): string => `P21:${paymentId}:fee`,
  /** The proportional reversal in a refund's transaction, per receipt refunded. */
  refund: (refundId: string, paymentId: string): string => `P14:${refundId}:${paymentId}:refund`,
} as const;
