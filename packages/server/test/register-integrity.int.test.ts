import { schema, sql, withCompany } from '@rent/db';
import { MAX_UNITS_PER_REQUEST } from '@rent/domain/portfolio';
import {
  InMemoryStorage,
  StorageError,
  type DeleteResult,
  type ObjectRef,
} from '@rent/integrations';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnersService } from '../src/companies/owners.service';
import { DocumentsService } from '../src/documents/documents.service';
import { PolicyService } from '../src/policy/policy.service';
import { PropertyFilesService } from '../src/portfolio/property-files.service';
import { RegisterReadService } from '../src/portfolio/register-read.service';
import { RegisterService } from '../src/portfolio/register.service';
import { RulesService } from '../src/rules/rules.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

type Staff = ReturnType<typeof staff>;

const rejected = <T>(r: PromiseSettledResult<T>): r is PromiseRejectedResult =>
  r.status === 'rejected';

let ctx: ServerTestContext;
let policy: PolicyService;
let register: RegisterService;
let read: RegisterReadService;
let owners: OwnersService;

let agencyId: string;
let admin: Staff;
let manager: Staff;
let ownerA: string;
let ownerB: string;
let legonId: string;
let osuId: string;

async function staffIn(
  companyId: string,
  kind: 'agency' | 'landlord',
  role: Parameters<typeof staff>[4],
  name: string,
) {
  const personId = await person(ctx, name);
  return staff(companyId, kind, personId, await member(ctx, companyId, personId, role), role);
}

const newProperty = (code: string, ownerId: string | null, extra: object = {}) => {
  const [areaCode, propertyPart] = code.split('-') as [string, string];
  return {
    areaCode,
    propertyPart,
    name: `Property ${code}`,
    propertyType: 'house' as const,
    use: 'residential' as const,
    ownerId,
    address: { region: 'Greater Accra' },
    ...extra,
  };
};

const propertyCount = (companyId: string) =>
  withCompany(
    ctx.database,
    { companyId, actorKind: 'system' },
    async (tx) =>
      (await tx.execute<{ n: number }>(sql`select count(*)::int as n from property`)).rows[0]!.n,
  );

