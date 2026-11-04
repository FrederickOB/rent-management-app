import { randomBytes, randomUUID } from 'node:crypto';
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
 * M6 messaging in the database (plan sections 4.2 and 6): append-only messages, idempotent
 * inbound, shared-number routing across companies without leaking either, push tokens only for a
 * company's own tenant, the interim plan for platform admins only, ticket numbers, the live inbox
 * NOTIFY and conversation visibility. Real PostgreSQL with RLS, through the application role.
 */
let db: TestDatabase;
let app: pg.Client;
let owner: pg.Client;
let companyA: string;
let companyB: string;
let platform: string;
let staffA: string;
let admin: string;
let tenantA: string;
let tenantB: string;
let conversationA: string;
let propertyA: string;
let propertyA2: string;
const SHARED_PHONE = '+233200000555';

const tx = <T>(ctx: Parameters<typeof inContext>[1], fn: () => Promise<T>) =>
  inContext(app, ctx, fn);

async function property(companyId: string, code: string): Promise<string> {
  return tx({ companyId }, async () => {
    const { rows: portfolios } = await app.query<{ id: string }>(
      'insert into portfolio (company_id, name, is_default) values ($1, $2, false) returning id',
      [companyId, `Portfolio ${code}`],
    );
    const { rows } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, $3, 'ACC', $3, 'compound_house', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolios[0]!.id, code],
    );
    const { rows: owners } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, $2, 'individual', 'Owner') returning id",
      [companyId, `OWN-${code}`],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, rows[0]!.id, owners[0]!.id],
    );
    return rows[0]!.id;
  });
}

async function tenantWithPhone(
  companyId: string,
  phone: string,
  createdBy: string,
): Promise<string> {
  return tx({ companyId, personId: createdBy }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name, phone, created_by) values ($1, 'individual', 'Ama', $2, $3) returning id",
      [companyId, phone, createdBy],
    );
    return rows[0]!.id;
  });
}

async function conversationFor(companyId: string, tenantId: string): Promise<string> {
  return tx({ companyId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into conversation (company_id, tenant_id, state) values ($1, $2, 'open') returning id",
      [companyId, tenantId],
    );
    return rows[0]!.id;
  });
}

const inbound = (
  companyId: string,
  conversationId: string,
  tenantId: string | null,
  providerId: string,
) =>
  app.query(
    `insert into message (id, company_id, tenant_id, purpose, body, channels, direction, conversation_id, author_type,
       channel, provider, provider_message_id)
     values ($1, $2, $3, 'inbound', 'Hello', '{whatsapp}', 'inbound', $4, $5, 'whatsapp', 'meta', $6)
     on conflict do nothing returning id`,
    [
      randomUUID(),
      companyId,
      tenantId,
      conversationId,
      tenantId ? 'tenant' : 'unknown',
      providerId,
    ],
  );

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  owner = await connect(db.ownerUrl);
  platform = await createCompany(app, 'Platform', 'platform');
  companyA = await createCompany(app, 'Osu Properties', 'agency');
  companyB = await createCompany(app, 'Kwame Mensah');
  admin = await createPerson(app, 'Platform admin');
  await createMembership(app, platform, admin, 'platform_admin');
  staffA = await createPerson(app, 'Manager A');
  await createMembership(app, companyA, staffA, 'property_manager');
  propertyA = await property(companyA, 'ACC-OSU');
  propertyA2 = await property(companyA, 'ACC-LEG');
  // The same phone rents from both landlords (TL-12).
  tenantA = await tenantWithPhone(companyA, SHARED_PHONE, staffA);
  tenantB = await tenantWithPhone(companyB, SHARED_PHONE, staffA);
  conversationA = await conversationFor(companyA, tenantA);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await db?.drop();
});

