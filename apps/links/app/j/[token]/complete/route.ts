import {
  declaredOver,
  JOB_SHEET_FORM_LIMITS,
  JOB_SHEET_MAX_BODY_BYTES,
} from '../../../../lib/body-limit';
import {
  codeDetails,
  errorOf,
  knownSheet,
  photosFrom,
  textOf,
  uploadPhotos,
} from '../../../../lib/job-sheet';
import { forgetUploads, keepUploads, keptUploads, onlyOnce } from '../../../../lib/job-sheet-store';
import { clientFrom, completeJobSheet, isToken } from '../../../../lib/links-api';
import { readMultipart } from '../../../../lib/multipart';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';
import { secured } from '../../../../lib/security-headers';
import { admitUpload } from '../../../../lib/upload-gate';

/**
 * "Send the finished work" (MI-06; decisions 6 and 7): at least one after photo, a completion
 * note and the one-time code. The photos are checked here and posted to storage first; the API
 * then records Work done.
 *
 * - **A refused completion keeps its photos** (M8 review LT 6): after a wrong or expired code the
 *   artisan sends the code again without choosing the photos again, and nothing is uploaded twice.
 *   New photos replace the kept ones.
 * - **A second tap** on the same form gets the first one's answer.
 * - **The proxy never sees this post** (proxy.ts), so this route guards it before reading it: a
 *   body declared over the job sheet's limit is refused, each address and the server take only
 *   a few photo forms at once (lib/upload-gate.ts), and the token must be one the API knows.
 *   The form is then read part by part, each photo to disk (lib/multipart.ts), and the answer
 *   carries the security headers itself.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return secured(notFoundResponse());
  return secured(await handle(request, token));
}

/** The API refused the files themselves: keeping them would only fail again. */
const refusesFiles = (code: string) => /MEDIA|UPLOAD/i.test(code);

async function handle(request: Request, token: string): Promise<Response> {
  if (declaredOver(request, JOB_SHEET_MAX_BODY_BYTES))
    return backToJobSheet(token, { error: 'BODY_TOO_LARGE' }, '#act');
  const admitted = admitUpload(clientFrom(request.headers).ip);
  if (!admitted.ok) return backToJobSheet(token, { error: 'RATE_LIMITED' }, '#act');
  try {
    // A token the API doesn't know is refused before a byte of the form is read (F2).
    const unknown = await knownSheet(token, clientFrom(request.headers));
    if (unknown) return unknown;
    const read = await readMultipart(request, JOB_SHEET_FORM_LIMITS);
    if (!read.ok)
      return backToJobSheet(
        token,
        { error: read.error === 'FORM_UNREADABLE' ? 'PHOTO_REQUIRED' : read.error },
        '#act',
      );
    try {
      return await completed(request, token, read.form);
    } finally {
      await read.cleanup();
    }
  } finally {
    admitted.release();
  }
}

async function completed(request: Request, token: string, form: FormData): Promise<Response> {
  return onlyOnce(token, textOf(form, 'form'), async () => {
    const checked = photosFrom(form, 'photos');
    if (!checked.ok) return backToJobSheet(token, { error: checked.error }, '#act');
    const kept = checked.photos.length === 0 ? keptUploads(token) : [];
    if (checked.photos.length === 0 && kept.length === 0)
      return backToJobSheet(token, { error: 'PHOTO_REQUIRED' }, '#act');
    const completionNote = textOf(form, 'completionNote');
    if (completionNote.length < 3) return backToJobSheet(token, { error: 'NOTE_REQUIRED' }, '#act');
    const code = textOf(form, 'code').replace(/\s+/g, '');

    const client = clientFrom(request.headers);
    let uploadIds = kept;
    if (checked.photos.length > 0) {
      const uploaded = await uploadPhotos(token, client, checked.photos);
      if (!uploaded.ok) {
        if (uploaded.status === 404) return notFoundResponse();
        return backToJobSheet(token, { error: uploaded.error }, '#act');
      }
      uploadIds = uploaded.uploadIds;
      forgetUploads(token);
    }
    const result = await completeJobSheet(token, client, { code, uploadIds, completionNote });
    if (result.ok) {
      forgetUploads(token);
      return backToJobSheet(token, { done: 'completed' });
    }
    if (result.status === 404) {
      forgetUploads(token);
      return notFoundResponse();
    }
    const error = errorOf(result);
    if (refusesFiles(error)) forgetUploads(token);
    else keepUploads(token, uploadIds);
    return backToJobSheet(token, { error, ...codeDetails(result) }, '#act');
  });
}
