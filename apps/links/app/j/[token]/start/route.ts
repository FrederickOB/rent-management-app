import { errorOf, photosFrom, textOf, uploadPhotos } from '../../../../lib/job-sheet';
import { clientFrom, isToken, startJobSheet } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';

/**
 * "Start the work" (MI-06; decision 7): a before photo, or a reason for none. The photos are
 * checked here, then posted to storage through the API's presigned uploads.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => null);
  if (!form) return backToJobSheet(token, { error: 'BEFORE_REQUIRED' }, '#act');
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
}