beforeAll(async () => {
  ctx = await startServerTest();
  policy = new PolicyService();
  owners = new OwnersService(ctx.database, policy);
  register = new RegisterService(ctx.database, policy, owners, ctx.clock, null);
  read = new RegisterReadService(ctx.database, policy);
  agencyId = await company(ctx, 'agency', 'Integrity Agency');
  admin = await staffIn(agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(agencyId, 'agency', 'property_manager', 'Manager');
  ownerA = (await owners.create(admin, { kind: 'individual', displayName: 'Ama Owner' })).id;
  ownerB = (await owners.create(admin, { kind: 'company', displayName: 'Kojo Owner' })).id;
  legonId = await register.createProperty(
    admin,
    newProperty('ACC-LEG', ownerA, { units: [{ unitType: 'single_room', count: 2 }] }),
  );
  osuId = await register.createProperty(admin, newProperty('ACC-OSU', ownerB));
});

afterAll(async () => {
  await ctx.close();
});

describe('AD-02 scoped property creation', () => {
  it('lets a manager scoped to Owner A add a property for Owner A, and refuses one for Owner B (403)', async () => {
    const scoped = {
      ...(await staffIn(agencyId, 'agency', 'property_manager', 'Scoped manager')),
      scope: { owners: [ownerA] },
    };
    const id = await register.createProperty(
      scoped,
      newProperty('ACC-AAA', ownerA, {
        blocks: [{ code: 'B1', units: [{ unitType: 'single_room', count: 3 }] }],
      }),
    );
    const detail = await read.getProperty(scoped, id);
    expect(detail).toMatchObject({ code: 'ACC-AAA', unitCount: 3, owner: { id: ownerA } });
    // The new property is in the scope from now on: more units go in as usual.
    await register.addUnits(scoped, detail.blocks[0]!.id, [{ unitType: 'studio', count: 1 }]);
    expect((await read.getProperty(scoped, id)).unitCount).toBe(4);

    const before = await propertyCount(agencyId);
    await expect(
      register.createProperty(scoped, newProperty('ACC-BBB', ownerB)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await propertyCount(agencyId)).toBe(before);
  });

  it('refuses a new property to a manager scoped to properties only, and owner moves outside the scope', async () => {
    const byProperty = {
      ...(await staffIn(agencyId, 'agency', 'property_manager', 'Property-scoped manager')),
      scope: { properties: [legonId] },
    };
    await expect(
      register.createProperty(byProperty, newProperty('ACC-CCC', ownerA)),
    ).rejects.toMatchObject({ status: 403 });
    const scopedAdmin = {
      ...(await staffIn(agencyId, 'agency', 'agency_admin', 'Scoped admin')),
      scope: { owners: [ownerA] },
    };
    await expect(
      register.changeOwner(scopedAdmin, legonId, { ownerId: ownerB, effectiveFrom: '2098-01-01' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets an owner-scoped admin add an owner, numbered after every owner in the company', async () => {
    const scopedAdmin = {
      ...(await staffIn(agencyId, 'agency', 'agency_admin', 'Owner-scoped admin')),
      scope: { owners: [ownerA] },
    };
    const created = await owners.create(scopedAdmin, {
      kind: 'individual',
      displayName: 'Efua New Owner',
    });
    expect(created).toMatchObject({ displayName: 'Efua New Owner', reference: 'OWN-03' });
    expect((await owners.get(admin, created.id)).reference).toBe('OWN-03');
  });

  it("gives a scoped manager in a landlord's company that company's owner, and never a new one", async () => {
    const landlordId = await company(ctx, 'landlord', 'Scoped Landlord');
    const landlord = await staffIn(landlordId, 'landlord', 'owner', 'Landlord');
    const firstId = await register.createProperty(landlord, newProperty('TEM-ONE', null));
    const [own] = await owners.list(landlord);
    const scoped = {
      ...(await staffIn(landlordId, 'landlord', 'property_manager', 'Landlord manager')),
      scope: { owners: [own!.id] },
    };
    const secondId = await register.createProperty(scoped, newProperty('TEM-TWO', null));
    expect((await read.getProperty(scoped, secondId)).owner?.id).toBe(own!.id);
    const byProperty = { ...scoped, scope: { properties: [firstId] } };
    await expect(
      register.createProperty(byProperty, newProperty('TEM-SIX', null)),
    ).rejects.toMatchObject({ status: 403 });
    expect((await owners.list(landlord)).map((o) => o.reference)).toEqual(['OWN-01']);
  });
});

describe('PR-01 races', () => {
  it('numbers units added to one block at the same time without a clash', async () => {
    const block = (await read.getProperty(manager, legonId)).blocks[0]!;
    // Several rounds: the first requests of a run do not always overlap.
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.allSettled([
        register.addUnits(manager, block.id, [{ unitType: 'single_room', count: 3 }]),
        register.addUnits(manager, block.id, [{ unitType: 'single_room', count: 3 }]),
      ]);
      expect(results.find(rejected)?.reason).toBeUndefined();
    }
    const codes = (await read.getProperty(manager, legonId)).blocks[0]!.units.map((u) => u.code);
    expect(codes).toEqual(
      Array.from({ length: 26 }, (_, i) => `ACC-LEG-B1-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it("gives two first properties added at once the landlord's one OWN-01", async () => {
    const landlordId = await company(ctx, 'landlord', 'Racing Landlord');
    const landlord = await staffIn(landlordId, 'landlord', 'owner', 'Racing landlord');
    const results = await Promise.allSettled([
      register.createProperty(landlord, newProperty('KUM-ONE', null)),
      register.createProperty(landlord, newProperty('KUM-TWO', null)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [only, ...rest] = await owners.list(landlord);
    expect(rest).toEqual([]);
    expect(only!.reference).toBe('OWN-01');
    const { rows } = await read.listProperties(landlord);
    expect(rows.map((r) => r.owner?.id)).toEqual([only!.id, only!.id]);
  });

  it('turns a code taken by a property outside the scope into a 409, not a 500', async () => {
    const scoped = {
      ...(await staffIn(agencyId, 'agency', 'property_manager', 'Another scoped manager')),
      scope: { owners: [ownerA] },
    };
    await expect(
      register.createProperty(scoped, newProperty('ACC-OSU', ownerA)),
    ).rejects.toMatchObject({ status: 409, code: 'property_code_taken' });
  });
});

describe('PR-01 bulk creation limits', () => {
  it(`refuses more than ${MAX_UNITS_PER_REQUEST} units in one request, and creates nothing`, async () => {
    const before = await propertyCount(agencyId);
    const blocks = Array.from({ length: 26 }, (_, i) => ({
      code: `B${i + 1}`,
      units: [{ unitType: 'single_room' as const, count: 200 }],
    }));
    await expect(
      register.createProperty(admin, newProperty('ACC-BIG', ownerA, { blocks })),
    ).rejects.toMatchObject({ code: 'unit.too_many', message: /at most 5,000 units/ });
    expect(await propertyCount(agencyId)).toBe(before);
    const block = (await read.getProperty(manager, legonId)).blocks[0]!;
    const batches = Array.from({ length: 26 }, () => ({
      unitType: 'single_room' as const,
      count: 200,
    }));
    await expect(register.addUnits(manager, block.id, batches)).rejects.toMatchObject({
      code: 'unit.too_many',
    });
    await expect(
      register.addBlock(manager, legonId, { code: 'BX', units: batches }),
    ).rejects.toMatchObject({ code: 'unit.too_many' });
  });
});

describe('AD-02 ownership changes', () => {
  it('lets one of two owner changes made at the same time apply, and refuses the other cleanly (N2)', async () => {
    const propertyId = await register.createProperty(admin, newProperty('ACC-TWN', ownerA));
    const ownerC = (await owners.create(admin, { kind: 'individual', displayName: 'Third' })).id;
    // Several rounds, each on a later date: the first requests of a run do not always overlap.
    for (const effectiveFrom of ['2099-01-01', '2099-02-01', '2099-03-01', '2099-04-01']) {
      const results = await Promise.allSettled([
        register.changeOwner(admin, propertyId, { ownerId: ownerB, effectiveFrom }),
        register.changeOwner(admin, propertyId, { ownerId: ownerC, effectiveFrom }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(rejected)?.reason).toMatchObject({ code: 'ownership_date' });
    }
    const rows = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.propertyOwnership)
          .where(sql`${schema.propertyOwnership.propertyId} = ${propertyId}`),
    );
    expect(rows).toHaveLength(5);
  });

  it('refuses to archive an owner who takes over a property on a later date (N3)', async () => {
    const later = (await owners.create(admin, { kind: 'individual', displayName: 'Later Owner' }))
      .id;
    await register.changeOwner(admin, osuId, { ownerId: later, effectiveFrom: '2099-06-01' });
    await expect(register.archiveOwner(admin, later)).rejects.toMatchObject({
      code: 'owner_has_properties',
    });
  });
});

describe('AD-02 owner notes', () => {
  it('shows an owner’s notes only to people who manage owners (N5)', async () => {
    const noted = await owners.create(admin, {
      kind: 'individual',
      displayName: 'Noted Owner',
      notes: 'Prefers calls after 6 pm',
    });
    expect(noted.notes).toBe('Prefers calls after 6 pm');
    expect((await owners.get(admin, noted.id)).notes).toBe('Prefers calls after 6 pm');
    expect(policy.can(manager, 'owner.manage').allowed).toBe(false);
    expect((await owners.get(manager, noted.id)).notes).toBeNull();
    expect((await owners.list(manager)).find((o) => o.id === noted.id)?.notes).toBeNull();
  });
});

/** Storage whose next delete fails, as an outage would. */
class FlakyStorage extends InMemoryStorage {
  failNextDelete = false;
  override async delete(ref: ObjectRef): Promise<DeleteResult> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new StorageError('unavailable', 'simulated outage');
    }
    return super.delete(ref);
  }
}

describe('PR-04 photo originals', () => {
  let storage: FlakyStorage;
  let files: PropertyFilesService;

  beforeAll(async () => {
    storage = new FlakyStorage();
    await storage.ensureBuckets({
      files: ctx.config.S3_BUCKET_FILES,
      evidence: ctx.config.S3_BUCKET_EVIDENCE,
    });
    const documents = new DocumentsService(
      ctx.database,
      storage,
      ctx.config,
      ctx.clock,
      ctx.audit,
      new RulesService(ctx.database),
    );
    files = new PropertyFilesService(
      ctx.database,
      policy,
      documents,
      storage,
      ctx.config,
      ctx.clock,
    );
  });

  const located = (colour: string) =>
    sharp({ create: { width: 800, height: 600, channels: 3, background: colour } })
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '5/1 39/1 0/1' } })
      .jpeg()
      .toBuffer();

  it('removes every version of the original, even when a delete fails and the job runs again (S7)', async () => {
    const first = await located('#887766');
    const second = await located('#223344');
    const intent = await files.createUpload(manager, legonId, {
      category: 'photo',
      contentType: 'image/jpeg',
      sizeBytes: second.length,
    });
    const key = intent.fields.key ?? intent.fields.Key!;
    const bucket = ctx.config.S3_BUCKET_FILES;
    // Uploaded twice through the same link: two versions, both with the location.
    for (const body of [first, second])
      await storage.put({ bucket, key, body, contentType: 'image/jpeg' });
    expect(await storage.listVersions({ bucket, key })).toHaveLength(2);
    const confirmed = await files.confirmUpload(manager, legonId, {
      uploadId: intent.uploadId,
      category: 'photo',
    });

    storage.failNextDelete = true;
    await expect(files.process(agencyId, confirmed.id)).rejects.toThrow('simulated outage');
    const [shown] = (await files.list(manager, legonId)).filter((f) => f.id === confirmed.id);
    expect(shown?.status).toBe('ready');
    expect((await storage.listVersions({ bucket, key })).length).toBeGreaterThan(0);

    await files.process(agencyId, confirmed.id); // the job's retry
    expect(await storage.listVersions({ bucket, key })).toEqual([]);
    expect(await storage.head({ bucket, key })).toBeNull();
    await files.process(agencyId, confirmed.id); // and again: nothing left to do
    expect(await files.downloadUrl(manager, confirmed.id)).toBeTruthy();
  });

  it('keeps a PDF paper, which is its own stored file, however often the job runs', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const intent = await files.createUpload(manager, legonId, {
      category: 'site_plan',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    });
    const key = intent.fields.key ?? intent.fields.Key!;
    const bucket = ctx.config.S3_BUCKET_FILES;
    await storage.put({ bucket, key, body: pdf, contentType: 'application/pdf' });
    const paper = await files.confirmUpload(manager, legonId, {
      uploadId: intent.uploadId,
      category: 'site_plan',
    });
    await files.process(agencyId, paper.id);
    await files.process(agencyId, paper.id);
    expect(await storage.head({ bucket, key })).not.toBeNull();
    expect(await files.downloadUrl(manager, paper.id)).toBeTruthy();
  });

  it('adds an upload confirmed twice at the same time once, and answers the other with a 409', async () => {
    const photo = await located('#556677');
    const intent = await files.createUpload(manager, legonId, {
      category: 'photo',
      contentType: 'image/jpeg',
      sizeBytes: photo.length,
    });
    await storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: intent.fields.key ?? intent.fields.Key!,
      body: photo,
      contentType: 'image/jpeg',
    });
    const confirm = () =>
      files.confirmUpload(manager, legonId, { uploadId: intent.uploadId, category: 'photo' });
    const results = await Promise.allSettled([confirm(), confirm()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(rejected)?.reason).toMatchObject({
      status: 409,
      code: 'upload_already_added',
    });
    await expect(confirm()).rejects.toMatchObject({ status: 409 });
  });
});
