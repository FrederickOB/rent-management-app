import { DomainError } from '../errors';

/**
 * Owners (AD-02): an agency's clients, or the landlord in their own company. Joint and family
 * ownership (PR-07, P2) adds kinds and more ownership rows; the share check below already sums.
 */
export const OWNER_KINDS = ['individual', 'company'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

/** A short reference for imports and lists, such as OWN-01. */
export function checkOwnerReference(input: string): string {
  const value = input.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(value))
    throw new DomainError(
      'owner.reference_invalid',
      'Use 2 to 20 letters, digits or hyphens for the owner reference',
    );
  return value;
}

/** Ownership shares in basis points: 10,000 is the whole property. */
export const WHOLE_PROPERTY_BPS = 10_000;

/** The shares held in a property on one date must add up to the whole property. */
export function checkOwnershipShares(shares: readonly { readonly shareBps: number }[]): void {
  if (shares.length === 0) throw new DomainError('ownership.empty', 'A property needs an owner');
  let total = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.shareBps) || s.shareBps <= 0 || s.shareBps > WHOLE_PROPERTY_BPS)
      throw new DomainError('ownership.share_invalid', 'Each share must be between 0.01% and 100%');
    total += s.shareBps;
  }
  if (total !== WHOLE_PROPERTY_BPS)
    throw new DomainError('ownership.shares_total', 'The shares must add up to 100%');
}
