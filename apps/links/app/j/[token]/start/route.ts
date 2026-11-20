import {
  declaredOver,
  JOB_SHEET_FORM_LIMITS,
  JOB_SHEET_MAX_BODY_BYTES,
} from '../../../../lib/body-limit';
import { errorOf, liveSheet, photosFrom, textOf, uploadPhotos } from '../../../../lib/job-sheet';
import { onlyOnce } from '../../../../lib/job-sheet-store';
import { clientFrom, isToken, startJobSheet } from '../../../../lib/links-api';
import { readMultipart } from '../../../../lib/multipart';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';
import { secured } from '../../../../lib/security-headers';
import { admitUpload } from '../../../../lib/upload-gate';

/**
 * "Start the work" (MI-06; decision 7): a before photo, or a reason for none. The photos are
 * checked here, then posted to storage through the API's presigned uploads.
 *
 * The proxy never sees this post (proxy.ts), so this route guards it before reading it: a body
 * declared over the job sheet's limit is refused, the sheet must be live (lib/job-sheet.ts,
 * liveSheet), and only then does the form count toward its address's few at once and 30 in 10
 * minutes (lib/upload-gate.ts), so unknown or dead links use up nothing (M11 review). The form is
 * then read part by part, each photo to disk, within a deadline (lib/multipart.ts), and the answer
 * carries the security headers itself. A second tap on the same form gets the first one's
 * answer, so nothing is uploaded twice.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return secured(notFoundResponse());
  return secured(await handle(request, token));
}

async function handle(request: Request, token: string): Promise<Response> {
  if (declaredOver(request, JOB_SHEET_MAX_BODY_BYTES))
    return backToJobSheet(token, { error: 'BODY_TOO_LARGE' }, '#act');
  const client = clientFrom(request.headers);
  // An unknown or dead link is refused before its form is counted or read (F2; M11 review).
  const refused = await liveSheet(token, client);
  if (refused) return refused;
  const admitted = admitUpload(client.ip);
  if (!admitted.ok) return backToJobSheet(token, { error: 'RATE_LIMITED' }, '#act');
  try {
    const read = await readMultipart(request, JOB_SHEET_FORM_LIMITS);
    if (!read.ok)
      return backToJobSheet(
        token,
        { error: read.error === 'FORM_UNREADABLE' ? 'BEFORE_REQUIRED' : read.error },
        '#act',
      );
    try {
      return await started(token, client, read.form);
    } finally {
      await read.cleanup();
    }
  } finally {
    admitted.release();
  }
}

async function started(
  token: string,
  client: ReturnType<typeof clientFrom>,
  form: FormData,
): Promise<Response> {
  return onlyOnce(token, textOf(form, 'form'), async () => {
    const checked = photosFrom(form, 'photos');
    if (!checked.ok) return backToJobSheet(token, { error: checked.error }, '#act');
    const beforePhotoReason = textOf(form, 'beforePhotoReason') || null;
    if (checked.photos.length === 0 && !beforePhotoReason)
      return backToJobSheet(token, { error: 'BEFORE_REQUIRED' }, '#act');

    const uploaded = await uploadPhotos(token, client, checked.photos);
    if (!uploaded.ok) {
      if (uploaded.status === 404) return notFoundResponse();
      return backToJobSheet(token, { error: uploaded.error }, '#act');
    }
    const result = await startJobSheet(token, client, {
      uploadIds: uploaded.uploadIds,
      beforePhotoReason,
    });
    if (result.ok) return backToJobSheet(token, { done: 'started' });
    if (result.status === 404) return notFoundResponse();
    return backToJobSheet(token, { error: errorOf(result) }, '#act');
  });
}
