import { schema, sql, withCompany } from '@rent/db';
import { MAX_UNITS_PER_REQUEST } from '@rent/domain/portfolio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  owner as asOwner,
  startApi,
  type Device,
  type TestApi,
} from './support';

const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let agencyId: string;
let admin: Device;
let manager: Device;
let accountant: Device;
let scopedAccountant: Device;
let scopedManager: Device;
let ownerA: string;
let ownerB: string;
let legonId: string;

type Role = 'agency_admin' | 'property_manager' | 'accountant';

async function signedIn(email: string, role: Role, scope?: { owners: string[] }) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  const membershipId = await addMembership(api, agencyId, personId, role);
  const device = (await enrolStaff(api, email, PASSWORD)).device;
  if (scope)
    await withCompany(api.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.membership)
        .set({ scope })
        .where(sql`${schema.membership.id} = ${membershipId}`),
    );
  return device;
}

const property = (code: string, ownerId: string, extra: object = {}) => {
  const [areaCode, propertyPart] = code.split('-');
  return {
    areaCode,
    propertyPart,
    name: `Property ${code}`,
    propertyType: 'house',
    use: 'residential',
    ownerId,
    address: { region: 'Greater Accra' },
    ...extra,
  };
};

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Scope API Agency');
  admin = await signedIn('admin@scope.invalid', 'agency_admin');
  manager = await signedIn('manager@scope.invalid', 'property_manager');
  accountant = await signedIn('accountant@scope.invalid', 'accountant');
  ownerA = String(
    (await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner A' } })).json.id,
  );
  ownerB = String(
    (await admin.call('/owners', { body: { kind: 'company', displayName: 'Owner B Ltd' } })).json
      .id,
  );
  scopedAccountant = await signedIn('scoped.accountant@scope.invalid', 'accountant', {
    owners: [ownerA],
  });
  scopedManager = await signedIn('scoped.manager@scope.invalid', 'property_manager', {
    owners: [ownerA],
  });
  legonId = String(
    (await admin.call('/properties', { body: property('ACC-LEG', ownerA) })).json.id,
  );
  await admin.call('/properties', { body: property('ACC-OSU', ownerB) });
});

afterAll(async () => {
  await api?.close();
});

describe('AD-07 audit search scope (API)', () => {
  it('refuses the audit log to a scoped accountant with a clear message, and serves an unscoped one', async () => {
    const refused = await scopedAccountant.call('/audit-events?limit=5');
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({
      code: 'FORBIDDEN',
      message:
        'The audit log covers the whole company, so it is not open to people limited to some owners or properties',
    });
    expect((await accountant.call('/audit-events?limit=5')).status).toBe(200);
  });
});

describe('AD-02 scoped property creation (API)', () => {
  it('lets a manager scoped to Owner A add a property for Owner A, and refuses one for Owner B with 403', async () => {
    const created = await scopedManager.call('/properties', {
      body: property('ACC-AAA', ownerA, { units: [{ unitType: 'studio', count: 2 }] }),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json).toMatchObject({ code: 'ACC-AAA', unitCount: 2 });
    const refused = await scopedManager.call('/properties', { body: property('ACC-BBB', ownerB) });
    expect(refused.status).toBe(403);
    expect((await admin.call('/properties?search=ACC-BBB')).json).toMatchObject({ rows: [] });
  });
});

describe('PR-01 conflicts over HTTP', () => {
  it('answers a property code taken at the same moment with 409, never 500', async () => {
    for (const code of ['ACC-RC1', 'ACC-RC2', 'ACC-RC3']) {
      const responses = await Promise.all([
        manager.call('/properties', { body: property(code, ownerA) }),
        manager.call('/properties', { body: property(code, ownerA) }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.json).toMatchObject({
        code: 'PROPERTY_CODE_TAKEN',
      });
    }
  });

  it('answers a code taken by a property outside the scope with 409', async () => {
    const taken = await scopedManager.call('/properties', { body: property('ACC-OSU', ownerA) });
    expect(taken.status).toBe(409);
    expect(taken.json).toMatchObject({ code: 'PROPERTY_CODE_TAKEN' });
  });

  it('turns a commit-time register check into a 409 with a safe message', async () => {
    // Stands in for the race RA014 guards: a second unit linked to a prepaid meter at commit.
    await asOwner(
      api,
      `create function test_meter_check() returns trigger language plpgsql as $$
       begin raise exception 'meter % secret internal detail', new.id using errcode = 'RA014'; end $$;
       create constraint trigger test_meter_check after insert on meter
         deferrable initially deferred for each row execute function test_meter_check();`,
    );
    try {
      const response = await manager.call(`/properties/${legonId}/meters`, {
        body: {
          utility: 'water',
          supplier: 'Ghana Water',
          meterNumber: 'W-RA14',
          meterType: 'shared',
        },
      });
      expect(response.status).toBe(409);
      expect(response.json).toMatchObject({ code: 'METER_NOT_SHARED' });
      expect(JSON.stringify(response.json)).not.toContain('secret');
    } finally {
      await asOwner(
        api,
        'drop trigger if exists test_meter_check on meter; drop function if exists test_meter_check()',
      );
    }
  });

  it('maps a unique key no service expected to a 409, and hides an unknown database error', async () => {
    await asOwner(
      api,
      `create unique index test_portfolio_upper on portfolio (company_id, upper(name));
       create function test_portfolio_fail() returns trigger language plpgsql as $$
       begin
         if new.name = 'Broken' then raise exception 'secret internal detail' using errcode = 'XX999'; end if;
         return new;
       end $$;
       create trigger test_portfolio_fail before insert on portfolio
         for each row execute function test_portfolio_fail();`,
    );
    try {
      expect((await admin.call('/portfolios', { body: { name: 'Coastal' } })).status).toBe(200);
      const clash = await admin.call('/portfolios', { body: { name: 'COASTAL' } });
      expect(clash.status).toBe(409);
      expect(clash.json).toMatchObject({ code: 'CHANGED_MEANWHILE' });
      expect(JSON.stringify(clash.json)).not.toContain('test_portfolio_upper');
      const broken = await admin.call('/portfolios', { body: { name: 'Broken' } });
      expect(broken.status).toBe(500);
      expect(JSON.stringify(broken.json)).not.toContain('secret');
    } finally {
      await asOwner(
        api,
        `drop trigger if exists test_portfolio_fail on portfolio;
         drop function if exists test_portfolio_fail();
         drop index if exists test_portfolio_upper;`,
      );
    }
  });
});

describe('PR-01 bulk creation limits (API)', () => {
  it(`refuses more than ${MAX_UNITS_PER_REQUEST} units in one request`, async () => {
    const blocks = Array.from({ length: 26 }, (_, i) => ({
      code: `B${i + 1}`,
      units: [{ unitType: 'single_room', count: 200 }],
    }));
    const refused = await manager.call('/properties', {
      body: property('ACC-BIG', ownerA, { blocks }),
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json)).toContain('Add at most 5,000 units at a time');
    expect((await admin.call('/properties?search=ACC-BIG')).json).toMatchObject({ rows: [] });
  });
});