describe('CM-05 messages are never edited or deleted', () => {
  it('refuses UPDATE and DELETE on messages, events and attachments, for the application and the owner', async () => {
    const docs = await tx({ companyId: companyA }, () =>
      app.query<{ id: string }>(
        "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'message_media', 'image/jpeg', 1, $2, 'b', 'k', false) returning id",
        [companyA, '0'.repeat(64)],
      ),
    );
    const [message] = (
      await tx({ companyId: companyA }, () =>
        inbound(companyA, conversationA, tenantA, randomUUID()),
      )
    ).rows as { id: string }[];
    await tx({ companyId: companyA }, async () => {
      await app.query(
        "insert into message_event (company_id, message_id, status, channel) values ($1, $2, 'delivered', 'whatsapp')",
        [companyA, message!.id],
      );
      await app.query(
        "insert into message_attachment (company_id, message_id, kind, content_type, document_id, status) values ($1, $2, 'image', 'image/jpeg', $3, 'stored')",
        [companyA, message!.id, docs.rows[0]!.id],
      );
    });
    for (const [table, column] of [
      ['message', 'body'],
      ['message_event', 'reason'],
      ['message_attachment', 'caption'],
    ] as const) {
      const set = `update ${table} set ${column} = 'changed'`;
      expect(
        await sqlState(tx({ companyId: companyA }, () => app.query(set))),
        `${table} update`,
      ).toMatch(/^(42501|RA001)$/);
      expect(
        await sqlState(tx({ companyId: companyA }, () => app.query(`delete from ${table}`))),
        `${table} delete`,
      ).toMatch(/^(42501|RA001)$/);
      expect(
        await sqlState(inContext(owner, { companyId: companyA }, () => owner.query(set))),
        table,
      ).toBe('RA001');
    }
  });
});

describe('CM-02 a duplicate inbound webhook makes one message', () => {
  it('stores a provider message once, whichever company tries again', async () => {
    const providerId = `wamid.${randomUUID()}`;
    const first = await tx({ companyId: companyA }, () =>
      inbound(companyA, conversationA, tenantA, providerId),
    );
    const again = await tx({ companyId: companyA }, () =>
      inbound(companyA, conversationA, tenantA, providerId),
    );
    expect(first.rowCount).toBe(1);
    expect(again.rowCount).toBe(0);
    const conversationB = await conversationFor(companyB, tenantB);
    const elsewhere = await tx({ companyId: companyB }, () =>
      inbound(companyB, conversationB, tenantB, providerId),
    );
    expect(elsewhere.rowCount).toBe(0);
  });

  it('records a repeated delivery report once', async () => {
    const [message] = (
      await tx({ companyId: companyA }, () =>
        inbound(companyA, conversationA, tenantA, randomUUID()),
      )
    ).rows as { id: string }[];
    const report = () =>
      tx({ companyId: companyA }, () =>
        app.query(
          "insert into message_event (company_id, message_id, status, channel, pricing_category, billable) values ($1, $2, 'read', 'whatsapp', 'service', false)",
          [companyA, message!.id],
        ),
      );
    expect(await sqlState(report())).toBeNull();
    expect(await sqlState(report())).toBe('23505');
  });

  it('files a message only in its own tenant’s conversation', async () => {
    const other = await tenantWithPhone(companyA, '+233200000556', staffA);
    expect(
      await sqlState(
        tx({ companyId: companyA }, () => inbound(companyA, conversationA, other, randomUUID())),
      ),
    ).toBe('RA061');
  });
});

describe('CM-01 and TL-12 shared-number routing across companies', () => {
  it('names both landlords of a phone that rents from two, and no others', async () => {
    const { rows } = await tx({}, () =>
      app.query<{ company_id: string; display_name: string }>(
        'select * from app.companies_for_phone($1)',
        [SHARED_PHONE],
      ),
    );
    expect(rows.map((r) => r.company_id).sort()).toEqual([companyA, companyB].sort());
    expect(rows.map((r) => r.display_name).sort()).toEqual(['Kwame Mensah', 'Osu Properties']);
    const none = await tx({}, () =>
      app.query('select * from app.companies_for_phone($1)', ['+233200000999']),
    );
    expect(none.rows).toEqual([]);
    const junk = await tx({}, () => app.query('select * from app.companies_for_phone($1)', ['%']));
    expect(junk.rows).toEqual([]);
  });

  it('finds a phone by a contact or a linked identity too', async () => {
    await tx({ companyId: companyB }, async () => {
      await app.query(
        "insert into tenant_contact (company_id, tenant_id, kind, name, phone) values ($1, $2, 'finance', 'Kofi', '+233200000557')",
        [companyB, tenantB],
      );
    });
    await tx({ companyId: companyA, personId: staffA }, async () => {
      await app.query(
        "insert into channel_identity (company_id, channel, address, tenant_id, linked_by) values ($1, 'whatsapp', '+233200000558', $2, $3)",
        [companyA, tenantA, staffA],
      );
    });
    const of = async (phone: string) =>
      (
        await tx({}, () =>
          app.query<{ company_id: string }>('select company_id from app.companies_for_phone($1)', [
            phone,
          ]),
        )
      ).rows.map((r) => r.company_id);
    expect(await of('+233200000557')).toEqual([companyB]);
    expect(await of('+233200000558')).toEqual([companyA]);
  });

  it('keeps each company’s conversations and messages from the other', async () => {
    const seen = await tx({ companyId: companyB }, () =>
      app.query('select id from conversation where id = $1', [conversationA]),
    );
    expect(seen.rows).toEqual([]);
    const messages = await tx({ companyId: companyB }, () =>
      app.query('select id from message where conversation_id = $1', [conversationA]),
    );
    expect(messages.rows).toEqual([]);
  });
});

