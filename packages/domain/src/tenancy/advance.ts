import { CYCLE_MONTHS, type LeaseTerms } from './lease-terms';

/**
 * Advance rent on a lease (AR-05; Act 220 s.25(5), unverified; OQ-11, OQ-28). The limits come
 * from the rules table and are passed in, with the rule version recorded by the caller. The
 * product never describes an advance as compliant: this says only whether a limit is exceeded.
 */
export interface AdvanceRules {
  /** `advance_rent.max_months.monthly_or_shorter`: tenancies of a month or less. */
  readonly monthlyOrShorter: number | null;
  /** `advance_rent.max_months.over_six_months`: tenancies longer than six months. */
  readonly overSixMonths: number | null;
}

export type AdvanceRule = 'monthly_or_shorter' | 'over_six_months';

export interface AdvanceCheck {
  /** Months the terms demand before the first period: the cycle, or a larger initial advance. */
  readonly monthsDemanded: number;
  /** The rule that applies to this term, or null where none was found (OQ-51). */
  readonly rule: AdvanceRule | null;
  readonly limitMonths: number | null;
  readonly exceedsLimit: boolean;
}

export function monthsDemandedInAdvance(
  terms: Pick<LeaseTerms, 'cycle' | 'initialAdvanceMonths'>,
): number {
  return Math.max(CYCLE_MONTHS[terms.cycle], terms.initialAdvanceMonths ?? 0);
}

export function checkAdvance(
  terms: Pick<LeaseTerms, 'cycle' | 'initialAdvanceMonths' | 'periodCount'>,
  rules: AdvanceRules,
): AdvanceCheck {
  const monthsDemanded = monthsDemandedInAdvance(terms);
  const rule: AdvanceRule | null =
    terms.periodCount <= 1
      ? 'monthly_or_shorter'
      : terms.periodCount > 6
        ? 'over_six_months'
        : null;
  const limitMonths =
    rule === 'monthly_or_shorter'
      ? rules.monthlyOrShorter
      : rule === 'over_six_months'
        ? rules.overSixMonths
        : null;
  return {
    monthsDemanded,
    rule,
    limitMonths,
    exceedsLimit: limitMonths !== null && monthsDemanded > limitMonths,
  };
}

export type AdvanceRentPolicy = 'off' | 'warn' | 'block';

/**
 * What the company's `advance_rent_policy` does with a check (CLAUDE.md section 7): `off`
 * records only, `warn` flags the lease, `block` refuses the save.
 */
export function advanceOutcome(
  check: AdvanceCheck,
  policy: AdvanceRentPolicy,
): { readonly flag: boolean; readonly refuse: boolean } {
  if (!check.exceedsLimit || policy === 'off') return { flag: false, refuse: false };
  return policy === 'warn' ? { flag: true, refuse: false } : { flag: true, refuse: true };
}
