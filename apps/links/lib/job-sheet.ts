import { MEDIA_MAX_FILES_PER_REQUEST, MEDIA_RULES } from '@rent/domain/maintenance';
import {
  createJobSheetUpload,
  checkJobSheet,
  type ApiResult,
  type Client,
  type JobSheetView,
} from './links-api';
import { backToJobSheet, notFoundResponse } from './redirect';
import { when } from './pay';
import { problemText } from './problems';

// The artisan's job sheet, /j/[token] (MI-04, MI-06; M8 decision 6 and plan 4.5). Plain HTML
// forms: every step works without the page's own script. Photos are posted to this server with
// the form, checked against the job-media limits (decision 2), then posted on to storage through
// the API's presigned upload. The API checks each file again from its first bytes.

type Query = Readonly<Record<string, string | undefined>>;

/** What went wrong with the last action, for the job sheet's own steps. */
const JOB_PROBLEMS: Readonly<Record<string, string>> = {
  PHOTO_REQUIRED: 'Add at least one photo of the finished work.',
  PHOTO_TYPE: 'Send photos as JPEG, PNG or WebP.',
  PHOTO_TOO_LARGE: `Each photo must be ${MEDIA_RULES.image.maxBytes / 1_000_000} MB or smaller.`,
  PHOTO_TOO_MANY: `Send at most ${MEDIA_MAX_FILES_PER_REQUEST} photos at a time.`,
  UPLOAD_FAILED: 'A photo could not be uploaded. Try again.',
  NOTE_REQUIRED: 'Say in a few words what you did.',
  BEFORE_REQUIRED: 'Add a photo from before you start, or say why there is none.',
  MAINTENANCE_AFTER_PHOTO_REQUIRED: 'Add at least one photo of the finished work.',
  MAINTENANCE_COMPLETION_NOTE_REQUIRED: 'Say in a few words what you did.',
  MAINTENANCE_BEFORE_PHOTO_REQUIRED: 'Add a photo from before you start, or say why there is none.',
  MAINTENANCE_REASON_REQUIRED: 'Say in a few words why.',
  MAINTENANCE_TRANSITION: 'This step is no longer possible. The page shows where the job is now.',
  MEDIA_TYPE_MISMATCH: 'A file is not the photo it says it is. Choose the photo again.',
  MEDIA_TYPE_NOT_ALLOWED: 'Send photos as JPEG, PNG or WebP.',
  MEDIA_TOO_LARGE: `Each photo must be ${MEDIA_RULES.image.maxBytes / 1_000_000} MB or smaller.`,
  JOB_SHEET_LOCKED: 'Too many wrong codes. Wait a while before you try again.',
  // Too many wrong codes (429): the API says until when, which the page adds.
  CODE_LOCKED: 'Too many wrong codes.',
  BODY_TOO_LARGE: `Send at most ${MEDIA_MAX_FILES_PER_REQUEST} photos at a time, each ${MEDIA_RULES.image.maxBytes / 1_000_000} MB or smaller.`,
  RESPONSE_REQUIRED: 'Choose whether you can take the job.',
  // M11 review: a form that stopped arriving, or came too slowly, holds no upload place.
  UPLOAD_TOO_SLOW:
    'Your photos took too long to arrive. Try again where the signal is better, or send fewer photos at a time.',
  // M11 decision 6: a file still being scanned for viruses, or one that is not served.
  SCAN_PENDING: 'That file is still being checked for viruses. Try again in a minute.',
  FILE_NOT_AVAILABLE: 'That file is not available.',
};

