import { errorCode, isRecord, statusOf, toProblem } from './errors';
import { formatMinor } from './tenancy-format';

// The advance rent limit on the cash and transfer forms (AR-05; M5 decision 4). Under
// `advance_rent_policy = block` the API refuses cash or a transfer that would pay more months
// ahead than the limit for the lease's term (Act 220 s.25(5), unverified), and says the most it
// may be. The form says so in plain words and offers that amount. It never calls an amount
// compliant: it says only what the company's setting refuses.

export interface AdvanceRefusal {
  /** The most this payment may be, in pesewas. */
  readonly maxMinor: number;
  readonly limitMonths: number;
  readonly text: string;
}

const whole = (value: unknown): number | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const months = (n: number): string => `${n} month${n === 1 ? '' : 's'}`;

/**
 * The refusal in words, or null for any other answer: 422 `advance_over_limit` with
 * `data: { maxMinor, limitMonths }`, which the API sends as strings.
 */
export function advanceRefusal(error: unknown): AdvanceRefusal | null {
  if (statusOf(error) !== 422 || errorCode(error) !== 'ADVANCE_OVER_LIMIT') return null;
  const data = isRecord(error) && isRecord(error.data) ? error.data : null;
  const maxMinor = whole(data?.maxMinor);
  const limitMonths = whole(data?.limitMonths);
  if (maxMinor === null || limitMonths === null) return null;
  // The API says when the rule it used is not verified; a verified one is never called unverified.
  const unverified = /unverified|not yet verified/i.test(toProblem(error).message);
  const most =
    maxMinor > 0
      ? `The most this payment can be is ${formatMinor(maxMinor)}.`
      : 'Nothing more can be recorded ahead for it now.';
  return {
    maxMinor,
    limitMonths,
    text: `Your company’s advance rent setting refuses rent paid more than ${months(limitMonths)} ahead for a lease of this length (Act 220 s.25(5)${unverified ? '; the limit is not yet verified by counsel' : ''}). ${most} Nothing was recorded.`,
  };
}
