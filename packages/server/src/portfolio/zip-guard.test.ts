import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { declaredUncompressedSize, inflatedSize } from './zip-guard';

const LIMIT = 50_000_000;

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  /** Stored (0) or deflated (8). */
  readonly method?: 0 | 8;
  /** The uncompressed size the headers claim. */
  readonly declared?: number;
  /** Write a zero local size and a data descriptor after the data. */
  readonly descriptor?: boolean;
}

/** A minimal zip writer, so a test can make the archives a real writer never would. */
function zip(entries: readonly ZipEntry[], options: { hidden?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const declared = entry.declared ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.descriptor ? 0x0008 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(entry.descriptor ? 0 : declared, 22);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(declared, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.descriptor ? 0x0008 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body, descriptor);
    centrals.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const hidden = options.hidden ?? Buffer.alloc(0);
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset + hidden.length, 16);
  return Buffer.concat([...locals, hidden, directory, end]);
}

const xml = (text: string) => Buffer.from(`<?xml version="1.0"?><x>${text}</x>`);

describe('PR-08 import zip-bomb guard', () => {
  it('measures real workbooks: the template writer and the end-to-end fixtures', async () => {
    const generated = await writeXlsxFile([
      { sheet: 'Units', data: [[{ value: 'Property code' }], [{ value: 'ACC-LEG' }]] },
    ]).toBuffer();
    const fixtures = path.resolve(import.meta.dirname, '../../../../apps/web/e2e/fixtures');
    for (const file of [
      generated,
      readFileSync(path.join(fixtures, 'register-import-good.xlsx')),
      readFileSync(path.join(fixtures, 'register-import-malformed.xlsx')),
    ]) {
      const result = inflatedSize(file, LIMIT);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.uncompressedBytes).toBe(declaredUncompressedSize(file));
    }
  });

  it('refuses a file whose declared sizes are small but which inflates past the limit', () => {
    const bomb = zip([
      { name: '[Content_Types].xml', data: xml('types') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(60_000_000, 0x20), declared: 100 },
    ]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(declaredUncompressedSize(bomb)).toBeLessThan(1_000);
    expect(inflatedSize(bomb, LIMIT)).toEqual({ ok: false, problem: 'too_large' });
  });

  it('adds every entry up, counting stored entries as they are', () => {
    const half = Buffer.alloc(30_000_000, 0x41);
    expect(
      inflatedSize(
        zip([
          { name: 'a.xml', data: half, declared: 1 },
          { name: 'b.xml', data: half, method: 0, declared: 1 },
        ]),
        LIMIT,
      ),
    ).toEqual({ ok: false, problem: 'too_large' });
    expect(
      inflatedSize(
        zip([
          { name: 'a.xml', data: xml('one') },
          { name: 'b.xml', data: xml('two'), method: 0 },
        ]),
        LIMIT,
      ),
    ).toEqual({ ok: true, uncompressedBytes: xml('one').length + xml('two').length });
  });

  it('accepts entries sized by data descriptors, as streaming writers make them', () => {
    const file = zip([
      { name: 'a.xml', data: xml('one'), descriptor: true },
      { name: 'b.xml', data: xml('two'), descriptor: true },
    ]);
    expect(inflatedSize(file, LIMIT)).toMatchObject({ ok: true });
  });

  it('refuses an entry hidden from the central directory, which a streaming reader would inflate', () => {
    const hiddenBomb = zip([{ name: 'xl/worksheets/sheet2.xml', data: Buffer.alloc(9_000_000) }]);
    const local = hiddenBomb.subarray(0, hiddenBomb.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
    // The hidden entry sits between the listed entry and the central directory.
    expect(
      inflatedSize(zip([{ name: 'a.xml', data: xml('one') }], { hidden: local }), LIMIT),
    ).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('refuses entries that share their data, a way to multiply a small file', () => {
    const file = zip([{ name: 'a.xml', data: xml('one') }]);
    const centralAt = file.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    const central = file.subarray(centralAt, file.length - 22);
    const end = Buffer.from(file.subarray(file.length - 22));
    end.writeUInt16LE(2, 8);
    end.writeUInt16LE(2, 10);
    end.writeUInt32LE(central.length * 2, 12);
    const twice = Buffer.concat([file.subarray(0, centralAt), central, central, end]);
    expect(inflatedSize(twice, LIMIT)).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('refuses a local header whose size differs from the central directory', () => {
    const file = zip([{ name: 'a.xml', data: xml('one') }]);
    file.writeUInt32LE(3, 18);
    expect(inflatedSize(file, LIMIT)).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('refuses what is not a zip, and methods it cannot inflate', () => {
    expect(inflatedSize(Buffer.from('plain text, not a zip at all'), LIMIT)).toEqual({
      ok: false,
      problem: 'not_zip',
    });
    const file = zip([{ name: 'a.xml', data: xml('one') }]);
    const centralAt = file.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    file.writeUInt16LE(14, centralAt + 10); // LZMA
    expect(inflatedSize(file, LIMIT)).toEqual({ ok: false, problem: 'unsupported' });
  });
});
