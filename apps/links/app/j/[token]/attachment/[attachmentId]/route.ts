import { clientFrom, isToken, jobSheetAttachment } from '../../../../../lib/links-api';
import { backToJobSheet, notFoundResponse, seeOther } from '../../../../../lib/redirect';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One of the job's files: a fresh 5-minute storage link at each open. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; attachmentId: string }> },
): Promise<Response> {
  const { token, attachmentId } = await params;
  if (!isToken(token) || !UUID.test(attachmentId)) return notFoundResponse();
  const result = await jobSheetAttachment(token, clientFrom(request.headers), attachmentId);
  if (result.ok && /^https?:\/\//i.test(result.value.url)) return seeOther(result.value.url);
  // M11 decision 6: a file still being scanned is not served yet, and one that failed the scan
  // never is; the page says which (409 DOCUMENT_SCAN_PENDING, 410 DOCUMENT_QUARANTINED).
  if (!result.ok && (result.code === 'DOCUMENT_SCAN_PENDING' || result.code === 'SCAN_PENDING'))
    return backToJobSheet(token, { error: 'SCAN_PENDING' });
  if (!result.ok && result.code === 'DOCUMENT_QUARANTINED')
    return backToJobSheet(token, { error: 'FILE_NOT_AVAILABLE' });
  if (!result.ok && result.status === 404) return notFoundResponse();
  return backToJobSheet(token, { error: 'UPLOAD_FAILED' });
}
