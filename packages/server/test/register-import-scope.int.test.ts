import { deflateRawSync } from 'node:zlib';
import { desc, schema, sql, withCompany, type Tx } from '@rent/db';
import type { ScopeIds } from '@rent/domain/policy';
import { PROPERTY_COLUMNS, UNIT_COLUMNS, XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { OwnersService } from '../src/companies/owners.service';
import { DocumentsService } from '../src/documents/documents.service';
import { PolicyService } from '../src/policy/policy.service';
import { MetersService } from '../src/portfolio/meters.service';
import {
  COMMIT_IMPORT_JOB,
  RegisterImportService,
  VALIDATE_IMPORT_JOB,
} from '../src/portfolio/register-import.service';
import { RegisterReadService } from '../src/portfolio/register-read.service';
import { RegisterService } from '../src/portfolio/register.service';
import { RulesService } from '../src/rules/rules.service';
import {
  asOwner,
  company,
  member,
  person,
  staff,
  startServerTest,
  type ServerTestContext,
} from './support';

type Staff = ReturnType<typeof staff>;
type Cells = Record<string, string | number | null | undefined>;

let ctx: ServerTestContext;
let imports: RegisterImportService;
let register: RegisterService;
let read: RegisterReadService;
let owners: OwnersService;
let meters: MetersService;

let agencyId: string;
let admin: Staff;
let manager: Staff;
let otherManager: Staff;
/** A manager limited to Owner A (AD-02). */
let scopedManager: Staff;
let ownerA: string;
let ownerB: string;
let legonId: string;
let osuId: string;

async function staffIn(role: Parameters<typeof staff>[4], name: string) {
  const personId = await person(ctx, name);
  return staff(agencyId, 'agency', personId, await member(ctx, agencyId, personId, role), role);
}

/** A sheet with the template's headers (or others), one row per object keyed by header. */
const sheet = (headers: readonly string[], rows: Cells[]) =>
  [headers, ...rows.map((r) => headers.map((h) => r[h] ?? null))].map((r) =>
    r.map((value) => (value == null ? null : { value: value as string | number })),
  );
const PROPERTY_HEADERS: readonly string[] = PROPERTY_COLUMNS.map((c) => c.header);
const UNIT_HEADERS: readonly string[] = UNIT_COLUMNS.map((c) => c.header);
const workbook = (
  properties: Cells[],
  units: Cells[],
  headers = { properties: PROPERTY_HEADERS, units: UNIT_HEADERS },
) =>
  writeXlsxFile([
    { sheet: 'Properties', data: sheet(headers.properties, properties) },
    { sheet: 'Units', data: sheet(headers.units, units) },
  ]).toBuffer();

const asSystem = <T>(fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, fn);

/** The payload of the latest outbox event of an import job: what the worker receives. */
async function payloadOf(type: string, importId: string) {
  const [event] = await asSystem((tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(
        sql`${schema.outboxEvent.type} = ${type} and ${schema.outboxEvent.payload}->>'importId' = ${importId}`,
      )
      .orderBy(desc(schema.outboxEvent.id))
      .limit(1),
  );
  return event!.payload as { scope: ScopeIds | null; attempt?: number };
}

/** The commit events queued for an import, oldest first. */
const commitEvents = (importId: string) =>
  asSystem((tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload, key: schema.outboxEvent.idempotencyKey })
      .from(schema.outboxEvent)
      .where(
        sql`${schema.outboxEvent.type} = ${COMMIT_IMPORT_JOB} and ${schema.outboxEvent.payload}->>'importId' = ${importId}`,
      )
      .orderBy(schema.outboxEvent.id),
  );

/** Runs an import job from its outbox payload, as the worker does (apps/worker register.jobs). */
async function runJob(type: string, importId: string) {
  const payload = await payloadOf(type, importId);
  if (type === VALIDATE_IMPORT_JOB)
    return imports.validate(agencyId, importId, { scope: payload.scope });
  return imports.commit(agencyId, importId, { attempt: payload.attempt, scope: payload.scope });
}

async function uploaded(actor: Staff, file: Buffer) {
  const { importId, upload } = await imports.createUpload(actor, {
    sizeBytes: file.length,
    fileName: 'register.xlsx',
  });
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key ?? upload.fields.Key!,
    body: file,
    contentType: XLSX_CONTENT_TYPE,
  });
  return importId;
}

