// The parser alone: the web build takes it from its own module (metro.trim.js).
import parsePhoneNumberFromString, { type MetadataJson } from 'libphonenumber-js/core';
import { loadAnyCountryPhone } from './phone-any-load';
import metadata from './phone-metadata.json';

/**
 * The tenant's phone number for sign-in, in E.164 (CLAUDE.md section 11), exactly as
 * libphonenumber's full rules read it with Ghana as the default country, as the API reads it.
 *
 * - **A Ghanaian number,** in its local form (`024 412 3456`) or with `+233`, is checked with
 *   Ghana's rules alone (M11 decision 8): the full rules for every country are 157 KB, a quarter
 *   of the sign-in screen's download on 3G. For Ghana they are the same rules.
 * - **A number that names another country,** with `+` or Ghana's international prefix `00`, is
 *   read by every country's rules (src/phone-any.ts), which the web build loads only then. So "+44 (0)7400 123456",
 *   an extension or a `tel:` link reads as it did before M11 (M11 review).
 */
export async function signInPhone(input: string): Promise<string | null> {
  const text = input.trim();
  const parsed = parsePhoneNumberFromString(text, 'GH', metadata as MetadataJson);
  if (parsed?.isValid()) return parsed.number;
  // Ghana's rules are the full ones for Ghana: only another country's number reads differently.
  if (parsed?.countryCallingCode === '233' || !/^[^0-9]*(?:[+\uFF0B]|00)/.test(text)) return null;
  const anyCountryPhone = await loadAnyCountryPhone();
  return anyCountryPhone(text);
}
