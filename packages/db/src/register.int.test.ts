import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { withCompany } from './context';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import { connect, createCompany, createPerson, inContext, sqlState } from './testing/fixtures';

let db: TestDatabase;
let app: pg.Client;
let database: Database;
let agency: string;
let staffId: string;
const ownerOf: Record<string, string> = {};
const propertyOf: Record<string, string> = {};
const blockOf: Record<string, string> = {};
const unitOf: Record<string, string> = {};

/** A property with one owner, one block and one unit, written as rent_app. */
async function addProperty(code: string, ownerRef: string, portfolioId: string) {
  return inContext(app, { companyId: agency, personId: staffId }, async () => {
    if (!ownerOf[ownerRef]) {
      const { rows } = await app.query<{ id: string }>(
        "insert into owner (company_id, reference, kind, display_name) values ($1, $2, 'individual', $2) returning id",
        [agency, ownerRef],
      );
      ownerOf[ownerRef] = rows[0]!.id;
    }
    const { rows: properties } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, $3, split_part($3, '-', 1), $3, 'compound_house', 'residential', 'Greater Accra') returning id`,
      [agency, portfolioId, code],
    );
    propertyOf[code] = properties[0]!.id;
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [agency, propertyOf[code], ownerOf[ownerRef]],
    );
    const { rows: blocks } = await app.query<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [agency, propertyOf[code]],
    );
    blockOf[code] = blocks[0]!.id;
    const { rows: units } = await app.query<{ id: string }>(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, $4 || '-B1-01', '01', 'single_room', 'single_room') returning id`,
      [agency, propertyOf[code], blockOf[code], code],
    );
    unitOf[code] = units[0]!.id;
  });
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  database = createDatabase(db.appUrl, { max: 2 });
  agency = await createCompany(app, 'Register agency', 'agency');
  staffId = await createPerson(app, 'Register manager');
  const portfolioId = await inContext(app, { companyId: agency }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into portfolio (company_id, name, is_default) values ($1, 'Main portfolio', true) returning id",
      [agency],
    );
    return rows[0]!.id;
  });
  await addProperty('ACC-LEG', 'OWN-A', portfolioId);
  await addProperty('ACC-ELG', 'OWN-A', portfolioId);
  await addProperty('ACC-OSU', 'OWN-B', portfolioId);
});

afterAll(async () => {
  await app.end();
  await database.close();
  await db.drop();
});

const count = (table: string) => sql.raw(`select count(*)::int as n from ${table}`);

describe('AD-02 owner scope in the database', () => {
  it("shows a scoped session only its owners' properties, even without a filter", async () => {
    const seen = await withCompany(
      database,
      {
        companyId: agency,
        actorKind: 'staff',
        scope: { ownerIds: [ownerOf['OWN-A']!], propertyIds: [] },
      },
      async (tx) => {
        const properties = await tx.execute<{ code: string }>(
          sql`select code from property order by code`,
        );
        const units = await tx.execute<{ n: number }>(count('unit'));
        const owners = await tx.execute<{ reference: string }>(sql`select reference from owner`);
        return {
          properties: properties.rows.map((r) => r.code),
          units: units.rows[0]!.n,
          owners: owners.rows.map((r) => r.reference),
        };
      },
    );
    expect(seen).toEqual({ properties: ['ACC-ELG', 'ACC-LEG'], units: 2, owners: ['OWN-A'] });
  });

  it('shows a caretaker only the assigned property, and no owner records', async () => {
    const seen = await withCompany(
      database,
      {
        companyId: agency,
        actorKind: 'staff',
        scope: { ownerIds: [], propertyIds: [propertyOf['ACC-OSU']!] },
      },
      async (tx) => {
        const tables = [
          'property',
          'block',
          'unit',
          'unit_status_event',
          'property_ownership',
          'owner',
        ];
        const counts: Record<string, number> = {};
        for (const t of tables) counts[t] = (await tx.execute<{ n: number }>(count(t))).rows[0]!.n;
        return counts;
      },
    );
    expect(seen).toEqual({
      property: 1,
      block: 1,
      unit: 1,
      unit_status_event: 1,
      property_ownership: 1,
      owner: 0,
    });
  });

  it('sees nothing when the scope is empty, and everything without a scope', async () => {
    const empty = await withCompany(
      database,
      { companyId: agency, actorKind: 'staff', scope: { ownerIds: [], propertyIds: [] } },
      async (tx) => (await tx.execute<{ n: number }>(count('property'))).rows[0]!.n,
    );
    const all = await withCompany(
      database,
      { companyId: agency, actorKind: 'staff' },
      async (tx) => (await tx.execute<{ n: number }>(count('property'))).rows[0]!.n,
    );
    expect([empty, all]).toEqual([0, 3]);
  });

  it('cannot write outside its scope', async () => {
    const state = await sqlState(
      withCompany(
        database,
        {
          companyId: agency,
          actorKind: 'staff',
          scope: { ownerIds: [ownerOf['OWN-A']!], propertyIds: [] },
        },
        (tx) =>
          tx.execute(
            sql`insert into block (company_id, property_id, code) values (${agency}, ${propertyOf['ACC-OSU']!}, 'B9')`,
          ),
      ),
    );
    expect(state).toBe('42501');
  });
});

