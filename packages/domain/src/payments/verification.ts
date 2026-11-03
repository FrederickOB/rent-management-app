/**
 * Verifying a provider payment before anything posts (CLAUDE.md section 8; M4b plan 4.4). The
 * webhook only says something happened: money is posted from the provider's verify response,
 * compared exactly with our own intent.
 */
export interface IntentFacts {
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface VerifiedFacts {
  readonly status: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export type VerificationOutcome =
  /** Everything matches: post the payment. */
  | { readonly kind: 'post'; readonly amountMinor: number }
  /**
   * Paid, but not the amount asked. The money received is what posts, and a person reviews it
   * (M4b plan 4.4, edge cases).
   */
  | {
      readonly kind: 'post_and_flag';
      readonly amountMinor: number;
      readonly reason: 'amount_differs';
    }
  /** Not paid (yet): nothing posts. Pending is checked again by verify-pending. */
  | { readonly kind: 'not_paid'; readonly status: 'pending' | 'failed' | 'abandoned' | 'other' }
  /** Something does not match that must: nothing posts and a security alert is raised. */
  | {
      readonly kind: 'reject';
      readonly reason: 'reference_differs' | 'currency_differs' | 'bad_amount';
    };

const PENDING = new Set(['pending', 'ongoing', 'processing', 'queued', 'pay_offline', 'send_otp']);

export function compareVerified(intent: IntentFacts, verified: VerifiedFacts): VerificationOutcome {
  if (verified.reference !== intent.reference)
    return { kind: 'reject', reason: 'reference_differs' };
  if (verified.currency !== intent.currency) return { kind: 'reject', reason: 'currency_differs' };
  if (verified.status !== 'success') {
    if (PENDING.has(verified.status)) return { kind: 'not_paid', status: 'pending' };
    if (verified.status === 'failed') return { kind: 'not_paid', status: 'failed' };
    if (verified.status === 'abandoned') return { kind: 'not_paid', status: 'abandoned' };
    return { kind: 'not_paid', status: 'other' };
  }
  if (!Number.isSafeInteger(verified.amountMinor) || verified.amountMinor <= 0)
    return { kind: 'reject', reason: 'bad_amount' };
  if (verified.amountMinor !== intent.amountMinor)
    return { kind: 'post_and_flag', amountMinor: verified.amountMinor, reason: 'amount_differs' };
  return { kind: 'post', amountMinor: verified.amountMinor };
}
