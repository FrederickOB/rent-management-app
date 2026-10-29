import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { DomainError } from '../errors';

/** E.164 phone handling (CLAUDE.md section 11). The default country comes from configuration. */
export type E164 = string & { readonly __brand: 'E164' };

export function normalisePhone(input: string, defaultCountry: CountryCode = 'GH'): E164 {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw new DomainError('phone.invalid', 'Enter a valid phone number');
  }
  return parsed.number as E164;
}

export function tryNormalisePhone(input: string, defaultCountry: CountryCode = 'GH'): E164 | null {
  try {
    return normalisePhone(input, defaultCountry);
  } catch {
    return null;
  }
}

/** Masks all but the last four digits, for display: `+233 ** *** 4567`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '****';
  const country = phone.startsWith('+233') ? '+233' : `+${digits.slice(0, digits.length - 9)}`;
  return `${country} ** *** ${digits.slice(-4)}`;
}
