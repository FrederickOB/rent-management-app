import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, type TestDatabase } from './testing';
import { connect, createCompany, createPerson, inContext, sqlState } from './testing/fixtures';

/**
 * M7 legal notices in the database (plan 4.8, 4.9 and 6): an issued notice keeps everything but
 * its status, ladder flags and outcome (RA070); nothing deletes a notice (RA072); a task closes
 * once (RA071); the timeline and service records are append-only; a tenant session sees an issued
 * notice it received, never a draft; and a company never reaches another's notices. Real
 * PostgreSQL with RLS, through the application role.
 */
let db: TestDatabase;
let app: pg.Client;
let companyA: string;
let companyB: string;
let staffA: string;
const fixture: Record<string, { property: string; unit: string; tenant: string; lease: string }> =
  {};

const tx = <T>(ctx: Parameters<typeof inContext>[1], fn: () => Promise<T>) =>
  inContext(app, ctx, fn);

async function setup(companyId: string, code: string) {
  return tx({ companyId }, async () => {
    const { rows: portfolios } = await app.query<{ id: string }>(
      'insert into portfolio (company_id, name, is_default) values ($1, $2, false) returning id',
      [companyId, `Portfolio ${code}`],
    );
    const { rows: properties } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, $3, 'ACC', $3, 'compound_house', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolios[0]!.id, `ACC-${code}`],
    );
    const property = properties[0]!.id;
    const { rows: owners } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, $2, 'individual', 'Owner') returning id",
      [companyId, `OWN-${code}`],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, property, owners[0]!.id],
    );
    const { rows: blocks } = await app.query<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, property],
    );
    const { rows: units } = await app.query<{ id: string }>(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, $4, '01', 'single_room', 'single_room') returning id`,
      [companyId, property, blocks[0]!.id, `ACC-${code}-B1-01`],
    );
    const { rows: tenants } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name, phone) values ($1, 'individual', 'Kofi', '+233200000777') returning id",
      [companyId],
    );
    const { rows: leases } = await app.query<{ id: string }>(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, start_date, end_date, monthly_rent_minor,
         rent_cycle, notice_days)
       values ($1, $2, $3, $4, 'residential', current_date, current_date + 364, 150000, 'monthly', 30) returning id`,
      [companyId, property, units[0]!.id, tenants[0]!.id],
    );
    const { rows: docs } = await app.query<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'lease_file', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
      [companyId, '0'.repeat(64)],
    );
    await app.query(
      "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
      [leases[0]!.id, docs[0]!.id],
    );
    return { property, unit: units[0]!.id, tenant: tenants[0]!.id, lease: leases[0]!.id };
  });
}

