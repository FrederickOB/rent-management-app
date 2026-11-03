import { paymentsQueueContract } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import type { MatchReason } from '@rent/domain/payments';
import { PAYMENT_METHOD_LABELS } from './billing-format';
import { humanise } from './format';
import { CORRECTION_REASON_MIN } from './payment-form';

// The unmatched queue (BC-12; M4b plan 4.5). Money that matched no pay link and no exact payment
// reference waits in suspense (P23) until a person matches it. The API ranks the leases it may
// belong to, by the amount, the payer's phone, the date and earlier payments; the screen shows
// why each is suggested, in the API's order, and a person confirms every match. Money that
// belongs to no one is refunded to its payer, once a second person approves (P31).

export type Suggestion = Awaited<ReturnType<ApiClient['paymentsQueue']['suggestions']>>[number];
export type UnmatchedRow = Awaited<ReturnType<ApiClient['payments']['unmatched']>>[number];
export type RefundInput = Parameters<ApiClient['paymentsQueue']['refund']>[0];

/** Why a lease is suggested, in words a person checks before confirming. */
export const MATCH_REASON_LABELS: Record<MatchReason, string> = {
  amount_is_due_now: 'The amount is exactly what is due now',
  amount_is_an_invoice: 'The amount is exactly what an open invoice asks for',
  amount_is_a_month: 'The amount is a whole number of months’ rent',
  phone_is_tenant: 'Paid from the tenant’s phone or a contact’s',
  phone_paid_before: 'This phone has paid for this lease before',
  near_due_date: 'Paid within a week of a due date',
  name_matches: 'The payer’s name matches the tenant’s',
};

/** The reasons for one suggestion, strongest evidence first as the API lists them. */
export const reasonsOf = (suggestion: Pick<Suggestion, 'reasons'>): string[] =>
  suggestion.reasons.map((reason) => MATCH_REASON_LABELS[reason]);

/**
 * The sentence a person reads before confirming a match (P23): the money pays the lease's oldest
 * debt first and the rest is held as credit, so a wrong match is a reversal, never an edit.
 */
export function confirmMatchText(
  amount: string,
  suggestion: Pick<Suggestion, 'unitCode' | 'tenantName'>,
): string {
  return `Match ${amount} to ${suggestion.unitCode} (${suggestion.tenantName})? It pays that lease’s oldest debt first, and anything left over is held as the tenant’s credit. Undoing it later takes a reversal that a second person approves.`;
}

// The queue's rows ---------------------------------------------------------------------------------

/**
 * The owner whose own account holds the money (P23), so matching offers only their leases: a
 * transfer into their account, or provider money that settles into it. Null when it sits with
 * the agency, which may match it to any lease it manages.
 */
export function queueOwnerOf(row: {
  /** Where the money arrived, as a queue row or a payment says it. */
  readonly receivedInto: string;
  readonly settlesInto?: UnmatchedRow['settlesInto'];
  readonly ownerId: string | null;
  readonly ownerName: string | null;
}): { readonly ownerId: string; readonly ownerName: string | null } | null {
  const intoOwner =
    row.receivedInto === 'owner_account' ||
    (row.receivedInto === 'provider' && row.settlesInto === 'owner_account');
  return intoOwner && row.ownerId ? { ownerId: row.ownerId, ownerName: row.ownerName } : null;
}

const PROVIDER_NAMES: Record<string, string> = { paystack: 'Paystack', flutterwave: 'Flutterwave' };

/**
 * What came with provider money, for a person working out whose it is: how it was paid and
 * through whom, the provider's reference, and who paid from which phone (masked; CLAUDE.md
 * section 10). Empty for a transfer recorded by hand, which has its own reference and note.
 */
export function providerFacts(
  row: Pick<
    UnmatchedRow,
    'receivedInto' | 'method' | 'provider' | 'providerReference' | 'payerName' | 'payerPhoneMasked'
  >,
): string[] {
  if (row.receivedInto !== 'provider') return [];
  const method = row.method ? PAYMENT_METHOD_LABELS[row.method] : 'Paid';
  const through = row.provider
    ? ` through ${PROVIDER_NAMES[row.provider] ?? humanise(row.provider)}`
    : '';
  const payer = [row.payerName, row.payerPhoneMasked].filter(Boolean).join(', ');
  return [
    `${method}${through}`,
    row.providerReference ? `Provider’s reference: ${row.providerReference}` : null,
    payer ? `Paid by ${payer}` : null,
  ].filter((line): line is string => line !== null);
}

/** A refund already asked for (P31): the money waits for it, and is not matched meanwhile. */
export function openRefundText(openRefund: NonNullable<UnmatchedRow['openRefund']>): string {
  return openRefund.status === 'approved'
    ? 'A refund to the payer was approved and is on its way.'
    : 'A refund to the payer is waiting for a second person.';
}

// Refunds (P31) ----------------------------------------------------------------------------------

/**
 * Money that came through the payment provider goes back through the provider's refund; any
 * other (a transfer into an owner's or the agency's account) is sent back outside the platform
 * and recorded with proof (plan 4.5). Takes the queue row's `receivedInto` as the API sends it.
 */
export const refundsThroughProvider = (receivedInto: string): boolean =>
  receivedInto === 'provider';

/**
 * The reason limits `POST /unmatched-receipts/{id}/refund` takes, from its contract, and never
 * shorter than every other money request that asks why (M4a plan 4.19).
 */
function refundLimits(): { readonly min: number; readonly max: number } {
  const reason = paymentsQueueContract.refund['~orpc'].inputSchema?.shape.reason;
  const min = reason?.minLength;
  const max = reason?.maxLength;
  if (!min || !max) throw new Error('The refund contract has no reason limits');
  return { min: Math.max(min, CORRECTION_REASON_MIN), max };
}

export const REFUND_REASON = refundLimits();

export interface RefundDraft {
  readonly reason: string;
}

/**
 * The refund request, or why it cannot go yet. Money that came through the provider goes back
 * through the provider's refund; a transfer is refunded outside the platform and recorded with
 * proof (plan 4.5), so its proof is asked for.
 */
export function refundForm(
  draft: RefundDraft,
  options: { readonly needsProof: boolean; readonly hasProof: boolean },
): {
  readonly reason: string | null;
  readonly errors: Partial<Record<'reason' | 'proof', string>>;
} {
  const errors: Partial<Record<'reason' | 'proof', string>> = {};
  const reason = draft.reason.trim();
  if (reason.length < REFUND_REASON.min)
    errors.reason = `Say why, in at least ${REFUND_REASON.min} characters`;
  else if (reason.length > REFUND_REASON.max)
    errors.reason = `Use at most ${REFUND_REASON.max} characters`;
  if (options.needsProof && !options.hasProof)
    errors.proof = 'Attach the proof that the money was sent back to the payer.';
  return { reason: Object.keys(errors).length ? null : reason, errors };
}
