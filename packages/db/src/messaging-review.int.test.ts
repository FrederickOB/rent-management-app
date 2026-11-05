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
 * M6 review findings in the database (T-3, S-6, M4): nothing deletes a message, not even the
 * owner role; the functions that look across companies answer only the platform's own jobs; and
 * a company sees only its own WhatsApp numbers.
 */
let db: TestDatabase;
let app: pg.Client;
let owner: pg.Client;
let companyA: string;
let companyB: string;
let staffA: string;
let messageId: string;
const PHONE = '+233200000777';

const tx = <T>(ctx: Parameters<typeof inContext>[1], fn: () => Promise<T>) =>
  inContext(app, ctx, fn);

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  owner = await connect(db.ownerUrl);
  await createCompany(app, 'Platform', 'platform');
  companyA = await createCompany(app, 'Review Agency', 'agency');
  companyB = await createCompany(app, 'Review Landlord');
  staffA = await createPerson(app, 'Manager');
  await createMembership(app, companyA, staffA, 'property_manager');
  messageId = randomUUID();
  await tx({ companyId: companyA, personId: staffA }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name, phone, created_by) values ($1, 'individual', 'Ama', $2, $3) returning id",
      [companyA, PHONE, staffA],
    );
    const tenantId = rows[0]!.id;
    const conversation = await app.query<{ id: string }>(
      "insert into conversation (company_id, tenant_id, state) values ($1, $2, 'open') returning id",
      [companyA, tenantId],
    );
    await app.query(
      `insert into message (id, company_id, tenant_id, purpose, body, channels, direction, conversation_id, author_type,
         channel, provider, provider_message_id)
       values ($1, $2, $3, 'inbound', 'Hello', '{whatsapp}', 'inbound', $4, 'tenant', 'whatsapp', 'meta', $5)`,
      [messageId, companyA, tenantId, conversation.rows[0]!.id, `wamid.${randomUUID()}`],
    );
    await app.query(
      "insert into message_event (company_id, message_id, status, channel) values ($1, $2, 'delivered', 'whatsapp')",
      [companyA, messageId],
    );
    const doc = await app.query<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'message_media', 'image/jpeg', 1, $2, 'b', 'k', false) returning id",
      [companyA, '0'.repeat(64)],
    );
    await app.query(
      "insert into message_attachment (company_id, message_id, kind, content_type, document_id, status) values ($1, $2, 'image', 'image/jpeg', $3, 'stored')",
      [companyA, messageId, doc.rows[0]!.id],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await db?.drop();
});

describe('CM-05 T-3 nothing deletes a message', () => {
  it('refuses DELETE on messages, events and attachments to the owner role too', async () => {
    for (const table of ['message', 'message_event', 'message_attachment'])
      expect(
        await sqlState(
          inContext(owner, { companyId: companyA }, () => owner.query(`delete from ${table}`)),
        ),
        table,
      ).toBe('RA001');
    const { rows } = await tx({ companyId: companyA }, () =>
      app.query('select id from message where id = $1', [messageId]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('CM-01 S-6 the cross-company functions answer only the platform', () => {
  it('refuses a company or a tenant session, and answers the system outside any company', async () => {
    for (const call of [
      ['select * from app.companies_for_phone($1)', [PHONE]],
      ["select * from app.recent_channel_companies('sms', $1, now() - interval '1 day')", [PHONE]],
      [
        "select * from app.recent_whatsapp_companies($1, $2, now() - interval '1 day')",
        [randomUUID(), PHONE],
      ],
      ["select * from app.message_by_provider_id('meta', $1)", ['wamid.x']],
      ['select app.drop_push_token($1)', ['ExponentPushToken[x]']],
    ] as const) {
      expect(
        await sqlState(tx({ companyId: companyA }, () => app.query(call[0], [...call[1]]))),
        call[0],
      ).toBe('RA063');
      expect(
        await sqlState(
          tx({ personId: staffA, actorKind: 'tenant' }, () => app.query(call[0], [...call[1]])),
        ),
        call[0],
      ).toBe('RA063');
    }
    const { rows } = await tx({}, () =>
      app.query<{ company_id: string }>('select company_id from app.companies_for_phone($1)', [
        PHONE,
      ]),
    );
    expect(rows.map((r) => r.company_id)).toEqual([companyA]);
  });

  it('shows a company only its own numbers and the shared one (M4)', async () => {
    const asked = await tx({ companyId: companyB }, () =>
      app.query('select * from app.whatsapp_company_accounts($1)', [companyA]),
    );
    expect(asked.rows).toEqual([]);
  });
});
