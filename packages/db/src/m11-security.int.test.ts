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
 * M11 migrations 0067 and 0068: the security review's database findings (R2 F4, F5), the approval
 * eligibility check (RA018), the cut-over and data protection request guards, and scan results.
 */
let db: TestDatabase;
let app: pg.Client;
let companyA: string;
let companyB: string;

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyA = await createCompany(app, 'M11 Company A');
  companyB = await createCompany(app, 'M11 Company B');
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('NFR-SEC definer functions cannot be fooled by temporary tables (review R2 F4)', () => {
  it('refuses rent_app a temporary table, so none can shadow period_lock', async () => {
    expect(
      await sqlState(
        inContext(app, { companyId: companyA }, () =>
          app.query(
            'create temporary table period_lock (company_id uuid, book_id uuid, month date)',
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('puts pg_temp last on every function that fixes its search path', async () => {
    const rows = await runSql<{ sig: string; config: string[] | null }>(
      db.ownerUrl,
      `select p.oid::regprocedure::text as sig, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'audit')
         and (p.prosecdef or exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`,
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows)
      expect(row.config, row.sig).toContain('search_path=pg_catalog, public, pg_temp');
  });
});

describe('NFR-SEC the deposit held is read in its own company only (review R2 F5)', () => {
  it('refuses app.deposit_deduction_room for another company', async () => {
    const lease = '00000000-0000-0000-0000-000000000001';
    expect(
      await sqlState(
        inContext(app, { companyId: companyA }, () =>
          app.query('select app.deposit_deduction_room($1, $2, $2)', [companyB, lease]),
        ),
      ),
    ).toBe('42501');
    const own = await inContext(app, { companyId: companyA }, () =>
      app.query<{ room: string }>('select app.deposit_deduction_room($1, $2, $2) as room', [
        companyA,
        lease,
      ]),
    );
    expect(Number(own.rows[0]!.room)).toBe(0);
  });
});

describe('AD-05 only someone eligible when a request was made decides it (RA018)', () => {
  it('refuses a decision by a person outside the request’s eligible approvers', async () => {
    const initiator = await createPerson(app, 'RA018 initiator');
    const eligible = await createPerson(app, 'RA018 eligible');
    const latecomer = await createPerson(app, 'RA018 latecomer');
    const initiatorMembership = await createMembership(app, companyA, initiator, 'agency_admin');
    const eligibleMembership = await createMembership(app, companyA, eligible, 'agency_admin');
    const lateMembership = await createMembership(app, companyA, latecomer, 'agency_admin');
    const request = async () =>
      (
        await inContext(app, { companyId: companyA, personId: initiator }, () =>
          app.query<{ id: string }>(
            `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash,
               initiated_by, initiator_membership_id, mode, status, expires_at, eligible_approvers)
             values ($1, 'test.action', 'test', gen_random_uuid()::text, '{}', 'h', $2, $3, 'two_person', 'pending',
               now() + interval '1 day', $4) returning id`,
            [companyA, initiator, initiatorMembership, [eligible]],
          ),
        )
      ).rows[0]!.id;
    const decide = (requestId: string, person: string, membership: string) =>
      inContext(app, { companyId: companyA, personId: person }, () =>
        app.query(
          `insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash)
           values ($1, $2, $3, $4, 'approve', 'h')`,
          [companyA, requestId, person, membership],
        ),
      );
    expect(await sqlState(decide(await request(), latecomer, lateMembership))).toBe('RA018');
    expect(await sqlState(decide(await request(), eligible, eligibleMembership))).toBeNull();
  });
});

describe('P25 the cut-over is fixed once opening balances are posted (RA120)', () => {
  it('lets the cut-over move until it is fixed, then never', async () => {
    await inContext(app, { companyId: companyA }, () =>
      app.query(
        `insert into company_onboarding (company_id, cut_over_date) values ($1, '2026-10-01')`,
        [companyA],
      ),
    );
    const set = (sqlText: string) =>
      inContext(app, { companyId: companyA }, () => app.query(sqlText));
    expect(
      await sqlState(set(`update company_onboarding set cut_over_date = '2026-10-15'`)),
    ).toBeNull();
    expect(await sqlState(set(`update company_onboarding set fixed_at = now()`))).toBeNull();
    expect(await sqlState(set(`update company_onboarding set cut_over_date = '2026-10-20'`))).toBe(
      'RA120',
    );
    expect(await sqlState(set(`update company_onboarding set fixed_at = null`))).toBe('RA120');
  });
});

describe('NFR-DP a closed data protection request never changes (RA121)', () => {
  it('refuses changes after completion, and to what the request is about', async () => {
    const staff = await createPerson(app, 'RA121 staff');
    const tenant = await inContext(app, { companyId: companyA }, () =>
      app.query<{ id: string }>(
        `insert into tenant (company_id, kind, display_name) values ($1, 'individual', 'RA121 Tenant') returning id`,
        [companyA],
      ),
    );
    const request = await inContext(app, { companyId: companyA, personId: staff }, () =>
      app.query<{ id: string }>(
        `insert into data_protection_request (company_id, tenant_id, kind, received_on, created_by)
         values ($1, $2, 'erasure', '2026-11-01', $3) returning id`,
        [companyA, tenant.rows[0]!.id, staff],
      ),
    );
    const id = request.rows[0]!.id;
    const run = (sqlText: string) =>
      inContext(app, { companyId: companyA }, () => app.query(sqlText, [id]));
    expect(
      await sqlState(run(`update data_protection_request set kind = 'access' where id = $1`)),
    ).toMatch(/^(42501|RA121)$/);
    expect(
      await sqlState(
        run(
          `update data_protection_request set messaging_stopped_at = now(), status = 'in_progress' where id = $1`,
        ),
      ),
    ).toBeNull();
    expect(
      await sqlState(
        run(`update data_protection_request set messaging_stopped_at = null where id = $1`),
      ),
    ).toBe('RA121');
    expect(
      await sqlState(
        run(
          `update data_protection_request set status = 'completed', completed_at = now(), outcome = 'Done' where id = $1`,
        ),
      ),
    ).toBeNull();
    expect(
      await sqlState(run(`update data_protection_request set outcome = 'Changed' where id = $1`)),
    ).toBe('RA121');
  });
});

describe('NFR-SEC scan results are append-only and per company (M11 decision 6)', () => {
  it('records a result once, never changes it, and hides it from another company', async () => {
    const zero = '0'.repeat(64);
    const doc = await inContext(app, { companyId: companyA }, () =>
      app.query<{ id: string }>(
        `insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once)
         values ($1, 'test', 'image/jpeg', 1, $2, 'b', 'scan-k', false) returning id`,
        [companyA, zero],
      ),
    );
    const id = doc.rows[0]!.id;
    await inContext(app, { companyId: companyA }, () =>
      app.query(
        `insert into document_scan (company_id, document_id, status, engine, finding)
         values ($1, $2, 'infected', 'fake', 'Eicar-Test-Signature')`,
        [companyA, id],
      ),
    );
    expect(
      await sqlState(
        inContext(app, { companyId: companyA }, () =>
          app.query(`update document_scan set status = 'clean', finding = null`),
        ),
      ),
    ).toMatch(/^(42501|RA001)$/);
    const other = await inContext(app, { companyId: companyB }, () =>
      app.query<{ n: number }>(
        'select count(*)::int as n from document_scan where document_id = $1',
        [id],
      ),
    );
    expect(other.rows[0]!.n).toBe(0);
    // Every document stored before M11 has its result (pre_m11); a new one starts with none.
    const unscanned = await inContext(app, { companyId: companyA }, () =>
      app.query<{ n: number }>(
        `select count(*)::int as n from document d
         where not exists (select 1 from document_scan s where s.company_id = d.company_id and s.document_id = d.id)`,
      ),
    );
    expect(unscanned.rows[0]!.n).toBe(0);
  });
});