async function check(actor: Staff, importId: string) {
  ctx.clock.advance(1_000); // each check is its own outbox event
  await imports.startValidation(actor, importId);
  await runJob(VALIDATE_IMPORT_JOB, importId);
  return imports.get(actor, importId);
}

const dryRun = async (actor: Staff, file: Buffer) => check(actor, await uploaded(actor, file));

async function commit(actor: Staff, importId: string) {
  await imports.startCommit(actor, importId);
  await runJob(COMMIT_IMPORT_JOB, importId);
  return imports.get(actor, importId);
}

const issuesAt =
  (report: { issues: { sheet: string; row: number | null }[] } | null) =>
  (sheetName: string, row: number) =>
    (report?.issues ?? []).filter((i) => i.sheet === sheetName && i.row === row);

const counts = () =>
  asSystem(async (tx) => {
    const n = async (table: string) =>
      (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]!
        .n;
    return {
      property: await n('property'),
      block: await n('block'),
      unit: await n('unit'),
      meter: await n('meter'),
    };
  });

const propertyByCode = async (code: string) =>
  (await read.listProperties(admin, { search: code, includeArchived: true })).rows.find(
    (p) => p.code === code,
  );

const LEGON = {
  'Property code': 'ACC-LEG',
  Name: 'Legon compound house',
  'Property type': 'Compound house',
  Use: 'Residential',
  'Owner reference': 'OWN-A',
  Region: 'Greater Accra',
};

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
  meters = new MetersService(ctx.database, policy);
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
  agencyId = await company(ctx, 'agency', 'Import Scope Agency');
  admin = await staffIn('agency_admin', 'Admin');
  manager = await staffIn('property_manager', 'Manager');
  otherManager = await staffIn('property_manager', 'Other manager');
  ownerA = (
    await owners.create(admin, { kind: 'individual', displayName: 'Ama Owner', reference: 'OWN-A' })
  ).id;
  ownerB = (
    await owners.create(admin, { kind: 'company', displayName: 'Kojo Owner', reference: 'OWN-B' })
  ).id;
  scopedManager = {
    ...(await staffIn('property_manager', 'Scoped manager')),
    scope: { owners: [ownerA] },
  };
  legonId = await register.createProperty(admin, {
    areaCode: 'ACC',
    propertyPart: 'LEG',
    name: 'Legon compound house',
    propertyType: 'compound_house',
    use: 'residential',
    ownerId: ownerA,
    address: { region: 'Greater Accra' },
    units: [{ unitType: 'single_room', count: 3 }],
  });
  osuId = await register.createProperty(admin, {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    name: 'Osu shops',
    propertyType: 'shop',
    use: 'commercial',
    ownerId: ownerB,
    address: { region: 'Greater Accra', town: 'Osu' },
    blocks: [{ code: 'G', units: [{ unitType: 'shop', count: 2 }] }],
  });
});

afterAll(async () => {
  await ctx.close();
});

