import { compareDates, parseBusinessDate } from '../dates';
import { DomainError } from '../errors';
import type { DiscountKind } from './constants';
import {
  checkDiscountTerms,
  compareMonths,
  monthsBetween,
  shiftMonth,
  type DiscountTerms,
} from './pricing';

/**
 * Discount codes (M10 decision 8; PB-05). A platform admin defines a code: a percentage (bps) or a
 * fixed amount off each month, for N billing months, with an optional last day to apply it and an
 * optional cap on uses. One code at a time per subscription; it shows as its own line on each
 * invoice it covers.
 */

export interface DiscountCodeFacts {
  readonly code: string;
  readonly kind: DiscountKind;
  readonly percentBps: number | null;
  readonly amountMinor: number | null;
  /** Billing months a redemption covers. */
  readonly months: number;
  /** The last day the code can be applied (inclusive); null: no expiry. */
  readonly expiresOn: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
}

/** Codes are compared trimmed and in capitals: " welcome20 " is WELCOME20. */
export function normalizeCode(text: string): string {
  return text.trim().toUpperCase();
}

const invalid = (why: string): DomainError => new DomainError('discount.invalid', why);

function checkMonths(months: number): number {
  if (!Number.isSafeInteger(months) || months < 1)
    throw invalid('A discount covers one billing month or more');
  return months;
}

/** The code's terms for an invoice line; throws 'discount.invalid' when the code is malformed. */
export function discountTermsOf(code: DiscountCodeFacts): DiscountTerms {
  const name = normalizeCode(code.code);
  if (name === '') throw invalid('A discount needs its code');
  checkMonths(code.months);
  if (code.kind === 'percentage') {
    const bps = code.percentBps;
    if (bps === null || code.amountMinor !== null)
      throw invalid('A percentage discount has a percentage and no amount');
    if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10_000)
      throw invalid('A percentage discount is from 1 to 10,000 basis points');
    return checkDiscountTerms({ kind: 'percentage', percentBps: bps, code: name });
  }
  if (code.kind === 'fixed') {
    const amount = code.amountMinor;
    if (amount === null || code.percentBps !== null)
      throw invalid('A fixed discount has an amount and no percentage');
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw invalid('A fixed discount takes a positive amount off');
    return checkDiscountTerms({ kind: 'fixed', amountMinor: amount, code: name });
  }
  throw invalid('A discount is a percentage or a fixed amount');
}

/**
 * Whether a subscription may apply the code today. Checked in this order: the code is well formed
 * ('discount.invalid'), not past its last day ('discount.expired'), has uses left
 * ('discount.used_up'), and the subscription has no code running ('discount.already_applied').
 */
export function assertRedeemable(
  code: DiscountCodeFacts,
  today: string,
  hasActiveRedemption: boolean,
): void {
  discountTermsOf(code);
  if (code.maxUses !== null && (!Number.isSafeInteger(code.maxUses) || code.maxUses < 1))
    throw invalid('A cap on uses is one or more');
  if (!Number.isSafeInteger(code.uses) || code.uses < 0)
    throw invalid('Uses are a whole number, zero or more');
  const day = parseBusinessDate(today);
  if (code.expiresOn !== null && compareDates(day, parseBusinessDate(code.expiresOn)) > 0)
    throw new DomainError('discount.expired', 'This discount code has expired');
  if (code.maxUses !== null && code.uses >= code.maxUses)
    throw new DomainError('discount.used_up', 'This discount code has been used up');
  if (hasActiveRedemption)
    throw new DomainError(
      'discount.already_applied',
      'A discount code is already running on this subscription: one at a time',
    );
}

/** The last billing month a redemption covers. */
export const lastCoveredMonth = (firstMonth: string, months: number): string =>
  shiftMonth(firstMonth, checkMonths(months) - 1);

/** The months a redemption covers: `months` billing months starting with firstMonth. */
export function redemptionCovers(firstMonth: string, months: number, month: string): boolean {
  return (
    compareMonths(month, firstMonth) >= 0 &&
    compareMonths(month, lastCoveredMonth(firstMonth, months)) <= 0
  );
}

/**
 * Covered months not yet billed, counting `currentMonth` (billing is in arrears, so this month's
 * invoice still carries the discount): all of them before the first month, none after the last.
 */
export function monthsLeft(firstMonth: string, months: number, currentMonth: string): number {
  const last = lastCoveredMonth(firstMonth, months);
  if (compareMonths(currentMonth, firstMonth) < 0) return months;
  if (compareMonths(currentMonth, last) > 0) return 0;
  return monthsBetween(currentMonth, last) + 1;
}
