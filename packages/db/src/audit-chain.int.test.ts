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

let db: TestDatabase;
let app: pg.Client;

interface Verification {
  ok: boolean;
  events: number;
  first_bad_seq: number | null;
  problem: string | null;
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

/** A company with a few audited changes: creation, two memberships and a role change. */
async function companyWithHistory(name: string) {
  const companyId = await createCompany(app, name);
  const admin = await createPerson(app, `${name} admin`);
  const member = await createPerson(app, `${name} member`);
  await createMembership(app, companyId, admin, 'agency_admin');
  const membershipId = await createMembership(app, companyId, member, 'caretaker');
  await inContext(app, { companyId, personId: admin, actorKind: 'staff' }, () =>
    app.query("update membership set role = 'property_manager', updated_at = now() where id = $1", [
      membershipId,
    ]),
  );
  return { companyId, admin, member, membershipId };
}

const verify = async (companyId: string) =>
  (
    await runSql<Verification>(
      db.superuserUrl,
      'select ok, events::int, first_bad_seq::int, problem from audit.verify_chain($1)',
      [companyId],
    )
  )[0]!;

/** Changes rows below the application, as someone with superuser access could. */
const tamper = (statement: string, values: unknown[]) =>
  runSql(
    db.superuserUrl,
    `set session_replication_role = replica; ${statement.replace(/\$(\d)/g, (_, n: string) => `'${String(values[Number(n) - 1])}'`)}`,
  );

describe('AD-07 audit chain detects tampering', () => {
  it('verifies an untouched chain', async () => {
    const { companyId } = await companyWithHistory('Clean');
    const result = await verify(companyId);
    expect(result).toMatchObject({ ok: true, problem: null });
    expect(result.events).toBeGreaterThanOrEqual(4);
  });

  it('detects an altered row and names its sequence number', async () => {
    const { companyId } = await companyWithHistory('Altered');
    await tamper(
      `update audit_event set data = '{"forged": true}' where company_id = $1 and seq = 2`,
      [companyId],
    );
    expect(await verify(companyId)).toMatchObject({
      ok: false,
      first_bad_seq: 2,
      problem: 'hash does not match the event contents',
    });
  });

  it('detects a deleted row in the middle', async () => {
    const { companyId } = await companyWithHistory('Deleted');
    await tamper('delete from audit_event where company_id = $1 and seq = 2', [companyId]);
    expect(await verify(companyId)).toMatchObject({
      ok: false,
      first_bad_seq: 2,
      problem: 'event missing from the chain',
    });
  });

  it('detects a deleted last row through the chain head', async () => {
    const { companyId } = await companyWithHistory('Truncated');
    await tamper(
      'delete from audit_event where company_id = $1 and seq = (select max(seq) from audit_event where company_id = $1)',
      [companyId],
    );
    expect(await verify(companyId)).toMatchObject({
      ok: false,
      problem: 'chain head does not match the last event',
    });
  });

  it('detects a forged row appended without the right hash', async () => {
    const { companyId } = await companyWithHistory('Forged');
    await tamper(
      `insert into audit_event (company_id, seq, occurred_at, actor_kind, action, prev_hash, hash)
       select company_id, last_seq + 1, now(), 'staff', 'forged.event', last_hash, sha256('forged') from audit_chain_head where company_id = $1`,
      [companyId],
    );
    expect(await verify(companyId)).toMatchObject({
      ok: false,
      problem: 'hash does not match the event contents',
    });
  });
});

describe('AD-07 audit capture', () => {
  it('records the actor, kind and request id from the transaction settings', async () => {
    const companyId = await createCompany(app, 'Actors');
    const admin = await createPerson(app, 'Actor admin');
    await app.query('begin');
    await app.query(
      "select set_config('app.company_id', $1, true), set_config('app.person_id', $2, true), set_config('app.actor_kind', 'staff', true), set_config('app.request_id', 'req-123', true)",
      [companyId, admin],
    );
    await app.query(
      "insert into membership (company_id, person_id, role) values ($1, $2, 'agency_admin')",
      [companyId, admin],
    );
    await app.query('commit');
    const [event] = await runSql<{
      actor_person_id: string;
      actor_kind: string;
      request_id: string;
      action: string;
    }>(
      db.superuserUrl,
      "select actor_person_id, actor_kind, request_id, action from audit_event where company_id = $1 and action = 'membership.insert'",
      [companyId],
    );
    expect(event).toEqual({
      actor_person_id: admin,
      actor_kind: 'staff',
      request_id: 'req-123',
      action: 'membership.insert',
    });
  });

  it('gives the application role no direct way to write, change or delete audit events', async () => {
    const companyId = await createCompany(app, 'No direct writes');
    const insert = await sqlState(
      inContext(app, { companyId }, () =>
        app.query(
          "insert into audit_event (company_id, seq, occurred_at, actor_kind, action, prev_hash, hash) values ($1, 99, now(), 'staff', 'x', '\\x00', '\\x00')",
          [companyId],
        ),
      ),
    );
    expect(insert).toBe('42501');
    expect(
      await sqlState(
        inContext(app, { companyId }, () => app.query('update audit_event set action = $1', ['x'])),
      ),
    ).toBe('42501');
    expect(
      await sqlState(inContext(app, { companyId }, () => app.query('delete from audit_event'))),
    ).toBe('42501');
  });

  it("refuses to append to another company's chain", async () => {
    const own = await createCompany(app, 'Own');
    const other = await createCompany(app, 'Other');
    const state = await sqlState(
      inContext(app, { companyId: own }, () =>
        app.query("select audit.append($1, 'x.y', null, null, '{}')", [other]),
      ),
    );
    expect(state).toBe('RA002');
  });

  it('records key material only as changed, never by value', async () => {
    const companyId = await createCompany(app, 'Keys');
    await inContext(app, { companyId }, () =>
      app.query(
        "insert into company_key (company_id, purpose, version, wrapped_key, kms_key_id) values ($1, 'field_encryption', 1, '\\xdeadbeef', 'k')",
        [companyId],
      ),
    );
    const [event] = await runSql<{ data: { after: { wrapped_key: string } } }>(
      db.superuserUrl,
      "select data from audit_event where company_id = $1 and action = 'company_key.insert'",
      [companyId],
    );
    expect(event!.data.after.wrapped_key).toBe('[redacted]');
  });
});

describe('AD-07 permission change is logged', () => {
  it('records who changed a role, when, and the before and after values', async () => {
    const { companyId, admin, membershipId } = await companyWithHistory('Permissions');
    const [event] = await runSql<{
      actor_person_id: string;
      occurred_at: Date;
      data: { before: { role: string }; after: { role: string } };
    }>(
      db.superuserUrl,
      "select actor_person_id, occurred_at, data from audit_event where company_id = $1 and action = 'membership.update' and record_id = $2",
      [companyId, membershipId],
    );
    expect(event!.actor_person_id).toBe(admin);
    expect(event!.occurred_at).toBeInstanceOf(Date);
    expect(event!.data.before.role).toBe('caretaker');
    expect(event!.data.after.role).toBe('property_manager');
  });
});
