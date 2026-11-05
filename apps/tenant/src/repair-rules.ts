import type { TenantRepairView } from '@rent/contracts';
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  MEDIA_MAX_FILES_PER_REQUEST,
  MEDIA_RULES,
  mediaKindOf,
  sniffContentType,
  type MaintenanceCategory,
} from '@rent/domain/maintenance';
import { formatTime } from './format';
import type { UploadPart } from './upload';

// Repair requests in the tenant app (MI-01; M8 decisions 2 and 3): what a tenant may attach, in
// words for them. The limits are the domain's (MEDIA_RULES), checked here before upload; the
// server checks every file again from its first bytes.

export type RepairFileKind = 'image' | 'video' | 'audio';

/** A file attached to a repair request. */
export interface RepairFile {
  /** Its id within the request. */
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Video and voice notes: how long, in seconds. */
  readonly durationSeconds: number | null;
  readonly kind: RepairFileKind;
  /** The bytes: a file kept on the phone, or on the web the browser's file (null once lost). */
  readonly part: UploadPart | null;
  /** Set once storage has it. */
  readonly uploadId: string | null;
}

/** A file just chosen, recorded or taken, before it is checked and kept. */
export interface ChosenMedia {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number | null;
  readonly part: UploadPart;
}

export const MAX_FILES = MEDIA_MAX_FILES_PER_REQUEST;

export const CATEGORY_CHOICES: readonly { value: MaintenanceCategory; label: string }[] =
  MAINTENANCE_CATEGORIES.map((value) => ({ value, label: MAINTENANCE_CATEGORY_LABELS[value] }));

const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
};

/** Names some platforms give the same types. */
const ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-aac': 'audio/aac',
  'audio/3gpp': 'video/3gpp',
};

/** A file's type: as given, with the usual aliases, or else from its name. */
export function mediaTypeOf(
  given: string | null | undefined,
  name: string | null | undefined,
): string {
  const declared = given?.toLowerCase().split(';')[0]?.trim();
  if (declared) return ALIASES[declared] ?? declared;
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(name ?? '')?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || 'application/octet-stream';
}

/**
 * The type the server will read from the file's first bytes, when they show one this product
 * takes; otherwise the declared type stands (and the server refuses it).
 */
export function typeFromBytes(head: Uint8Array | null, declared: string): string {
  const sniffed = head ? sniffContentType(head) : null;
  return sniffed && mediaKindOf(sniffed) ? sniffed : declared;
}

const NOUNS: Readonly<Record<RepairFileKind, string>> = {
  image: 'photo',
  video: 'video',
  audio: 'voice note',
};

/** "90 seconds", "3 minutes". */
export function secondsLabel(seconds: number): string {
  if (seconds % 60 === 0) return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** "1:05", for a recording's length. */
export function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The kind a file is, or why it cannot be sent (decision 2's limits), in words for the tenant. */
export function checkRepairFile(
  file: Pick<ChosenMedia, 'contentType' | 'sizeBytes' | 'durationSeconds'>,
): { ok: true; kind: RepairFileKind } | { ok: false; problem: string } {
  const kind = mediaKindOf(file.contentType);
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio')
    return {
      ok: false,
      problem:
        'This kind of file cannot be sent. Send a photo (JPEG, PNG or WebP), a video (MP4, MOV or 3GP) or a voice note.',
    };
  const rule = MEDIA_RULES[kind];
  const noun = NOUNS[kind];
  if (file.sizeBytes <= 0) return { ok: false, problem: `That ${noun} is empty. Choose another.` };
  if (file.sizeBytes > rule.maxBytes)
    return {
      ok: false,
      problem: `That ${noun} is too big: at most ${rule.maxBytes / 1_000_000} MB.`,
    };
  if (rule.maxSeconds !== undefined) {
    if (file.durationSeconds === null || !(file.durationSeconds > 0))
      return { ok: false, problem: `We could not tell how long that ${noun} is. Choose it again.` };
    if (file.durationSeconds > rule.maxSeconds)
      return {
        ok: false,
        problem: `That ${noun} is too long: at most ${secondsLabel(rule.maxSeconds)}.`,
      };
  }
  return { ok: true, kind };
}

/** "Photo", "Video", "Voice note", with its size or length. */
export function fileLabel(
  file: Pick<RepairFile, 'kind' | 'sizeBytes' | 'durationSeconds'>,
): string {
  const noun = NOUNS[file.kind];
  const name = `${noun[0]!.toUpperCase()}${noun.slice(1)}`;
  if (file.durationSeconds !== null && file.kind !== 'image')
    return `${name} (${clockLabel(file.durationSeconds)})`;
  const tenths = Math.ceil(file.sizeBytes / 100_000);
  return file.sizeBytes < 1_000_000
    ? `${name} (${Math.max(1, Math.ceil(file.sizeBytes / 1_000))} KB)`
    : `${name} (${Math.floor(tenths / 10)}.${tenths % 10} MB)`;
}

const STEP_WORDS: Readonly<Record<TenantRepairView['steps'][number]['kind'], string>> = {
  reported: 'Reported',
  assigned: 'Someone is assigned',
  visit_planned: 'Visit planned',
  started: 'Work started',
  work_done: 'Work done',
  confirmed: 'You confirmed it',
  disputed: 'You said something is still wrong',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** "Work done, 5 Nov 2026, 14:20 GMT (Africa/Accra)". */
export const stepLabel = (step: TenantRepairView['steps'][number]): string =>
  `${STEP_WORDS[step.kind]}, ${formatTime(step.at)}`;
