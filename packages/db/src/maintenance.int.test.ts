import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, type TestDatabase } from './testing';
import {
  connect,
  createCompany,
  createMembership,
  createPerson,
  inContext,
  sqlState,
} from './testing/fixtures';

/**
 * M8 in the database (plan 4.10 and 6): the job machine with MI-06's evidence (RA080 to RA082);
 * submitted inspections frozen (RA083, RA084); deductions within the deposit held and fixed once
 * the settlement leaves drafting (RA085 to RA087); the move-out machine and its two-person
 * approval (RA088, RA089); an expense paid once and never after a reversal (RA090); and property,
 * owner and tenant scope on the new tables, with a positive case each. Real PostgreSQL with RLS,
 * through the application role.
 */
let db: TestDatabase;
let app: pg.Client;
let companyId: string;
let manager: string;
let approver: string;
let managerMembership: string;
let approverMembership: string;
interface Place {
  property: string;
  unit: string;
  tenant: string;
  lease: string;
  owner: string;
  book: string;
}
let here: Place;
let there: Place;

const tx = <T>(fn: () => Promise<T>) => inContext(app, { companyId, personId: manager }, fn);
const scoped = <T>(scope: { property?: string[]; tenant?: string[] }, fn: () => Promise<T>) =>
  tx(async () => {
    if (scope.property)
      await app.query("select set_config('app.property_scope', $1, true)", [
        `{${scope.property.join(',')}}`,
      ]);
    if (scope.tenant)
      await app.query("select set_config('app.tenant_scope', $1, true)", [
        `{${scope.tenant.join(',')}}`,
      ]);
    return fn();
  });
const one = async <T = { id: string }>(sql: string, params: unknown[]) =>
  (await app.query(sql, params)).rows[0] as T;

async function place(code: string): Promise<Place> {
  return tx(async () => {
    const portfolio = await one(
      'insert into portfolio (company_id, name, is_default) values ($1, $2, false) returning id',
      [companyId, `Portfolio ${code}`],
    );
    const property = await one(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, $3, 'ACC', $3, 'compound_house', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolio.id, `ACC-${code}`],
    );
    const owner = await one(
      "insert into owner (company_id, reference, kind, display_name) values ($1, $2, 'individual', 'Owner') returning id",
      [companyId, `OWN-${code}`],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, property.id, owner.id],
    );
    const block = await one(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, property.id],
    );
    const unit = await one(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, $4, '01', 'single_room', 'single_room') returning id`,
      [companyId, property.id, block.id, `ACC-${code}-B1-01`],
    );
    const tenant = await one(
      "insert into tenant (company_id, kind, display_name, phone) values ($1, 'individual', 'Kofi', '+233200000777') returning id",
      [companyId],
    );
    const lease = await one(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, start_date, end_date, monthly_rent_minor,
         rent_cycle, notice_days)
       values ($1, $2, $3, $4, 'residential', current_date, current_date + 364, 150000, 'monthly', 30) returning id`,
      [companyId, property.id, unit.id, tenant.id],
    );
    const book = await one('select id from book where owner_id = $1', [owner.id]);
    return {
      property: property.id,
      unit: unit.id,
      tenant: tenant.id,
      lease: lease.id,
      owner: owner.id,
      book: book.id,
    };
  });
}

async function documentId(): Promise<string> {
  return tx(
    async () =>
      (
        await one(
          "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'test', 'image/jpeg', 1, $2, 'b', $3, true) returning id",
          [companyId, '0'.repeat(64), randomUUID()],
        )
      ).id,
  );
}

async function job(at: Place = here): Promise<string> {
  return tx(
    async () =>
      (
        await one(
          `insert into maintenance_job (company_id, property_id, unit_id, lease_id, tenant_id, source, description)
           values ($1, $2, $3, $4, $5, 'staff', 'The tap leaks') returning id`,
          [companyId, at.property, at.unit, at.lease, at.tenant],
        )
      ).id,
  );
}

const update = (table: string, set: string, id: string, params: unknown[] = []) =>
  sqlState(tx(() => app.query(`update ${table} set ${set} where id = $1`, [id, ...params])));

async function attach(jobId: string, stage: string, kind = 'image', at: Place = here) {
  const doc = await documentId();
  await tx(() =>
    app.query(
      `insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind, stage, added_by_kind)
       values ($1, $2, $3, $4, $5, $6, 'staff')`,
      [companyId, at.property, jobId, doc, kind, stage],
    ),
  );
}