describe('CM-01 WhatsApp numbers through narrow functions (ADR-002)', () => {
  it('keeps the platform tables from the application role', async () => {
    for (const table of ['whatsapp_account', 'whatsapp_template_status', 'push_device'])
      expect(
        await sqlState(tx({ companyId: companyA }, () => app.query(`select * from ${table}`))),
        table,
      ).toBe('42501');
  });

  it('lets only a platform admin register numbers, and sends from a company’s own number before the shared one', async () => {
    const register = (
      actor: { personId: string; actorKind: string },
      kind: string,
      companyId: string | null,
      id: string,
    ) =>
      tx(actor, () =>
        app.query<{ id: string }>(
          "select app.register_whatsapp_account($1, 'waba-1', '+233300000001', $2, $3, $4) as id",
          [id, `Number ${id}`, kind, companyId],
        ),
      );
    expect(
      await sqlState(
        register({ personId: staffA, actorKind: 'staff' }, 'shared', null, 'pn-shared'),
      ),
    ).toBe('RA063');
    expect(
      await sqlState(
        register({ personId: staffA, actorKind: 'platform_admin' }, 'shared', null, 'pn-x'),
      ),
    ).toBe('RA063');
    await register({ personId: admin, actorKind: 'platform_admin' }, 'shared', null, 'pn-shared');
    const sending = (companyId: string) =>
      tx({ companyId }, () =>
        app.query<{ kind: string }>('select kind from app.whatsapp_sending_account($1)', [
          companyId,
        ]),
      );
    expect((await sending(companyB)).rows).toEqual([{ kind: 'shared' }]);
    await register(
      { personId: admin, actorKind: 'platform_admin' },
      'company',
      companyA,
      'pn-agency',
    );
    expect((await sending(companyA)).rows).toEqual([{ kind: 'company' }]);
    expect((await sending(companyB)).rows).toEqual([{ kind: 'shared' }]);
    // Asked from another company's context, it answers nothing.
    const wrong = await tx({ companyId: companyB }, () =>
      app.query('select * from app.whatsapp_sending_account($1)', [companyA]),
    );
    expect(wrong.rows).toEqual([]);
    const byNumber = await tx({}, () =>
      app.query<{ kind: string; company_id: string | null }>(
        'select kind, company_id from app.whatsapp_account_by_number($1)',
        ['pn-agency'],
      ),
    );
    expect(byNumber.rows).toEqual([{ kind: 'company', company_id: companyA }]);
  });

  it('records template statuses only from the platform, and shows a company its numbers’ statuses', async () => {
    const [template] = await runSql<{ id: string }>(
      db.ownerUrl,
      // Migration 0033 adds the template rows; use its rent_reminder v1 (founder-approved, 2026-11-04).
      "select id from message_template where key = 'rent_reminder' and version = 1",
    );
    const accounts = await tx({ personId: admin, actorKind: 'platform_admin' }, () =>
      app.query<{ id: string; kind: string }>('select id, kind from app.whatsapp_accounts()'),
    );
    const shared = accounts.rows.find((a) => a.kind === 'shared')!;
    const record = (ctx: Parameters<typeof inContext>[1]) =>
      tx(ctx, () =>
        app.query(
          "select app.record_whatsapp_template_status($1, $2, 'approved', 'utility', 'meta-1', null)",
          [shared.id, template!.id],
        ),
      );
    expect(await sqlState(record({ companyId: companyA }))).toBe('RA063');
    expect(await sqlState(record({}))).toBeNull();
    const statuses = await tx({ companyId: companyB }, () =>
      app.query<{ template_key: string; status: string; is_sending: boolean }>(
        'select template_key, status, is_sending from app.whatsapp_template_statuses($1)',
        [companyB],
      ),
    );
    expect(statuses.rows).toEqual([
      { template_key: 'rent_reminder', status: 'approved', is_sending: true },
    ]);
  });
});

