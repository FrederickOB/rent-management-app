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
 * BE-22 (M10 decision 1; review access 10): every table with a `subscriber_read` policy, swept in
 * raw SQL as the application role on real PostgreSQL with RLS forced. A subscriber's staff session
 * sees only its own rows of the platform company's subscription records, and writes none: not the
 * platform's rows, and not rows of its own (migration 0065's restrictive write policies).
 */
let db: TestDatabase;
let app: pg.Client;
let platform: string;
let subA: string;
let subB: string;
let personA: string;
let personB: string;

const TABLES = [
  'subscription',
  'subscription_event',
  'billing_snapshot',
  'billing_snapshot_unit',
  'subscription_invoice',
  'subscription_invoice_line',
  'subscription_payment',
  'subscription_allocation',
  'subscription_receipt',
  'discount_code',
  'discount_redemption',
  'subscription_credit_note',
] as const;
type Table = (typeof TABLES)[number];

/** One row per table for a subscriber, in the platform company, as the engine writes them. */
async function seed(subscriber: string, n: number): Promise<Record<Table, string>> {
  return inContext(app, { companyId: platform, actorKind: 'system' }, async () => {
    const one = async (query: string, values: unknown[]) =>
      (await app.query<{ id: string }>(query, values)).rows[0]!.id;
    const subscription = await one(
      `insert into subscription (company_id, subscriber_company_id, tier, status, started_on)
       values ($1, $2, 'growth', 'active', '2026-01-01') returning id`,
      [platform, subscriber],
    );
    const event = await one(
      `insert into subscription_event (company_id, subscription_id, subscriber_company_id, kind, tier, effective_on)
       values ($1, $2, $3, 'started', 'growth', '2026-01-01') returning id`,
      [platform, subscription, subscriber],
    );
    const snapshot = await one(
      `insert into billing_snapshot (company_id, subscription_id, subscriber_company_id, month, single_room_units,
         self_contained_units, commercial_units)
       values ($1, $2, $3, '2026-01', 0, 1, 0) returning id`,
      [platform, subscription, subscriber],
    );
    await app.query(
      `insert into billing_snapshot_unit (company_id, snapshot_id, unit_id, unit_code, band, lease_id, days_leased)
       values ($1, $2, gen_random_uuid(), $3, 'self_contained', gen_random_uuid(), 31)`,
      [platform, snapshot, `ACC-ISO-A-0${n}`],
    );
    const terms = (await app.query<{ id: string }>('select id from subscription_terms limit 1'))
      .rows[0]!.id;
    const invoice = await one(
      `insert into subscription_invoice (company_id, subscription_id, subscriber_company_id, number, month, snapshot_id,
         issued_on, due_on, subtotal_minor, discount_minor, net_minor, vat_minor, total_minor, price_list_ids, terms_id,
         template_key, template_version)
       values ($1, $2, $3, $4, '2026-01', $5, '2026-02-01', '2026-02-08', 15000, 0, 15000, 0, 15000,
         '{}', $6, 'subscription.invoice', 1) returning id`,
      [platform, subscription, subscriber, `SUB-2026-00000${n}`, snapshot, terms],
    );
    await app.query(
      `insert into subscription_invoice_line (company_id, invoice_id, line_no, kind, description, amount_minor)
       values ($1, $2, 1, 'minimum', 'Fixture minimum', 15000)`,
      [platform, invoice],
    );
    const payment = await one(
      `insert into subscription_payment (company_id, subscription_id, subscriber_company_id, reference, purpose, channel,
         amount_minor, status, provider, succeeded_at)
       values ($1, $2, $3, $4, 'invoices', 'card', 10000, 'succeeded', 'paystack', now()) returning id`,
      [platform, subscription, subscriber, `SUB-ISO-${n}-${subscriber}`],
    );
    const allocation = await one(
      `insert into subscription_allocation (company_id, subscriber_company_id, source, payment_id, invoice_id, amount_minor)
       values ($1, $2, 'payment', $3, $4, 10000) returning id`,
      [platform, subscriber, payment, invoice],
    );
    const receipt = await one(
      `insert into subscription_receipt (company_id, subscriber_company_id, payment_id, number, paid_on, amount_minor,
         template_key, template_version)
       values ($1, $2, $3, $4, '2026-02-02', 10000, 'subscription.receipt', 1) returning id`,
      [platform, subscriber, payment, `SUBR-2026-00000${n}`],
    );
    const code = await one(
      `insert into discount_code (company_id, code, kind, percent_bps, months)
       values ($1, $2, 'percentage', 1000, 1) returning id`,
      [platform, `ISO-${n}`],
    );
    const redemption = await one(
      `insert into discount_redemption (company_id, discount_code_id, subscription_id, subscriber_company_id,
         first_month, months)
       values ($1, $2, $3, $4, '2026-01', 1) returning id`,
      [platform, code, subscription, subscriber],
    );
    const creditNote = await one(
      `insert into subscription_credit_note (company_id, subscriber_company_id, invoice_id, number, issued_on,
         net_minor, vat_minor, amount_minor, reason, template_key, template_version)
       values ($1, $2, $3, $4, '2026-02-03', 1000, 0, 1000, 'Fixture credit', 'subscription.credit_note', 1)
       returning id`,
      [platform, subscriber, invoice, `SUBC-2026-00000${n}`],
    );
    return {
      subscription,
      subscription_event: event,
      billing_snapshot: snapshot,
      billing_snapshot_unit: snapshot,
      subscription_invoice: invoice,
      subscription_invoice_line: invoice,
      subscription_payment: payment,
      subscription_allocation: allocation,
      subscription_receipt: receipt,
      discount_code: code,
      discount_redemption: redemption,
      subscription_credit_note: creditNote,
    };
  });
}

