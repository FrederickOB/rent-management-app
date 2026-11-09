import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import {
  connect,
  createCompany,
  createMembership,
  createPerson,
  inContext,
  sqlState,
} from './testing/fixtures';

/**
 * ★ AD-10 (M10 decision 13; plan section 6): support access without the customer's recorded
 * consent is refused by the database, whatever the code does. `app.current_company_id()`, which
 * every RLS policy compares with, is null for a platform admin in any company but the platform's
 * unless that company has an active support grant; for every other actor kind it is unchanged.
 * Raw SQL, as the application role, on real PostgreSQL with RLS forced.
 */
let db: TestDatabase;
let app: pg.Client;
let platform: string;
let customer: string;
let other: string;
let admin: string;
let impostor: string;
let customerOwner: string;
let otherOwner: string;

type Kind = 'staff' | 'tenant' | 'system' | 'link' | 'platform_admin' | '';

/** Every table under forced RLS: the company-scoped tables, platform company tables included. */
async function rlsTables(): Promise<string[]> {
  const rows = await runSql<{ relname: string }>(
    db.ownerUrl,
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
       and c.relforcerowsecurity
     order by 1`,
  );
  return rows.map((r) => r.relname);
}

/** Each table's visible row count in one transaction with this context. */
async function visibleCounts(
  ctx: { companyId: string; personId?: string; actorKind: Kind },
  tables: readonly string[],
): Promise<Record<string, number>> {
  return inContext(app, ctx, async () => {
    const out: Record<string, number> = {};
    for (const table of tables) {
      const { rows } = await app.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      out[table] = rows[0]!.n;
    }
    return out;
  });
}

async function currentCompany(ctx: {
  companyId: string;
  personId?: string;
  actorKind: Kind;
}): Promise<string | null> {
  return inContext(app, ctx, async () => {
    const { rows } = await app.query<{ id: string | null }>(
      'select app.current_company_id() as id',
    );
    return rows[0]!.id;
  });
}

/** A support grant as the company's own admin records it, over `[from, until)` from now. */
async function grant(
  companyId: string,
  grantedBy: string,
  window: { fromHours: number; untilHours: number } = { fromHours: 0, untilHours: 24 },
): Promise<string> {
  return inContext(app, { companyId, personId: grantedBy, actorKind: 'staff' }, async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into support_grant (company_id, granted_by, reason, starts_at, ends_at)
       values ($1, $2, 'A tenant cannot see a receipt', now() + make_interval(hours => $3),
               now() + make_interval(hours => $4))
       returning id`,
      [companyId, grantedBy, window.fromHours, window.untilHours],
    );
    return rows[0]!.id;
  });
}

async function revoke(companyId: string, grantId: string, by: string): Promise<void> {
  await inContext(app, { companyId, personId: by, actorKind: 'staff' }, () =>
    app.query('update support_grant set revoked_at = now(), revoked_by = $2 where id = $1', [
      grantId,
      by,
    ]),
  );
}