describe('CM-09 push devices (decision 5)', () => {
  it('returns a person’s tokens only to a company where they are a tenant, and drops them with the session', async () => {
    const person = await createPerson(app, 'Tenant person');
    const sessionId = randomUUID();
    await app.query(
      "insert into session (id, expires_at, token, user_id, auth_method) values ($1, now() + interval '30 days', $2, $3, 'phone_otp')",
      [sessionId, randomBytes(16).toString('hex'), person],
    );
    const token = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
    expect(
      await sqlState(
        tx({ personId: staffA, actorKind: 'tenant' }, () =>
          app.query("select app.register_push_device($1, $2, 'android', 'Pixel')", [
            sessionId,
            token,
          ]),
        ),
      ),
    ).toBe('RA064');
    await tx({ personId: person, actorKind: 'tenant' }, () =>
      app.query("select app.register_push_device($1, $2, 'android', 'Pixel')", [sessionId, token]),
    );
    // Registering again moves nothing and makes no second row.
    await tx({ personId: person, actorKind: 'tenant' }, () =>
      app.query("select app.register_push_device($1, $2, 'android', 'Pixel 8')", [
        sessionId,
        token,
      ]),
    );
    await tx({ companyId: companyA }, () =>
      app.query('update tenant set person_id = $2 where id = $1', [tenantA, person]),
    );
    const tokens = (companyId: string, tenantId: string) =>
      tx({ companyId }, () =>
        app.query<{ token: string }>('select token from app.push_tokens_for_tenant($1)', [
          tenantId,
        ]),
      );
    expect((await tokens(companyA, tenantA)).rows).toEqual([{ token }]);
    // Company B's tenant is another person; and company B cannot ask about company A's tenant.
    expect((await tokens(companyB, tenantB)).rows).toEqual([]);
    expect((await tokens(companyB, tenantA)).rows).toEqual([]);
    await app.query('delete from session where id = $1', [sessionId]);
    expect((await tokens(companyA, tenantA)).rows).toEqual([]);
    const left = await runSql(db.ownerUrl, 'select id from push_device where token = $1', [token]);
    expect(left).toEqual([]);
  });
});

describe('CM-05 interim plan (decision 9)', () => {
  it('is set only by a platform admin, through the function, and audited in the company’s chain', async () => {
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update company set interim_plan = 'starter' where id = $1", [companyA]),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        tx({ companyId: companyA, personId: staffA, actorKind: 'staff' }, () =>
          app.query("select app.set_company_plan($1, 'starter')", [companyA]),
        ),
      ),
    ).toBe('RA063');
    const set = await tx({ personId: admin, actorKind: 'platform_admin' }, () =>
      app.query<{ changed: boolean }>("select app.set_company_plan($1, 'starter') as changed", [
        companyB,
      ]),
    );
    expect(set.rows[0]!.changed).toBe(true);
    const plan = await tx({ companyId: companyB }, () =>
      app.query<{ interim_plan: string }>('select interim_plan from company where id = $1', [
        companyB,
      ]),
    );
    expect(plan.rows).toEqual([{ interim_plan: 'starter' }]);
    const audit = await runSql<{ actor_person_id: string }>(
      db.superuserUrl,
      "select actor_person_id from audit_event where company_id = $1 and action = 'company.update' order by seq desc limit 1",
      [companyB],
    );
    expect(audit[0]!.actor_person_id).toBe(admin);
    const plans = await tx({ personId: admin, actorKind: 'platform_admin' }, () =>
      app.query<{ company_id: string; interim_plan: string }>(
        'select company_id, interim_plan from app.company_plans()',
      ),
    );
    expect(plans.rows).toContainEqual({ company_id: companyB, interim_plan: 'starter' });
    expect(plans.rows.some((r) => r.company_id === platform)).toBe(false);
  });
});

describe('CM-04 ticket numbers', () => {
  it('numbers each company’s jobs from 1, whatever the insert says and whatever the session sees', async () => {
    const job = (companyId: string, propertyId: string, scope?: string) =>
      tx({ companyId }, async () => {
        if (scope) await app.query("select set_config('app.property_scope', $1, true)", [scope]);
        const { rows } = await app.query<{ ticket_number: number }>(
          "insert into maintenance_job (company_id, property_id, source, description, ticket_number) values ($1, $2, 'staff', 'Leak', 99) returning ticket_number",
          [companyId, propertyId],
        );
        return rows[0]!.ticket_number;
      });
    expect(await job(companyA, propertyA)).toBe(1);
    // A session scoped to the other property cannot see job 1, and still gets 2.
    expect(await job(companyA, propertyA2, `{${propertyA2}}`)).toBe(2);
    const propertyB = await property(companyB, 'ACC-TEM');
    expect(await job(companyB, propertyB)).toBe(1);
  });

  it('makes one ticket per source message', async () => {
    const [message] = (
      await tx({ companyId: companyA }, () =>
        inbound(companyA, conversationA, tenantA, randomUUID()),
      )
    ).rows as { id: string }[];
    const report = () =>
      tx({ companyId: companyA }, () =>
        app.query(
          "insert into maintenance_job (company_id, property_id, tenant_id, source, description, conversation_id, source_message_id) values ($1, $2, $3, 'whatsapp', 'Leak', $4, $5)",
          [companyA, propertyA, tenantA, conversationA, message!.id],
        ),
      );
    expect(await sqlState(report())).toBeNull();
    expect(await sqlState(report())).toBe('23505');
  });
});