/** Puts a job in progress, with its before photo. */
async function inProgress(): Promise<string> {
  const id = await job();
  expect(
    await update(
      'maintenance_job',
      "status = 'triaged', priority = 'urgent', category = 'plumbing'",
      id,
    ),
  ).toBeNull();
  expect(
    await update(
      'maintenance_job',
      "status = 'assigned', assignee_kind = 'staff', assignee_person_id = $2",
      id,
      [manager],
    ),
  ).toBeNull();
  await attach(id, 'before');
  expect(await update('maintenance_job', "status = 'in_progress'", id)).toBeNull();
  return id;
}

/** A credit of the lease's deposit in 2100, as P10 leaves it. */
async function deposit(at: Place, amountMinor: number) {
  await tx(async () => {
    const entry = randomUUID();
    await app.query('set local role ledger_writer');
    await app.query(
      // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
      `insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date, record_type, record_id)
       values ($1, $2, 'P10', $3, current_date, current_date, 'fixture', $1)`,
      [entry, companyId, `P10:${entry}`],
    );
    await app.query(
      // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
      `insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor, property_id,
         unit_id, lease_id, tenant_id)
       values (gen_random_uuid(), $1, $2, 1, $3, '1010', $4, $5, $6, $7, $8),
              (gen_random_uuid(), $1, $2, 2, $3, '2100', -$4::bigint, $5, $6, $7, $8)`,
      [companyId, entry, at.book, amountMinor, at.property, at.unit, at.lease, at.tenant],
    );
    await app.query('set local role none');
  });
}

async function moveOut(at: Place, inspectionId: string | null = null): Promise<string> {
  return tx(
    async () =>
      (
        await one(
          `insert into move_out (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, reason,
             planned_date, inspection_id, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, 'end_of_term', current_date, $8, $9) returning id`,
          [
            companyId,
            at.property,
            at.tenant,
            at.lease,
            at.unit,
            at.owner,
            at.book,
            inspectionId,
            manager,
          ],
        )
      ).id,
  );
}

const deduct = (
  at: Place,
  moveOutId: string,
  amountMinor: number,
  items: string[] = [],
  photos: string[] = [],
) =>
  sqlState(
    tx(() =>
      app.query(
        `insert into deposit_deduction (company_id, property_id, tenant_id, lease_id, move_out_id, kind, amount_minor,
           reason, inspection_item_ids, photo_ids, created_by)
         values ($1, $2, $3, $4, $5, 'damage', $6, 'A broken window', $7::uuid[], $8::uuid[], $9)`,
        [
          companyId,
          at.property,
          at.tenant,
          at.lease,
          moveOutId,
          amountMinor,
          items,
          photos,
          manager,
        ],
      ),
    ),
  );

