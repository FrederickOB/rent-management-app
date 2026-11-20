// What the tenant app leaves out of its bundles (M11 decision 8), applied to every module Metro
// resolves. Kept apart from metro.config.js so a Jest test can check it.
const path = require('node:path');

/**
 * zod's API exports every one of its 50 or so error-message languages, as `z.locales`, which no
 * code here uses: about 300 KB of the web bundle before compression. Its English messages are what
 * zod configures itself with, so the list of languages is swapped for English alone.
 */
const ZOD_LOCALES = /([\\/]zod[\\/]v4[\\/]locales[\\/])index(\.c?js)$/;

/**
 * libphonenumber's `core` entry exports all of it: formatting as you type, finding numbers in
 * text and more, about 110 KB. The sign-in check (src/phone.ts) needs only its default export,
 * the parser, so that import gets the parser's own module.
 */
const PHONE_CHECK = path.join(__dirname, 'src', 'phone.ts');
const PHONE_CORE = /([\\/]libphonenumber-js[\\/])core[\\/]index\.js$/;

function resolveTrimmed(context, resolution) {
  if (!resolution || resolution.type !== 'sourceFile') return resolution;
  if (ZOD_LOCALES.test(resolution.filePath))
    return { ...resolution, filePath: resolution.filePath.replace(ZOD_LOCALES, '$1en$2') };
  if (context.originModulePath === PHONE_CHECK && PHONE_CORE.test(resolution.filePath))
    return {
      ...resolution,
      filePath: resolution.filePath.replace(PHONE_CORE, '$1es6/parsePhoneNumber.js'),
    };
  return resolution;
}

module.exports = { resolveTrimmed, ZOD_LOCALES, PHONE_CHECK, PHONE_CORE };
