import type { LeaseDetailView } from '@rent/contracts';

// What the lease page shows (M3 plan 4.16). The API decides a lease's state; these helpers only
// read it.

/**
 * Whether the lease was signed, on paper or electronically, whatever happened to it since. It is
 * read from the signing record, not the status: a signed lease that was later cancelled keeps
 * its documents, its recorded schedule and its trackers, and a cancelled draft never had any.
 */
export function wasSigned(lease: Pick<LeaseDetailView, 'signing'>): boolean {
  return lease.signing.signedAt !== null || lease.signing.method !== null;
}

/** A lease in force or about to be: what is not yet done on it is still tracked and reminded. */
export function stillTracked(lease: Pick<LeaseDetailView, 'status'>): boolean {
  return !TRACKING_ENDED[lease.status];
}

const TRACKING_ENDED: Record<LeaseDetailView['status'], boolean> = {
  draft: false,
  pending_signatures: false,
  signed: false,
  active: false,
  ending: false,
  holding_over: false,
  ended: true,
  terminated: true,
  cancelled: true,
};

/** The warning for a template version no lawyer has reviewed (decision 3; OQ-53). */
export const COUNSEL_WARNING =
  'This template version has not been reviewed by your lawyer. Its legal clauses may still read “Wording to be supplied by your lawyer.” (OQ-53)';

/**
 * The preview's warnings without the counsel-review one, which the page already shows from the
 * lease itself, so it appears once.
 */
export function otherWarnings(warnings: readonly string[]): string[] {
  return warnings.filter(
    (warning) => warning !== COUNSEL_WARNING && !/not been reviewed by your lawyer/i.test(warning),
  );
}