async function inspection(at: Place, kind = 'move_out') {
  return tx(async () => {
    const row = await one(
      `insert into inspection (company_id, property_id, unit_id, lease_id, tenant_id, kind, unit_type, performed_by)
       values ($1, $2, $3, $4, $5, $6, 'single_room', $7) returning id`,
      [companyId, at.property, at.unit, at.lease, at.tenant, kind, manager],
    );
    const item = await one(
      `insert into inspection_item (company_id, property_id, inspection_id, position, room_key, room_label, item_key,
         item_label) values ($1, $2, $3, 1, 'room', 'Room', 'window', 'Window') returning id`,
      [companyId, at.property, row.id],
    );
    return { id: row.id, item: item.id };
  });
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyId = await createCompany(app, 'Maintenance Co');
  manager = await createPerson(app, 'Manager');
  approver = await createPerson(app, 'Approver');
  managerMembership = await createMembership(app, companyId, manager);
  approverMembership = await createMembership(app, companyId, approver, 'agency_admin');
  here = await place('MH');
  there = await place('MT');
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('MI-06 the job machine in the database', () => {
  it('starts every job as reported', async () => {
    expect(
      await sqlState(
        tx(() =>
          app.query(
            `insert into maintenance_job (company_id, property_id, source, description, status)
             values ($1, $2, 'staff', 'Gate broken', 'triaged')`,
            [companyId, here.property],
          ),
        ),
      ),
    ).toBe('RA080');
  });

  it('refuses a move the machine does not allow, and triage without priority and category', async () => {
    const id = await job();
    expect(await update('maintenance_job', "status = 'in_progress'", id)).toBe('RA080');
    expect(await update('maintenance_job', "status = 'triaged'", id)).toBe('23514');
    expect(await update('maintenance_job', "status = 'closed', closed_at = now()", id)).toBe(
      'RA080',
    );
  });

  it('starts work only with a before photo or a reason for none', async () => {
    const id = await job();
    await update(
      'maintenance_job',
      "status = 'triaged', priority = 'routine', category = 'carpentry'",
      id,
    );
    await update(
      'maintenance_job',
      "status = 'assigned', assignee_kind = 'staff', assignee_person_id = $2",
      id,
      [manager],
    );
    expect(await update('maintenance_job', "status = 'in_progress'", id)).toBe('RA081');
    expect(
      await update(
        'maintenance_job',
        "status = 'in_progress', before_photo_reason = 'Emergency: no time'",
        id,
      ),
    ).toBeNull();
  });

  it('★ cannot reach work done or closed without an after photo and a completion note', async () => {
    const id = await inProgress();
    expect(
      await update(
        'maintenance_job',
        "status = 'work_done', work_done_at = now(), completion_note = 'Fixed it'",
        id,
      ),
    ).toBe('RA081');
    // A video is not a photo, and a note is needed too.
    await attach(id, 'after', 'video');
    expect(
      await update(
        'maintenance_job',
        "status = 'work_done', work_done_at = now(), completion_note = 'Fixed it'",
        id,
      ),
    ).toBe('RA081');
    await attach(id, 'after');
    expect(
      await update(
        'maintenance_job',
        "status = 'work_done', work_done_at = now(), completion_note = ' '",
        id,
      ),
    ).toBe('RA081');
    expect(
      await update(
        'maintenance_job',
        "status = 'work_done', work_done_at = now(), completion_note = 'Fixed it'",
        id,
      ),
    ).toBeNull();
    // A dispute sends it back; the evidence still stands for the close.
    expect(
      await update('maintenance_job', "status = 'in_progress', tenant_response = 'disputed'", id),
    ).toBeNull();
    expect(
      await update('maintenance_job', "status = 'work_done', completion_note = 'Fixed again'", id),
    ).toBeNull();
    expect(await update('maintenance_job', "status = 'closed'", id)).toBe('RA081');
    expect(await update('maintenance_job', "status = 'closed', closed_at = now()", id)).toBeNull();
  });

  it('never changes a closed or cancelled job, nor what was reported, nor adds files to it', async () => {
    const id = await job();
    expect(await update('maintenance_job', "description = 'Something else'", id)).not.toBeNull();
    expect(await update('maintenance_job', "status = 'cancelled'", id)).toBe('RA081');
    expect(
      await update('maintenance_job', "status = 'cancelled', cancel_reason = 'A duplicate'", id),
    ).toBeNull();
    expect(await update('maintenance_job', "priority = 'urgent'", id)).toBe('RA082');
    expect(await sqlState(attach(id, 'other'))).toBe('RA082');
    // The table owner's trigger refuses the fixed facts even where a grant would allow them.
    const open = await job();
    expect(await update('maintenance_job', "priority = 'emergency'", open)).toBeNull();
    expect(
      await sqlState(tx(() => app.query('delete from maintenance_job where id = $1', [open]))),
    ).not.toBeNull();
  });

  it('keeps the job history append-only', async () => {
    const id = await job();
    const event = await tx(() =>
      one(
        `insert into maintenance_job_event (company_id, property_id, job_id, kind, actor_kind, actor_person_id)
         values ($1, $2, $3, 'note', 'staff', $4) returning id`,
        [companyId, here.property, id, manager],
      ),
    );
    expect(await update('maintenance_job_event', "kind = 'reported'", event.id)).toBe('42501');
  });
});

describe('MI-10 a submitted inspection is frozen', () => {
  it('submits only when every item has a condition, then refuses any change', async () => {
    const { id, item } = await inspection(here, 'routine');
    expect(await update('inspection', "status = 'submitted', submitted_at = now()", id)).toBe(
      'RA084',
    );
    expect(await update('inspection_item', "condition = 'good', note = 'Fine'", item)).toBeNull();
    expect(await update('inspection_item', "item_key = 'door'", item)).not.toBeNull();
    expect(await update('inspection', "status = 'submitted', submitted_at = now()", id)).toBeNull();
    expect(await update('inspection_item', "condition = 'poor'", item)).toBe('RA083');
    expect(await update('inspection', "status = 'in_progress', submitted_at = null", id)).toBe(
      'RA083',
    );
    const doc = await documentId();
    expect(
      await sqlState(
        tx(() =>
          app.query(
            'insert into inspection_photo (company_id, property_id, inspection_id, item_id, document_id) values ($1, $2, $3, $4, $5)',
            [companyId, here.property, id, item, doc],
          ),
        ),
      ),
    ).toBe('RA083');
    // A correction is a new inspection that names it, once.
    const correction = () =>
      sqlState(
        tx(() =>
          app.query(
            `insert into inspection (company_id, property_id, unit_id, kind, unit_type, corrects_inspection_id)
             values ($1, $2, $3, 'routine', 'single_room', $4)`,
            [companyId, here.property, here.unit, id],
          ),
        ),
      );
    expect(await correction()).toBeNull();
    expect(await correction()).toBe('23505');
  });
});

describe('MI-11 deductions in the database', () => {
  it('★ refuses deductions beyond the deposit held, counting withdrawals back', async () => {
    const at = await place('MD');
    await deposit(at, 100_000);
    const move = await moveOut(at);
    expect(await deduct(at, move, 60_000)).toBeNull();
    expect(await deduct(at, move, 40_001)).toBe('RA086');
    expect(await deduct(at, move, 40_000)).toBeNull();
    const first = await tx(() =>
      one('select id from deposit_deduction where move_out_id = $1 order by created_at limit 1', [
        move,
      ]),
    );
    await tx(() =>
      app.query(
        'insert into deposit_deduction_withdrawal (company_id, property_id, move_out_id, deduction_id) values ($1, $2, $3, $4)',
        [companyId, at.property, move, first.id],
      ),
    );
    expect(await deduct(at, move, 60_000)).toBeNull();
    expect(await deduct(at, move, 1)).toBe('RA086');
  });

  it('takes evidence only from the move-out inspection, and nothing once sent for approval', async () => {
    const at = await place('ME');
    await deposit(at, 50_000);
    const own = await inspection(at);
    const other = await inspection(at, 'routine');
    const move = await moveOut(at, own.id);
    expect(await deduct(at, move, 1000, [other.item])).toBe('RA087');
    expect(await deduct(at, move, 1000, [own.item])).toBeNull();
    expect(await update('move_out', "status = 'settlement_drafted'", move)).toBeNull();
    const request = await approval(move);
    expect(
      await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
        request,
      ]),
    ).toBeNull();
    expect(await deduct(at, move, 1000)).toBe('RA085');
    expect(
      await update('move_out', `charges = '[{"description":"Keys","amountMinor":100}]'`, move),
    ).toBe('RA088');
  });
});

