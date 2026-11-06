import type { MediaKind } from '@rent/domain/maintenance';
import { declaredMediaType, mediaProblem, needsDuration } from './maintenance';
import { sendToStorage, type PresignedPost } from './upload';

// Browser-only: photos, videos and voice notes for jobs, inspection photos and expense receipts
// (M8 decision 2). Each file is checked by the domain's rules before anything is sent, then goes
// straight to storage with a presigned POST (CLAUDE.md section 10); the API checks its first bytes
// when the upload is used.

/** What the API's upload endpoints take (`POST /maintenance-uploads` and its siblings). */
export interface MediaDeclaration {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly durationSeconds?: number | null;
}

export type CreateMediaUpload = (
  input: MediaDeclaration,
) => Promise<PresignedPost & { readonly uploadId: string }>;

/** A chosen file the rules refuse: said before anything is sent. */
export class MediaRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaRefused';
  }
}

const DURATION_WAIT_MS = 10_000;

/**
 * How long a video or voice note is, read by the browser's own player from the file on this
 * device; null when the browser cannot read it (some AMR and 3GP files).
 */
export function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const isVideo = declaredMediaType(file).startsWith('video/');
    const element = document.createElement(isVideo ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), DURATION_WAIT_MS);
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const seconds = element.duration;
      done(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    element.onerror = () => done(null);
    element.src = url;
  });
}

/** Checks a file against the rules and the kinds the place takes; its declaration, or why not. */
export async function declareMedia(
  file: File,
  kinds: readonly MediaKind[],
): Promise<MediaDeclaration> {
  const durationSeconds = needsDuration(file) ? await readDuration(file) : null;
  const problem = mediaProblem(file, kinds, durationSeconds);
  if (problem) throw new MediaRefused(problem);
  return {
    contentType: declaredMediaType(file),
    sizeBytes: file.size,
    ...(durationSeconds !== null ? { durationSeconds } : {}),
  };
}

/**
 * One upload per chosen file for the life of a form: a retry of the same submission sends the
 * same upload ids, so the write stays the same request. A refused upload is forgotten, so the
 * file is sent again when chosen again.
 */
export class MediaUploads {
  private readonly ids = new WeakMap<File, string>();

  constructor(
    private readonly kinds: readonly MediaKind[],
    private readonly create: CreateMediaUpload,
  ) {}

  /** Checks every file first, so a bad one stops the batch before any is sent. */
  async check(files: readonly File[]): Promise<MediaDeclaration[]> {
    return Promise.all(files.map((file) => declareMedia(file, this.kinds)));
  }

  async idsFor(files: readonly File[], onProgress?: (done: number) => void): Promise<string[]> {
    const declarations = await this.check(files);
    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
      const known = this.ids.get(file);
      if (known) {
        ids.push(known);
      } else {
        const slot = await this.create(declarations[index]!);
        await sendToStorage(slot, file);
        this.ids.set(file, slot.uploadId);
        ids.push(slot.uploadId);
      }
      onProgress?.(index + 1);
    }
    return ids;
  }

  forget(files: readonly File[]): void {
    for (const file of files) this.ids.delete(file);
  }
}
