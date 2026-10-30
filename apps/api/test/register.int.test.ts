import { schema, sql, withCompany } from '@rent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let agencyId: string;
let admin: Device;
let manager: Device;
let clientOwner: Device;
let clientMembership: string;
let ownerA: string;
let ownerB: string;
let legon: { id: string; blocks: { units: { id: string; code: string }[] }[] };
let osuId: string;

async function signedIn(email: string, role: 'agency_admin' | 'property_manager' | 'owner') {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  const membershipId = await addMembership(api, agencyId, personId, role);
  return { device: (await enrolStaff(api, email, PASSWORD)).device, membershipId };
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Register API Agency');
  admin = (await signedIn('admin@register.invalid', 'agency_admin')).device;
  manager = (await signedIn('manager@register.invalid', 'property_manager')).device;
  const client = await signedIn('client@register.invalid', 'owner');
  clientOwner = client.device;
  clientMembership = client.membershipId;
  ownerA = String(
    (await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner A' } })).json.id,
  );
  ownerB = String(
    (await admin.call('/owners', { body: { kind: 'company', displayName: 'Owner B Ltd' } })).json
      .id,
  );
  // The client owner sees Owner B's properties only (AD-02).
  await withCompany(api.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.membership)
      .set({ scope: { owners: [ownerB] } })
      .where(sql`${schema.membership.id} = ${clientMembership}`),
  );
});

afterAll(async () => {
  await api?.close();
});

describe('PR-01 register over HTTP', () => {
  it('creates a property with its units in one call, coded in the PRD pattern', async () => {
    const created = await manager.call('/properties', {
      body: {
        areaCode: 'acc',
        propertyPart: 'leg',
        name: 'Legon compound house',
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: ownerA,
        address: { region: 'Greater Accra', town: 'Legon', ghanapostGps: 'ga-000-0001' },
        units: [
          { unitType: 'single_room', count: 6 },
          { unitType: 'chamber_and_hall', count: 6 },
        ],
      },
    });
    expect(created.status).toBe(200);
    legon = created.json as typeof legon;
    expect(created.json).toMatchObject({
      code: 'ACC-LEG',
      unitCount: 12,
      owner: { displayName: 'Owner A' },
    });
    expect(legon.blocks[0]!.units.at(-1)!.code).toBe('ACC-LEG-B1-12');
    const osu = await manager.call('/properties', {
      body: {
        areaCode: 'ACC',
        propertyPart: 'OSU',
        name: 'Osu shops',
        propertyType: 'shop',
        use: 'commercial',
        ownerId: ownerB,
        address: { region: 'Greater Accra' },
        units: [{ unitType: 'shop', count: 2 }],
      },
    });
    expect(osu.status).toBe(200);
    osuId = String(osu.json.id);
  });

  it('lists units across owners with counts, and refuses a taken code with 409', async () => {
    const units = await manager.call('/units?status=vacant&limit=5');
    expect(units.status).toBe(200);
    expect(units.json).toMatchObject({ total: 14, counts: { vacant: 14, occupied: 0 } });
    expect((units.json.rows as unknown[]).length).toBe(5);
    const taken = await manager.call('/properties', {
      body: {
        areaCode: 'ACC',
        propertyPart: 'LEG',
        name: 'Again',
        propertyType: 'house',
        use: 'residential',
        ownerId: ownerA,
        address: { region: 'Greater Accra' },
      },
    });
    expect(taken.status).toBe(409);
    expect(taken.json).toMatchObject({ code: 'PROPERTY_CODE_TAKEN' });
    // The free code comes as data, so a screen can offer it without reading the message.
    expect(taken.json).toMatchObject({ data: { suggestedCode: 'ACC-LEG2' } });
  });
});

describe('PB-01 billing bands over HTTP', () => {
  it('forbids a manager and lets an agency admin override with a reason', async () => {
    const unitId = legon.blocks[0]!.units[0]!.id;
    const body = { band: 'commercial', reason: 'Front room let as a barber shop' };
    expect((await manager.call(`/units/${unitId}/band`, { body })).status).toBe(403);
    const changed = await admin.call(`/units/${unitId}/band`, { body });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ billingBand: 'commercial', bandOverridden: true });
  });
});

describe('PR-06 unit status over HTTP', () => {
  it('needs a reason, and records the change in the history', async () => {
    const unitId = legon.blocks[0]!.units[1]!.id;
    expect(
      (
        await manager.call(`/units/${unitId}/availability`, {
          body: { availability: 'under_repair', reason: '' },
        })
      ).status,
    ).toBe(400);
    const changed = await manager.call(`/units/${unitId}/availability`, {
      body: { availability: 'under_repair', reason: 'Burst pipe' },
    });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ status: 'under_repair' });
    expect((changed.json.history as { reason: string | null }[])[0]!.reason).toBe('Burst pipe');
    const occupied = await manager.call(`/units/${unitId}/availability`, {
      body: { availability: 'occupied', reason: 'Tenant moved in' },
    });
    expect(occupied.status).toBe(400);
  });
});

describe('AD-02 owner scope over HTTP', () => {
  it("shows a client owner only their owner's properties and units", async () => {
    const properties = await clientOwner.call('/properties');
    expect(properties.status).toBe(200);
    expect((properties.json.rows as { id: string }[]).map((p) => p.id)).toEqual([osuId]);
    expect((await clientOwner.call(`/properties/${legon.id}`)).status).toBe(404);
    const units = await clientOwner.call('/units');
    expect(units.json).toMatchObject({ total: 2 });
    const owners = await clientOwner.call('/owners');
    expect((owners.json as unknown as { id: string }[]).map((o) => o.id)).toEqual([ownerB]);
  });

  it('forbids a client owner from changing the register', async () => {
    expect((await clientOwner.call(`/properties/${osuId}/archive`, { body: {} })).status).toBe(403);
  });
});

describe('PR-08 and PR-03 over HTTP', () => {
  it('serves the import template as a workbook', async () => {
    const template = await manager.call('/register-imports/template');
    expect(template.status).toBe(200);
    expect(template.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('reports the address lookup as unavailable without a licensed source', async () => {
    const lookup = await manager.call('/address-lookup?code=GA-000-0001');
    expect(lookup.status).toBe(200);
    expect(lookup.json).toEqual({ available: false, address: null });
  });
});