async function approval(moveOutId: string): Promise<string> {
  return tx(
    async () =>
      (
        await one(
          `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash,
             initiated_by, initiator_membership_id, mode, status, expires_at)
           values ($1, 'lease.move_out_settlement', 'move_out', $2, '{}', 'h', $3, $4, 'two_person', 'pending',
             now() + interval '1 day') returning id`,
          [companyId, moveOutId, manager, managerMembership],
        )
      ).id,
  );
}

describe('TL-11 the move-out machine in the database', () => {
  it('★ is approved only on a second person’s approval, then its settlement is fixed', async () => {
    const at = await place('MA');
    const move = await moveOut(at);
    expect(await update('move_out', "status = 'approved'", move)).toBe('RA088');
    await update('move_out', "status = 'settlement_drafted'", move);
    const request = await approval(move);
    await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
      request,
    ]);
    const approve =
      "status = 'approved', approved_on = current_date, approved_at = now(), statement = '{}'";
    expect(await update('move_out', approve, move)).toBe('RA089');
    // The initiator's own decision is refused by AD-05; another person's counts.
    await inContext(app, { companyId, personId: approver }, () =>
      app.query(
        "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
        [companyId, request, approver, approverMembership],
      ),
    );
    expect(await update('move_out', approve, move)).toBeNull();
    expect(await update('move_out', 'planned_date = current_date + 1', move)).toBe('RA088');
    expect(
      await update(
        'move_out',
        "status = 'cancelled', cancelled_at = now(), cancel_reason = 'No'",
        move,
      ),
    ).toBe('RA088');
    expect(await update('move_out', "status = 'closed', closed_at = now()", move)).toBeNull();
    expect(await update('move_out', "note = 'Later'", move)).toBe('RA088');
  });

  it('keeps one live move-out per lease, and starts a deposit settlement drafted', async () => {
    const at = await place('ML');
    const first = await moveOut(at);
    expect(await sqlState(moveOut(at))).toBe('23505');
    await update(
      'move_out',
      "status = 'cancelled', cancelled_at = now(), cancel_reason = 'Stayed on'",
      first,
    );
    const insert = (status: string) =>
      sqlState(
        tx(() =>
          app.query(
            `insert into move_out (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, kind, status,
               planned_date) values ($1, $2, $3, $4, $5, $6, $7, 'deposit_settlement', $8, current_date)`,
            [companyId, at.property, at.tenant, at.lease, at.unit, at.owner, at.book, status],
          ),
        ),
      );
    expect(await insert('planned')).toBe('RA088');
    expect(await insert('settlement_drafted')).toBeNull();
  });
});

