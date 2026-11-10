// The parser alone: the web build takes it from its own module (metro.trim.js).
import parsePhoneNumberFromString, { type MetadataJson } from 'libphonenumber-js/core';
import metadata from './phone-metadata.json';

/**
 * The tenant's phone number for sign-in, in E.164 (CLAUDE.md section 11), checked here with
 * Ghana's rules only (M11 decision 8): the full rules for every country are 157 KB, a quarter of
 * the sign-in screen's download on 3G.
 *
 * - **A Ghanaian number,** in its local form (`024 412 3456`) or with `+233`, is checked against
 *   libphonenumber's full rules for Ghana, as the API checks it.
 * - **Any other country's number** is taken in its international form (`+44 7400 123456`, or
 *   `0044…`) as long as it has the shape of one: a country code and 7 to 15 digits in all. The
 *   API, which has every country's rules, checks it, and sends a code only to a number on record.
 */
export function signInPhone(input: string): string | null {
  const text = input.trim();
  const parsed = parsePhoneNumberFromString(text, 'GH', metadata as MetadataJson);
  if (parsed?.isValid()) return parsed.number;
  const compact = text.replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (compact.startsWith('+233')) return null;
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}
