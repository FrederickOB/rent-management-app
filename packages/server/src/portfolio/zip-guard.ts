import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const DATA_DESCRIPTOR = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
/** Signature, CRC-32 and two 4-byte sizes: the data descriptor the workbook reader expects. */
const DATA_DESCRIPTOR_LENGTH = 16;

/** The end-of-central-directory record, or null if the file is not a zip. */
function endOfDirectory(file: Buffer): number | null {
  if (file.length < 22) return null;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i -= 1) {
    if (file.readUInt32LE(i) === END_OF_DIRECTORY) return i;
  }
  return null;
}

/**
 * The total uncompressed size a zip file declares, from its central directory, so a zip bomb is
 * refused before any of it is inflated (PR-08 import safety). Null if the file is not a zip.
 * Zip64 archives report an unbounded size; an .xlsx under our upload limit never needs zip64.
 * A crafted file can understate these sizes, so inflatedSize checks the real ones next.
 */
export function declaredUncompressedSize(file: Buffer): number | null {
  const end = endOfDirectory(file);
  if (end === null) return null;
  const entries = file.readUInt16LE(end + 10);
  const directorySize = file.readUInt32LE(end + 12);
  const directoryOffset = file.readUInt32LE(end + 16);
  if (directoryOffset + directorySize > file.length) return null;
  let position = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (position + 46 > file.length || file.readUInt32LE(position) !== DIRECTORY_ENTRY) return null;
    const uncompressed = file.readUInt32LE(position + 24);
    if (uncompressed === ZIP64_MARKER) return Number.MAX_SAFE_INTEGER;
    total += uncompressed;
    position +=
      46 +
      file.readUInt16LE(position + 28) +
      file.readUInt16LE(position + 30) +
      file.readUInt16LE(position + 32);
  }
  return total;
}

export type ZipCheck =
  | { readonly ok: true; readonly uncompressedBytes: number }
  | { readonly ok: false; readonly problem: 'not_zip' | 'too_large' | 'unsupported' };

interface Entry {
  readonly name: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/** The central directory's entries, or a problem. */
function directory(file: Buffer): Entry[] | ZipCheck {
  const end = endOfDirectory(file);
  if (end === null) return { ok: false, problem: 'not_zip' };
  const count = file.readUInt16LE(end + 10);
  const directorySize = file.readUInt32LE(end + 12);
  const directoryOffset = file.readUInt32LE(end + 16);
  if (directoryOffset === ZIP64_MARKER || count === 0xffff)
    return { ok: false, problem: 'unsupported' };
  if (directoryOffset + directorySize > end) return { ok: false, problem: 'not_zip' };
  const entries: Entry[] = [];
  let position = directoryOffset;
  for (let n = 0; n < count; n += 1) {
    if (position + 46 > end || file.readUInt32LE(position) !== DIRECTORY_ENTRY)
      return { ok: false, problem: 'not_zip' };
    const nameLength = file.readUInt16LE(position + 28);
    const entry: Entry = {
      flags: file.readUInt16LE(position + 8),
      method: file.readUInt16LE(position + 10),
      compressedSize: file.readUInt32LE(position + 20),
      localOffset: file.readUInt32LE(position + 42),
      name: file.subarray(position + 46, position + 46 + nameLength),
    };
    if (entry.compressedSize === ZIP64_MARKER || entry.localOffset === ZIP64_MARKER)
      return { ok: false, problem: 'unsupported' };
    if (entry.flags & ENCRYPTED_FLAG) return { ok: false, problem: 'unsupported' };
    if (entry.method !== STORED && entry.method !== DEFLATED)
      return { ok: false, problem: 'unsupported' };
    entries.push(entry);
    position +=
      46 + nameLength + file.readUInt16LE(position + 30) + file.readUInt16LE(position + 32);
  }
  return entries;
}

/**
 * Inflates every entry of a zip and refuses it once the real uncompressed total passes `limit`
 * (PR-08 zip-bomb guard). Inflation stops at the limit, so a bomb never fills memory; stored
 * entries count as they are.
 *
 * The workbook reader (unzipper) streams the file from its first byte and trusts the local
 * headers, not the central directory, so the check also refuses any layout where the two could
 * see different entries: entries that overlap, bytes hidden between entries, a local header that
 * names another entry, method or size, or a deflate stream that ends before its entry does. An
 * entry whose size comes only from a data descriptor must end exactly where the reader will look
 * for that descriptor.
 */
export function inflatedSize(file: Buffer, limit: number): ZipCheck {
  const listed = directory(file);
  if (!Array.isArray(listed)) return listed;
  const directoryOffset = file.readUInt32LE(endOfDirectory(file)! + 16);
  const entries = [...listed].sort((a, b) => a.localOffset - b.localOffset);
  let total = 0;
  // Where the next local header must start: the reader reads one record after another.
  let expected = 0;
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at !== expected) return { ok: false, problem: 'unsupported' };
    if (at + 30 > directoryOffset || file.readUInt32LE(at) !== LOCAL_HEADER)
      return { ok: false, problem: 'not_zip' };
    const localFlags = file.readUInt16LE(at + 6);
    const localSize = file.readUInt32LE(at + 18);
    const localNameLength = file.readUInt16LE(at + 26);
    const localExtraLength = file.readUInt16LE(at + 28);
    const name = file.subarray(at + 30, at + 30 + localNameLength);
    // As the reader decides: the local size counts unless it is zero behind a descriptor flag.
    const sizeFromDescriptor = (localFlags & DATA_DESCRIPTOR_FLAG) !== 0 && localSize === 0;
    if (
      file.readUInt16LE(at + 8) !== entry.method ||
      !name.equals(entry.name) ||
      (!sizeFromDescriptor && localSize !== entry.compressedSize)
    )
      return { ok: false, problem: 'unsupported' };
    const start = at + 30 + localNameLength + localExtraLength;
    const finish = start + entry.compressedSize;
    if (finish > directoryOffset) return { ok: false, problem: 'not_zip' };
    const data = file.subarray(start, finish);
    if (sizeFromDescriptor) {
      // The reader ends the entry at the first descriptor signature it meets.
      if (
        data.includes(DATA_DESCRIPTOR) ||
        !file.subarray(finish, finish + 4).equals(DATA_DESCRIPTOR)
      )
        return { ok: false, problem: 'unsupported' };
    }
    if (entry.method === STORED) total += data.length;
    else {
      let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
      try {
        inflated = inflateRawSync(data, {
          info: true,
          maxOutputLength: Math.max(1, limit - total + 1),
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      } catch (error) {
        if (error instanceof RangeError) return { ok: false, problem: 'too_large' };
        return { ok: false, problem: 'not_zip' };
      }
      if (inflated.engine.bytesWritten !== data.length)
        return { ok: false, problem: 'unsupported' };
      total += inflated.buffer.length;
    }
    if (total > limit) return { ok: false, problem: 'too_large' };
    expected = finish + (sizeFromDescriptor ? DATA_DESCRIPTOR_LENGTH : 0);
  }
  if (directoryOffset !== expected) return { ok: false, problem: 'unsupported' };
  return { ok: true, uncompressedBytes: total };
}
