import type { ApiClient } from '@rent/contracts/client';
import { api } from './api';
import { fileProblem, fileTypesLabel, LEASE_PAPER_UPLOAD, sendToStorage } from './upload';

type LeasePaperType = Parameters<ApiClient['leases']['createUpload']>[0]['contentType'];

const isLeasePaperType = (type: string): type is LeasePaperType =>
  LEASE_PAPER_UPLOAD.types.includes(type);

/**
 * Sends a lease paper (a signed scan, a stamped copy or a formal lease) straight to storage with a
 * presigned POST, and returns the upload id the lease endpoints take (CLAUDE.md section 10). The
 * caller checks the file with `leasePaperProblems` first; the API checks the type and size again.
 */
export async function uploadLeasePaper(file: File, leaseId: string | null): Promise<string> {
  if (!isLeasePaperType(file.type))
    throw new Error(`Choose a ${fileTypesLabel(LEASE_PAPER_UPLOAD)} file.`);
  const slot = await api().leases.createUpload({
    leaseId,
    contentType: file.type,
    sizeBytes: file.size,
  });
  await sendToStorage(slot, file);
  return slot.uploadId;
}

// Paper leases in Ghana often annex a photocopy of the tenant's ID card. We must never store an
// image of a Ghana Card (CLAUDE.md section 10), so every lease upload says so, and staff confirm
// the file has no ID card or passport copy before it is sent.

export const NO_ID_COPY_NOTE =
  'Leave out any copy of an ID card or passport. We must not store them.';
export const NO_ID_COPY_TICK = 'This file has no ID card or passport copy';
export const NO_ID_COPY_PROBLEM = 'Confirm that the file has no ID card or passport copy.';

type ChosenFile = { readonly name: string; readonly type: string; readonly size: number };

/**
 * Why a lease paper cannot be sent yet: the file (none chosen when one is needed, or the wrong
 * type or size) or the tick that it has no ID copy. Nothing is checked when no file is chosen
 * and none is needed.
 */
export function leasePaperProblems(
  file: ChosenFile | undefined,
  options: {
    readonly noIdCopy: boolean;
    /** What to say when no file is chosen; absent when the file is optional. */
    readonly missing?: string;
  },
): { readonly file: string | null; readonly tick: string | null } {
  if (!file) return { file: options.missing ?? null, tick: null };
  return {
    file: fileProblem(file, LEASE_PAPER_UPLOAD),
    tick: options.noIdCopy ? null : NO_ID_COPY_PROBLEM,
  };
}
