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
