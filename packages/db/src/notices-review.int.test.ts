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
 * The M7 review's database rules (0039; docs/plans/M7.md section 9.3): a notice to quit is issued
 * only on a second person's approval with OQ-16 in force (RA073); recipients are fixed at issue
 * (RA074); an assessment is corrected or voided once, never both (RA075); one live correction per
 * notice; a closed notice takes a late-service flag once; and the ladder's shift moves. Real
 * PostgreSQL with RLS, through the application role.
 */
let db: TestDatabase;
let app: pg.Client;
let companyId: string;
let initiator: string;
let initiatorMembership: string;
let approver: string;
let approverMembership: string;
let f: { property: string; unit: string; tenant: string; lease: string };

const tx = <T>(fn: () => Promise<T>) => inContext(app, { companyId }, fn);
const one = async <T>(text: string, values: unknown[] = []) =>
  (await app.query<T & pg.QueryResultRow>(text, values)).rows[0]!;

async function notice(type: string, status = 'draft', corrects: string | null = null) {
  return tx(
    async () =>
      (
        await one<{ id: string }>(
          `insert into notice (company_id, type, subtype, status, property_id, unit_id, lease_id, tenant_id, fields,
           template_key, template_version, corrects_notice_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, '{"particulars":"x"}', 'notices.notice', 1, $9) returning id`,
          [
            companyId,
            type,
            type === 'notice_to_quit' ? 'arrears' : 'noise',
            status,
            f.property,
            f.unit,
            f.lease,
            f.tenant,
            corrects,
          ],
        )
      ).id,
  );
}

/** Issues a draft as the service does: a number, then status sent. */
const issue = (id: string, number: number) =>
  tx(() =>
    app.query(
      `update notice set status = 'sent', number = $2, issue_date = current_date, issued_at = now()
       where id = $1`,
      [id, number],
    ),
  );

async function approval(noticeId: string, decision: 'approve' | 'self' | null, by = approver) {
  return tx(async () => {
    const { id } = await one<{ id: string }>(
      `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash,
         initiated_by, initiator_membership_id, mode, status, cooling_off_until, expires_at)
       values ($1, 'notice.issue_quit', 'notice', $2, '{}', 'h', $3, $4, $5, $6, $7, now() + interval '7 days')
       returning id`,
      [
        companyId,
        noticeId,
        initiator,
        initiatorMembership,
        // OQ-29: a sole user confirms only after the cooling-off.
        decision === 'self' ? 'single_user' : 'two_person',
        decision === 'self' ? 'cooling_off' : 'pending',
        decision === 'self' ? new Date(Date.now() - 60_000) : null,
      ],
    );
    if (decision)
      await app.query(
        `insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind,
           payload_hash, step_up_verified)
         values ($1, $2, $3, $4, $5, 'h', $6)`,
        [
          companyId,
          id,
          decision === 'self' ? initiator : by,
          decision === 'self'
            ? initiatorMembership
            : by === approver
              ? approverMembership
              : initiatorMembership,
          decision === 'self' ? 'self_confirm' : 'approve',
          decision === 'self',
        ],
      );
    await app.query('update notice set approval_request_id = $2 where id = $1', [noticeId, id]);
    return id;
  });
}

const quitAck = (action: 'grant' | 'withdraw') =>
  tx(() =>
    app.query(
      `insert into notice_quit_acknowledgement (company_id, action, person_id, membership_id, typed_name,
         statement_version, statement_sha256, reason)
       values ($1, $2, $3, $4, $5, 'quit_ack.v1', $6, $7)`,
      [
        companyId,
        action,
        initiator,
        initiatorMembership,
        action === 'grant' ? 'Admin' : null,
        '0'.repeat(64),
        action === 'withdraw' ? 'Paused' : null,
      ],
    ),
  );

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyId = await createCompany(app, 'Review A', 'agency');
  initiator = await createPerson(app, 'Initiator');
  approver = await createPerson(app, 'Approver');
  initiatorMembership = await createMembership(app, companyId, initiator);
  approverMembership = await createMembership(app, companyId, approver);
  f = await tx(async () => {
    const portfolio = await one<{ id: string }>(
      "insert into portfolio (company_id, name, is_default) values ($1, 'P', false) returning id",
      [companyId],
    );
    const property = (
      await one<{ id: string }>(
        `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
         values ($1, $2, 'ACC-RV', 'ACC', 'ACC-RV', 'compound_house', 'residential', 'Greater Accra') returning id`,
        [companyId, portfolio.id],
      )
    ).id;
    const owner = await one<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-RV', 'individual', 'Owner') returning id",
      [companyId],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, property, owner.id],
    );
    const block = await one<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, property],
    );
    const unit = (
      await one<{ id: string }>(
        `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
         values ($1, $2, $3, 'ACC-RV-B1-01', '01', 'single_room', 'single_room') returning id`,
        [companyId, property, block.id],
      )
    ).id;
    const tenant = (
      await one<{ id: string }>(
        "insert into tenant (company_id, kind, display_name, phone) values ($1, 'individual', 'Kofi', '+233200000778') returning id",
        [companyId],
      )
    ).id;
    const lease = (
      await one<{ id: string }>(
        `insert into lease (company_id, property_id, unit_id, tenant_id, use, start_date, end_date, monthly_rent_minor,
           rent_cycle, notice_days)
         values ($1, $2, $3, $4, 'residential', current_date, current_date + 364, 150000, 'monthly', 30) returning id`,
        [companyId, property, unit, tenant],
      )
    ).id;
    const doc = await one<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'lease_file', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
      [companyId, '0'.repeat(64)],
    );
    await app.query(
      "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
      [lease, doc.id],
    );
    return { property, unit, tenant, lease };
  });
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('M7 review data S4: a notice to quit is issued only on a second person’s approval', () => {
  it('refuses sent without an approval, or with OQ-16 off; allows it on another person’s or a single user’s confirmation', async () => {
    const bare = await notice('notice_to_quit');
    expect(await sqlState(issue(bare, 901))).toBe('RA073');
    // The initiator approving their own request is refused before it gets here (AD-05).
    const approved = await notice('notice_to_quit');
    await approval(approved, 'approve');
    expect(await sqlState(issue(approved, 903))).toBe('RA073');
    await quitAck('grant');
    expect(await sqlState(issue(approved, 903))).toBeNull();
    const solo = await notice('notice_to_quit');
    await approval(solo, 'self');
    expect(await sqlState(issue(solo, 904))).toBeNull();
    await quitAck('withdraw');
    const after = await notice('notice_to_quit');
    await approval(after, 'approve');
    expect(await sqlState(issue(after, 905))).toBe('RA073');
    // Other notices issue as before.
    expect(await sqlState(issue(await notice('breach'), 906))).toBeNull();
    await quitAck('grant');
  });
});