/** The subscriber each visible row belongs to: its own column, or its parent's. */
const OWNER_OF: Record<Table, string> = {
  subscription: 'subscriber_company_id',
  subscription_event: 'subscriber_company_id',
  billing_snapshot: 'subscriber_company_id',
  billing_snapshot_unit: `(select s.subscriber_company_id from billing_snapshot s
    where s.company_id = t.company_id and s.id = t.snapshot_id)`,
  subscription_invoice: 'subscriber_company_id',
  subscription_invoice_line: `(select i.subscriber_company_id from subscription_invoice i
    where i.company_id = t.company_id and i.id = t.invoice_id)`,
  subscription_payment: 'subscriber_company_id',
  subscription_allocation: 'subscriber_company_id',
  subscription_receipt: 'subscriber_company_id',
  discount_code: `(select r.subscriber_company_id from discount_redemption r
    where r.company_id = t.company_id and r.discount_code_id = t.id limit 1)`,
  discount_redemption: 'subscriber_company_id',
  subscription_credit_note: 'subscriber_company_id',
};

const staffOf = (companyId: string, personId: string) => ({
  companyId,
  personId,
  actorKind: 'staff',
});

async function owners(ctx: ReturnType<typeof staffOf>, table: Table): Promise<string[]> {
  return inContext(app, ctx, async () =>
    (
      await app.query<{ owner: string }>(
        `select ${OWNER_OF[table]} as owner from ${table} t order by 1`,
      )
    ).rows.map((r) => r.owner),
  );
}

/** Every row of every table, below RLS, to prove the writes changed nothing. */
async function everything(): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const rows = await runSql(db.superuserUrl, `select * from ${table} order by 1, 2`);
    parts.push(`${table}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  platform = await createCompany(app, 'Platform', 'platform');
  subA = await createCompany(app, 'Isolation Agency', 'agency');
  subB = await createCompany(app, 'Isolation Landlord', 'landlord');
  personA = await createPerson(app, 'Agency Admin');
  personB = await createPerson(app, 'Landlord');
  await createMembership(app, subA, personA, 'agency_admin');
  await createMembership(app, subB, personB, 'owner');
  await seed(subA, 1);
  await seed(subB, 2);
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('BE-22 PB-07 a subscriber reads only its own subscription records (raw SQL)', () => {
  it('covers every table with a subscriber_read policy', async () => {
    const rows = await runSql<{ tablename: string }>(
      db.ownerUrl,
      "select tablename from pg_policies where schemaname = 'public' and policyname = 'subscriber_read' order by 1",
    );
    expect(rows.map((r) => r.tablename)).toEqual([...TABLES].sort());
  });

  it('shows each subscriber its own rows in every table, and never the other’s', async () => {
    for (const table of TABLES) {
      expect(await owners(staffOf(subA, personA), table), `${table} for A`).toEqual([subA]);
      expect(await owners(staffOf(subB, personB), table), `${table} for B`).toEqual([subB]);
    }
    // The platform company sees both; another kind of session in a subscriber sees as staff do.
    for (const table of TABLES)
      expect(
        (await owners({ companyId: platform, personId: '', actorKind: 'system' }, table)).sort(),
        table,
      ).toEqual([subA, subB].sort());
  });
});

describe('BE-22 PB-07 a subscriber writes none of them (raw SQL)', () => {
  it('cannot insert, change or delete a row of the platform company’s, its own or the other’s', async () => {
    const before = await everything();
    const ctx = staffOf(subA, personA);
    for (const table of TABLES) {
      // A copy of a row it can see, with fresh keys, in the platform company and in its own.
      for (const companyId of [platform, subA]) {
        const refused = await sqlState(
          inContext(app, ctx, () =>
            app.query(
              `insert into ${table} select (jsonb_populate_record(null::${table},
                 to_jsonb(t) || jsonb_build_object('company_id', $1::text,
                   'id', gen_random_uuid(), 'unit_id', gen_random_uuid(), 'line_no', 99,
                   'number', t.ctid::text, 'reference', 'SUB-' || gen_random_uuid(),
                   'code', 'X' || floor(random() * 1e9)::text))).*
               from ${table} t limit 1`,
              [companyId],
            ),
          ),
        );
        const where = companyId === platform ? 'platform' : 'own';
        expect(refused, `${table} insert into ${where}`).toBe('42501');
      }
      const changed = await inContext(app, ctx, async () => {
        const update = await app
          .query(`update ${table} set company_id = company_id`)
          .then((r) => r.rowCount ?? 0)
          .catch(() => 0);
        return update;
      }).catch(() => 0);
      expect(changed, `${table} update`).toBe(0);
      const deleted = await inContext(app, ctx, () =>
        app.query(`delete from ${table}`).then((r) => r.rowCount ?? 0),
      ).catch(() => 0);
      expect(deleted, `${table} delete`).toBe(0);
    }
    expect(await everything()).toBe(before);
  });

  it('refuses a row of its own even with a fresh id (the restrictive write policies)', async () => {
    const refused = await sqlState(
      inContext(app, staffOf(subA, personA), () =>
        app.query(
          `insert into subscription (company_id, subscriber_company_id, tier, status, started_on)
           values ($1, $1, 'growth', 'active', '2026-01-01')`,
          [subA],
        ),
      ),
    );
    expect(refused).toBe('42501');
    // The platform's own paths still write: the system and a platform admin's console.
    await expect(
      inContext(app, { companyId: platform, actorKind: 'system' }, () =>
        app.query(
          `insert into discount_code (company_id, code, kind, percent_bps, months)
           values ($1, 'ISO-SYSTEM', 'percentage', 500, 1)`,
          [platform],
        ),
      ),
    ).resolves.toBeDefined();
  });
});