/** Rows in a few more tables than a new company has, for the positive controls. */
async function seed(companyId: string, personId: string) {
  const zero = '0'.repeat(64);
  await inContext(app, { companyId, personId, actorKind: 'system' }, async () => {
    await app.query(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'test', 'application/pdf', 1, $2, 'b', 'k', true)",
      [companyId, zero],
    );
    await app.query(
      "insert into outbox_event (company_id, type, payload, idempotency_key) values ($1, 'test.event', '{}', 'k1')",
      [companyId],
    );
    await app.query(
      "insert into processed_job (company_id, key, job_name) values ($1, 'job-1', 'test')",
      [companyId],
    );
    await app.query("select audit.append($1, 'test.event', 'test', 't1', '{}'::jsonb)", [
      companyId,
    ]);
  });
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  // Function call counts for the performance check below (a superuser setting, for this
  // database only, picked up by connections made after it).
  await runSql(db.superuserUrl, `alter database "${db.name}" set track_functions = 'all'`);
  app = await connect(db.appUrl);
  platform = await createCompany(app, 'Platform', 'platform');
  customer = await createCompany(app, 'Customer Landlord', 'landlord');
  other = await createCompany(app, 'Other Agency', 'agency');
  admin = await createPerson(app, 'Platform Admin');
  impostor = await createPerson(app, 'Not An Admin');
  customerOwner = await createPerson(app, 'Customer Owner');
  otherOwner = await createPerson(app, 'Other Owner');
  await createMembership(app, platform, admin, 'platform_admin');
  await createMembership(app, customer, customerOwner, 'owner');
  await createMembership(app, other, otherOwner, 'agency_admin');
  await seed(customer, customerOwner);
  await seed(other, otherOwner);
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('AD-10 support access: the database guard', () => {
  it('leaves the company context of every other actor kind as it was', async () => {
    for (const actorKind of ['staff', 'tenant', 'system', 'link', ''] as const) {
      expect(
        await currentCompany({ companyId: customer, personId: customerOwner, actorKind }),
        actorKind || 'no actor kind',
      ).toBe(customer);
      // Whoever the person is: a platform admin's person id under another kind changes nothing.
      expect(await currentCompany({ companyId: customer, personId: admin, actorKind })).toBe(
        customer,
      );
    }
  });

  it('gives a platform admin the platform company, and nothing in a customer without a grant', async () => {
    const asAdmin = { personId: admin, actorKind: 'platform_admin' as const };
    expect(await currentCompany({ companyId: platform, ...asAdmin })).toBe(platform);
    expect(await currentCompany({ companyId: customer, ...asAdmin })).toBeNull();
    expect(await currentCompany({ companyId: other, ...asAdmin })).toBeNull();
    // Claiming the actor kind without the membership opens nothing, not even the platform.
    const claimed = { personId: impostor, actorKind: 'platform_admin' as const };
    expect(await currentCompany({ companyId: platform, ...claimed })).toBeNull();
    expect(await currentCompany({ companyId: customer, ...claimed })).toBeNull();
  });

  it('★ shows a platform admin zero rows in every company-scoped table without consent, raw SQL', async () => {
    const tables = await rlsTables();
    expect(tables.length).toBeGreaterThan(100);
    const staff = await visibleCounts(
      { companyId: customer, personId: customerOwner, actorKind: 'staff' },
      tables,
    );
    // The positive control: the company's own staff see its rows.
    for (const table of [
      'company',
      'membership',
      'audit_event',
      'book',
      'document',
      'outbox_event',
    ])
      expect(staff[table], `staff see ${table}`).toBeGreaterThan(0);
    const support = await visibleCounts(
      { companyId: customer, personId: admin, actorKind: 'platform_admin' },
      tables,
    );
    for (const table of tables) expect(support[table], `${table} without a grant`).toBe(0);
    // Nor can the session write there: every policy's check is against a null company.
    const refused = await sqlState(
      inContext(app, { companyId: customer, personId: admin, actorKind: 'platform_admin' }, () =>
        app.query(
          "insert into processed_job (company_id, key, job_name) values ($1, 'by-support', 'test')",
          [customer],
        ),
      ),
    );
    expect(refused).toBe('42501');
  });

  it('with an active grant shows exactly what the company’s staff see, read-only when asked', async () => {
    const tables = await rlsTables();
    const id = await grant(customer, customerOwner);
    try {
      const staff = await visibleCounts(
        { companyId: customer, personId: customerOwner, actorKind: 'staff' },
        tables,
      );
      const support = await visibleCounts(
        { companyId: customer, personId: admin, actorKind: 'platform_admin' },
        tables,
      );
      expect(support).toEqual(staff);
      // The grant is the company's own: it opens no other company.
      expect(
        await currentCompany({ companyId: other, personId: admin, actorKind: 'platform_admin' }),
      ).toBeNull();
      // Someone claiming the actor kind still sees nothing under it.
      expect(
        await currentCompany({
          companyId: customer,
          personId: impostor,
          actorKind: 'platform_admin',
        }),
      ).toBeNull();
      // A support session is a read-only transaction (withSupport): a write fails there.
      await app.query('begin read only');
      try {
        await app.query(
          "select set_config('app.company_id', $1, true), set_config('app.person_id', $2, true), set_config('app.actor_kind', 'platform_admin', true)",
          [customer, admin],
        );
        expect(
          await sqlState(
            app.query(
              "insert into processed_job (company_id, key, job_name) values ($1, 'by-support', 'test')",
              [customer],
            ),
          ),
        ).toBe('25006');
      } finally {
        await app.query('rollback');
      }
      // And the active grant is what the session's audit names.
      const active = await inContext(
        app,
        { companyId: customer, personId: admin, actorKind: 'platform_admin' },
        async () =>
          (
            await app.query<{ id: string | null }>('select app.active_support_grant($1) as id', [
              customer,
            ])
          ).rows[0]!.id,
      );
      expect(active).toBe(id);
    } finally {
      await revoke(customer, id, customerOwner);
    }
  });

  it('ends at the grant’s expiry and at its revocation', async () => {
    const asAdmin = { companyId: customer, personId: admin, actorKind: 'platform_admin' as const };
    // Expired an hour ago, and one not started yet: neither opens the company.
    await grant(customer, customerOwner, { fromHours: -25, untilHours: -1 });
    await grant(customer, customerOwner, { fromHours: 1, untilHours: 5 });
    expect(await currentCompany(asAdmin)).toBeNull();
    const live = await grant(customer, customerOwner);
    expect(await currentCompany(asAdmin)).toBe(customer);
    await revoke(customer, live, customerOwner);
    expect(await currentCompany(asAdmin)).toBeNull();
    const tables = await rlsTables();
    const after = await visibleCounts(asAdmin, tables);
    for (const table of tables) expect(after[table], `${table} after revocation`).toBe(0);
    // A revocation is recorded once.
    expect(
      await sqlState(
        inContext(app, { companyId: customer, personId: customerOwner, actorKind: 'staff' }, () =>
          app.query('update support_grant set revoked_at = now() where id = $1', [live]),
        ),
      ),
    ).toBe('RA110');
  });

  it('adds no work to a staff query: the guard is never called and the company index still serves', async () => {
    // Counts not yet flushed to the cumulative statistics, which happens only outside a
    // transaction: so the difference within one transaction is that transaction's calls.
    const guardCalls = async () =>
      (
        await app.query<{ calls: number }>(
          `select coalesce(sum(calls), 0)::int as calls from pg_stat_xact_user_functions
           where schemaname = 'app' and funcname = 'support_access_allowed'`,
        )
      ).rows[0]!.calls;
    const calls = async (ctx: { companyId: string; personId: string; actorKind: Kind }) =>
      inContext(app, ctx, async () => {
        const before = await guardCalls();
        for (const table of ['membership', 'audit_event', 'document', 'support_grant'])
          await app.query(`select count(*) from ${table}`);
        return (await guardCalls()) - before;
      });
    for (const actorKind of ['staff', 'system', 'link'] as const)
      expect(await calls({ companyId: customer, personId: customerOwner, actorKind })).toBe(0);
    // The control: a platform admin's queries do go through the guard.
    expect(
      await calls({ companyId: customer, personId: admin, actorKind: 'platform_admin' }),
    ).toBeGreaterThan(0);
    // The policy is still an index condition on the company for staff.
    const plan = await inContext(
      app,
      { companyId: customer, personId: customerOwner, actorKind: 'staff' },
      async () => {
        await app.query('set local enable_seqscan = off');
        const { rows } = await app.query<{ 'QUERY PLAN': unknown }>(
          'explain (format json) select * from audit_event',
        );
        return JSON.stringify(rows[0]!['QUERY PLAN']);
      },
    );
    expect(plan).toMatch(/"Index Cond":"\(company_id = /);
    expect(plan).not.toContain('Seq Scan');
  });
});
