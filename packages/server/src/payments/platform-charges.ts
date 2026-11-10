import type { ListedReversal, ProviderSettlement, ProviderTransaction } from '@rent/integrations';

export { isPlatformReference, PLATFORM_REFERENCE_PREFIX } from '@rent/integrations';

/**
 * The platform's own charges (M10 decision 9): the subscription, paid into the platform's own
 * provider account with no subaccount, under references that start `SUB-`. Payments never posts
 * them and never matches them to rent (D1). Webhook processing and the daily reconciliation hand
 * them to whoever registered for them (the subscription module, a layer above, so payments never
 * imports it); with nobody registered they are refused, never treated as rent.
 */
export interface PlatformCharges {
  /** A paid event (`charge.success`): verify with the provider, compare exactly, then post. */
  paid(provider: string, reference: string): Promise<string>;
  /** Money taken back (a refund or chargeback event): ask the provider what was taken. */
  reversed(provider: string, reference: string): Promise<string>;
  /** The day's platform transactions and reversals, as the provider lists them. */
  reconcile(
    provider: string,
    range: { readonly from: string; readonly to: string },
    transactions: readonly ProviderTransaction[],
    reversals: readonly ListedReversal[],
  ): Promise<{ readonly matched: number; readonly processed: number; readonly exceptions: number }>;
  /** A payout of the platform's own balance: posted once, or raised for a person. */
  settlement(provider: string, settlement: ProviderSettlement): Promise<boolean>;
}

/**
 * Whether a settlement pays out the platform's own balance rather than a landlord's or agency's
 * subaccount: it names no subaccount (rent always does, D1).
 */
export const isPlatformSettlement = (settlement: ProviderSettlement): boolean =>
  settlement.subaccountCode === '';

/** A platform charge arrived with nobody registered to take it: never rent, so it waits. */
export class PlatformChargesUnavailable extends Error {
  override readonly name = 'PlatformChargesUnavailable';
  constructor() {
    super('A platform (SUB-) payment arrived but the subscription payments are not registered');
  }
}