describe('PR-01 codes in the database', () => {
  it('refuses to change a code, as rent_app and as the owner role', async () => {
    const asApp = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query("update unit set code = 'ACC-LEG-B1-99' where id = $1", [unitOf['ACC-LEG']]),
      ),
    );
    expect(asApp).toBe('42501');
    const asOwner = await sqlState(
      runSql(
        db.ownerUrl,
        `select set_config('app.company_id', '${agency}', false);
         update unit set code = 'ACC-LEG-B1-99' where id = '${unitOf['ACC-LEG']}'`,
      ),
    );
    expect(asOwner).toBe('RA011');
  });

  it('never deletes a property, block or unit, so a code is never reused', async () => {
    for (const [table, id] of [
      ['unit', unitOf['ACC-LEG']],
      ['block', blockOf['ACC-LEG']],
      ['property', propertyOf['ACC-LEG']],
    ] as const) {
      const state = await sqlState(
        inContext(app, { companyId: agency }, () =>
          app.query(`delete from ${table} where id = $1`, [id]),
        ),
      );
      expect(state, table).toBe('42501');
    }
    const duplicate = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query(
          `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
           values ($1, $2, $3, 'ACC-LEG-B1-01', '01', 'single_room', 'single_room')`,
          [agency, propertyOf['ACC-LEG'], blockOf['ACC-LEG']],
        ),
      ),
    );
    expect(duplicate).toBe('23505');
  });

  it('refuses a unit code that does not match its property, block and label', async () => {
    const state = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query(
          `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
           values ($1, $2, $3, 'ACC-XXX-B1-02', '02', 'single_room', 'single_room')`,
          [agency, propertyOf['ACC-LEG'], blockOf['ACC-LEG']],
        ),
      ),
    );
    expect(state).toBe('RA011');
  });
});

describe('PR-06 unit status history in the database', () => {
  it('records every availability change, with the reason and person, from the trigger', async () => {
    await inContext(app, { companyId: agency, personId: staffId }, async () => {
      await app.query(
        "select set_config('app.status_reason', 'Roof leak', true), set_config('app.status_source', 'manual', true)",
      );
      await app.query("update unit set availability = 'under_repair' where id = $1", [
        unitOf['ACC-ELG'],
      ]);
    });
    const rows = await inContext(app, { companyId: agency }, async () => {
      const { rows } = await app.query<{
        from_value: string | null;
        to_value: string;
        reason: string | null;
        source: string;
        actor_person_id: string | null;
      }>(
        'select from_value, to_value, reason, source, actor_person_id from unit_status_event where unit_id = $1 order by occurred_at, id',
        [unitOf['ACC-ELG']],
      );
      return rows;
    });
    expect(rows).toEqual([
      {
        from_value: null,
        to_value: 'available',
        reason: null,
        source: 'created',
        actor_person_id: staffId,
      },
      {
        from_value: 'available',
        to_value: 'under_repair',
        reason: 'Roof leak',
        source: 'manual',
        actor_person_id: staffId,
      },
    ]);
  });

  it('cannot be written or rewritten by the application, and has no vacant or occupied availability', async () => {
    const insert = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query(
          "insert into unit_status_event (company_id, property_id, unit_id, kind, to_value, source) values ($1, $2, $3, 'occupancy', 'vacant', 'manual')",
          [agency, propertyOf['ACC-LEG'], unitOf['ACC-LEG']],
        ),
      ),
    );
    expect(insert).toBe('42501');
    const update = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query("update unit_status_event set reason = 'x' where unit_id = $1", [
          unitOf['ACC-LEG'],
        ]),
      ),
    );
    expect(update).toBe('42501');
    for (const value of ['vacant', 'occupied']) {
      const state = await sqlState(
        inContext(app, { companyId: agency }, () =>
          app.query('update unit set availability = $2 where id = $1', [unitOf['ACC-LEG'], value]),
        ),
      );
      expect(state, value).toBe('23514');
    }
  });
});

