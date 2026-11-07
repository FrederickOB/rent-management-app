import { formWithin, JOB_SHEET_MAX_BODY_BYTES } from '../../../../lib/body-limit';
import { errorOf, photosFrom, textOf, uploadPhotos } from '../../../../lib/job-sheet';
import { onlyOnce } from '../../../../lib/job-sheet-store';
import { clientFrom, isToken, startJobSheet } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';
import { secured } from '../../../../lib/security-headers';

/**
 * "Start the work" (MI-06; decision 7): a before photo, or a reason for none. The photos are
 * checked here, then posted to storage through the API's presigned uploads.
 *
 * The proxy never sees this post (proxy.ts), so the form is read here within the job sheet's
 * limit, and the answer carries the security headers itself. A second tap on the same form gets
 * the first one's answer, so nothing is uploaded twice.
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
  const read = await formWithin(request, JOB_SHEET_MAX_BODY_BYTES);
  if (!read.ok)
    return backToJobSheet(
      token,
      { error: read.error === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'BEFORE_REQUIRED' },
      '#act',
    );
  const { form } = read;
  return onlyOnce(token, textOf(form, 'form'), async () => {
    const checked = photosFrom(form, 'photos');
    if (!checked.ok) return backToJobSheet(token, { error: checked.error }, '#act');
    const beforePhotoReason = textOf(form, 'beforePhotoReason') || null;
    if (checked.photos.length === 0 && !beforePhotoReason)
      return backToJobSheet(token, { error: 'BEFORE_REQUIRED' }, '#act');

    const client = clientFrom(request.headers);
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
