import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Every country's rules (libphonenumber's `max`), as the sign-in screen checked numbers before
 * M11. Loaded by src/phone.ts only for a number that names another country, so a Ghanaian
 * sign-in never downloads it; on the web it is a bundle of its own.
 */
export function anyCountryPhone(text: string): string | null {
  const parsed = parsePhoneNumberFromString(text, 'GH');
  return parsed?.isValid() ? parsed.number : null;
}
