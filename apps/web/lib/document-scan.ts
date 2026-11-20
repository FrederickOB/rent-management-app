import { QUARANTINED_TEXT, SCAN_PENDING_TEXT, scanRefusal } from './errors';

/**
 * Uploads are scanned for malware before anyone but the uploader can open them (M11 decision 6;
 * NFR-SEC). The route that serves a file refuses while its scan is pending (409
 * `DOCUMENT_SCAN_PENDING`) and refuses a quarantined file for good (410 `DOCUMENT_QUARANTINED`);
 * `toProblem` words both everywhere. A file viewer shows them as a note rather than an error: the
 * pending one with its button to try again, the quarantined one with nothing to open.
 */
export type ScanNote = { readonly state: 'pending' | 'quarantined'; readonly text: string };

export function scanNote(error: unknown): ScanNote | null {
  const refusal = scanRefusal(error);
  if (refusal === 'pending') return { state: 'pending', text: SCAN_PENDING_TEXT };
  if (refusal === 'quarantined') return { state: 'quarantined', text: QUARANTINED_TEXT };
  return null;
}
