import { paymentsQueueContract } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';

// Reconciliation and settlement exceptions (CLAUDE.md section 8; M4b plan 4.8). Each night the
// provider's transactions are compared with our payments, and each settlement with the payments
// it pays out. Whatever the comparison cannot explain waits here for a person, who looks into it
// and records what they found. Resolving one records a note; it changes no money.

export type ReconciliationException = Awaited<
  ReturnType<ApiClient['paymentsQueue']['exceptions']>
>[number];
export type ExceptionKind = ReconciliationException['kind'];

export interface ExceptionWords {
  /** A short title for the row. */
  readonly title: string;
  /** What it means and what to check, for the person resolving it. */
  readonly check: string;
}

export const EXCEPTION_WORDS: Record<ExceptionKind, ExceptionWords> = {
  missing_here: {
    title: 'Paid at the provider, missing here',
    check:
      'The provider reports a successful payment we had no record of. It has gone through the normal path: check that it was posted to its lease or is waiting in Unmatched receipts.',
  },
  missing_at_provider: {
    title: 'Recorded here, not listed by the provider',
    check:
      'We have a payment the provider did not list for that day. Check the payment with the provider before relying on it.',
  },
  amount_differs: {
    title: 'The amounts differ',
    check: 'The provider’s amount is not the amount we recorded. Check both with the provider.',
  },
  not_successful_at_provider: {
    title: 'Not successful at the provider',
    check:
      'We recorded the payment, but the provider does not show it as successful. If the money never arrived, the payment needs a reversal that a second person approves.',
  },
  settlement_difference: {
    title: 'A settlement does not add up',
    check:
      'What the provider paid out does not match the payments and fees in its report. Compare the settlement report with the bank statement.',
  },
  verified_amount_differs: {
    title: 'Paid a different amount than asked',
    check:
      'The provider confirmed a different amount from the one the tenant started paying. The amount received was posted; check that the tenant’s balance is right.',
  },
  receipt_late: {
    title: 'A receipt went out late',
    check:
      'The receipt reached the tenant more than a minute after the payment was confirmed (BC-06). Check that messages are going out.',
  },
};

export const exceptionWords = (kind: ExceptionKind): ExceptionWords => EXCEPTION_WORDS[kind];

/** The note limits `POST /reconciliation/exceptions/{id}/resolve` takes, from its contract. */
function noteLimits(): { readonly min: number; readonly max: number } {
  const note = paymentsQueueContract.resolveException['~orpc'].inputSchema?.shape.note;
  const min = note?.minLength;
  const max = note?.maxLength;
  if (!min || !max) throw new Error('The resolve contract has no note limits');
  return { min, max };
}

export const RESOLVE_NOTE = noteLimits();

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Open ones first, oldest first, so the longest-waiting difference is looked at first; then the
 * resolved ones, most recently resolved first.
 */
export function sortExceptions(
  rows: readonly ReconciliationException[],
): ReconciliationException[] {
  return [...rows].sort((a, b) => {
    if (a.resolvedAt === null && b.resolvedAt === null) return byText(a.createdAt, b.createdAt);
    if (a.resolvedAt === null) return -1;
    if (b.resolvedAt === null) return 1;
    return byText(b.resolvedAt, a.resolvedAt);
  });
}
