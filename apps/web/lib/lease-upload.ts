import { api } from './api';
import { LEASE_PAPER_UPLOAD, sendToStorage } from './upload';

type LeasePaperType = 'application/pdf' | 'image/jpeg' | 'image/png';

const isLeasePaperType = (type: string): type is LeasePaperType =>
  LEASE_PAPER_UPLOAD.types.includes(type);

/**
 * Sends a lease paper (a signed scan, a stamped copy or a formal lease) straight to storage with a
 * presigned POST, and returns the upload id the lease endpoints take (CLAUDE.md section 10). The
 * caller checks the file with `fileProblem` first; the API checks the type and size again.
 */
export async function uploadLeasePaper(file: File, leaseId: string | null): Promise<string> {
  if (!isLeasePaperType(file.type)) throw new Error('Choose a PDF, JPEG or PNG file.');
  const slot = await api().leases.createUpload({
    leaseId,
    contentType: file.type,
    sizeBytes: file.size,
  });
  await sendToStorage(slot, file);
  return slot.uploadId;
}
