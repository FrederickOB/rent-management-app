import { schema, sql, withCompany } from '@rent/db';
import readXlsxFile from 'read-excel-file/node';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { OwnersService } from '../src/companies/owners.service';
import { DocumentsService } from '../src/documents/documents.service';
import { PolicyService } from '../src/policy/policy.service';
import { MetersService } from '../src/portfolio/meters.service';
import { PropertyFilesService } from '../src/portfolio/property-files.service';
import { RegisterImportService } from '../src/portfolio/register-import.service';
import { RegisterReadService } from '../src/portfolio/register-read.service';
import { RegisterService } from '../src/portfolio/register.service';
import { RulesService } from '../src/rules/rules.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let files: PropertyFilesService;
let imports: RegisterImportService;
let register: RegisterService;
let read: RegisterReadService;
let owners: OwnersService;

let agencyId: string;
let manager: ReturnType<typeof staff>;
let caretaker: ReturnType<typeof staff>;
let clientOwnerB: ReturnType<typeof staff>;
let ownerA: string;
let propertyId: string;

async function staffIn(role: Parameters<typeof staff>[4], name: string) {
  const personId = await person(ctx, name);
  return staff(agencyId, 'agency', personId, await member(ctx, agencyId, personId, role), role);
}

/** Puts bytes where the presigned upload would, as the browser does. */
async function upload(fields: Record<string, string>, body: Buffer, contentType: string) {
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: fields.key ?? fields.Key!,
    body,
    contentType,
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  const policy = new PolicyService();
  const documents = new DocumentsService(
    ctx.database,
    ctx.storage,
    ctx.config,
    ctx.clock,
    ctx.audit,
    new RulesService(ctx.database),
  );
  owners = new OwnersService(ctx.database, policy);
  register = new RegisterService(ctx.database, policy, owners, ctx.clock, null);
  read = new RegisterReadService(ctx.database, policy);
  const meters = new MetersService(ctx.database, policy);
  files = new PropertyFilesService(
    ctx.database,
    policy,
    documents,
    ctx.storage,
    ctx.config,
    ctx.clock,
  );
  imports = new RegisterImportService(
    ctx.database,
    policy,
    documents,
    register,
    meters,
    owners,
    ctx.storage,
    ctx.config,
    ctx.clock,
  );
  agencyId = await company(ctx, 'agency', 'Files Agency');
  const admin = await staffIn('agency_admin', 'Admin');
  manager = await staffIn('property_manager', 'Manager');
  ownerA = (
    await owners.create(admin, { kind: 'individual', displayName: 'Owner A', reference: 'OWN-A' })
  ).id;
  const ownerB = (
    await owners.create(admin, { kind: 'individual', displayName: 'Owner B', reference: 'OWN-B' })
  ).id;
  propertyId = await register.createProperty(manager, {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    name: 'East Legon flats',
    propertyType: 'apartment_block',
    use: 'residential',
    ownerId: ownerA,
    address: { region: 'Greater Accra' },
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const care = await staffIn('caretaker', 'Caretaker');
  caretaker = { ...care, scope: { properties: [propertyId] } };
  const client = await staffIn('owner', 'Client B');
  clientOwnerB = { ...client, scope: { owners: [ownerB] } };
});

afterAll(async () => {
  await ctx.close();
});

describe('PR-04 property files', () => {
  it('refuses the wrong type or size before anything is uploaded', async () => {
    await expect(
      files.createUpload(manager, propertyId, {
        category: 'photo',
        contentType: 'image/gif',
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'upload_type' });
    await expect(
      files.createUpload(manager, propertyId, {
        category: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: 11_000_000,
      }),
    ).rejects.toMatchObject({ code: 'upload_size' });
    await expect(
      files.createUpload(caretaker, propertyId, {
        category: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('re-encodes a photo without its location data, keeps a thumbnail, and deletes the original', async () => {
    const photo = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: '#887766' },
    })
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '5/1 39/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const intent = await files.createUpload(manager, propertyId, {
      category: 'photo',
      contentType: 'image/jpeg',
      sizeBytes: photo.length,
    });
    await upload(intent.fields, photo, 'image/jpeg');
    const confirmed = await files.confirmUpload(manager, propertyId, {
      uploadId: intent.uploadId,
      category: 'photo',
      caption: 'Front of the building',
      fileName: 'IMG_0001.jpg',
    });
    expect(confirmed.status).toBe('processing');
    await files.process(agencyId, confirmed.id);
    await files.process(agencyId, confirmed.id); // a replayed job changes nothing
    const [listed] = await files.list(manager, propertyId);
    expect(listed).toMatchObject({
      status: 'ready',
      category: 'photo',
      caption: 'Front of the building',
    });
    expect(listed!.thumbnailUrl).toBeTruthy();
    const documents = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.document)
          .where(sql`${schema.document.kind} like 'property_photo%'`),
    );
    expect(documents.map((d) => d.kind).sort()).toEqual([
      'property_photo',
      'property_photo_thumbnail',
    ]);
    for (const d of documents) {
      const bytes = await ctx.storage.get({ bucket: d.bucket, key: d.storageKey });
      const meta = await sharp(bytes).metadata();
      expect(meta.exif, d.kind).toBeUndefined();
      expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(
        d.kind === 'property_photo' ? 1600 : 400,
      );
    }
    const original = await ctx.storage.head({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: intent.fields.key ?? intent.fields.Key!,
    });
    expect(original).toBeNull();
  });

  it('marks a file whose bytes do not match the declared type as failed', async () => {
    const intent = await files.createUpload(manager, propertyId, {
      category: 'photo',
      contentType: 'image/jpeg',
      sizeBytes: 20,
    });
    await upload(intent.fields, Buffer.from('%PDF-1.7 not a photo'), 'image/jpeg');
    const confirmed = await files.confirmUpload(manager, propertyId, {
      uploadId: intent.uploadId,
      category: 'photo',
    });
    await files.process(agencyId, confirmed.id);
    const failed = (await files.list(manager, propertyId)).find((f) => f.id === confirmed.id);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/declared/) });
  });

  it('shows papers to permitted users only: not caretakers, not other owners', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const intent = await files.createUpload(manager, propertyId, {
      category: 'title_or_indenture',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    });
    await upload(intent.fields, pdf, 'application/pdf');
    const paper = await files.confirmUpload(manager, propertyId, {
      uploadId: intent.uploadId,
      category: 'title_or_indenture',
    });
    await files.process(agencyId, paper.id);
    expect(await files.downloadUrl(manager, paper.id)).toMatch(/^memory:|^https?:/);
    const caretakerSees = await files.list(caretaker, propertyId);
    expect(caretakerSees.map((f) => f.category)).not.toContain('title_or_indenture');
    expect(caretakerSees.some((f) => f.category === 'photo')).toBe(true);
    await expect(files.downloadUrl(caretaker, paper.id)).rejects.toMatchObject({ status: 403 });
    await expect(files.list(clientOwnerB, propertyId)).rejects.toMatchObject({ status: 404 });
    await expect(files.downloadUrl(clientOwnerB, paper.id)).rejects.toMatchObject({ status: 404 });
  });
});