describe('AC-03 expenses in the database', () => {
  async function expense(paidBy: string) {
    return tx(async () => {
      const entry = await one('select id from journal_entry order by posted_at limit 1', []);
      return (
        await one(
          `insert into expense (company_id, property_id, owner_id, book_id, category, supplier_name, amount_minor,
             expense_date, paid_by, entry_id, accounting_date)
           values ($1, $2, $3, $4, 'repairs', 'Kofi Plumber', 12000, current_date, $5, $6, current_date) returning id`,
          [companyId, here.property, here.owner, here.book, paidBy, entry.id],
        )
      ).id;
    });
  }
  const pay = (expenseId: string) =>
    sqlState(
      tx(async () => {
        const entry = await one('select id from journal_entry order by posted_at limit 1', []);
        await app.query(
          `insert into expense_payment (company_id, property_id, expense_id, paid_on, paid_from, entry_id, accounting_date)
           values ($1, $2, $3, current_date, 'owner_account', $4, current_date)`,
          [companyId, here.property, expenseId, entry.id],
        );
      }),
    );
  const reverse = (expenseId: string) =>
    sqlState(
      tx(async () => {
        const entry = await one('select id from journal_entry order by posted_at limit 1', []);
        await app.query(
          `insert into expense_reversal (company_id, property_id, expense_id, reason, entry_id, value_date, accounting_date)
           values ($1, $2, $3, 'Recorded twice', $4, current_date, current_date)`,
          [companyId, here.property, expenseId, entry.id],
        );
      }),
    );

  it('pays a payable once, never one paid when recorded, and nothing after a reversal', async () => {
    await deposit(here, 1);
    const paid = await expense('owner');
    expect(await pay(paid)).toBe('RA090');
    const payable = await expense('unpaid');
    expect(await pay(payable)).toBeNull();
    expect(await pay(payable)).toBe('23505');
    const mistaken = await expense('unpaid');
    expect(await reverse(mistaken)).toBeNull();
    expect(await pay(mistaken)).toBe('RA090');
    expect(await reverse(mistaken)).toBe('RA090');
    expect(await update('expense', 'amount_minor = 1', payable)).toBe('42501');
  });
});

