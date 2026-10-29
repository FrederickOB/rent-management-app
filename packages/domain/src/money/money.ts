import { DomainError } from '../errors';

/**
 * Money is an integer number of minor units (pesewas for GHS) plus a currency (ADR-004).
 * Every rounding in the product happens in this file.
 */
export type CurrencyCode = 'GHS';

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

const BPS_PER_UNIT = 10_000n;

function assertSafe(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      'money.not_integer',
      'Money amounts must be safe integers of minor units',
    );
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError(
      'money.currency_mismatch',
      `Cannot combine ${a.currency} with ${b.currency}`,
    );
  }
}

function fromBigInt(value: bigint, currency: CurrencyCode): Money {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError('money.overflow', 'Money amount exceeds the safe integer range');
  }
  return money(Number(value), currency);
}

export function money(amountMinor: number, currency: CurrencyCode = 'GHS'): Money {
  assertSafe(amountMinor);
  return Object.freeze({ amountMinor: amountMinor === 0 ? 0 : amountMinor, currency });
}

export const zero = (currency: CurrencyCode = 'GHS'): Money => money(0, currency);

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return fromBigInt(BigInt(a.amountMinor) + BigInt(b.amountMinor), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return fromBigInt(BigInt(a.amountMinor) - BigInt(b.amountMinor), a.currency);
}

export const negate = (a: Money): Money => money(-a.amountMinor, a.currency);

export function sum(items: readonly Money[], currency: CurrencyCode = 'GHS'): Money {
  return items.reduce((acc, item) => add(acc, item), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export const isZero = (a: Money): boolean => a.amountMinor === 0;
export const isNegative = (a: Money): boolean => a.amountMinor < 0;

/** Integer division rounded half up on the magnitude, so rounding commutes with negation. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/**
 * Applies a rate in basis points (8% = 800) and rounds half up to the minor unit, once.
 * Exact for every safe-integer amount because the product is computed in BigInt.
 */
export function multiplyBps(amount: Money, bps: number): Money {
  if (!Number.isSafeInteger(bps))
    throw new DomainError('money.bps_not_integer', 'Rates must be integer basis points');
  return fromBigInt(
    divideRoundHalfUp(BigInt(amount.amountMinor) * BigInt(bps), BPS_PER_UNIT),
    amount.currency,
  );
}

/**
 * Splits a total into parts proportional to `weights` by the largest remainder method, so the
 * parts always add up to the total exactly. Ties go to the earlier part (ADR-004: an annual
 * GH₵10,000 gives the four leftover pesewas to the first four months).
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0)
    throw new DomainError('money.no_weights', 'Cannot split across zero parts');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new DomainError('money.bad_weights', 'Weights must be non-negative integers');
  }
  const weightTotal = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (weightTotal === 0n)
    throw new DomainError('money.zero_weights', 'Weights must not all be zero');

  const negative = total.amountMinor < 0;
  const magnitude = BigInt(Math.abs(total.amountMinor));
  const shares = weights.map((w, index) => {
    const exact = magnitude * BigInt(w);
    return { index, floor: exact / weightTotal, remainder: exact % weightTotal };
  });
  let leftover = magnitude - shares.reduce((a, s) => a + s.floor, 0n);
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    if (weights[share.index] === 0) continue;
    share.floor += 1n;
    leftover -= 1n;
  }
  return shares.map((s) => fromBigInt(negative ? -s.floor : s.floor, total.currency));
}

export const splitEvenly = (total: Money, parts: number): Money[] =>
  allocate(
    total,
    Array.from({ length: parts }, () => 1),
  );

const SYMBOLS: Record<CurrencyCode, string> = { GHS: 'GH₵' };

/** Display only, at the edge: `GH₵1,500.00`, `-GH₵0.07`. */
export function format(amount: Money): string {
  const negative = amount.amountMinor < 0;
  const magnitude = BigInt(Math.abs(amount.amountMinor));
  const whole = (magnitude / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${SYMBOLS[amount.currency]}${whole}.${minor}`;
}

/** Parses user input such as `1500`, `1,500.5` or `1500.50` into minor units, exactly. */
export function parseAmount(input: string, currency: CurrencyCode = 'GHS'): Money {
  const cleaned = input.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new DomainError('money.unparseable', 'Enter an amount such as 1500 or 1500.50');
  const [, sign, whole = '0', fraction = ''] = match;
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return fromBigInt(sign ? -minor : minor, currency);
}
