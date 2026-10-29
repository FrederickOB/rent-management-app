import { PDFDocument } from '@cantoo/pdf-lib';
import { DocumentError } from '../templates/errors';

/**
 * Appends the pages of `appendix` (a signing certificate) to `original` (the frozen document)
 * as an incremental update (TL-07; M3 plan 4.8). The original's bytes stay a byte-exact prefix
 * of the result, so its SHA-256, printed on the certificate, can still be checked against the
 * first bytes of the signed copy. Metadata is left as it was.
 */
export async function appendPdfPages(
  original: Uint8Array,
  appendix: Uint8Array,
): Promise<Uint8Array> {
  let document: PDFDocument;
  let extra: PDFDocument;
  try {
    document = await PDFDocument.load(original, {
      forIncrementalUpdate: true,
      updateMetadata: false,
    });
    extra = await PDFDocument.load(appendix, { updateMetadata: false });
  } catch (error) {
    throw new DocumentError('invalid_data', 'A document to combine is not a readable PDF', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const before = document.getPageCount();
  const pages = await document.copyPages(extra, extra.getPageIndices());
  for (const page of pages) document.addPage(page);
  const combined = await document.commit();
  if (!startsWith(combined, original))
    throw new DocumentError('invalid_data', 'The combined PDF does not keep the original intact');
  const check = await PDFDocument.load(combined, { updateMetadata: false });
  if (check.getPageCount() !== before + extra.getPageCount())
    throw new DocumentError('invalid_data', 'The combined PDF is missing pages');
  return combined;
}

/** The number of pages in a PDF. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
}

/** True when `bytes` begins with exactly `prefix`. */
export function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}
