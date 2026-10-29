import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { sha256Hex, verifyFingerprint } from '../fingerprint';
import { appendPdfPages, pdfPageCount, startsWith } from './append';

async function pdfWith(lines: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) doc.addPage([595, 842]).drawText(line, { x: 50, y: 780, font });
  return doc.save();
}

describe('TL-07 signed copy: the certificate page appended to the frozen document', () => {
  it('adds the certificate pages after the document, keeping the original bytes intact', async () => {
    const original = await pdfWith(['Lease page 1', 'Lease page 2']);
    const certificate = await pdfWith(['Signing certificate']);
    const signed = await appendPdfPages(original, certificate);

    expect(await pdfPageCount(signed)).toBe(3);
    // An incremental update: the frozen document is a byte-exact prefix of the signed copy, so
    // the fingerprint on the certificate can be checked against the signed copy's first bytes.
    expect(startsWith(signed, original)).toBe(true);
    expect(verifyFingerprint(signed.subarray(0, original.length), sha256Hex(original))).toBe(true);
    expect(sha256Hex(signed)).not.toBe(sha256Hex(original));
  });

  it('refuses something that is not a PDF', async () => {
    const certificate = await pdfWith(['Signing certificate']);
    await expect(appendPdfPages(Buffer.from('not a pdf'), certificate)).rejects.toThrow(
      /not a readable PDF/,
    );
  });

  it('compares prefixes byte by byte', () => {
    expect(startsWith(Buffer.from('abcdef'), Buffer.from('abc'))).toBe(true);
    expect(startsWith(Buffer.from('abcdef'), Buffer.from('abd'))).toBe(false);
    expect(startsWith(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
  });
});
