import { readFileSync } from 'node:fs';

/**
 * Noto Sans 2.015, unhinted TTF, from github.com/notofonts/notofonts.github.io at commit 28b15b4
 * (fonts/NotoSans/unhinted/ttf), under the SIL Open Font License in fonts/OFL.txt. Both weights
 * contain the cedi sign (U+20B5) and the Ghanaian letters ɛ ɔ ŋ ɖ ƒ ɣ ʋ; fonts.test.ts checks.
 */
export const DOCUMENT_FONTS = [
  { file: 'NotoSans-Regular.ttf', weight: 400 },
  { file: 'NotoSans-Bold.ttf', weight: 700 },
] as const;

export const DOCUMENT_FONT_FAMILY = 'Noto Sans';

export const fontPath = (file: string) => new URL(`../../fonts/${file}`, import.meta.url);

let fontFaces: string | undefined;

/** @font-face rules with the fonts inlined as base64, read once on first use. */
export function fontFaceCss(): string {
  fontFaces ??= DOCUMENT_FONTS.map(
    ({ file, weight }) =>
      `@font-face{font-family:'${DOCUMENT_FONT_FAMILY}';font-style:normal;font-weight:${weight};` +
      `font-display:block;src:url(data:font/ttf;base64,${readFileSync(fontPath(file)).toString('base64')}) format('truetype')}`,
  ).join('\n');
  return fontFaces;
}
