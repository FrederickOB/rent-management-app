import { MEDIA_MAX_FILES_PER_REQUEST, MEDIA_RULES } from '@rent/domain/maintenance';

/**
 * The most a job-sheet photo form may carry (decision 2): ten photos of up to 10 MB, and room for
 * the note, the code and the form's own framing. The proxy never sees these posts (proxy.ts), so
 * Next.js neither copies nor cuts them; this is their only limit.
 */
export const JOB_SHEET_MAX_BODY_BYTES =
  MEDIA_MAX_FILES_PER_REQUEST * MEDIA_RULES.image.maxBytes + 1_000_000;

/**
 * The job sheet's photo forms, read part by part (lib/multipart.ts): each photo at most 10 MB and
 * at most 10 of them, as photosFrom checks, and the whole body within JOB_SHEET_MAX_BODY_BYTES.
 *
 * A form holds an upload place while it is read (lib/upload-gate.ts), so it must keep arriving
 * (M11 review): never 30 seconds with nothing, and all of it in the time its declared length takes
 * at 64 KB a second, at least a minute and at most 20 minutes. The 3G profile the pages are tested
 * on uploads at 96 KB a second: the largest form, 101 MB, takes it about 17 minutes.
 */
export const JOB_SHEET_FORM_LIMITS = {
  maxBytes: JOB_SHEET_MAX_BODY_BYTES,
  maxFileBytes: MEDIA_RULES.image.maxBytes,
  maxFiles: MEDIA_MAX_FILES_PER_REQUEST,
  maxFieldBytes: 16 * 1024,
  maxParts: 32,
  idleMs: 30_000,
  deadlineMs: 20 * 60_000,
  minBytesPerSecond: 64 * 1024,
} as const;

/** Whether a request says, in its Content-Length, that it is over `limit`. */
export function declaredOver(request: Request, limit: number): boolean {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  return Number.isFinite(declared) && declared > limit;
}

export type FormRead =
  | { readonly ok: true; readonly form: FormData }
  | { readonly ok: false; readonly error: 'BODY_TOO_LARGE' | 'FORM_UNREADABLE' };

/**
 * Reads a posted form, refusing it once it passes `limit` bytes: at once when its declared length
 * is over, or as soon as the bytes read pass it, without reading the rest.
 */
export async function formWithin(request: Request, limit: number): Promise<FormRead> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) return { ok: false, error: 'BODY_TOO_LARGE' };
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    let total = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, error: 'FORM_UNREADABLE' };
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: 'BODY_TOO_LARGE' };
      }
      chunks.push(new Uint8Array(chunk.value));
    }
  }
  try {
    const form = await new Response(new Blob(chunks), {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, error: 'FORM_UNREADABLE' };
  }
}