describe('AD-02 and TL-12 scope on the new tables', () => {
  it('shows a property-scoped session its own property’s rows and none of another property', async () => {
    const mine = await job(here);
    const theirs = await job(there);
    await inspection(here, 'routine');
    await inspection(there, 'routine');
    await moveOut(there);
    const count = (table: string, property: string) =>
      scoped({ property: [here.property] }, async () =>
        Number(
          (
            await app.query<{ n: string }>(
              `select count(*) as n from ${table} where property_id = $1`,
              [property],
            )
          ).rows[0]!.n,
        ),
      );
    for (const table of ['maintenance_job', 'inspection', 'inspection_item']) {
      expect(await count(table, here.property), table).toBeGreaterThan(0);
      expect(await count(table, there.property), table).toBe(0);
    }
    expect(await count('move_out', there.property)).toBe(0);
    expect(mine).not.toBe(theirs);
  });

  it('shows a tenant their own job’s files and the steps they hear about, never a staff note', async () => {
    const id = await job(here);
    await attach(id, 'report');
    await tx(() =>
      app.query(
        `insert into maintenance_job_event (company_id, property_id, job_id, kind, actor_kind, actor_person_id, data)
         values ($1, $2, $3, 'reported', 'staff', $4, '{}'), ($1, $2, $3, 'note', 'staff', $4, '{"note":"Internal"}')`,
        [companyId, here.property, id, manager],
      ),
    );
    const seen = (tenant: string) =>
      scoped({ tenant: [tenant], property: [here.property, there.property] }, async () => ({
        files: (await app.query('select 1 from maintenance_job_attachment where job_id = $1', [id]))
          .rowCount,
        events: (
          await app.query('select kind from maintenance_job_event where job_id = $1', [id])
        ).rows.map((r) => r.kind),
        artisans: (await app.query('select 1 from artisan')).rowCount,
      }));
    expect(await seen(here.tenant)).toEqual({ files: 1, events: ['reported'], artisans: 0 });
    expect(await seen(there.tenant)).toEqual({ files: 0, events: [], artisans: 0 });
  });

  it('shows a tenant their move-out only once it is approved', async () => {
    const at = await place('MV');
    const move = await moveOut(at);
    const visible = () =>
      scoped(
        { tenant: [at.tenant], property: [at.property] },
        async () => (await app.query('select 1 from move_out where id = $1', [move])).rowCount,
      );
    expect(await visible()).toBe(0);
    await update('move_out', "status = 'settlement_drafted'", move);
    const request = await approval(move);
    await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
      request,
    ]);
    await inContext(app, { companyId, personId: approver }, () =>
      app.query(
        "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
        [companyId, request, approver, approverMembership],
      ),
    );
    await update(
      'move_out',
      "status = 'approved', approved_on = current_date, approved_at = now(), statement = '{}'",
      move,
    );
    expect(await visible()).toBe(1);
  });
});

describe('MI-01 and TL-12 a tenant sees the files of their own repairs, and no one else’s (0042)', () => {
  it('shows a tenant their own job’s report and after files, not its staff files, and nothing of another tenant’s job', async () => {
    const own = await job(here);
    const theirs = await job(there);
    const add = async (jobId: string, at: Place, stage: string) => {
      const doc = await documentId();
      await tx(() =>
        app.query(
          `insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind, stage, added_by_kind)
           values ($1, $2, $3, $4, 'image', $5, 'staff')`,
          [companyId, at.property, jobId, doc, stage],
        ),
      );
      return doc;
    };
    const report = await add(own, here, 'report');
    const after = await add(own, here, 'after');
    const staffOnly = await add(own, here, 'other');
    const other = await add(theirs, there, 'report');
    const visible = (tenant: string) =>
      scoped({ tenant: [tenant], property: [here.property, there.property] }, async () =>
        (
          await app.query<{ id: string }>('select id from document where id = any($1::uuid[])', [
            [report, after, staffOnly, other],
          ])
        ).rows
          .map((r) => r.id)
          .sort(),
      );
    expect(await visible(here.tenant)).toEqual([report, after].sort());
    expect(await visible(there.tenant)).toEqual([other]);
    // Staff see every file.
    expect(
      (
        await tx(() =>
          app.query('select id from document where id = any($1::uuid[])', [
            [report, after, staffOnly, other],
          ]),
        )
      ).rowCount,
    ).toBe(4);
  });

  it('shows a tenant the final statement of their own approved move-out, and not another tenant', async () => {
    const at = await place('FS');
    const move = await moveOut(at);
    await update('move_out', "status = 'settlement_drafted'", move);
    const request = await approval(move);
    await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
      request,
    ]);
    await inContext(app, { companyId, personId: approver }, () =>
      app.query(
        "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
        [companyId, request, approver, approverMembership],
      ),
    );
    await update(
      'move_out',
      "status = 'approved', approved_on = current_date, approved_at = now(), statement = '{}'",
      move,
    );
    const statement = await documentId();
    expect(
      await update(
        'move_out',
        "statement_document_id = $2, statement_sha256 = repeat('0', 64)",
        move,
        [statement],
      ),
    ).toBeNull();
    const visible = (tenant: string) =>
      scoped(
        { tenant: [tenant], property: [at.property, here.property] },
        async () => (await app.query('select 1 from document where id = $1', [statement])).rowCount,
      );
    expect(await visible(at.tenant)).toBe(1);
    expect(await visible(here.tenant)).toBe(0);
  });
});

