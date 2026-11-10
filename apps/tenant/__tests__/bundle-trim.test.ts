import kept from '../src/phone-metadata.json';
import { signInPhone } from '../src/phone';

// NFR-PERF (M11 decision 8): the tenant web build leaves out what it never uses. Ghana's phone
// rules alone instead of every country's; zod's English messages alone; libphonenumber's parser
// alone. Sign-in still takes every number it took before (AD-06).

/** Node's file reading, for this test only: the app's TypeScript has no Node types. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node, in a Jest test
const { readFileSync } = require('node:fs') as { readFileSync(file: string, as: 'utf8'): string };
const resolve = (id: string) => (require as unknown as { resolve(id: string): string }).resolve(id);
const dirOf = (file: string) => file.slice(0, file.lastIndexOf('/'));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS Metro config
const { resolveTrimmed, PHONE_CHECK } = require('../metro.trim') as {
  resolveTrimmed: (
    context: { originModulePath: string },
    resolution: { type: string; filePath?: string } | null,
  ) => { type: string; filePath?: string } | null;
  PHONE_CHECK: string;
};

describe('NFR-PERF AD-06 sign-in phone numbers with Ghana’s rules only', () => {
  it('takes a Ghanaian number in its local or international form, as E.164', () => {
    expect(signInPhone('024 412 3456')).toBe('+233244123456');
    expect(signInPhone('0244123456')).toBe('+233244123456');
    expect(signInPhone('+233 24 412 3456')).toBe('+233244123456');
    expect(signInPhone('00233244123456')).toBe('+233244123456');
    expect(signInPhone(' 0302 123 456 ')).toBe('+233302123456');
  });

  it('refuses what is not a Ghanaian number, as libphonenumber’s full rules do', () => {
    for (const input of ['12345', '024 412', '0999 999 999', '+233 99 999 9999', 'abc', ''])
      expect(signInPhone(input)).toBeNull();
  });

  it('takes another country’s number in its international form, for the API to check', () => {
    expect(signInPhone('+44 7400 123456')).toBe('+447400123456');
    expect(signInPhone('0044 7400 123456')).toBe('+447400123456');
    expect(signInPhone('+1 (202) 555-0143')).toBe('+12025550143');
    expect(signInPhone('+234 803 123 4567')).toBe('+2348031234567');
    // Too short or too long for any E.164 number, or with no country code.
    expect(signInPhone('+44 12')).toBeNull();
    expect(signInPhone('+1234567890123456')).toBeNull();
    expect(signInPhone('7400 123456')).toBeNull();
  });

  it('the checked-in rules are Ghana’s, exactly as the installed libphonenumber-js has them', () => {
    const full = JSON.parse(
      readFileSync(resolve('libphonenumber-js/metadata.max.json'), 'utf8'),
    ) as { version: number; countries: Record<string, unknown> };
    // If libphonenumber-js changes, run scripts/phone-metadata.mjs (see its header).
    expect(kept).toEqual({
      version: full.version,
      country_calling_codes: { '233': ['GH'] },
      countries: { GH: full.countries.GH },
      nonGeographic: {},
    });
    expect(JSON.stringify(kept).length).toBeLessThan(2_000);
  });
});

describe('NFR-PERF what Metro leaves out of the tenant bundle (metro.trim.js)', () => {
  const zod = (file: string) =>
    `/repo/node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/locales/${file}`;
  const anywhere = { originModulePath: '/repo/node_modules/zod/v4/classic/external.js' };

  it('zod’s list of every language becomes English alone', () => {
    expect(resolveTrimmed(anywhere, { type: 'sourceFile', filePath: zod('index.js') })).toEqual({
      type: 'sourceFile',
      filePath: zod('en.js'),
    });
    expect(resolveTrimmed(anywhere, { type: 'sourceFile', filePath: zod('index.cjs') })).toEqual({
      type: 'sourceFile',
      filePath: zod('en.cjs'),
    });
    // English itself, another language asked for by name, and everything else stay as they are.
    for (const file of [zod('en.js'), zod('fr.js'), '/repo/apps/tenant/src/index.js'])
      expect(resolveTrimmed(anywhere, { type: 'sourceFile', filePath: file })).toEqual({
        type: 'sourceFile',
        filePath: file,
      });
  });

  it('the sign-in check gets libphonenumber’s parser alone; any other importer, all of it', () => {
    const core = '/repo/node_modules/libphonenumber-js/core/index.js';
    expect(
      resolveTrimmed({ originModulePath: PHONE_CHECK }, { type: 'sourceFile', filePath: core }),
    ).toEqual({
      type: 'sourceFile',
      filePath: '/repo/node_modules/libphonenumber-js/es6/parsePhoneNumber.js',
    });
    expect(resolveTrimmed(anywhere, { type: 'sourceFile', filePath: core })).toEqual({
      type: 'sourceFile',
      filePath: core,
    });
    expect(resolveTrimmed(anywhere, { type: 'empty' })).toEqual({ type: 'empty' });
    expect(PHONE_CHECK.endsWith('/src/phone.ts')).toBe(true);
  });

  it('the parser module the web build uses is the one core exports as its default', () => {
    const pkg = dirOf(resolve('libphonenumber-js/package.json'));
    expect(readFileSync(`${pkg}/core/index.js`, 'utf8')).toContain(
      "export { default as default, default as parsePhoneNumberFromString } from '../es6/parsePhoneNumber.js'",
    );
  });
});
