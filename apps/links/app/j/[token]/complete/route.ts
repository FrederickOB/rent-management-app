import { errorOf, photosFrom, textOf, uploadPhotos } from '../../../../lib/job-sheet';
import { clientFrom, completeJobSheet, isToken } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';

/**
 * "Send the finished work" (MI-06; decisions 6 and 7): at least one after photo, a completion
 * note and the one-time code. The photos are checked here and posted to storage first; the API
 * then records Work done.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => null);
  if (!form) return backToJobSheet(token, { error: 'PHOTO_REQUIRED' }, '#act');
  const checked = photosFrom(form, 'photos');
  if (!checked.ok) return backToJobSheet(token, { error: checked.error }, '#act');
  if (checked.photos.length === 0)
    return backToJobSheet(token, { error: 'PHOTO_REQUIRED' }, '#act');
  const completionNote = textOf(form, 'completionNote');
  if (completionNote.length < 3) return backToJobSheet(token, { error: 'NOTE_REQUIRED' }, '#act');
  const code = textOf(form, 'code').replace(/\s+/g, '');

  const client = clientFrom(request.headers);
  const uploaded = await uploadPhotos(token, client, checked.photos);
  if (!uploaded.ok) {
    if (uploaded.status === 404) return notFoundResponse();
    return backToJobSheet(token, { error: uploaded.error }, '#act');
  }
  const result = await completeJobSheet(token, client, {
    code,
    uploadIds: uploaded.uploadIds,
    completionNote,
  });
  if (result.ok) return backToJobSheet(token, { done: 'completed' });
  if (result.status === 404) return notFoundResponse();
  return backToJobSheet(token, { error: errorOf(result), left: result.data?.attemptsLeft }, '#act');
}
