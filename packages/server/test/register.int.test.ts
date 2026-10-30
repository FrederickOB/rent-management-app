import { schema, sql, withCompany } from '@rent/db';
import { InMemoryAddressLookup } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnersService } from '../src/companies/owners.service';
import { PolicyService } from '../src/policy/policy.service';
import { MetersService } from '../src/portfolio/meters.service';
import { RegisterReadService } from '../src/portfolio/register-read.service';
import { RegisterService } from '../src/portfolio/register.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let register: RegisterService;
let read: RegisterReadService;
let owners: OwnersService;
let meters: MetersService;

let agencyId: string;
let admin: ReturnType<typeof staff>;
let manager: ReturnType<typeof staff>;
let clientOwnerA: ReturnType<typeof staff>;
let caretaker: ReturnType<typeof staff>;
let ownerA: string;
let ownerB: string;
let legonId: string;
let osuId: string;

const ADDRESS = { region: 'Greater Accra', town: 'Legon', ghanapostGps: 'ga 000 0001' };

async function staffIn(
  companyId: string,
  kind: 'agency' | 'landlord',
  role: Parameters<typeof staff>[4],
  name: string,
) {
  const personId = await person(ctx, name);
  const membershipId = await member(ctx, companyId, personId, role);
  return staff(companyId, kind, personId, membershipId, role);
}

