import { DomainError } from '../errors';

/**
 * Media for repairs, inspections and expenses (MI-01, MI-06, MI-10; M8 decision 2): product limits,
 * not law, held here once. A file's type is read from its first bytes, never from its name or the
 * type the client declared; there is no transcoding.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface MediaKindRule {
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  /** Video and voice notes: the longest the app may send. */
  readonly maxSeconds?: number;
}

const MB = 1_000_000;

export const MEDIA_RULES: Readonly<Record<MediaKind, MediaKindRule>> = {
  // HEIC arrives as JPEG: the app converts it, so the server never needs a HEIC decoder.
  image: { contentTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * MB },
  video: {
    contentTypes: ['video/mp4', 'video/quicktime', 'video/3gpp'],
    maxBytes: 50 * MB,
    maxSeconds: 90,
  },
  audio: {
    contentTypes: ['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/amr'],
    maxBytes: 10 * MB,
    maxSeconds: 180,
  },
  // Receipts for expenses (AC-03).
  document: { contentTypes: ['application/pdf'], maxBytes: 10 * MB },
};

/** At most this many files in one repair request (decision 2). */
export const MEDIA_MAX_FILES_PER_REQUEST = 10;

/** How many leading bytes the sniffer reads. */
export const MEDIA_SNIFF_BYTES = 64;

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

const starts = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);

/** ISO base media brands (`ftyp`): which kind each brand is. */
const BRANDS: Readonly<Record<string, string>> = {
  'qt  ': 'video/quicktime',
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso4: 'video/mp4',
  iso5: 'video/mp4',
  iso6: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  dash: 'video/mp4',
  MSNV: 'video/mp4',
  'M4V ': 'video/mp4',
  'M4A ': 'audio/mp4',
  'M4B ': 'audio/mp4',
  heic: 'image/heic',
  heix: 'image/heic',
  mif1: 'image/heic',
};

/**
 * The content type a file's first bytes show, or null for anything this product does not take.
 * JPEG, PNG, WebP, PDF, ISO base media (MP4, MOV, 3GP, M4A; HEIC is recognised and refused), MP3,
 * AAC (ADTS), Ogg and AMR.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return 'video/3gpp';
    return BRANDS[brand] ?? null;
  }
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 6) === '#!AMR\n') return 'audio/amr';
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    const b1 = bytes[1]!;
    // ADTS (AAC): sync 0xFFF, layer 00.
    if ((b1 & 0xf6) === 0xf0) return 'audio/aac';
    // An MPEG audio frame (MP3 without an ID3 tag): sync 0xFFE, layer III.
    if ((b1 & 0xe0) === 0xe0 && (b1 & 0x06) === 0x02) return 'audio/mpeg';
  }
  return null;
}

/** The kind a content type belongs to, or null when no rule takes it. */
export function mediaKindOf(contentType: string): MediaKind | null {
  for (const [kind, rule] of Object.entries(MEDIA_RULES) as [MediaKind, MediaKindRule][])
    if (rule.contentTypes.includes(contentType)) return kind;
  return null;
}

/**
 * A file as declared when its upload is asked for: the kinds the purpose takes, its type, size
 * and (video, audio) length. The bytes are checked again when the upload is staged.
 */
export function checkDeclaredMedia(input: {
  readonly kinds: readonly MediaKind[];
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly durationSeconds?: number | null;
}): MediaKind {
  const kind = mediaKindOf(input.contentType);
  if (!kind || !input.kinds.includes(kind))
    throw new DomainError('media.type_not_allowed', 'This kind of file cannot be added here');
  const rule = MEDIA_RULES[kind];
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1)
    throw new DomainError('media.empty', 'The file is empty');
  if (input.sizeBytes > rule.maxBytes)
    throw new DomainError(
      'media.too_large',
      `A ${kind === 'document' ? 'document' : kind} can be at most ${rule.maxBytes / MB} MB`,
    );
  if (rule.maxSeconds !== undefined) {
    const seconds = input.durationSeconds;
    if (seconds === null || seconds === undefined || !(seconds > 0))
      throw new DomainError('media.duration_required', 'Say how long the recording is');
    if (seconds > rule.maxSeconds)
      throw new DomainError(
        'media.too_long',
        kind === 'video'
          ? `A video can be at most ${rule.maxSeconds} seconds`
          : `A voice note can be at most ${rule.maxSeconds / 60} minutes`,
      );
  }
  return kind;
}

/**
 * The staged bytes against what was declared: the first bytes must show a type this purpose takes,
 * of the same kind as declared (a renamed file is refused), and the stored size within the limit.
 */
export function checkStagedMedia(input: {
  readonly kinds: readonly MediaKind[];
  readonly declaredType: string;
  readonly head: Uint8Array;
  readonly sizeBytes: number;
}): { readonly kind: MediaKind; readonly contentType: string } {
  const sniffed = sniffContentType(input.head);
  const kind = sniffed ? mediaKindOf(sniffed) : null;
  if (!sniffed || !kind || !input.kinds.includes(kind))
    throw new DomainError('media.type_mismatch', 'The file is not a kind this accepts');
  if (kind !== mediaKindOf(input.declaredType))
    throw new DomainError('media.type_mismatch', 'The file is not the kind of file it was named');
  if (input.sizeBytes < 1 || input.sizeBytes > MEDIA_RULES[kind].maxBytes)
    throw new DomainError('media.too_large', 'The file is larger than it may be');
  return { kind, contentType: sniffed };
}
