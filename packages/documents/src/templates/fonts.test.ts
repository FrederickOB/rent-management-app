import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_FONTS, fontFaceCss, fontPath } from './fonts';

/**
 * Reads a TrueType font's tables as bytes, so the test checks the font itself rather than
 * whatever a browser would fall back to. Only the parts needed here: name, cmap, loca and glyf.
 */
function openTrueType(font: Buffer) {
  const tables = new Map<string, number>();
  for (let i = 0; i < font.readUInt16BE(4); i += 1) {
    const record = 12 + i * 16;
    tables.set(font.toString('latin1', record, record + 4), font.readUInt32BE(record + 8));
  }
  const table = (tag: string) => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`missing ${tag} table`);
    return offset;
  };

  /** Glyph for a code point from the Windows Unicode full-repertoire cmap (format 12). */
  function glyphId(codePoint: number): number {
    const cmap = table('cmap');
    for (let i = 0; i < font.readUInt16BE(cmap + 2); i += 1) {
      const record = cmap + 4 + i * 8;
      if (font.readUInt16BE(record) !== 3 || font.readUInt16BE(record + 2) !== 10) continue;
      const subtable = cmap + font.readUInt32BE(record + 4);
      if (font.readUInt16BE(subtable) !== 12) throw new Error('expected a format 12 cmap');
      for (let g = 0; g < font.readUInt32BE(subtable + 12); g += 1) {
        const group = subtable + 16 + g * 12;
        const start = font.readUInt32BE(group);
        if (codePoint >= start && codePoint <= font.readUInt32BE(group + 4)) {
          return font.readUInt32BE(group + 8) + (codePoint - start);
        }
      }
      return 0;
    }
    throw new Error('no format 12 cmap');
  }

  /** Bytes of outline data for a glyph; zero for an empty glyph. */
  function outlineBytes(glyph: number): number {
    const longOffsets = font.readInt16BE(table('head') + 50) === 1;
    const loca = table('loca');
    const at = (i: number) =>
      longOffsets ? font.readUInt32BE(loca + i * 4) : font.readUInt16BE(loca + i * 2) * 2;
    return at(glyph + 1) - at(glyph);
  }

  /** A Windows name record (nameID 1 is the family). */
  function name(id: number): string | undefined {
    const base = table('name');
    const strings = base + font.readUInt16BE(base + 4);
    for (let i = 0; i < font.readUInt16BE(base + 2); i += 1) {
      const record = base + 6 + i * 12;
      if (font.readUInt16BE(record) !== 3 || font.readUInt16BE(record + 6) !== id) continue;
      const start = strings + font.readUInt16BE(record + 10);
      // UTF-16BE; copied before swapping so the font buffer itself is untouched.
      return Buffer.from(font.subarray(start, start + font.readUInt16BE(record + 8)))
        .swap16()
        .toString('utf16le');
    }
    return undefined;
  }

  return { glyphId, outlineBytes, name };
}

const CEDI = 0x20b5;
// Akan, Ga, Dagbani and Ewe letters, as in tenant and company names.
const GHANAIAN_LETTERS = 'ƐɛƆɔŊŋƉɖƑƒƔɣƲʋ';

describe('PLATFORM documents', () => {
  describe.each(DOCUMENT_FONTS)('$file', ({ file }) => {
    const font = openTrueType(readFileSync(fontPath(file)));

    it('is Noto Sans', () => {
      expect(font.name(1)).toBe('Noto Sans');
    });

    it('draws the cedi sign (U+20B5) with a real glyph', () => {
      const glyph = font.glyphId(CEDI);
      expect(glyph).toBeGreaterThan(0);
      expect(font.outlineBytes(glyph)).toBeGreaterThan(0);
    });

    it('draws the letters of Ghanaian languages', () => {
      for (const letter of GHANAIAN_LETTERS) {
        const glyph = font.glyphId(letter.codePointAt(0) ?? 0);
        expect(glyph, letter).toBeGreaterThan(0);
        expect(font.outlineBytes(glyph), letter).toBeGreaterThan(0);
      }
    });

    it('maps a private-use code point to no glyph, so the checks above can fail', () => {
      expect(font.glyphId(0xe000)).toBe(0);
    });
  });

  it('ships the fonts with their licence and inlines both weights as base64', () => {
    expect(readFileSync(fontPath('OFL.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    );
    const css = fontFaceCss();
    for (const { file, weight } of DOCUMENT_FONTS) {
      const base64 = readFileSync(fontPath(file)).toString('base64');
      expect(css).toContain(
        `font-weight:${weight};font-display:block;src:url(data:font/ttf;base64,${base64})`,
      );
    }
  });
});
