import { PDFDocument } from '@cantoo/pdf-lib';
import { DocumentError } from '../templates/errors';

/**
 * Gives a rendered PDF fixed creation and modification dates (M5, TX-03): Chromium stamps the time
 * of rendering, which is the only thing that differs between two renders of the same HTML, so a
 * report regenerated for a locked month is then identical byte for byte. The date is the report's
 * own (its period's end), at midnight UTC.
 */
export async function withFixedPdfDates(bytes: Uint8Array, date: string): Promise<Uint8Array> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new DocumentError('invalid_data', 'A fixed PDF date is a date such as 2026-10-31');
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new DocumentError('invalid_data', 'The rendered document is not a readable PDF', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const fixed = new Date(`${date}T00:00:00.000Z`);
  document.setCreationDate(fixed);
  document.setModificationDate(fixed);
  return document.save({ useObjectStreams: false, updateFieldAppearances: false });
}
