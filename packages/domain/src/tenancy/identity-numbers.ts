import { DomainError } from '../errors';

/**
 * ID and tax numbers (TL-02, TL-04; CLAUDE.md section 10). They are encrypted at rest and shown
 * masked; these helpers only check formats. Ghana Card checks are biometric through the identity
 * provider; no image of a card is ever requested or stored.
 */
export const ID_TYPES = ['ghana_card', 'passport'] as const;
export type IdType = (typeof ID_TYPES)[number];

/** GHA- plus 9 digits, a hyphen and a check digit, for example GHA-123456789-0. */
const GHANA_CARD = /^GHA-\d{9}-\d$/;

/** Accepts the number with or without hyphens and spaces, in any case. */
export function checkGhanaCard(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  const value = /^GHA\d{10}$/.test(compact)
    ? `GHA-${compact.slice(3, 12)}-${compact.slice(12)}`
    : input.trim().toUpperCase();
  if (!GHANA_CARD.test(value))
    throw new DomainError(
      'id.ghana_card_invalid',
      'Enter a Ghana Card number such as GHA-123456789-0',
    );
  return value;
}

/** A passport number (6 to 12 letters or digits) and the issuing country (two letters). */
export function checkPassport(
  number: string,
  country: string,
): { number: string; country: string } {
  const n = number.toUpperCase().replace(/\s/g, '');
  const c = country.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(n))
    throw new DomainError(
      'id.passport_invalid',
      'Enter the passport number: 6 to 12 letters or digits',
    );
  if (!/^[A-Z]{2}$/.test(c))
    throw new DomainError(
      'id.passport_country_invalid',
      'Give the issuing country as two letters, such as NG',
    );
  return { number: n, country: c };
}

export function checkIdNumber(type: IdType, number: string, country?: string | null) {
  return type === 'ghana_card'
    ? { number: checkGhanaCard(number), country: 'GH' }
    : checkPassport(number, country ?? '');
}

/** A TIN: an individual's is their Ghana Card number; a company's has letters and digits. */
export function checkTin(input: string): string {
  const compact = input.toUpperCase().replace(/\s/g, '');
  if (/^GHA-?\d{9}-?\d$/.test(compact)) return checkGhanaCard(compact);
  if (!/^[A-Z0-9-]{6,20}$/.test(compact))
    throw new DomainError('tin.invalid', 'Enter the TIN: 6 to 20 letters, digits or hyphens');
  return compact;
}

/** Masks a number for display (GHA-*******89-0; others keep their last four characters). */
export function maskIdNumber(value: string): string {
  if (GHANA_CARD.test(value)) return `GHA-*******${value.slice(11, 13)}-${value.slice(-1)}`;
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`;
}