beforeAll(async () => {
  ctx = await startServerTest();
  const policy = new PolicyService();
  owners = new OwnersService(ctx.database, policy);
  register = new RegisterService(
    ctx.database,
    policy,
    owners,
    ctx.clock,
    new InMemoryAddressLookup(),
  );
  read = new RegisterReadService(ctx.database, policy);
  meters = new MetersService(ctx.database, policy);

  agencyId = await company(ctx, 'agency', 'Register Agency');
  admin = await staffIn(agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(agencyId, 'agency', 'property_manager', 'Manager');
  ownerA = (
    await owners.create(admin, {
      kind: 'individual',
      displayName: 'Ama Mensah',
      timeZone: 'Europe/London',
    })
  ).id;
  ownerB = (await owners.create(admin, { kind: 'company', displayName: 'Osu Holdings Ltd' })).id;
  const client = await staffIn(agencyId, 'agency', 'owner', 'Client owner');
  clientOwnerA = { ...client, scope: { owners: [ownerA] } };
  const care = await staffIn(agencyId, 'agency', 'caretaker', 'Caretaker');
  caretaker = care;

  legonId = await register.createProperty(manager, {
    areaCode: 'acc',
    propertyPart: 'leg',
    name: 'Legon compound house',
    propertyType: 'compound_house',
    use: 'residential',
    ownerId: ownerA,
    address: ADDRESS,
    units: [
      { unitType: 'single_room', count: 6 },
      { unitType: 'chamber_and_hall', count: 6 },
    ],
  });
  osuId = await register.createProperty(manager, {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    name: 'Osu mixed-use building',
    propertyType: 'mixed_use',
    use: 'mixed',
    ownerId: ownerB,
    address: { region: 'greater accra', latitude: '5.556', longitude: -0.1819 },
    blocks: [
      { code: 'G', name: 'Ground floor', units: [{ unitType: 'shop', count: 4 }] },
      { code: 'F1', name: 'First floor', units: [{ unitType: 'office', count: 4 }] },
    ],
  });
  caretaker = { ...caretaker, scope: { properties: [osuId] } };
});

afterAll(async () => {
  await ctx.close();
});

describe('PR-01 bulk creation', () => {
  it('sets up a 12-room compound house in one step, with codes in the PRD pattern', async () => {
    const detail = await read.getProperty(manager, legonId);
    expect(detail.code).toBe('ACC-LEG');
    expect(detail.blocks).toHaveLength(1);
    const units = detail.blocks[0]!.units;
    expect(units.map((u) => u.code)).toEqual(
      Array.from({ length: 12 }, (_, i) => `ACC-LEG-B1-${String(i + 1).padStart(2, '0')}`),
    );
    expect(units.slice(0, 6).every((u) => u.unitType === 'single_room')).toBe(true);
    expect(units.slice(6).every((u) => u.unitType === 'chamber_and_hall')).toBe(true);
    expect(detail.counts.vacant).toBe(12);
  });

  it('numbers new units after the highest ever used, archived units included', async () => {
    const detail = await read.getProperty(manager, legonId);
    const block = detail.blocks[0]!;
    await register.archiveUnit(manager, block.units.at(-1)!.id);
    const [id] = await register.addUnits(manager, block.id, [
      { unitType: 'single_room', count: 1 },
    ]);
    expect((await read.getUnit(manager, id!)).code).toBe('ACC-LEG-B1-13');
  });

  it('refuses a property code that is taken, and suggests a free one', async () => {
    await expect(
      register.createProperty(manager, {
        areaCode: 'ACC',
        propertyPart: 'LEG',
        name: 'Another Legon house',
        propertyType: 'house',
        use: 'residential',
        ownerId: ownerA,
        address: ADDRESS,
      }),
    ).rejects.toMatchObject({
      code: 'property_code_taken',
      message: expect.stringContaining('ACC-LEG2'),
    });
    await expect(
      register.createProperty(manager, {
        areaCode: 'ACC',
        propertyPart: 'LEG',
        name: 'Another Legon house',
        propertyType: 'house',
        use: 'residential',
        ownerId: ownerA,
        address: ADDRESS,
      }),
    ).rejects.toMatchObject({ details: { suggestedCode: 'ACC-LEG2' } });
  });

  it('gives custom blocks their own codes', async () => {
    const detail = await read.getProperty(manager, osuId);
    expect(detail.blocks.map((b) => b.units.map((u) => u.code))).toEqual([
      ['ACC-OSU-F1-01', 'ACC-OSU-F1-02', 'ACC-OSU-F1-03', 'ACC-OSU-F1-04'],
      ['ACC-OSU-G-01', 'ACC-OSU-G-02', 'ACC-OSU-G-03', 'ACC-OSU-G-04'],
    ]);
    expect(detail.address.pin).toEqual({ latitude: '5.556', longitude: '-0.1819' });
    expect(detail.address.mapsLink).toContain('5.556%2C-0.1819');
  });
});

describe('PB-01 billing bands', () => {
  it('gives every unit the band of its type', async () => {
    const detail = await read.getProperty(manager, osuId);
    const bands = new Set(detail.blocks.flatMap((b) => b.units.map((u) => u.billingBand)));
    expect([...bands]).toEqual(['commercial']);
  });

  it('lets only an owner or agency admin override a band, with a reason that is audited', async () => {
    const unit = (await read.getProperty(manager, osuId)).blocks[1]!.units[0]!;
    await expect(
      register.setBand(manager, unit.id, {
        band: 'single_room',
        reason: 'Kiosk-style room let for living',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(register.setBand(admin, unit.id, { band: 'single_room' })).rejects.toThrow(
      /reason/,
    );
    await register.setBand(admin, unit.id, {
      band: 'single_room',
      reason: 'Kiosk-style room let for living',
    });
    const detail = await read.getUnit(admin, unit.id);
    expect(detail).toMatchObject({ billingBand: 'single_room', bandOverridden: true });
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ data: { after: { band_override_reason: string } } }>(
          sql`select data from audit_event where record_type = 'unit' and record_id = ${unit.id} and action = 'unit.update' order by seq desc limit 1`,
        ),
    );
    expect(events.rows[0]!.data.after.band_override_reason).toBe('Kiosk-style room let for living');
  });

  it('resets the band to the default when the unit type changes', async () => {
    const unit = (await read.getProperty(manager, osuId)).blocks[1]!.units[0]!;
    await register.updateUnit(manager, unit.id, { unitType: 'store' });
    expect(await read.getUnit(manager, unit.id)).toMatchObject({
      unitType: 'store',
      billingBand: 'commercial',
      bandOverridden: false,
    });
  });
});

describe('PR-06 unit status', () => {
  it('records every manual change with its reason and the person', async () => {
    const unit = (await read.getProperty(manager, legonId)).blocks[0]!.units[0]!;
    await register.setAvailability(manager, unit.id, {
      availability: 'under_repair',
      reason: 'Roof leak',
    });
    await expect(
      register.setAvailability(manager, unit.id, {
        availability: 'not_lettable',
        reason: 'Condemned',
      }),
    ).rejects.toThrow(/made available first/);
    await expect(
      register.setAvailability(manager, unit.id, { availability: 'available', reason: '' }),
    ).rejects.toThrow(/reason/);
    const detail = await read.getUnit(manager, unit.id);
    expect(detail.status).toBe('under_repair');
    expect(
      detail.history.map((h) => [h.fromValue, h.toValue, h.reason, h.source, h.actorName]),
    ).toEqual([
      ['available', 'under_repair', 'Roof leak', 'manual', 'Manager'],
      [null, 'available', null, 'created', 'Manager'],
    ]);
  });
});

describe('PR-03 addresses', () => {
  it('normalises the GhanaPost GPS address and checks the region', async () => {
    expect((await read.getProperty(manager, legonId)).address.ghanapostGps).toBe('GA-000-0001');
    await expect(
      register.createProperty(manager, {
        areaCode: 'ACC',
        propertyPart: 'BAD',
        name: 'Bad address',
        propertyType: 'house',
        use: 'residential',
        ownerId: ownerA,
        address: { region: 'Lagos' },
      }),
    ).rejects.toMatchObject({ code: 'address_region' });
  });

  it('looks addresses up through the adapter, and keeps manual entry when there is none', async () => {
    expect(await register.lookupAddress(manager, 'ga-000-0002')).toMatchObject({
      available: true,
      address: { code: 'GA-000-0002' },
    });
    expect(await register.lookupAddress(manager, 'GA-999-9999')).toEqual({
      available: true,
      address: null,
    });
    const off = new RegisterService(ctx.database, new PolicyService(), owners, ctx.clock, null);
    expect(await off.lookupAddress(manager, 'GA-000-0002')).toEqual({
      available: false,
      address: null,
    });
  });
});

describe('PR-05 meters', () => {
  it('lets a shared meter serve several units, and a prepaid meter only one', async () => {
    const units = (await read.getProperty(manager, legonId)).blocks[0]!.units;
    const shared = await meters.add(manager, legonId, {
      utility: 'water',
      supplier: 'Ghana Water',
      meterNumber: 'w-100',
      meterType: 'shared',
      unitIds: [units[0]!.id, units[1]!.id, units[2]!.id],
    });
    await expect(
      meters.add(manager, legonId, {
        utility: 'electricity',
        supplier: 'ECG',
        meterNumber: 'P-1',
        meterType: 'prepaid',
        unitIds: [units[0]!.id, units[1]!.id],
      }),
    ).rejects.toThrow(/shared/);
    const unit = await read.getUnit(manager, units[1]!.id);
    expect(unit.meters).toEqual([
      expect.objectContaining({ id: shared, meterNumber: 'W-100', unitIds: expect.any(Array) }),
    ]);
  });
});

describe('AD-02 owner scope', () => {
  it("shows an agency's client owner only their own properties and units", async () => {
    const { rows, counts } = await read.listUnits(clientOwnerA, { limit: 500 });
    expect(new Set(rows.map((r) => r.propertyCode))).toEqual(new Set(['ACC-LEG']));
    expect(counts.vacant + counts.under_repair).toBe(rows.length);
    await expect(read.getProperty(clientOwnerA, osuId)).rejects.toMatchObject({ status: 404 });
    expect((await owners.list(clientOwnerA)).map((o) => o.id)).toEqual([ownerA]);
  });

  it('forbids a client owner from changing the register', async () => {
    await expect(register.archiveProperty(clientOwnerA, legonId)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('AD-02 caretaker scope', () => {
  it('shows a caretaker only the assigned property, and no owners', async () => {
    const { rows } = await read.listProperties(caretaker);
    expect(rows.map((r) => r.code)).toEqual(['ACC-OSU']);
    expect(rows[0]!.owner).toBeNull();
    await expect(read.getProperty(caretaker, legonId)).rejects.toMatchObject({ status: 404 });
    await expect(owners.list(caretaker)).rejects.toMatchObject({ status: 403 });
  });
});

describe('PR-01 portfolio list', () => {
  it('filters across owners, with counts that follow every filter but status', async () => {
    const all = await read.listUnits(manager, { limit: 500 });
    expect(new Set(all.rows.map((r) => r.owner?.displayName))).toEqual(
      new Set(['Ama Mensah', 'Osu Holdings Ltd']),
    );
    const shops = await read.listUnits(manager, { unitType: 'shop' });
    expect(shops.rows.every((r) => r.unitType === 'shop')).toBe(true);
    const repairs = await read.listUnits(manager, { ownerId: ownerA, status: 'under_repair' });
    expect(repairs.total).toBe(1);
    expect(repairs.counts.under_repair).toBe(1);
    expect(repairs.counts.vacant).toBeGreaterThan(0);
  });

  it('lists 5,000 units with counts quickly', async () => {
    const bulkOwner = (await owners.create(admin, { kind: 'company', displayName: 'Bulk Estates' }))
      .id;
    const blocks = Array.from({ length: 25 }, (_, i) => ({
      code: `B${i + 1}`,
      units: [{ unitType: 'single_room' as const, count: 200 }],
    }));
    await register.createProperty(admin, {
      areaCode: 'TEM',
      propertyPart: 'BLK',
      name: 'Bulk estate',
      propertyType: 'gated_estate',
      use: 'residential',
      ownerId: bulkOwner,
      address: { region: 'Greater Accra' },
      blocks,
    });
    await read.listUnits(manager, { ownerId: bulkOwner });
    const timings: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const result = await read.listUnits(manager, { ownerId: bulkOwner, status: 'vacant' });
      timings.push(performance.now() - started);
      expect(result.total).toBe(5_000);
    }
    timings.sort((a, b) => a - b);
    expect(timings[1]).toBeLessThan(300);
  });
});

describe('AD-02 owners', () => {
  it("creates a landlord's own owner record with the first property", async () => {
    const landlordId = await company(ctx, 'landlord', 'Tema Landlord');
    const owner = await staffIn(landlordId, 'landlord', 'owner', 'Landlord');
    const id = await register.createProperty(owner, {
      areaCode: 'TEM',
      propertyPart: 'EST',
      name: 'Tema estate house',
      propertyType: 'gated_estate',
      use: 'residential',
      address: { region: 'Greater Accra', town: 'Tema' },
      units: [{ unitType: 'detached_house', count: 1, bedrooms: 4 }],
    });
    const detail = await read.getProperty(owner, id);
    expect(detail.owner).toMatchObject({ reference: 'OWN-01', displayName: 'Tema Landlord' });
    expect(detail.blocks[0]!.units[0]!.code).toBe('TEM-EST-B1-01');
  });

  it('keeps the ownership history when a property changes owner, and refuses an earlier date', async () => {
    await expect(
      register.changeOwner(admin, osuId, { ownerId: ownerA, effectiveFrom: '2020-01-01' }),
    ).rejects.toMatchObject({ code: 'ownership_date' });
    await register.changeOwner(admin, osuId, { ownerId: ownerA, effectiveFrom: '2099-01-01' });
    const detail = await read.getProperty(admin, osuId);
    expect(detail.ownership.map((o) => [o.displayName, o.current])).toEqual([
      ['Ama Mensah', false],
      ['Osu Holdings Ltd', true],
    ]);
    const rows = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.propertyOwnership),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to archive an owner who still owns a property', async () => {
    await expect(register.archiveOwner(admin, ownerB)).rejects.toMatchObject({
      code: 'owner_has_properties',
    });
  });
});

describe('AD-07 register audit', () => {
  it("records an owner's contact details only as changed, never their values", async () => {
    await owners.update(admin, ownerB, { phone: '024 412 3456', email: 'owner.b@example.invalid' });
    const rows = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ data: string }>(
          sql`select data::text as data from audit_event where record_type = 'owner' and record_id = ${ownerB} order by seq desc limit 1`,
        ),
    );
    const data = rows.rows[0]!.data;
    expect(data).not.toContain('244123456');
    expect(data).not.toContain('owner.b@example.invalid');
    expect(JSON.parse(data)).toMatchObject({ redacted_changed: ['phone', 'email'] });
  });
});
