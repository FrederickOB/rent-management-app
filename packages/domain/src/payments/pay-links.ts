import { lineBalance, type AllocationRow, type BillingLine } from '../billing/lines';
import { remainingAfterWalk, type WalkResult } from '../billing/walk';
import { DomainError } from '../errors';

/**
 * What a pay link lets a tenant pay (BC-04; M4b decision 7): pre-filled with what is due now,
 * and any amount from GH₵1 up to the rent remaining to the end of the term. More than is due
 * becomes the payment's credit (P05).
 */
export const MIN_PAYMENT_MINOR = 100;

export interface PayLinkAmounts {
  readonly prefillMinor: number;
  readonly minMinor: number;
  readonly maxMinor: number;
}

export function payLinkAmounts(input: {
  readonly dueNowMinor: number;
  /** Rent and charges still to pay to the end of the term, after the lease's credit. */
  readonly remainingTermMinor: number;
}): PayLinkAmounts {
  const maxMinor = Math.max(input.remainingTermMinor, input.dueNowMinor, MIN_PAYMENT_MINOR);
  const prefill = Math.min(Math.max(input.dueNowMinor, 0), maxMinor);
  return {
    prefillMinor: prefill >= MIN_PAYMENT_MINOR ? prefill : 0,
    minMinor: MIN_PAYMENT_MINOR,
    maxMinor,
  };
}

export function checkPayAmount(amountMinor: number, limits: PayLinkAmounts): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < limits.minMinor)
    throw new DomainError('payment.amount_too_small', 'Pay at least GH₵1.00');
  if (amountMinor > limits.maxMinor)
    throw new DomainError(
      'payment.amount_too_large',
      'That is more than the rent left to the end of the lease',
    );
  return amountMinor;
}

/**
 * The most a pay link may take ahead under a company's advance rent limit (AR-05; M4b review
 * 15): what is due now, plus whole months up to the limit, less what the tenant already holds
 * ahead (unearned rent and credit). The months come from the rules table (unverified); the
 * caller applies the policy: `block` caps the amount, `warn` accepts it and flags it.
 */
export function advanceCapMinor(input: {
  readonly dueNowMinor: number;
  /** Rent and service charge for one month. */
  readonly monthlyMinor: number;
  readonly limitMonths: number;
  /** Already paid ahead: unearned rent and credit. */
  readonly aheadMinor: number;
}): number {
  for (const v of [input.dueNowMinor, input.monthlyMinor, input.limitMonths, input.aheadMinor])
    if (!Number.isSafeInteger(v) || v < 0)
      throw new DomainError('payment.bad_amount', 'Advance limits are whole, zero or more');
  return input.dueNowMinor + Math.max(0, input.limitMonths * input.monthlyMinor - input.aheadMinor);
}

/** Pay links expire when the invoice is settled, or after 60 days (M4b plan 4.3). */
export const PAY_LINK_DAYS = 60;

/**
 * The customer email Paystack requires for a tenant with none (OQ-06): a per-tenant address on a
 * platform domain, from the tenant's random id, never from the phone number.
 */
export function syntheticCustomerEmail(tenantId: string, domain: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId))
    throw new DomainError('payment.bad_tenant_id', 'A tenant id is a UUID');
  if (!/^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain))
    throw new DomainError('payment.bad_email_domain', 'The customer email domain is not valid');
  return `tenant-${tenantId.replace(/-/g, '').toLowerCase()}@${domain.toLowerCase()}`;
}

/**
 * What the pay page asks for (plan 4.3): the lease's lines due by this invoice's due date or
 * today, whichever is later, still to pay after the credit the lease holds. Payments go to the
 * oldest debt first, so that is this invoice and anything older (deviation 3).
 */
export function payPageDueMinor(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly walk: WalkResult;
  readonly today: string;
  readonly invoiceDueDate: string;
}): number {
  const until = input.invoiceDueDate > input.today ? input.invoiceDueDate : input.today;
  return input.lines
    .filter((l) => l.dueDate <= until)
    .reduce((sum, l) => sum + remainingAfterWalk(l, input.allocations, input.walk), 0);
}

/**
 * The rent and charges still to pay to the end of the term, after the lease's credit (decision
 * 7): every invoiced line's remainder, and every charge period not invoiced yet (with its VAT).
 */
export function remainingTermMinor(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly walk: WalkResult;
}): number {
  const walked = new Set(input.walk.lines.flatMap((l) => (l.lineId ? [l.lineId] : [])));
  const outside = input.lines
    .filter((l) => !walked.has(l.id))
    .reduce((sum, l) => sum + lineBalance(l, input.allocations).outstandingMinor, 0);
  return outside + input.walk.lines.reduce((sum, l) => sum + Math.max(0, l.remainingMinor), 0);
}

/** An invoice still to pay after the lease's credit (BC-09: the ladder stops when it is paid). */
export function invoiceRemainingMinor(input: {
  readonly invoiceLines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly walk: WalkResult;
}): number {
  return input.invoiceLines.reduce(
    (sum, l) => sum + remainingAfterWalk(l, input.allocations, input.walk),
    0,
  );
}

/**
 * Our reference for a charge (plan 4.3): unique everywhere, from the intent's random id, in the
 * characters Paystack accepts (letters, digits, `-`, `.` and `=`).
 */
export function chargeReference(intentId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(intentId))
    throw new DomainError('payment.bad_intent_id', 'An intent id is a UUID');
  return `pi-${intentId.replace(/-/g, '').toLowerCase()}`;
}

/** Ghana's MoMo networks as the pay page offers them (plan 4.3). */
export const MOMO_NETWORKS = ['mtn', 'telecel', 'at'] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];
