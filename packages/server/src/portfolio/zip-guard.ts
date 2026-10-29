/**
 * The total uncompressed size a zip file declares, from its central directory, so a zip bomb is
 * refused before any of it is inflated (PR-08 import safety). Null if the file is not a zip.
 * Zip64 archives report an unbounded size; an .xlsx under our upload limit never needs zip64.
 */
export function declaredUncompressedSize(file: Buffer): number | null {
  const END_OF_DIRECTORY = 0x06054b50;
  const DIRECTORY_ENTRY = 0x02014b50;
  if (file.length < 22) return null;
  let end = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i -= 1) {
    if (file.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = file.readUInt16LE(end + 10);
  const directorySize = file.readUInt32LE(end + 12);
  const directoryOffset = file.readUInt32LE(end + 16);
  if (directoryOffset + directorySize > file.length) return null;
  let position = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (position + 46 > file.length || file.readUInt32LE(position) !== DIRECTORY_ENTRY) return null;
    const uncompressed = file.readUInt32LE(position + 24);
    if (uncompressed === 0xffffffff) return Number.MAX_SAFE_INTEGER;
    total += uncompressed;
    position +=
      46 +
      file.readUInt16LE(position + 28) +
      file.readUInt16LE(position + 30) +
      file.readUInt16LE(position + 32);
  }
  return total;
}
