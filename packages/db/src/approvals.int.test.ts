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

let db: TestDatabase;
let app: pg.Client;
let companyId: string;
let initiator: string;
let initiatorMembership: string;
let approver: string;
let approverMembership: string;

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyId = await createCompany(app, 'Approvals Co', 'agency');
  initiator = await createPerson(app, 'Initiator');
  approver = await createPerson(app, 'Approver');
  initiatorMembership = await createMembership(app, companyId, initiator, 'agency_admin');
  approverMembership = await createMembership(app, companyId, approver, 'property_manager');
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

async function request(
  mode: 'two_person' | 'single_user',
  coolingOff = "now() + interval '24 hours'",
): Promise<string> {
  return inContext(app, { companyId, personId: initiator }, async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
         initiator_membership_id, mode, status, cooling_off_until, expires_at)
       values ($1, 'test.action', 'test', gen_random_uuid()::text, '{}', 'h', $2, $3, $4, $5, ${mode === 'single_user' ? coolingOff : 'null'}, now() + interval '7 days')
       returning id`,
      [
        companyId,
        initiator,
        initiatorMembership,
        mode,
        mode === 'single_user' ? 'cooling_off' : 'pending',
      ],
    );
    return rows[0]!.id;
  });
}

const decide = (
  requestId: string,
  person: string,
  membership: string,
  kind: string,
  stepUp = false,
) =>
  inContext(app, { companyId, personId: person }, () =>
    app.query(
      'insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash, step_up_verified) values ($1, $2, $3, $4, $5, $6, $7)',
      [companyId, requestId, person, membership, kind, 'h', stepUp],
    ),
  );

const setStatus = (requestId: string, status: string) =>
  inContext(app, { companyId, personId: approver }, () =>
    app.query('update approval_request set status = $2 where id = $1', [requestId, status]),
  );

describe('AD-05 approvals: the initiator can never approve (database)', () => {
  it('rejects a raw insert of the initiator approving their own request', async () => {
    const id = await request('two_person');
    expect(await sqlState(decide(id, initiator, initiatorMembership, 'approve'))).toBe('RA013');
    expect(await sqlState(decide(id, initiator, initiatorMembership, 'reject'))).toBe('RA013');
  });

  it('accepts a second person, and only then lets the request be approved', async () => {
    const id = await request('two_person');
    expect(await sqlState(setStatus(id, 'approved'))).toBe('RA017');
    expect(await sqlState(decide(id, approver, approverMembership, 'approve'))).toBeNull();
    expect(await sqlState(setStatus(id, 'approved'))).toBeNull();
    // Closed requests accept nothing more.
    expect(await sqlState(setStatus(id, 'rejected'))).toBe('RA011');
    expect(await sqlState(decide(id, approver, approverMembership, 'approve'))).not.toBeNull();
  });

  it('refuses a second decision by the same person', async () => {
    const id = await request('two_person');
    await decide(id, approver, approverMembership, 'reject');
    expect(await sqlState(decide(id, approver, approverMembership, 'approve'))).not.toBeNull();
  });
});

describe('AD-05 single-user cooling-off (database)', () => {
  it('refuses self-confirmation before the cooling-off period ends', async () => {
    const id = await request('single_user');
    expect(await sqlState(decide(id, initiator, initiatorMembership, 'self_confirm', true))).toBe(
      'RA013',
    );
  });

  it('accepts self-confirmation after it, but only with a verified one-time code', async () => {
    const id = await request('single_user', "now() - interval '1 minute'");
    expect(await sqlState(decide(id, initiator, initiatorMembership, 'self_confirm', false))).toBe(
      'RA013',
    );
    expect(
      await sqlState(decide(id, initiator, initiatorMembership, 'self_confirm', true)),
    ).toBeNull();
    expect(await sqlState(setStatus(id, 'approved'))).toBeNull();
  });

  it('never accepts self-confirmation from anyone else, or an ordinary approval in single-user mode', async () => {
    const id = await request('single_user', "now() - interval '1 minute'");
    expect(await sqlState(decide(id, approver, approverMembership, 'self_confirm', true))).toBe(
      'RA014',
    );
    expect(await sqlState(decide(id, approver, approverMembership, 'approve'))).toBe('RA015');
  });
});
