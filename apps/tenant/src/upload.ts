import { MESSAGE_PHOTO_CONTENT_TYPES, MESSAGE_PHOTO_MAX_BYTES } from './message-rules';

/** A photo's bytes as fetch can post them: a browser File or Blob, or a file on the phone. */
export type UploadPart =
  Blob | { readonly uri: string; readonly name: string; readonly type: string };

export type PhotoType = (typeof MESSAGE_PHOTO_CONTENT_TYPES)[number];

/** A photo the tenant chose to send, not uploaded yet. */
export interface PickedPhoto {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly part: UploadPart;
}

/** The presigned post the API gives for one photo (`createPhotoUpload`). */
export interface UploadSlot {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export const MAX_PHOTOS = 5;

export const isPhotoType = (value: string): value is PhotoType =>
  (MESSAGE_PHOTO_CONTENT_TYPES as readonly string[]).includes(value);

/** Why a photo cannot be sent, in words for the tenant, or null when it can. */
export function photoProblem(photo: Pick<PickedPhoto, 'contentType' | 'sizeBytes'>): string | null {
  if (!isPhotoType(photo.contentType)) return 'Choose a photo: a JPEG, PNG or WebP image.';
  if (photo.sizeBytes <= 0) return 'That photo is empty. Choose another.';
  if (photo.sizeBytes > MESSAGE_PHOTO_MAX_BYTES)
    return `That photo is too big. Choose one under ${MESSAGE_PHOTO_MAX_BYTES / 1_000_000} MB.`;
  return null;
}

/** `850 KB`, `2.4 MB`: whole tenths, from a byte count, for the photo chips. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.ceil(bytes / 1_000))} KB`;
  const tenths = Math.ceil(bytes / 100_000);
  return `${Math.floor(tenths / 10)}.${tenths % 10} MB`;
}

/** Storage refused the upload, or could not be reached. */
export class UploadFailed extends Error {
  constructor(readonly status: number | null) {
    super('upload_failed');
  }
}

/**
 * Posts one photo straight to storage through its presigned post (CLAUDE.md section 10): the
 * policy's fields first, then the file. No cookies go with it, and nothing about it is kept.
 */
export async function uploadToStorage(
  slot: UploadSlot,
  photo: PickedPhoto,
  post: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  // React Native's FormData takes a { uri, name, type } file; the browser's takes the Blob.
  form.append('file', photo.part as Blob, photo.name);
  let response: Response;
  try {
    response = await post(slot.url, { method: 'POST', body: form, credentials: 'omit' });
  } catch {
    throw new UploadFailed(null);
  }
  if (!response.ok) throw new UploadFailed(response.status);
}
