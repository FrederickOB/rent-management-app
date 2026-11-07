import { noticesContract } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { sendToStorage, type UploadRule } from './upload';

// Files for notices (plan 4.7 and decision 13): a photo of a posted notice, a sworn affidavit, a
// tenant's own notice and a Rent Officer assessment. The types and the size limit are read from
// the API's upload contract (`POST /notice-uploads`), which checks them again.

function noticeUploadRule(): UploadRule {
  const input = noticesContract.createUpload['~orpc'].inputSchema;
  const maxBytes = input?.shape.sizeBytes.maxValue;
  if (!input || !maxBytes || !Number.isFinite(maxBytes))
    throw new Error('The notice-upload contract has no file types or size limit');
  return { types: input.shape.contentType.options, maxBytes };
}

export const NOTICE_UPLOAD: UploadRule = noticeUploadRule();

export type NoticeUploadPurpose =
  'service_photo' | 'affidavit' | 'received_notice' | 'rent_assessment';

/**
 * Sends a chosen file straight to storage (CLAUDE.md section 10) and returns the upload's id for
 * the record that uses it. The caller checks the file with `fileProblem(file, NOTICE_UPLOAD)` first.
 */
export async function uploadNoticeFile(
  file: File,
  purpose: NoticeUploadPurpose,
  client: { readonly createUpload: ApiClient['notices']['createUpload'] },
): Promise<string> {
  const slot = await client.createUpload({
    purpose,
    contentType: file.type as 'application/pdf' | 'image/jpeg' | 'image/png',
    sizeBytes: file.size,
  });
  await sendToStorage(slot, file);
  return slot.uploadId;
}

/**
 * Uploads made for files chosen on a form (review item 4): a retry of the same submission reuses
 * the upload of the same File instead of storing it again, so a record retried after a lost
 * answer points at the same document. Choosing another file uploads that one.
 */
export class UploadCache {
  private readonly ids = new WeakMap<File, Map<NoticeUploadPurpose, string>>();

  async upload(
    file: File,
    purpose: NoticeUploadPurpose,
    send: (file: File, purpose: NoticeUploadPurpose) => Promise<string>,
  ): Promise<string> {
    const known = this.ids.get(file)?.get(purpose);
    if (known) return known;
    const id = await send(file, purpose);
    const forFile = this.ids.get(file) ?? new Map<NoticeUploadPurpose, string>();
    forFile.set(purpose, id);
    this.ids.set(file, forFile);
    return id;
  }
}
