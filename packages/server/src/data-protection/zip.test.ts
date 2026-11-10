import { randomBytes } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipArchive } from './zip';

/** Reads an archive back from its central directory, as an unzip tool would. */
function unzip(file: Buffer): { name: string; bytes: Buffer }[] {
  let end = file.length - 22;
  while (end >= 0 && file.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const out: { name: string; bytes: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(file.readUInt32LE(at)).toBe(0x02014b50);
    const method = file.readUInt16LE(at + 10);
    const crc = file.readUInt32LE(at + 16);
    const size = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const local = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(file.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const data = file.subarray(start, start + size);
    const bytes = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(bytes)).toBe(crc);
    out.push({ name, bytes });
    at += 46 + nameLength;
  }
  return out;
}

describe('NFR-DP the export archive (M11 decision 5)', () => {
  it('holds every entry exactly, compressed where that helps, readable by a zip reader', () => {
    const text = Buffer.from('Profile\nName,Ama\n'.repeat(200));
    const noise = randomBytes(4096);
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const archive = zipArchive([
      { name: 'personal-data.xlsx', bytes: text },
      { name: 'leases/ACC-LEG-B2-04-2026-01-01-signed.pdf', bytes: pdf },
      { name: 'receipts/receipt-000001.pdf', bytes: noise },
    ]);
    const entries = unzip(archive);
    expect(entries.map((e) => e.name)).toEqual([
      'personal-data.xlsx',
      'leases/ACC-LEG-B2-04-2026-01-01-signed.pdf',
      'receipts/receipt-000001.pdf',
    ]);
    expect(entries[0]!.bytes.equals(text)).toBe(true);
    expect(entries[1]!.bytes.equals(pdf)).toBe(true);
    expect(entries[2]!.bytes.equals(noise)).toBe(true);
    // Text shrinks; random bytes are stored as they are rather than grown.
    expect(archive.length).toBeLessThan(text.length + pdf.length + noise.length + 600);
    // The same entries always give the same bytes (no times inside).
    expect(
      zipArchive([{ name: 'a.txt', bytes: text }]).equals(
        zipArchive([{ name: 'a.txt', bytes: text }]),
      ),
    ).toBe(true);
  });

  it('refuses names that could leave the archive’s folder, and the same name twice', () => {
    const bytes = Buffer.from('x');
    expect(() => zipArchive([{ name: '../etc/passwd', bytes }])).toThrow();
    expect(() => zipArchive([{ name: '/abs.txt', bytes }])).toThrow();
    expect(() => zipArchive([{ name: '', bytes }])).toThrow();
    expect(() =>
      zipArchive([
        { name: 'a.pdf', bytes },
        { name: 'a.pdf', bytes },
      ]),
    ).toThrow();
    expect(unzip(zipArchive([]))).toEqual([]);
  });
});
