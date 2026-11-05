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
  if (!result.ok && result.status === 404) return notFoundResponse();
  return backToJobSheet(token, { error: 'UPLOAD_FAILED' });
}