describe('TL-11 a closed settlement takes its final statement once (0043)', () => {
  it('closes an approved settlement with no refund, then attaches its statement, and nothing else', async () => {
    const at = await place('MZ');
    const move = await moveOut(at);
    await update('move_out', "status = 'settlement_drafted'", move);
    const request = await approval(move);
    await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
      request,
    ]);
    await inContext(app, { companyId, personId: approver }, () =>
      app.query(
        "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
        [companyId, request, approver, approverMembership],
      ),
    );
    // No refund: approved and closed at once, before the PDF is rendered.
    expect(
      await update(
        'move_out',
        "status = 'approved', approved_on = current_date, approved_at = now(), statement = '{}', deposit_refund_minor = 0, credit_refund_minor = 0",
        move,
      ),
    ).toBeNull();
    expect(await update('move_out', "status = 'closed', closed_at = now()", move)).toBeNull();
    const statement = await documentId();
    const other = await documentId();
    // The statement may come with a change to anything else: refused.
    expect(
      await update(
        'move_out',
        "statement_document_id = $2, statement_sha256 = repeat('0', 64), note = 'Late'",
        move,
        [statement],
      ),
    ).toBe('RA088');
    // Half of it: refused.
    expect(await update('move_out', 'statement_document_id = $2', move, [statement])).toBe('RA088');
    expect(
      await update(
        'move_out',
        "statement_document_id = $2, statement_sha256 = repeat('0', 64), updated_at = now()",
        move,
        [statement],
      ),
    ).toBeNull();
    // Once only.
    expect(
      await update(
        'move_out',
        "statement_document_id = $2, statement_sha256 = repeat('0', 64)",
        move,
        [other],
      ),
    ).toBe('RA088');
    expect(await update('move_out', "note = 'Later'", move)).toBe('RA088');
  });

  it('still never changes a cancelled move-out', async () => {
    const at = await place('MC');
    const move = await moveOut(at);
    await update(
      'move_out',
      "status = 'cancelled', cancelled_at = now(), cancel_reason = 'Stayed on'",
      move,
    );
    const statement = await documentId();
    expect(
      await update(
        'move_out',
        "statement_document_id = $2, statement_sha256 = repeat('0', 64)",
        move,
        [statement],
      ),
    ).toBe('RA088');
  });
});

