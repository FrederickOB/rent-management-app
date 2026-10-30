import {
  PROPERTY_PAPER_MAX_BYTES,
  PROPERTY_PAPER_TYPES,
  PROPERTY_PHOTO_MAX_BYTES,
  PROPERTY_PHOTO_TYPES,
  REGISTER_IMPORT_MAX_BYTES,
  XLSX_CONTENT_TYPE,
} from '@rent/domain/portfolio';

/** A presigned POST from the API: the storage URL and the policy fields it signed. */
export interface PresignedPost {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Storage refused the file (expired link, wrong type or size); the API never saw it. */
export class StorageUploadError extends Error {
  constructor() {
    super('The file could not be uploaded to storage. Try again.');
    this.name = 'StorageUploadError';
  }
}

/**
 * Sends a file straight to storage with a presigned POST (CLAUDE.md section 10), so files never
 * pass through the API. Storage expects the policy fields first and the file last; no cookies go.
 */
export async function sendToStorage(
  slot: PresignedPost,
  file: Blob,
  send: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', file);
  const response = await send(slot.url, { method: 'POST', body: form, credentials: 'omit' });
  if (!response.ok) throw new StorageUploadError();
}

/** What a kind of upload accepts. The limits come from packages/domain; the API checks again. */
export interface UploadRule {
  readonly types: readonly string[];
  readonly maxBytes: number;
  /** File name endings the picker offers, for types browsers do not always name (.xlsx). */
  readonly extensions?: readonly string[];
  /** How to ask for the right file, when "a JPEG or PNG file" does not read well. */
  readonly noun?: string;
}

export const PHOTO_UPLOAD: UploadRule = {
  types: PROPERTY_PHOTO_TYPES,
  maxBytes: PROPERTY_PHOTO_MAX_BYTES,
};
export const PAPER_UPLOAD: UploadRule = {
  types: PROPERTY_PAPER_TYPES,
  maxBytes: PROPERTY_PAPER_MAX_BYTES,
};
export const REGISTER_IMPORT_UPLOAD: UploadRule = {
  types: [XLSX_CONTENT_TYPE],
  maxBytes: REGISTER_IMPORT_MAX_BYTES,
  extensions: ['.xlsx'],
  noun: 'an Excel workbook (.xlsx)',
};

const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
  [XLSX_CONTENT_TYPE]: 'Excel (.xlsx)',
};

/** `JPEG, PNG or WebP` for the types a rule accepts. */
export function fileTypesLabel(rule: UploadRule): string {
  const names = rule.types.map((type) => TYPE_NAMES[type] ?? type);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
    : (names[0] ?? '');
}

const megabytes = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** `10 MB` for a size limit, in the decimal megabytes the limits are set in. */
export function sizeLabel(bytes: number): string {
  return `${megabytes.format(bytes / 1_000_000)} MB`;
}

/** The picker's `accept` attribute for a rule. */
export function acceptFor(rule: UploadRule): string {
  return [...(rule.extensions ?? []), ...rule.types].join(',');
}

/**
 * Why a chosen file cannot be uploaded, or null. Checked before anything is sent, so a wrong
 * file gets a clear answer at once; a file with no type (some systems give none for .xlsx) is
 * judged by its name when the rule lists extensions.
 */
export function fileProblem(
  file: { readonly name: string; readonly type: string; readonly size: number },
  rule: UploadRule,
): string | null {
  const byName = rule.extensions?.some((ext) => file.name.toLowerCase().endsWith(ext)) ?? false;
  const byType = rule.types.includes(file.type);
  if (!(rule.extensions ? byName : byType))
    return `Choose ${rule.noun ?? `a ${fileTypesLabel(rule)} file`}.`;
  if (file.size === 0) return 'That file is empty.';
  if (file.size > rule.maxBytes) return `The file must be ${sizeLabel(rule.maxBytes)} or smaller.`;
  return null;
}