describe('AD-02 import scope', () => {
  it('reports rows outside a scoped manager’s owners at the dry run, revealing nothing more', async () => {
    const before = await counts();
    const result = await dryRun(
      scopedManager,
      await workbook(
        [
          {
            'Property code': 'ACC-OSU',
            Name: 'Renamed by import',
            'Property type': 'Shop',
            Use: 'Commercial',
            Region: 'Greater Accra',
          },
          {
            'Property code': 'ACC-NEW',
            Name: 'A house for Owner B',
            'Property type': 'House',
            Use: 'Residential',
            'Owner reference': 'OWN-B',
            Region: 'Greater Accra',
          },
          LEGON,
        ],
        [
          {
            'Property code': 'ACC-OSU',
            'Block code': 'G',
            Unit: '01',
            'Unit type': 'Store',
            Availability: 'Not lettable',
          },
          {
            'Property code': 'ACC-LEG',
            'Block code': 'B1',
            Unit: '01',
            'Unit type': 'Single room',
          },
        ],
      ),
    );
    expect(result.status).toBe('invalid');
    const at = issuesAt(result.report);
    expect(at('Properties', 2)).toEqual([
      expect.objectContaining({
        column: 'Property code',
        message: 'ACC-OSU is not a property you can manage',
      }),
    ]);
    expect(at('Properties', 3)).toEqual([
      expect.objectContaining({
        column: 'Owner reference',
        message: 'OWN-B is not an owner you can manage',
      }),
    ]);
    expect(at('Properties', 4)).toEqual([]);
    expect(at('Units', 2)).toEqual([
      expect.objectContaining({
        column: 'Property code',
        message: 'ACC-OSU is not a property you can manage',
      }),
    ]);
    expect(at('Units', 3)).toEqual([]);
    const text = JSON.stringify(result.report);
    for (const secret of ['Osu shops', 'Kojo', ownerB, osuId]) expect(text).not.toContain(secret);
    expect(await counts()).toEqual(before);
    expect(await propertyByCode('ACC-OSU')).toMatchObject({ name: 'Osu shops' });
  });

  it('commits a scoped manager’s rows for their own owner, new property included', async () => {
    const result = await dryRun(
      scopedManager,
      await workbook(
        [
          { ...LEGON, Name: 'Legon compound house (imported)' },
          {
            'Property code': 'ACC-TWO',
            Name: 'Second Legon house',
            'Property type': 'House',
            Use: 'Residential',
            'Owner reference': 'OWN-A',
            Region: 'Greater Accra',
          },
        ],
        [{ 'Property code': 'ACC-TWO', 'Block code': 'B1', Unit: '01', 'Unit type': 'Studio' }],
      ),
    );
    expect(result.status, JSON.stringify(result.report?.issues)).toBe('validated');
    expect((await commit(scopedManager, result.id)).status).toBe('committed');
    const created = await propertyByCode('ACC-TWO');
    expect(created).toMatchObject({ owner: { id: ownerA }, unitCount: 1 });
    expect((await read.getProperty(scopedManager, created!.id)).code).toBe('ACC-TWO');
    expect(await propertyByCode('ACC-LEG')).toMatchObject({
      name: 'Legon compound house (imported)',
    });
  });

  it('runs the commit under the scope at commit time: a row now outside it writes nothing', async () => {
    const result = await dryRun(
      scopedManager,
      await workbook([{ ...LEGON, Name: 'Legon, renamed at commit' }], []),
    );
    expect(result.status).toBe('validated');
    // An admin moves this person to Owner B between the check and the commit.
    const movedToB = { ...scopedManager, scope: { owners: [ownerB] } };
    const committed = await commit(movedToB, result.id);
    expect(committed.status).toBe('invalid');
    expect(issuesAt(committed.report)('Properties', 2)).toEqual([
      expect.objectContaining({ message: 'ACC-LEG is not a property you can manage' }),
    ]);
    expect(await propertyByCode('ACC-LEG')).toMatchObject({
      name: 'Legon compound house (imported)',
    });
  });

  it('keeps one manager’s import and report from another (N4)', async () => {
    const importId = await uploaded(manager, await workbook([LEGON], []));
    await expect(imports.get(otherManager, importId)).rejects.toMatchObject({ status: 404 });
    await expect(imports.startValidation(otherManager, importId)).rejects.toMatchObject({
      status: 404,
    });
    expect((await imports.get(manager, importId)).status).toBe('uploaded');
  });
});