describe('AD-02 ownership shares in the database (PR-07 ready)', () => {
  it('refuses ownership that does not add up to the whole property, at commit', async () => {
    const half = await sqlState(
      inContext(app, { companyId: agency }, () =>
        app.query(
          'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 5000, current_date + 1)',
          [agency, propertyOf['ACC-LEG'], ownerOf['OWN-B']],
        ),
      ),
    );
    expect(half).toBe('RA012');
    const joint = await sqlState(
      inContext(app, { companyId: agency }, async () => {
        for (const [ref, share] of [
          ['OWN-A', 6000],
          ['OWN-B', 4000],
        ] as const)
          await app.query(
            'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, $4, current_date + 2)',
            [agency, propertyOf['ACC-OSU'], ownerOf[ref], share],
          );
      }),
    );
    expect(joint).toBeNull();
  });

  it('refuses a property with no owner', async () => {
    const state = await sqlState(
      inContext(app, { companyId: agency }, async () => {
        const { rows } = await app.query<{ id: string }>(
          'select id from portfolio where company_id = $1 limit 1',
          [agency],
        );
        await app.query(
          `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
           values ($1, $2, 'ACC-NEW', 'ACC', 'Orphan', 'house', 'residential', 'Greater Accra')`,
          [agency, rows[0]!.id],
        );
      }),
    );
    expect(state).toBe('RA013');
  });
});

describe('PR-05 meter links in the database', () => {
  it('lets only a shared meter serve two units', async () => {
    const second = await inContext(app, { companyId: agency }, async () => {
      const { rows } = await app.query<{ id: string }>(
        `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
         values ($1, $2, $3, 'ACC-LEG-B1-02', '02', 'single_room', 'single_room') returning id`,
        [agency, propertyOf['ACC-LEG'], blockOf['ACC-LEG']],
      );
      return rows[0]!.id;
    });
    const link = (type: string, number: string) =>
      sqlState(
        inContext(app, { companyId: agency }, async () => {
          const { rows } = await app.query<{ id: string }>(
            "insert into meter (company_id, property_id, utility, supplier, meter_number, meter_type) values ($1, $2, 'water', 'Ghana Water', $3, $4) returning id",
            [agency, propertyOf['ACC-LEG'], number, type],
          );
          for (const unitId of [unitOf['ACC-LEG'], second])
            await app.query(
              'insert into unit_meter (company_id, property_id, meter_id, unit_id) values ($1, $2, $3, $4)',
              [agency, propertyOf['ACC-LEG'], rows[0]!.id, unitId],
            );
        }),
      );
    expect(await link('postpaid', 'W-1')).toBe('RA014');
    expect(await link('shared', 'W-2')).toBeNull();
  });
});

describe('NFR-SEC scope policy coverage', () => {
  it('has the restrictive property_scope policy on every register table, and owner_scope on owner', async () => {
    const policies = await runSql<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      db.ownerUrl,
      `select tablename, policyname, permissive, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and policyname in ('property_scope', 'owner_scope')`,
    );
    const policyOn = (table: string, name: string) =>
      policies.find((p) => p.tablename === table && p.policyname === name);
    const scoped: Record<string, string> = {
      property: 'id',
      property_ownership: 'property_id',
      block: 'property_id',
      unit: 'property_id',
      unit_status_event: 'property_id',
      meter: 'property_id',
      unit_meter: 'property_id',
      property_file: 'property_id',
    };
    for (const [table, column] of Object.entries(scoped)) {
      // Restrictive, for every command, and without WITH CHECK, so the same test guards writes.
      expect(policyOn(table, 'property_scope'), table).toEqual({
        tablename: table,
        policyname: 'property_scope',
        permissive: 'RESTRICTIVE',
        cmd: 'ALL',
        qual: `app.in_property_scope(${column})`,
        with_check: null,
      });
    }
    expect(policyOn('owner', 'owner_scope')).toEqual({
      tablename: 'owner',
      policyname: 'owner_scope',
      permissive: 'RESTRICTIVE',
      cmd: 'ALL',
      qual: 'app.in_owner_scope(id)',
      with_check: null,
    });
  });
});