/** The problem to show: the job sheet's own words first, then the signing page's for codes. */
export function jobSheetProblem(query: Query, timeZone = 'Africa/Accra'): string | null {
  if (!query.error) return null;
  if (query.error === 'CODE_LOCKED') {
    // From the query string: only a well-formed instant is shown.
    const until = query.until && ISO_INSTANT.test(query.until) ? query.until : null;
    return until
      ? `${JOB_PROBLEMS.CODE_LOCKED} Try again after ${when(until, timeZone)}.`
      : `${JOB_PROBLEMS.CODE_LOCKED} Wait a while before you try again.`;
  }
  if (Object.hasOwn(JOB_PROBLEMS, query.error)) return JOB_PROBLEMS[query.error]!;
  return problemText(query);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type PhotoCheck =
  | { readonly ok: true; readonly photos: readonly File[] }
  | { readonly ok: false; readonly error: string };

/**
 * The photos a form posted under `field`: the empty part a browser sends when no file was chosen
 * is left out. Each must be a JPEG, PNG or WebP of at most 10 MB, at most 10 in all (decision 2).
 */
export function photosFrom(form: FormData, field: string): PhotoCheck {
  const photos = form
    .getAll(field)
    .filter(
      (value): value is File => typeof value === 'object' && value !== null && value.size > 0,
    );
  if (photos.length > MEDIA_MAX_FILES_PER_REQUEST) return { ok: false, error: 'PHOTO_TOO_MANY' };
  for (const photo of photos) {
    if (!MEDIA_RULES.image.contentTypes.includes(photo.type))
      return { ok: false, error: 'PHOTO_TYPE' };
    if (photo.size > MEDIA_RULES.image.maxBytes) return { ok: false, error: 'PHOTO_TOO_LARGE' };
  }
  return { ok: true, photos };
}

/** A text field, trimmed; empty when missing. */
export function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export type UploadOutcome =
  | { readonly ok: true; readonly uploadIds: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Posts each photo to storage through the API's presigned upload: the policy's fields first, then
 * the file, as storage expects. No cookie goes with it.
 */
export async function uploadPhotos(
  token: string,
  client: Client,
  photos: readonly File[],
  post: typeof fetch = fetch,
): Promise<UploadOutcome> {
  const uploadIds: string[] = [];
  for (const photo of photos) {
    const slot = await createJobSheetUpload(token, client, {
      contentType: photo.type,
      sizeBytes: photo.size,
    });
    if (!slot.ok) return { ok: false, status: slot.status, error: slot.code };
    const form = new FormData();
    for (const [key, value] of Object.entries(slot.value.fields)) form.append(key, value);
    form.append('file', photo, photo.name || 'photo');
    let stored: Response;
    try {
      stored = await post(slot.value.url, { method: 'POST', body: form, credentials: 'omit' });
    } catch {
      return { ok: false, status: 503, error: 'UPLOAD_FAILED' };
    }
    if (!stored.ok) return { ok: false, status: stored.status, error: 'UPLOAD_FAILED' };
    uploadIds.push(slot.value.uploadId);
  }
  return { ok: true, uploadIds };
}

/**
 * Whether a photo form's sheet is live, asked before the form counts toward its address's upload
 * window or a byte of it is read (M11 security review F2, review B13 and C10). The API's check
 * records nothing: no open, no open count. Null when the sheet is live; otherwise the answer to
 * give, unread: not found for a token the API does not know, the sheet's own page for one that is
 * closed, expired or replaced (it says which), or back to the sheet with the problem (too many
 * requests, the API unreachable).
 */
export async function liveSheet(token: string, client: Client): Promise<Response | null> {
  const checked = await checkJobSheet(token, client);
  if (checked.ok) return checked.value.live ? null : backToJobSheet(token, {});
  if (checked.status === 404) return notFoundResponse();
  return backToJobSheet(token, { error: errorOf(checked) }, '#act');
}

/** The error code for the page after a refused action: the API's, or the rate limit's. */
export function errorOf(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  // A lock on the code is a 429 with its own words, and the time it ends (lockedUntil).
  if (result.status === 429 && result.code.toUpperCase() === 'CODE_LOCKED') return 'CODE_LOCKED';
  return result.status === 429 ? 'RATE_LIMITED' : result.code;
}

/** What the page adds to a refused code: the tries left (code_wrong), or when a lock ends. */
export function codeDetails(result: Extract<ApiResult<unknown>, { ok: false }>) {
  return { left: result.data?.attemptsLeft, until: result.data?.lockedUntil };
}

/**
 * A file's malware scan (M11 decision 6): `pending` until the worker has scanned it, then
 * `clean`. The API never lists an infected file; one that says so anyway is treated as such and
 * never offered. A file without the field is clean, as every file was before scanning began.
 */
export type ScanStatus = 'pending' | 'clean' | 'infected';

export function scanOf(attachment: JobSheetView['attachments'][number]): ScanStatus {
  const scan: unknown = attachment.scan;
  return scan === 'pending' || scan === 'infected' ? scan : 'clean';
}

/** How the page refers to one of the job's files. */
export function attachmentLabel(
  attachment: JobSheetView['attachments'][number],
  index: number,
): string {
  const kind =
    attachment.kind === 'image'
      ? 'Photo'
      : attachment.kind === 'video'
        ? 'Video'
        : attachment.kind === 'audio'
          ? 'Voice note'
          : 'File';
  return `${kind} ${index + 1}`;
}