const PROPERTY_HEADERS = [
  'Property code',
  'Name',
  'Property type',
  'Use',
  'Owner reference',
  'GhanaPost GPS',
  'Region',
  'Town',
];
const UNIT_HEADERS = [
  'Property code',
  'Block code',
  'Unit',
  'Unit type',
  'Bedrooms',
  'Amenities',
  'Availability',
  'Water meter',
  'Water meter type',
];

const workbook = (properties: unknown[][], units: unknown[][]) =>
  writeXlsxFile([
    {
      sheet: 'Properties',
      data: [PROPERTY_HEADERS, ...properties].map((r) =>
        r.map((value) => (value == null ? null : { value: value as string | number })),
      ),
    },
    {
      sheet: 'Units',
      data: [UNIT_HEADERS, ...units].map((r) =>
        r.map((value) => (value == null ? null : { value: value as string | number })),
      ),
    },
  ]).toBuffer();

/** Uploads a file, runs the dry run as the worker would, and returns the import. */
async function dryRun(file: Buffer, fileName = 'register.xlsx') {
  const { importId, upload: target } = await imports.createUpload(manager, {
    sizeBytes: file.length,
    fileName,
  });
  await upload(
    target.fields,
    file,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  await imports.startValidation(manager, importId);
  await imports.validate(agencyId, importId);
  return imports.get(manager, importId);
}

async function commit(importId: string) {
  await imports.startCommit(manager, importId);
  await imports.commit(agencyId, importId);
  return imports.get(manager, importId);
}

const unitCount = () =>
  withCompany(
    ctx.database,
    { companyId: agencyId, actorKind: 'system' },
    async (tx) =>
      (await tx.execute<{ n: number }>(sql`select count(*)::int as n from unit`)).rows[0]!.n,
  );

const GOOD = () =>
  workbook(
    [
      [
        'ACC-LEG',
        'Legon compound house',
        'Compound house',
        'Residential',
        'OWN-A',
        'ga 000 0001',
        'Greater Accra',
        'Legon',
      ],
    ],
    [
      ['ACC-LEG', 'B1', 1, 'Chamber and hall', null, 'Borehole', 'Available', 'W-77', 'Shared'],
      ['ACC-LEG', 'B1', 2, 'Chamber and hall', null, 'Borehole', 'Available', 'W-77', 'Shared'],
      ['ACC-LEG', 'B2', 1, 'Single room', null, null, 'Under repair', null, null],
      ['ACC-ELG', 'B1', 3, 'Apartment', 3, 'Parking, Generator', 'Available', null, null],
    ],
  );

describe('PR-08 import', () => {
  it('offers a template with every column and the allowed values', async () => {
    const sheets = await readXlsxFile(await imports.template(manager));
    expect(sheets.map((s) => s.sheet)).toEqual(['Properties', 'Units', 'Lists']);
    expect(sheets[0]!.data[0]).toContain('GhanaPost GPS');
    expect(sheets[1]!.data[0]).toContain('Unit type');
    const lists = sheets[2]!.data;
    expect(lists.map((r) => r[lists[0]!.indexOf('Owner reference')])).toContain('OWN-A');
  });

  it('rejects a malformed sheet row by row, and writes nothing', async () => {
    const before = await unitCount();
    const file = await workbook(
      [
        [
          'ACC-LEG',
          'Legon compound house',
          'Castle',
          'Residential',
          'OWN-Z',
          'Legon',
          'Lagos',
          null,
        ],
        ['ACCOSU', '', 'Shops', 'Commercial', 'OWN-A', null, 'Greater Accra', null],
      ],
      [
        ['ACC-XYZ', 'B1', 1, 'Single room', null, null, null, null, null],
        ['ACC-ELG', 'B1', 1, 'Penthouse', null, 'Pool', 'Vacant', null, null],
      ],
    );
    const result = await dryRun(file);
    expect(result.status).toBe('invalid');
    const at = (sheet: string, row: number) =>
      result.report!.issues.filter((i) => i.sheet === sheet && i.row === row).map((i) => i.column);
    expect(at('Properties', 2)).toEqual([
      'Property type',
      'GhanaPost GPS',
      'Region',
      'Owner reference',
    ]);
    expect(at('Properties', 3)).toEqual(['Property code', 'Name']);
    expect(at('Units', 2)).toEqual(['Property code']);
    expect(at('Units', 3)).toEqual(['Unit type', 'Amenities', 'Availability']);
    await expect(imports.startCommit(manager, result.id)).rejects.toMatchObject({
      code: 'import_not_validated',
    });
    expect(await unitCount()).toBe(before);
  });

  it('refuses files that are not workbooks, and zip bombs before unpacking them', async () => {
    const notXlsx = await dryRun(Buffer.from('just some text, not a spreadsheet'));
    expect(notXlsx.report!.issues[0]!.message).toMatch(/not an Excel workbook/);
    const bomb = await dryRun(zipDeclaring(2_000_000_000));
    expect(bomb.report!.issues[0]!.message).toMatch(/too large once unpacked/);
  });

  it('commits a validated file in one go, with history and meters', async () => {
    const before = await unitCount();
    const result = await dryRun(await GOOD());
    expect(result.status).toBe('validated');
    expect(result.report!.counts).toEqual({
      properties: { create: 1, update: 0, unchanged: 0 },
      units: { create: 4, update: 0, unchanged: 0 },
      blocks: 2,
      meters: 1,
    });
    expect(await unitCount()).toBe(before);
    const committed = await commit(result.id);
    expect(committed.status).toBe('committed');
    expect(await unitCount()).toBe(before + 4);
    const property = (await read.listProperties(manager, { search: 'ACC-LEG' })).rows[0]!;
    const detail = await read.getProperty(manager, property.id);
    expect(detail.owner?.reference).toBe('OWN-A');
    expect(detail.address.ghanapostGps).toBe('GA-000-0001');
    const codes = detail.blocks.flatMap((b) => b.units.map((u) => u.code));
    expect(codes).toEqual(['ACC-LEG-B1-01', 'ACC-LEG-B1-02', 'ACC-LEG-B2-01']);
    expect(detail.meters).toHaveLength(1);
    expect(detail.meters[0]!.unitIds).toHaveLength(2);
    const repair = await read.getUnit(manager, detail.blocks[1]!.units[0]!.id);
    expect(repair.history[0]).toMatchObject({
      toValue: 'under_repair',
      source: 'import',
      reason: 'Imported from register.xlsx',
    });
  });

  it('changes nothing when the same file is imported again', async () => {
    const before = await unitCount();
    const result = await dryRun(await GOOD());
    expect(result.report!.counts).toEqual({
      properties: { create: 0, update: 0, unchanged: 1 },
      units: { create: 0, update: 0, unchanged: 4 },
      blocks: 0,
      meters: 0,
    });
    expect((await commit(result.id)).status).toBe('committed');
    expect(await unitCount()).toBe(before);
  });

  it('updates only what an edited file changes, and never a code', async () => {
    const edited = await workbook(
      [
        [
          'ACC-LEG',
          'Legon compound house (main)',
          'Compound house',
          'Residential',
          'OWN-A',
          'GA-000-0001',
          'Greater Accra',
          'Legon',
        ],
      ],
      [['ACC-LEG', 'B1', 1, 'Single room', null, 'Borehole', 'Available', 'W-77', 'Shared']],
    );
    const result = await dryRun(edited);
    expect(result.report!.counts.properties).toEqual({ create: 0, update: 1, unchanged: 0 });
    expect(result.report!.counts.units).toEqual({ create: 0, update: 1, unchanged: 0 });
    await commit(result.id);
    const unit = (await read.listUnits(manager, { search: 'ACC-LEG-B1-01' })).rows[0]!;
    expect(unit).toMatchObject({
      code: 'ACC-LEG-B1-01',
      unitType: 'single_room',
      propertyName: 'Legon compound house (main)',
    });
  });
});

/** A zip whose central directory declares `size` bytes for one empty, stored entry. */
function zipDeclaring(size: number): Buffer {
  const name = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}
