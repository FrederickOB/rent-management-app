import { crc32, deflateRawSync } from 'node:zlib';

/** A file in the archive: a plain relative name (no folders above it) and its bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const DIRECTORY_ENTRY = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const DEFLATED = 8;
const STORED = 0;
/** Bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800;
const VERSION = 20;
/** The archive stays well inside the classic format: no zip64. */
const LIMIT = 0xffffffff;

/** 1980-01-01 00:00, the format's earliest date: entries carry no time, so the bytes repeat. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * A ZIP archive of the entries (PKWARE APPNOTE, classic format), each deflated unless that makes
 * it larger. Built in memory: a tenant's export is a workbook and some PDFs. No new dependency:
 * Node's zlib gives deflate and CRC-32.
 */
export function zipArchive(entries: readonly ZipEntry[]): Buffer {
  const names = new Set<string>();
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..'))
      throw new Error('A zip entry needs a plain relative name');
    if (names.has(entry.name)) throw new Error('Each zip entry needs its own name');
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.bytes);
    const stored = deflated.length >= entry.bytes.length;
    const data = stored ? entry.bytes : deflated;
    const crc = crc32(entry.bytes);
    if (data.length >= LIMIT || entry.bytes.length >= LIMIT || offset >= LIMIT)
      throw new Error('The archive is too large for the classic zip format');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? STORED : DEFLATED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(DIRECTORY_ENTRY, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? STORED : DEFLATED, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk, internal and external attributes: none.
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directoryBytes = Buffer.concat(directory);
  if (entries.length > 0xffff) throw new Error('Too many entries for the classic zip format');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}