describe('PR-08 re-import with blank cells', () => {
  it('leaves availability, floor, description, amenities, GhanaPost code, pin and district as they are', async () => {
    const houseId = await register.createProperty(admin, {
      areaCode: 'TEM',
      propertyPart: 'EST',
      name: 'Tema estate house',
      propertyType: 'house',
      use: 'residential',
      ownerId: ownerA,
      address: {
        region: 'Greater Accra',
        ghanapostGps: 'GT-000-0001',
        district: 'Tema Metropolitan',
        mmda: 'TMA',
        town: 'Tema',
        street: 'Community 25',
        latitude: '5.6698',
        longitude: '-0.0166',
      },
      units: [{ unitType: 'detached_house', count: 1, bedrooms: 4 }],
    });
    const unitId = (await read.getProperty(admin, houseId)).blocks[0]!.units[0]!.id;
    await register.updateUnit(admin, unitId, {
      floor: 'Ground',
      description: 'Four-bedroom house with a boys’ quarters',
      amenities: ['parking', 'borehole'],
    });
    await register.setAvailability(admin, unitId, {
      availability: 'under_repair',
      reason: 'Roof repairs',
    });
    const propertyBefore = await read.getProperty(admin, houseId);
    const unitBefore = await read.getUnit(admin, unitId);

    const blanks = await workbook(
      [
        {
          'Property code': 'TEM-EST',
          Name: 'Tema estate house',
          'Property type': 'House',
          Use: 'Residential',
          Region: 'Greater Accra',
        },
      ],
      [
        {
          'Property code': 'TEM-EST',
          'Block code': 'B1',
          Unit: '01',
          'Unit type': 'Detached house',
        },
      ],
    );
    const result = await dryRun(admin, blanks);
    expect(result.status, JSON.stringify(result.report?.issues)).toBe('validated');
    expect(result.report!.counts.properties).toEqual({ create: 0, update: 0, unchanged: 1 });
    expect(result.report!.counts.units).toEqual({ create: 0, update: 0, unchanged: 1 });
    expect((await commit(admin, result.id)).status).toBe('committed');

    // A changed name is applied; the blank cells still leave everything else alone.
    const renamed = await dryRun(
      admin,
      await workbook(
        [
          {
            'Property code': 'TEM-EST',
            Name: 'Tema estate house (main)',
            'Property type': 'House',
            Use: 'Residential',
            Region: 'Greater Accra',
          },
        ],
        [
          {
            'Property code': 'TEM-EST',
            'Block code': 'B1',
            Unit: '01',
            'Unit type': 'Detached house',
            Floor: 'First',
          },
        ],
      ),
    );
    expect(renamed.report!.counts.properties).toEqual({ create: 0, update: 1, unchanged: 0 });
    expect(renamed.report!.counts.units).toEqual({ create: 0, update: 1, unchanged: 0 });
    expect((await commit(admin, renamed.id)).status).toBe('committed');

    const property = await read.getProperty(admin, houseId);
    expect(property.name).toBe('Tema estate house (main)');
    expect(property.address).toEqual(propertyBefore.address);
    expect(property.address).toMatchObject({
      ghanapostGps: 'GT-000-0001',
      district: 'Tema Metropolitan',
      pin: { latitude: '5.6698', longitude: '-0.0166' },
    });
    const unit = await read.getUnit(admin, unitId);
    expect(unit).toMatchObject({
      availability: 'under_repair',
      floor: 'First',
      description: unitBefore.description,
      amenities: ['parking', 'borehole'],
      bedrooms: 4,
    });
    expect(unit.history.filter((h) => h.source === 'import')).toEqual([]);
  });
});

