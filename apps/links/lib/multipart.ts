import { openAsBlob } from 'node:fs';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A posted multipart form, read as it arrives (M11 security review F2). Text fields are kept in
 * memory, each up to a small limit; each file goes straight to a file in a folder of its own on
 * this server's disk, so memory stays at about one network chunk however large the photos are.
 * The form then holds disk-backed files, and the folder is deleted once the post is handled. The
 * folder is made in LINKS_UPLOAD_DIR, or the system's temporary folder.
 *
 * Refusals come as soon as they are certain, without reading the rest: the whole body over its
 * limit, a file over its own, or too many files.
 */
export interface MultipartLimits {
  /** The whole body. */
  readonly maxBytes: number;
  /** One file. */
  readonly maxFileBytes: number;
  /** Files with content; an empty file part (a file input left empty) does not count. */
  readonly maxFiles: number;
  /** One text field. */
  readonly maxFieldBytes: number;
  /** Text fields and files together. */
  readonly maxParts: number;
}

export type MultipartRefusal =
  'BODY_TOO_LARGE' | 'FORM_UNREADABLE' | 'PHOTO_TOO_LARGE' | 'PHOTO_TOO_MANY';

export type MultipartForm =
  | { readonly ok: true; readonly form: FormData; readonly cleanup: () => Promise<void> }
  | { readonly ok: false; readonly error: MultipartRefusal };

class Refusal extends Error {
  constructor(readonly code: MultipartRefusal) {
    super(code);
  }
}

const HEADERS_MAX = 16 * 1024;
const CRLF = Buffer.from('\r\n');
const HEADERS_END = Buffer.from('\r\n\r\n');
const CLOSE = Buffer.from('--');

/** The boundary a multipart content type names, or null. */
export function boundaryOf(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2] ?? null;
  return boundary && boundary.length <= 70 ? boundary : null;
}

interface PartHead {
  readonly name: string;
  readonly filename: string | null;
  readonly type: string;
}

function headOf(block: string): PartHead {
  let name: string | null = null;
  let filename: string | null = null;
  let type = 'application/octet-stream';
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1] ?? null;
      const file = /(?:^|;)\s*filename="([^"]*)"/i.exec(value);
      filename = file ? file[1]! : null;
    } else if (key === 'content-type') {
      type = value.split(';')[0]!.trim().toLowerCase() || type;
    }
  }
  if (name === null) throw new Refusal('FORM_UNREADABLE');
  return { name, filename, type };
}

/** Reads `request`'s multipart body within `limits`; see the module's comment. */
export async function readMultipart(
  request: Request,
  limits: MultipartLimits,
): Promise<MultipartForm> {
  const boundary = boundaryOf(request.headers.get('content-type'));
  if (!boundary || !request.body) return { ok: false, error: 'FORM_UNREADABLE' };
  const marker = Buffer.from(`\r\n--${boundary}`);
  const reader = request.body.getReader();
  let folder: string | null = null;
  const cleanup = async () => {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  };

  // The body as an unread window: the stream is read only as far as each step needs. A CRLF goes
  // in front, so the first delimiter looks like every later one.
  let window: Buffer = Buffer.from(CRLF);
  let total = 0;
  const more = async (): Promise<boolean> => {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Refusal('FORM_UNREADABLE');
    }
    if (chunk.done) return false;
    total += chunk.value.byteLength;
    if (total > limits.maxBytes) throw new Refusal('BODY_TOO_LARGE');
    window = window.length > 0 ? Buffer.concat([window, chunk.value]) : Buffer.from(chunk.value);
    return true;
  };
  /** Reads until `bytes` are in the window; false at the end of the body. */
  const fill = async (bytes: number): Promise<boolean> => {
    while (window.length < bytes) if (!(await more())) return false;
    return true;
  };

  const fields: [string, string][] = [];
  const files: { name: string; filename: string; type: string; file: string | null }[] = [];
  let withContent = 0;
  try {
    // The preamble, up to the first delimiter.
    for (;;) {
      const at = window.indexOf(marker);
      if (at >= 0) {
        window = window.subarray(at + marker.length);
        break;
      }
      window = window.subarray(Math.max(0, window.length - marker.length));
      if (!(await more())) throw new Refusal('FORM_UNREADABLE');
    }
    for (;;) {
      // After a delimiter: "--" ends the form, CRLF starts a part.
      if (!(await fill(2))) throw new Refusal('FORM_UNREADABLE');
      if (window.subarray(0, 2).equals(CLOSE)) break;
      if (!window.subarray(0, 2).equals(CRLF)) throw new Refusal('FORM_UNREADABLE');
      window = window.subarray(2);
      if (fields.length + files.length >= limits.maxParts) throw new Refusal('FORM_UNREADABLE');

      // The part's headers.
      let end = window.indexOf(HEADERS_END);
      while (end < 0) {
        if (window.length > HEADERS_MAX || !(await more())) throw new Refusal('FORM_UNREADABLE');
        end = window.indexOf(HEADERS_END);
      }
      const head = headOf(window.subarray(0, end).toString('utf8'));
      window = window.subarray(end + HEADERS_END.length);

      // The part's content, up to the next delimiter: a text field in memory, a file on disk.
      let handle: FileHandle | null = null;
      let filePath: string | null = null;
      const kept: Buffer[] = [];
      let size = 0;
      const write = async (bytes: Buffer) => {
        if (bytes.length === 0) return;
        size += bytes.length;
        if (head.filename === null) {
          if (size > limits.maxFieldBytes) throw new Refusal('FORM_UNREADABLE');
          kept.push(Buffer.from(bytes));
          return;
        }
        if (size > limits.maxFileBytes) throw new Refusal('PHOTO_TOO_LARGE');
        if (!handle) {
          withContent += 1;
          if (withContent > limits.maxFiles) throw new Refusal('PHOTO_TOO_MANY');
          folder ??= await mkdtemp(
            path.join(process.env.LINKS_UPLOAD_DIR || tmpdir(), 'rent-links-'),
          );
          filePath = path.join(folder, `${files.length}`);
          handle = await open(filePath, 'w');
        }
        await handle.write(bytes);
      };
      try {
        for (;;) {
          const at = window.indexOf(marker);
          if (at >= 0) {
            await write(window.subarray(0, at));
            window = window.subarray(at + marker.length);
            break;
          }
          // Everything but a possible start of the delimiter is content.
          const safe = window.length - (marker.length - 1);
          if (safe > 0) {
            await write(window.subarray(0, safe));
            window = window.subarray(safe);
          }
          if (!(await more())) throw new Refusal('FORM_UNREADABLE');
        }
      } finally {
        await (handle as FileHandle | null)?.close();
      }
      if (head.filename === null) fields.push([head.name, Buffer.concat(kept).toString('utf8')]);
      else
        files.push({ name: head.name, filename: head.filename, type: head.type, file: filePath });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await cleanup();
    if (error instanceof Refusal) return { ok: false, error: error.code };
    return { ok: false, error: 'FORM_UNREADABLE' };
  }

  // The form, as a browser built it: text fields as strings, files backed by the disk.
  const form = new FormData();
  try {
    for (const [name, value] of fields) form.append(name, value);
    for (const part of files) {
      const blob = part.file ? await openAsBlob(part.file, { type: part.type }) : new Blob([]);
      form.append(part.name, new File([blob], part.filename, { type: part.type }));
    }
  } catch {
    await cleanup();
    return { ok: false, error: 'FORM_UNREADABLE' };
  }
  return { ok: true, form, cleanup };
}
