import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GLOBAL_TABLES } from './append-only';
import { createDatabase } from './client';
import { withCompany } from './context';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import {
  connect,
  createCompany,
  createMembership,
  createPerson,
  inContext,
  sqlState,
} from './testing/fixtures';

let db: TestDatabase;
let app: pg.Client;
let companyA: string;
let companyB: string;
const membershipOf: Record<string, string> = {};
const personOf: Record<string, string> = {};

/** One row in every company-scoped table, written through the application role. */
async function seedCompany(companyId: string) {
  const initiator = await createPerson(app, `initiator ${companyId}`);
  const approver = await createPerson(app, `approver ${companyId}`);
  const initiatorMembership = await createMembership(app, companyId, initiator);
  const approverMembership = await createMembership(app, companyId, approver);
  membershipOf[companyId] = initiatorMembership;
  personOf[companyId] = initiator;
  const zero = '0'.repeat(64);
  await inContext(app, { companyId, personId: initiator }, async () => {
    await app.query(
      "insert into company_key (company_id, purpose, version, wrapped_key, kms_key_id) values ($1, 'field_encryption', 1, '\\x00', 'test')",
      [companyId],
    );
    const { rows: docs } = await app.query<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'test', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
      [companyId, zero],
    );
    const { rows: requests } = await app.query<{ id: string }>(
      `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
         initiator_membership_id, mode, status, expires_at)
       values ($1, 'test.action', 'test', 's1', '{}', 'h', $2, $3, 'two_person', 'pending', now() + interval '1 day') returning id`,
      [companyId, initiator, initiatorMembership],
    );
    await app.query(
      "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
      [companyId, requests[0]!.id, approver, approverMembership],
    );
    await app.query(
      "insert into outbox_event (company_id, type, payload, idempotency_key) values ($1, 'test.event', '{}', 'k1')",
      [companyId],
    );
    await app.query(
      "insert into processed_job (company_id, key, job_name) values ($1, 'job-1', 'test')",
      [companyId],
    );
    await app.query(
      "insert into document_render_request (company_id, template_key, template_version, data, document_id) values ($1, 'system.sample', 1, '{}', $2)",
      [companyId, docs[0]!.id],
    );
    await app.query(
      "insert into upload_intent (company_id, purpose, storage_key, content_type, max_bytes, created_by, expires_at) values ($1, 'logo', 'k', 'image/png', 1000, $2, now() + interval '1 hour')",
      [companyId, initiator],
    );
    await app.query(
      "insert into audit_anchor (company_id, anchor_date, seq, hash, storage_key, object_sha256) values ($1, current_date, 1, '\\x00', 'k', $2)",
      [companyId, zero],
    );
    // The register (M2). The unit's status history row comes from its trigger.
    const { rows: owners } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-01', 'individual', 'Owner') returning id",
      [companyId],
    );
    const { rows: portfolios } = await app.query<{ id: string }>(
      "insert into portfolio (company_id, name, is_default) values ($1, 'Main portfolio', true) returning id",
      [companyId],
    );
    const { rows: properties } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, 'ACC-LEG', 'ACC', 'Legon', 'compound_house', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolios[0]!.id],
    );
    const propertyId = properties[0]!.id;
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, propertyId, owners[0]!.id],
    );
    const { rows: blocks } = await app.query<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, propertyId],
    );
    const { rows: units } = await app.query<{ id: string }>(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, 'ACC-LEG-B1-01', '01', 'single_room', 'single_room') returning id`,
      [companyId, propertyId, blocks[0]!.id],
    );
    const { rows: meters } = await app.query<{ id: string }>(
      "insert into meter (company_id, property_id, utility, supplier, meter_number, meter_type) values ($1, $2, 'electricity', 'ECG', 'P-0001', 'prepaid') returning id",
      [companyId, propertyId],
    );
    await app.query(
      'insert into unit_meter (company_id, property_id, meter_id, unit_id) values ($1, $2, $3, $4)',
      [companyId, propertyId, meters[0]!.id, units[0]!.id],
    );
    await app.query(
      "insert into property_file (company_id, property_id, category, upload_intent_id, uploaded_by) values ($1, $2, 'photo', gen_random_uuid(), $3)",
      [companyId, propertyId, initiator],
    );
    await app.query(
      "insert into register_import (company_id, upload_intent_id, storage_key, created_by) values ($1, gen_random_uuid(), 'k', $2)",
      [companyId, initiator],
    );
  });
}

async function companyScopedTables(): Promise<string[]> {
  const rows = await runSql<{ table_name: string }>(
    db.ownerUrl,
    `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'company_id'
     union select 'company' order by 1`,
  );
  return rows.map((r) => r.table_name);
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyA = await createCompany(app, 'Company A');
  companyB = await createCompany(app, 'Company B');
  await seedCompany(companyA);
  await seedCompany(companyB);
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('NFR-SEC RLS coverage', () => {
  it('forces RLS with a policy on every company-scoped table, and classifies every table', async () => {
    const tables = await runSql<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: number;
      has_company_id: boolean;
    }>(
      db.ownerUrl,
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') as has_company_id
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      if ((GLOBAL_TABLES as readonly string[]).includes(t.relname)) {
        expect(t.has_company_id, `${t.relname} is global but has company_id`).toBe(false);
        continue;
      }
      expect(
        t.has_company_id || t.relname === 'company',
        `${t.relname} has no company_id and is not listed as global`,
      ).toBe(true);
      expect(t.rls, `${t.relname}: RLS enabled`).toBe(true);
      expect(t.forced, `${t.relname}: RLS forced`).toBe(true);
      expect(t.policies, `${t.relname}: has a policy`).toBeGreaterThan(0);
    }
  });

  it('runs the application as a role that owns nothing and cannot bypass RLS', async () => {
    const [role] = await runSql<{ rolbypassrls: boolean; rolsuper: boolean }>(
      db.ownerUrl,
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'rent_app'",
    );
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await runSql(
      db.ownerUrl,
      "select tablename from pg_tables where tableowner = 'rent_app'",
    );
    expect(owned).toEqual([]);
    const [system] = await runSql<{ rolcanlogin: boolean }>(
      db.ownerUrl,
      "select rolcanlogin from pg_roles where rolname = 'rent_system'",
    );
    expect(system!.rolcanlogin).toBe(false);
  });
});

describe('NFR-SEC RLS isolation', () => {
  it("reads zero rows of company B from every table with company A's context, using raw SQL", async () => {
    for (const table of await companyScopedTables()) {
      const column = table === 'company' ? 'id' : 'company_id';
      await inContext(app, { companyId: companyA }, async () => {
        const other = await app.query<{ n: number }>(
          `select count(*)::int as n from ${table} where ${column} = $1`,
          [companyB],
        );
        expect(other.rows[0]!.n, `${table} leaks company B`).toBe(0);
        const all = await app.query<{ n: number; foreign: number }>(
          `select count(*)::int as n, count(*) filter (where ${column} <> $1)::int as foreign from ${table}`,
          [companyA],
        );
        expect(
          all.rows[0]!.n,
          `${table} has no fixture row for company A; add one to seedCompany`,
        ).toBeGreaterThan(0);
        expect(all.rows[0]!.foreign, table).toBe(0);
      });
    }
  });

  it('returns nothing at all without a company context (RLS fails closed)', async () => {
    for (const table of await companyScopedTables()) {
      await inContext(app, {}, async () => {
        const { rows } = await app.query<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(rows[0]!.n, table).toBe(0);
      });
    }
  });

  it("refuses to write another company's id", async () => {
    const attempts = [
      [
        'membership',
        `insert into membership (company_id, person_id, role) values ($1, '${personOf[companyA]}', 'caretaker')`,
      ],
      [
        'outbox_event',
        "insert into outbox_event (company_id, type, payload, idempotency_key) values ($1, 'x', '{}', 'k-cross')",
      ],
      [
        'processed_job',
        "insert into processed_job (company_id, key, job_name) values ($1, 'cross', 'x')",
      ],
    ] as const;
    for (const [table, statement] of attempts) {
      const state = await sqlState(
        inContext(app, { companyId: companyA }, () => app.query(statement, [companyB])),
      );
      expect(state, table).toBe('42501');
    }
  });

  it("cannot point a foreign key at another company's row", async () => {
    const state = await sqlState(
      inContext(app, { companyId: companyA, personId: personOf[companyA] }, () =>
        app.query(
          `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
             initiator_membership_id, mode, status, expires_at)
           values ($1, 'test.action', 'test', 's2', '{}', 'h', $2, $3, 'two_person', 'pending', now() + interval '1 day')`,
          [companyA, personOf[companyA], membershipOf[companyB]],
        ),
      ),
    );
    expect(state).toBe('23503');
  });
});

describe('NFR-SEC company context', () => {
  it('does not survive the transaction on a pooled connection', async () => {
    const database = createDatabase(db.appUrl, { max: 1 });
    try {
      const inside = await withCompany(
        database,
        { companyId: companyA, actorKind: 'system' },
        async (tx) => {
          const result = await tx.execute<{ company: string }>(
            sql`select current_setting('app.company_id', true) as company`,
          );
          return result.rows[0]!.company;
        },
      );
      expect(inside).toBe(companyA);
      const after = await database.pool.query<{ company: string | null; n: number }>(
        "select current_setting('app.company_id', true) as company, (select count(*)::int from membership) as n",
      );
      expect(after.rows[0]!.company ?? '').toBe('');
      expect(after.rows[0]!.n).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('refuses a context that is not a UUID', async () => {
    const database = createDatabase(db.appUrl, { max: 1 });
    try {
      await expect(
        withCompany(database, { companyId: "x' or '1'='1", actorKind: 'system' }, async () => 1),
      ).rejects.toThrow('UUID');
    } finally {
      await database.close();
    }
  });
});