/** A notice under the company's lease, as a draft or (with a number) issued. */
async function notice(companyId: string, status: 'draft' | 'sent', number: number | null) {
  const f = fixture[companyId]!;
  return tx({ companyId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into notice (company_id, number, type, subtype, status, property_id, unit_id, lease_id, tenant_id, fields,
         template_key, template_version, issue_date, issued_at, effective_date)
       values ($1, $2, 'notice_to_quit', 'arrears', $3, $4, $5, $6, $7, '{"particulars":"Rent unpaid"}',
         'notices.notice', 1, $8, $9, current_date + 30) returning id`,
      [
        companyId,
        number,
        status,
        f.property,
        f.unit,
        f.lease,
        f.tenant,
        number === null ? null : new Date().toISOString().slice(0, 10),
        number === null ? null : new Date(),
      ],
    );
    if (status === 'sent')
      await app.query(
        `insert into notice_recipient (company_id, property_id, notice_id, tenant_id, lease_id, unit_id, kind, name,
           phone, channels, physical_service_planned, position)
         values ($1, $2, $3, $4, $5, $6, 'tenant', 'Kofi', '+233200000777', '[]', false, 1)`,
        [companyId, f.property, rows[0]!.id, f.tenant, f.lease, f.unit],
      );
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyA = await createCompany(app, 'Notices A');
  companyB = await createCompany(app, 'Notices B');
  staffA = await createPerson(app, 'Manager A');
  fixture[companyA] = await setup(companyA, 'NA');
  fixture[companyB] = await setup(companyB, 'NB');
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('LN-01 and plan 4.8 an issued notice is frozen', () => {
  it('lets a draft change, but an issued notice only moves its status, flags and outcome', async () => {
    const draft = await notice(companyA, 'draft', null);
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(`update notice set fields = '{"particulars":"Changed"}' where id = $1`, [
            draft,
          ]),
        ),
      ),
    ).toBeNull();
    const issued = await notice(companyA, 'sent', 101);
    for (const change of [
      `fields = '{"particulars":"Changed"}'`,
      'effective_date = current_date + 1',
      'issue_date = current_date - 1',
      'number = 999',
      "subtype = 'breach'",
      `ladder = '[]'`,
    ])
      expect(
        await sqlState(
          tx({ companyId: companyA }, () =>
            app.query(`update notice set ${change} where id = $1`, [issued]),
          ),
        ),
        change,
      ).toBe('RA070');
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(
            "update notice set status = 'reminded', ladder_paused = true, ladder_reason = 'Tenant in hospital' where id = $1",
            [issued],
          ),
        ),
      ),
    ).toBeNull();
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update notice set status = 'draft' where id = $1", [issued]),
        ),
      ),
    ).toBe('RA070');
  });

  it('records the frozen document once', async () => {
    const issued = await notice(companyA, 'sent', 102);
    const { rows: docs } = await tx({ companyId: companyA }, () =>
      app.query<{ id: string }>(
        "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'notice', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
        [companyA, 'a'.repeat(64)],
      ),
    );
    const set = (sha: string) =>
      tx({ companyId: companyA }, () =>
        app.query('update notice set document_id = $2, document_sha256 = $3 where id = $1', [
          issued,
          docs[0]!.id,
          sha,
        ]),
      );
    expect(await sqlState(set('a'.repeat(64)))).toBeNull();
    expect(await sqlState(set('b'.repeat(64)))).toBe('RA070');
  });

  it('keeps a closed notice closed, and never deletes a notice', async () => {
    const issued = await notice(companyA, 'sent', 103);
    await tx({ companyId: companyA }, () =>
      app.query(
        "update notice set status = 'closed', outcome = 'paid', close_note = 'Paid in full', closed_at = now() where id = $1",
        [issued],
      ),
    );
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(
            "update notice set status = 'sent', outcome = null, closed_at = null where id = $1",
            [issued],
          ),
        ),
      ),
    ).toBe('RA070');
    expect(
      await sqlState(
        tx({ companyId: companyA }, () => app.query('delete from notice where id = $1', [issued])),
      ),
    ).not.toBeNull();
  });

  it('needs an outcome exactly when closed, and a number exactly when issued', async () => {
    const f = fixture[companyA]!;
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(
            `insert into notice (company_id, type, status, property_id, lease_id, tenant_id, template_key, template_version)
             values ($1, 'breach', 'sent', $2, $3, $4, 'notices.notice', 1)`,
            [companyA, f.property, f.lease, f.tenant],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(
            `insert into notice (company_id, type, status, property_id, lease_id, tenant_id, template_key, template_version, outcome)
             values ($1, 'breach', 'draft', $2, $3, $4, 'notices.notice', 1, 'paid')`,
            [companyA, f.property, f.lease, f.tenant],
          ),
        ),
      ),
    ).toBe('23514');
  });
});

describe('LN-03 the timeline and service records are append-only', () => {
  it('refuses to change or delete an event or a service record', async () => {
    const issued = await notice(companyA, 'sent', 104);
    const f = fixture[companyA]!;
    await tx({ companyId: companyA }, async () => {
      await app.query(
        "insert into notice_event (company_id, property_id, notice_id, kind) values ($1, $2, $3, 'sent')",
        [companyA, f.property, issued],
      );
      await app.query(
        `insert into service_record (company_id, property_id, notice_id, method, served_at, served_by_name, recorded_by)
         values ($1, $2, $3, 'posted_on_premises', now(), 'Kojo', $4)`,
        [companyA, f.property, issued, staffA],
      );
    });
    for (const sql of [
      "update notice_event set kind = 'signed' where notice_id = $1",
      'delete from notice_event where notice_id = $1',
      "update service_record set method = 'courier' where notice_id = $1",
    ])
      expect(
        await sqlState(tx({ companyId: companyA }, () => app.query(sql, [issued]))),
        sql,
      ).not.toBeNull();
  });

  it('lands an event with a dedupe key once', async () => {
    const issued = await notice(companyA, 'sent', 105);
    const f = fixture[companyA]!;
    const insert = () =>
      tx({ companyId: companyA }, () =>
        app.query(
          "insert into notice_event (company_id, property_id, notice_id, kind, dedupe_key) values ($1, $2, $3, 'reminded', 'ladder:x:reminder_1')",
          [companyA, f.property, issued],
        ),
      );
    expect(await sqlState(insert())).toBeNull();
    expect(await sqlState(insert())).toBe('23505');
  });
});

describe('CF-06 a task closes once', () => {
  it('completes an open task, and refuses any change after', async () => {
    const issued = await notice(companyA, 'sent', 106);
    const f = fixture[companyA]!;
    const { rows } = await tx({ companyId: companyA }, () =>
      app.query<{ id: string }>(
        `insert into task (company_id, property_id, kind, title, related_type, notice_id, due_at, dedupe_key)
         values ($1, $2, 'notice_post_on_premises', 'Post it', 'notice', $3, now(), $4) returning id`,
        [companyA, f.property, issued, `t:${issued}`],
      ),
    );
    const taskId = rows[0]!.id;
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update task set kind = 'notice_physical_service' where id = $1", [taskId]),
        ),
      ),
      // What a task is about is refused twice over: no grant on the column, and the trigger.
    ).toMatch(/^(42501|RA071)$/);
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update task set status = 'done', completed_at = now() where id = $1", [
            taskId,
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update task set note = 'again' where id = $1", [taskId]),
        ),
      ),
    ).toBe('RA071');
    expect(
      await sqlState(
        tx({ companyId: companyA }, () => app.query('delete from task where id = $1', [taskId])),
      ),
    ).not.toBeNull();
  });
});

describe('LN-02 isolation and tenant visibility', () => {
  it('shows a tenant session an issued notice it received, never a draft', async () => {
    const f = fixture[companyA]!;
    const draft = await notice(companyA, 'draft', null);
    const issued = await notice(companyA, 'sent', 107);
    const seen = await tx({ companyId: companyA, actorKind: 'tenant' }, async () => {
      await app.query("select set_config('app.tenant_scope', $1, true)", [`{${f.tenant}}`]);
      await app.query("select set_config('app.property_scope', $1, true)", [`{${f.property}}`]);
      const { rows } = await app.query<{ id: string }>('select id from notice');
      const { rows: events } = await app.query('select id from notice_event');
      return { ids: rows.map((r) => r.id), events: events.length };
    });
    expect(seen.ids).toContain(issued);
    expect(seen.ids).not.toContain(draft);
    expect(seen.events).toBe(0);
  });

  it("never reaches another company's notices, by id or by reference", async () => {
    const theirs = await notice(companyB, 'sent', 1);
    const mine = fixture[companyA]!;
    const { rows } = await tx({ companyId: companyA }, () =>
      app.query('select id from notice where id = $1', [theirs]),
    );
    expect(rows).toEqual([]);
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query(
            "insert into notice_event (company_id, property_id, notice_id, kind) values ($1, $2, $3, 'sent')",
            [companyA, mine.property, theirs],
          ),
        ),
      ),
    ).toBe('23503');
  });

  it('keeps notice numbers per company: each starts at 1', async () => {
    const value = async (companyId: string) =>
      tx({ companyId }, async () => {
        const { rows } = await app.query<{ value: number }>(
          `insert into company_counter (company_id, name, value) values ($1, 'notice', 1)
           on conflict (company_id, name) do update set value = company_counter.value + 1 returning value`,
          [companyId],
        );
        return Number(rows[0]!.value);
      });
    expect(await value(companyA)).toBe(1);
    expect(await value(companyA)).toBe(2);
    expect(await value(companyB)).toBe(1);
  });
});
