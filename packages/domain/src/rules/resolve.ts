import type { BusinessDate } from '../dates';
import { compareDates } from '../dates';

export type VerificationStatus = 'verified' | 'from_prd' | 'unverified';

export interface RuleRow {
  readonly id: string;
  readonly country: string;
  readonly key: string;
  readonly value: unknown;
  readonly effectiveFrom: BusinessDate;
  readonly effectiveTo: BusinessDate | null;
  readonly source: string;
  readonly verificationStatus: VerificationStatus;
  readonly createdAt: Date;
}

/**
 * The rule in force on `asOf`: the latest `effectiveFrom` on or before it, the newest row
 * breaking a tie (a verification or correction of the same value and date), and not past
 * its own `effectiveTo`. Rows are never edited, so a past answer never changes once the
 * caller has recorded the rule id it used.
 */
export function resolveAsOf(rows: readonly RuleRow[], asOf: BusinessDate): RuleRow | undefined {
  let best: RuleRow | undefined;
  for (const row of rows) {
    if (compareDates(row.effectiveFrom, asOf) > 0) continue;
    if (
      !best ||
      compareDates(row.effectiveFrom, best.effectiveFrom) > 0 ||
      (compareDates(row.effectiveFrom, best.effectiveFrom) === 0 &&
        row.createdAt.getTime() > best.createdAt.getTime())
    ) {
      best = row;
    }
  }
  if (best?.effectiveTo && compareDates(best.effectiveTo, asOf) < 0) return undefined;
  return best;
}

/** Staff see a warning wherever an unverified value affects a legal outcome (CLAUDE.md section 7). */
export const needsWarning = (row: Pick<RuleRow, 'verificationStatus'>): boolean =>
  row.verificationStatus !== 'verified';

/**
 * The words of that warning, from the verification status of the rule version a calculation
 * used, so a message never calls a verified value unverified, or the reverse. Null when the
 * rule is verified.
 */
export function verificationWarning(status: VerificationStatus): string | null {
  switch (status) {
    case 'verified':
      return null;
    case 'from_prd':
      return 'taken from the PRD and not yet verified: counsel to confirm';
    default:
      return 'unverified: counsel to confirm';
  }
}
