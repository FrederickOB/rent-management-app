import { oc } from '@orpc/contract';
import { z } from 'zod';

/**
 * Malware scanning of uploads (M11 decision 6). Every upload is scanned in the worker before
 * anyone but the uploader can open it: `pending` until scanned, `clean` once it may be served,
 * `infected` when it is quarantined (kept, never served; an alert is raised).
 */
export const DOCUMENT_SCAN_STATUSES = ['pending', 'clean', 'infected'] as const;

/**
 * How every route that serves an uploaded file refuses one that is not clean (M11 decision 6):
 * property files, lease papers, owner-money proofs, expense receipts, repair and move-out photos,
 * evidence and tax files, the job sheet, the inbox, and the links API. The uploader may still open
 * their own pending file. Contract routes send the code in capitals, as every other code; plain
 * JSON routes send it in lower case (`document_scan_pending`), so compare without case.
 */
export const DOCUMENT_SCAN_ERRORS = {
  /** The scan isn't finished: retry later. */
  pending: { status: 409, code: 'DOCUMENT_SCAN_PENDING' },
  /** The scan found malware: the file is kept in quarantine and never served. */
  quarantined: { status: 410, code: 'DOCUMENT_QUARANTINED' },
} as const;

export const documentScanSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(DOCUMENT_SCAN_STATUSES),
  scannedAt: z.string().datetime().nullable(),
});

export const documentsContract = {
  scanStatus: oc
    .route({
      method: 'GET',
      path: '/documents/{documentId}/scan',
      summary:
        'An upload’s scan status, for the person who uploaded it or anyone who may see the document',
    })
    .input(z.object({ documentId: z.string().uuid() }))
    .output(documentScanSchema),
};