describe('MI-04 and MI-11 the M8 review rules in the database (0044, 0045)', () => {
  it('keeps a revoked secure link revoked (RA091), while its opens are still counted', async () => {
    const jobId = await job(here);
    const link = await tx(async () => {
      const artisan = await one(
        "insert into artisan (company_id, name, phone, trades, created_by) values ($1, 'Kojo Fix', '+233200000088', '{plumbing}', $2) returning id",
        [companyId, manager],
      );
      return one(
        `insert into secure_link (company_id, property_id, purpose, token_hash, job_id, artisan_id, expires_at)
         values ($1, $2, 'job_sheet', $3, $4, $5, now() + interval '30 days') returning id`,
        [companyId, here.property, randomUUID().replace(/-/g, '').repeat(2), jobId, artisan.id],
      );
    });
    expect(
      await update('secure_link', "revoked_at = now(), revoke_reason = 'superseded'", link.id),
    ).toBeNull();
    expect(await update('secure_link', 'revoked_at = null', link.id)).toBe('RA091');
    expect(await update('secure_link', "revoke_reason = 'expired'", link.id)).toBe('RA091');
    expect(await update('secure_link', 'open_count = open_count + 1', link.id)).toBeNull();
  });

  it('refuses a deduction on a move-out that does not exist (RA085), and keeps a withdrawal on its deduction’s property', async () => {
    const at = await place('RV');
    await deposit(at, 50_000);
    expect(await deduct(at, randomUUID(), 1_000)).toBe('RA085');
    const move = await moveOut(at);
    expect(await deduct(at, move, 50_001)).toBe('RA086');
    expect(await deduct(at, move, 20_000)).toBeNull();
    const { id: deduction } = await tx(() =>
      one('select id from deposit_deduction where move_out_id = $1', [move]),
    );
    const withdraw = (property: string) =>
      sqlState(
        tx(() =>
          app.query(
            'insert into deposit_deduction_withdrawal (company_id, property_id, move_out_id, deduction_id) values ($1, $2, $3, $4)',
            [companyId, property, move, deduction],
          ),
        ),
      );
    expect(await withdraw(here.property)).toBe('23503');
    expect(await withdraw(at.property)).toBeNull();
  });

  it('shows an owner’s advisers the children of that owner’s move-outs only (owner scope through the parent)', async () => {
    const mine = await place('OA');
    const theirs = await place('OB');
    await deposit(mine, 40_000);
    await deposit(theirs, 40_000);
    const myMove = await moveOut(mine);
    const theirMove = await moveOut(theirs);
    expect(await deduct(mine, myMove, 10_000)).toBeNull();
    expect(await deduct(theirs, theirMove, 10_000)).toBeNull();
    const seen = (owner: string) =>
      tx(async () => {
        await app.query("select set_config('app.owner_scope', $1, true)", [`{${owner}}`]);
        return (
          await app.query<{ move_out_id: string }>(
            'select move_out_id from deposit_deduction where move_out_id = any($1::uuid[])',
            [[myMove, theirMove]],
          )
        ).rows.map((r) => r.move_out_id);
      });
    expect(await seen(mine.owner)).toEqual([myMove]);
    expect(await seen(theirs.owner)).toEqual([theirMove]);
  });

  it('keeps one move-in report out for signature per lease', async () => {
    const at = await place('MR');
    const open = (inspectionId: string) =>
      sqlState(
        tx(() =>
          app.query(
            `insert into signing_request (company_id, property_id, tenant_id, lease_id, subject_type, inspection_id,
               status, created_by)
             values ($1, $2, $3, $4, 'move_in_report', $5, 'preparing', $6)`,
            [companyId, at.property, at.tenant, at.lease, inspectionId, manager],
          ),
        ),
      );
    const first = await inspection(at, 'move_in');
    const second = await inspection(at, 'move_in');
    expect(await open(first.id)).toBeNull();
    expect(await open(second.id)).toBe('23505');
  });
});

describe('MI-01 a tenant sees the before files of their own repair (0042, M8 review)', () => {
  it('shows the tenant a before file of their own job, and not another tenant’s', async () => {
    const own = await job(here);
    const doc = await documentId();
    await tx(() =>
      app.query(
        `insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind, stage, added_by_kind)
         values ($1, $2, $3, $4, 'image', 'before', 'staff')`,
        [companyId, here.property, own, doc],
      ),
    );
    const visible = (tenant: string) =>
      scoped({ tenant: [tenant], property: [here.property, there.property] }, async () => ({
        files: (
          await app.query('select 1 from maintenance_job_attachment where job_id = $1', [own])
        ).rowCount,
        documents: (await app.query('select 1 from document where id = $1', [doc])).rowCount,
      }));
    expect(await visible(here.tenant)).toEqual({ files: 1, documents: 1 });
    expect(await visible(there.tenant)).toEqual({ files: 0, documents: 0 });
  });
});

describe('TL-11 a final statement carries its document’s own hash (0046; founder, 2026-11-06)', () => {
  it('refuses a statement whose hash is not its document’s, on an approved and on a closed move-out (RA092)', async () => {
    for (const close of [false, true]) {
      const at = await place(close ? 'HC' : 'HA');
      const move = await moveOut(at);
      await update('move_out', "status = 'settlement_drafted'", move);
      const request = await approval(move);
      await update('move_out', "status = 'awaiting_approval', approval_request_id = $2", move, [
        request,
      ]);
      await inContext(app, { companyId, personId: approver }, () =>
        app.query(
          "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
          [companyId, request, approver, approverMembership],
        ),
      );
      await update(
        'move_out',
        "status = 'approved', approved_on = current_date, approved_at = now(), statement = '{}'",
        move,
      );
      if (close) await update('move_out', "status = 'closed', closed_at = now()", move);
      const statement = await documentId();
      expect(
        await update(
          'move_out',
          "statement_document_id = $2, statement_sha256 = repeat('f', 64)",
          move,
          [statement],
        ),
      ).toBe('RA092');
      expect(
        await update(
          'move_out',
          "statement_document_id = $2, statement_sha256 = repeat('0', 64)",
          move,
          [statement],
        ),
      ).toBeNull();
    }
  });
});