describe('M7 review data S5: the recipients are fixed at issue', () => {
  it('takes recipients before the sent event, and refuses one after', async () => {
    const id = await notice('breach');
    const recipient = (position: number) =>
      tx(() =>
        app.query(
          `insert into notice_recipient (company_id, property_id, notice_id, tenant_id, lease_id, unit_id, kind, name,
             phone, channels, physical_service_planned, position)
           values ($1, $2, $3, $4, $5, $6, 'tenant', 'Kofi', '+233200000778', '[]', false, $7)`,
          [companyId, f.property, id, f.tenant, f.lease, f.unit, position],
        ),
      );
    expect(await sqlState(recipient(1))).toBeNull();
    await issue(id, 910);
    await tx(() =>
      app.query(
        "insert into notice_event (company_id, property_id, notice_id, kind, dedupe_key) values ($1, $2, $3, 'sent', $4)",
        [companyId, f.property, id, `sent:${id}`],
      ),
    );
    expect(await sqlState(recipient(2))).toBe('RA074');
  });
});

describe('M7 review C4: an assessment is corrected or voided once, never both', () => {
  it('refuses a second correction, a void of a corrected one and a correction of a voided one', async () => {
    const assessment = (replaces: string | null = null) =>
      tx(
        async () =>
          (
            await one<{ id: string }>(
              `insert into rent_assessment (company_id, property_id, unit_id, assessed_on, reference, replaces_id, reason,
               recorded_by)
             values ($1, $2, $3, current_date - 10, 'RO/1', $4, $5, $6) returning id`,
              [companyId, f.property, f.unit, replaces, replaces ? 'Typed wrong' : null, initiator],
            )
          ).id,
      );
    const voidOf = (id: string) =>
      tx(() =>
        app.query(
          `insert into rent_assessment_void (company_id, property_id, unit_id, assessment_id, reason, voided_by)
           values ($1, $2, $3, $4, 'Wrong unit', $5)`,
          [companyId, f.property, f.unit, id, initiator],
        ),
      );
    const first = await assessment();
    await assessment(first);
    expect(await sqlState(assessment(first))).toBe('23505');
    expect(await sqlState(voidOf(first))).toBe('RA075');
    const second = await assessment();
    expect(await sqlState(voidOf(second))).toBeNull();
    expect(await sqlState(voidOf(second))).toBe('23505');
    expect(await sqlState(assessment(second))).toBe('RA075');
    expect(
      await sqlState(
        tx(() =>
          app.query("update rent_assessment_void set reason = 'x' where assessment_id = $1", [
            second,
          ]),
        ),
      ),
    ).not.toBeNull();
  });
});

describe('M7 review S6, MF-8 and D-B: corrections, late service and the ladder shift', () => {
  it('allows one live correction per notice; a discarded one makes room', async () => {
    const original = await notice('breach');
    await issue(original, 920);
    const correction = await notice('breach', 'draft', original);
    expect(await sqlState(notice('breach', 'draft', original))).toBe('23505');
    await tx(() => app.query("update notice set status = 'cancelled' where id = $1", [correction]));
    expect(await sqlState(notice('breach', 'draft', original))).toBeNull();
  });

  it('lets a closed notice take its late-service flag once, and an issued one move its ladder shift', async () => {
    const id = await notice('breach');
    await issue(id, 930);
    expect(
      await sqlState(
        tx(() => app.query('update notice set ladder_shift_seconds = 3600 where id = $1', [id])),
      ),
    ).toBeNull();
    await tx(() =>
      app.query(
        "update notice set status = 'closed', outcome = 'withdrawn', close_note = 'x', closed_at = now() where id = $1",
        [id],
      ),
    );
    const flag = (detail: string) =>
      tx(() => app.query(`update notice set served_too_late = $2 where id = $1`, [id, detail]));
    expect(await sqlState(flag('{"shortByDays":5}'))).toBeNull();
    expect(await sqlState(flag('{"shortByDays":6}'))).toBe('RA070');
    expect(
      await sqlState(
        tx(() => app.query("update notice set close_note = 'changed' where id = $1", [id])),
      ),
    ).toBe('RA070');
  });
});