describe('PR-08 import of a malformed sheet', () => {
  it('reports a wrong or missing header as a missing column, and writes nothing', async () => {
    const before = await counts();
    const result = await dryRun(
      manager,
      await workbook(
        [{ ...LEGON, 'Property code': 'ACC-HDR' }],
        [{ 'Property code': 'ACC-HDR', Unit: '01', 'Unit kind': 'Single room' }],
        {
          properties: PROPERTY_HEADERS.filter((h) => h !== 'Region'),
          units: UNIT_HEADERS.map((h) => (h === 'Unit type' ? 'Unit kind' : h)),
        },
      ),
    );
    expect(result.status).toBe('invalid');
    expect(result.report!.issues).toEqual(
      expect.arrayContaining([
        { sheet: 'Properties', row: 1, column: 'Region', message: 'This column is missing' },
        { sheet: 'Units', row: 1, column: 'Unit type', message: 'This column is missing' },
      ]),
    );
    await expect(imports.startCommit(manager, result.id)).rejects.toMatchObject({
      code: 'import_not_validated',
    });
    expect(await counts()).toEqual(before);
  });

  it('writes nothing when the commit’s re-check finds a problem, and can be checked and committed again', async () => {
    const units = (await read.getProperty(admin, legonId)).blocks[0]!.units;
    const second = units[1]!;
    const before = await counts();
    const file = await workbook(
      [],
      [
        {
          'Property code': 'ACC-LEG',
          'Block code': 'B1',
          Unit: '02',
          'Unit type': 'Single room',
          Availability: 'Reserved',
        },
        { 'Property code': 'ACC-LEG', 'Block code': 'B1', Unit: '09', 'Unit type': 'Single room' },
      ],
    );
    const checked = await dryRun(manager, file);
    expect(checked.status).toBe('validated');
    // The unit goes under repair after the check: reserved is no longer a valid change.
    await register.setAvailability(manager, second.id, {
      availability: 'under_repair',
      reason: 'Burst pipe',
    });
    const refused = await commit(manager, checked.id);
    expect(refused.status).toBe('invalid');
    expect(issuesAt(refused.report)('Units', 2)).toEqual([
      expect.objectContaining({ column: 'Availability' }),
    ]);
    expect(await counts()).toEqual(before);
    expect((await read.getUnit(manager, second.id)).availability).toBe('under_repair');

    // Fixed in the register, checked again, committed: the stale commit key does not block it.
    await register.setAvailability(manager, second.id, {
      availability: 'available',
      reason: 'Pipe fixed',
    });
    expect((await check(manager, checked.id)).status).toBe('validated');
    expect((await commit(manager, checked.id)).status).toBe('committed');
    const events = await commitEvents(checked.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.key)).size).toBe(2);
    expect((await read.getUnit(manager, second.id)).availability).toBe('reserved');
    expect((await counts()).unit).toBe(before.unit + 1);
  });

  it('writes nothing when the commit fails part-way, marks it failed after the last retry, and recovers', async () => {
    await asOwner(
      ctx,
      `create function test_refuse_unit() returns trigger language plpgsql as $$
       begin
         if new.label = '77' then raise exception 'test refusal with internal detail'; end if;
         return new;
       end $$;
       create trigger test_refuse_unit before insert on unit
         for each row execute function test_refuse_unit();`,
    );
    try {
      const before = await counts();
      const checked = await dryRun(
        manager,
        await workbook(
          [
            {
              'Property code': 'ACC-PRT',
              Name: 'Part-way house',
              'Property type': 'House',
              Use: 'Residential',
              'Owner reference': 'OWN-A',
              Region: 'Greater Accra',
            },
            { ...LEGON, Name: 'Legon, renamed part-way' },
          ],
          [
            { 'Property code': 'ACC-PRT', 'Block code': 'B1', Unit: '01', 'Unit type': 'Studio' },
            { 'Property code': 'ACC-PRT', 'Block code': 'B1', Unit: '77', 'Unit type': 'Studio' },
          ],
        ),
      );
      expect(checked.status).toBe('validated');
      await imports.startCommit(manager, checked.id);
      await expect(runJob(COMMIT_IMPORT_JOB, checked.id)).rejects.toThrow();
      expect(await counts()).toEqual(before);
      expect(await propertyByCode('ACC-PRT')).toBeUndefined();
      expect((await propertyByCode('ACC-LEG'))!.name).not.toBe('Legon, renamed part-way');
      expect((await imports.get(manager, checked.id)).status).toBe('committing');

      // The job gives up: the import says so, without the database's message.
      const { attempt } = await payloadOf(COMMIT_IMPORT_JOB, checked.id);
      await imports.commitAbandoned(agencyId, checked.id, attempt! - 1); // a stale job: no effect
      expect((await imports.get(manager, checked.id)).status).toBe('committing');
      await imports.commitAbandoned(agencyId, checked.id, attempt);
      const failed = await imports.get(manager, checked.id);
      expect(failed).toMatchObject({
        status: 'failed',
        error: 'The import could not be completed, and nothing was changed.',
      });
      expect(JSON.stringify(failed)).not.toContain('internal detail');

      await asOwner(ctx, 'drop trigger test_refuse_unit on unit');
      expect((await check(manager, checked.id)).status).toBe('validated');
      expect((await commit(manager, checked.id)).status).toBe('committed');
      expect(await propertyByCode('ACC-PRT')).toMatchObject({ unitCount: 2 });

      // A commit job delivered again changes nothing.
      const after = await counts();
      await runJob(COMMIT_IMPORT_JOB, checked.id);
      expect(await counts()).toEqual(after);
      await expect(imports.startCommit(manager, checked.id)).rejects.toMatchObject({
        code: 'import_not_validated',
      });
    } finally {
      await asOwner(
        ctx,
        'drop trigger if exists test_refuse_unit on unit; drop function if exists test_refuse_unit()',
      );
    }
  });

  it('marks a check that fails its last retry as failed, so it can be checked again', async () => {
    const importId = await uploaded(manager, await workbook([LEGON], []));
    await imports.startValidation(manager, importId);
    await imports.validationAbandoned(agencyId, importId);
    expect(await imports.get(manager, importId)).toMatchObject({
      status: 'failed',
      error: 'The file could not be checked.',
    });
    expect((await check(manager, importId)).status).toBe('validated');
  });
});