describe('CM-02 and CM-05 conversations', () => {
  it('links a triage conversation to a tenant once, and keeps the address it began with', async () => {
    const { rows } = await tx({ companyId: companyA }, () =>
      app.query<{ id: string }>(
        "insert into conversation (company_id, state, triage_channel, triage_address) values ($1, 'triage', 'whatsapp', '+233200000777') returning id",
        [companyA],
      ),
    );
    const triage = rows[0]!.id;
    const other = await tenantWithPhone(companyA, '+233200000778', staffA);
    await tx({ companyId: companyA, personId: staffA }, () =>
      app.query(
        "update conversation set tenant_id = $2, state = 'open', linked_by = $3, linked_at = now() where id = $1",
        [triage, other, staffA],
      ),
    );
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query('update conversation set tenant_id = $2 where id = $1', [triage, tenantA]),
        ),
      ),
    ).toBe('RA060');
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query("update conversation set triage_address = '+233200000779' where id = $1", [
            triage,
          ]),
        ),
      ),
    ).toMatch(/^(42501|RA060)$/);
    expect(
      await sqlState(
        tx({ companyId: companyA }, () =>
          app.query('delete from conversation where id = $1', [triage]),
        ),
      ),
    ).toMatch(/^(42501|RA001)$/);
  });

  it('shows triage only to whole-company sessions, and a tenant only its own conversation', async () => {
    await tx({ companyId: companyA }, () =>
      app.query(
        "insert into conversation (company_id, state, triage_channel, triage_address) values ($1, 'triage', 'sms', '+233200000780')",
        [companyA],
      ),
    );
    // Not the tenants' creator: a scoped creator still sees a tenant with no lease (M3 plan 4.3).
    const someoneElse = await createPerson(app, 'Scoped caretaker');
    const count = (setup: string | null) =>
      tx({ companyId: companyA, personId: someoneElse }, async () => {
        if (setup) await app.query(setup);
        const { rows } = await app.query<{ triage: number; tenants: string[] }>(
          "select count(*) filter (where tenant_id is null)::int as triage, coalesce(array_agg(tenant_id) filter (where tenant_id is not null), '{}') as tenants from conversation",
        );
        return rows[0]!;
      });
    const whole = await count(null);
    expect(whole.triage).toBeGreaterThan(0);
    expect(whole.tenants).toContain(tenantA);
    // A session scoped to properties none of these tenants lease sees neither (AD-02).
    const scoped = await count(`select set_config('app.property_scope', '{${propertyA2}}', true)`);
    expect(scoped).toEqual({ triage: 0, tenants: [] });
    const tenantSession = await count(
      `select set_config('app.tenant_scope', '{${tenantA}}', true), set_config('app.property_scope', '{}', true)`,
    );
    expect(tenantSession.triage).toBe(0);
    expect(tenantSession.tenants.every((t) => t === tenantA)).toBe(true);
  });
});

describe('CM-05 live inbox', () => {
  it('notifies listeners with ids only, on commit', async () => {
    const listener = await connect(db.appUrl);
    const received: string[] = [];
    listener.on('notification', (n) => {
      if (n.channel === 'inbox' && n.payload) received.push(n.payload);
    });
    await listener.query('listen inbox');
    const secret = `Secret body ${randomUUID()}`;
    const id = randomUUID();
    await tx({ companyId: companyA }, () =>
      app.query(
        `insert into message (id, company_id, tenant_id, purpose, body, channels, direction, conversation_id, author_type,
           channel, provider, provider_message_id)
         values ($1, $2, $3, 'inbound', $4, '{sms}', 'inbound', $5, 'tenant', 'sms', 'hubtel', $6)`,
        [id, companyA, tenantA, secret, conversationA, randomUUID()],
      ),
    );
    for (let i = 0; i < 50 && !received.some((p) => p.includes(id)); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await listener.end();
    const payload = received
      .map((p) => JSON.parse(p) as Record<string, unknown>)
      .find((p) => p.messageId === id);
    expect(payload).toEqual({
      companyId: companyA,
      conversationId: conversationA,
      messageId: id,
      kind: 'message',
    });
    expect(received.join('')).not.toContain(secret);
    expect(received.join('')).not.toContain(SHARED_PHONE);
  });
});
