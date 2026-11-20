// Writes src/phone-metadata.json: libphonenumber's full ("max") metadata for Ghana only, so the
// web build carries about half a kilobyte of phone rules instead of 157 KB (M11 decision 8). Run
// it after libphonenumber-js changes version; a Jest test (bundle-trim) fails until it matches.
//
//   node scripts/phone-metadata.mjs && ../../node_modules/.bin/prettier --write src/phone-metadata.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The countries whose numbers the app checks itself: Ghana. Others go as E.164 (src/phone.ts). */
const PHONE_COUNTRIES = ['GH'];
const OUT = new URL('../src/phone-metadata.json', import.meta.url);

const require = createRequire(import.meta.url);
const full = JSON.parse(
  readFileSync(require.resolve('libphonenumber-js/metadata.max.json'), 'utf8'),
);
const metadata = {
  version: full.version,
  country_calling_codes: Object.fromEntries(
    Object.entries(full.country_calling_codes)
      .map(([code, list]) => [code, list.filter((country) => PHONE_COUNTRIES.includes(country))])
      .filter(([, list]) => list.length > 0),
  ),
  countries: Object.fromEntries(PHONE_COUNTRIES.map((code) => [code, full.countries[code]])),
  nonGeographic: {},
};
writeFileSync(OUT, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`wrote ${fileURLToPath(OUT)}`);