describe('PR-08 import meters', () => {
  it('reports a meter number an archived meter holds at the dry run (S4)', async () => {
    const meterId = await meters.add(admin, legonId, {
      utility: 'water',
      supplier: 'Ghana Water',
      meterNumber: 'W-ARCHIVED',
      meterType: 'postpaid',
    });
    await meters.archive(admin, meterId);
    const result = await dryRun(
      manager,
      await workbook(
        [],
        [
          {
            'Property code': 'ACC-LEG',
            'Block code': 'B1',
            Unit: '40',
            'Unit type': 'Single room',
            'Water meter': 'W-ARCHIVED',
            'Water meter type': 'Postpaid',
          },
        ],
      ),
    );
    expect(result.status).toBe('invalid');
    expect(issuesAt(result.report)('Units', 2)).toEqual([
      expect.objectContaining({
        column: 'Water meter',
        message: 'An archived meter has this number. Use another number.',
      }),
    ]);
  });

  it('reports a meter number used on a property outside the scope', async () => {
    await meters.add(admin, osuId, {
      utility: 'electricity',
      supplier: 'ECG',
      meterNumber: 'P-OSU-1',
      meterType: 'prepaid',
    });
    const result = await dryRun(
      scopedManager,
      await workbook(
        [],
        [
          {
            'Property code': 'ACC-LEG',
            'Block code': 'B1',
            Unit: '41',
            'Unit type': 'Single room',
            'Electricity meter': 'P-OSU-1',
            'Electricity meter type': 'Prepaid',
          },
        ],
      ),
    );
    expect(issuesAt(result.report)('Units', 2)).toEqual([
      expect.objectContaining({
        column: 'Electricity meter',
        message: 'This meter belongs to another property',
      }),
    ]);
  });
});

/** A one-entry zip whose headers say 100 bytes, while the entry inflates to 60 MB. */
function understatedBomb(): Buffer {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const body = deflateRawSync(Buffer.alloc(60_000_000, 0x20));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(100, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(100, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

describe('PR-08 import zip bombs', () => {
  it('refuses a workbook whose declared sizes are small but which inflates past the limit', async () => {
    const result = await dryRun(manager, understatedBomb());
    expect(result.status).toBe('invalid');
    expect(result.report!.issues).toEqual([
      {
        sheet: 'File',
        row: null,
        column: null,
        message: 'This workbook is too large once unpacked',
      },
    ]);
  });
});
