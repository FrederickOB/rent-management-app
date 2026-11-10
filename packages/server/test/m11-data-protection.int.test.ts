import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageRequestSchema, MESSAGE_SEND_JOB, queueMessage } from '../src/core/messages';
import { tenantCheckConflict } from '../src/core/db-errors';
import {
  DATA_PROTECTION_EXPORT_JOB,
  DataProtectionService,
  EXPORT_PREFIX,
} from '../src/data-protection/data-protection.service';
import { RetentionReviewService } from '../src/data-protection/retention-review.service';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { platform } from './support/messaging';
import { noticesServices, NoticesWorker } from './support/notices';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Data protection requests under Act 843 against the real database with RLS on (M11 decision 5;
 * plan section 6, Data protection): the register and its due date from the rules row, the export
 * holds only that tenant's records (★ cross-company and cross-tenant), nothing personal is written
 * to the audit log's semantic events or the job's log (★ log redaction: see also
 * apps/worker/src/data-protection.jobs.test.ts), erasure is limited while retention is unverified,
 * messaging stops on every channel (CM-09), the nightly retention review, and anonymisation with a
 * verified rule row added as `rules:add` would, keeping the books balanced and the audit chain
 * verifying. Every date is relative to the test clock's day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let dp: DataProtectionService;
let review: RetentionReviewService;
let today: string;
let c: Awaited<ReturnType<typeof moneyCompany>>;
let other: Awaited<ReturnType<typeof moneyCompany>>;
let units: string[];

const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

/** A tenant with a phone, an email, SMS and email consent, and a next of kin. */
async function tenant(
  actor: Parameters<TenancyServices['tenants']['create']>[0],
  name: string,
  phone: string,
  extra: { idNumber?: string } = {},
) {
  return (
    await s.tenants.create(actor, {
      kind: 'individual',
      displayName: name,
      phone,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`,
      occupation: 'Teacher',
      notes: `Notes about ${name}`,
      consent: { sms: true, email: true },
      ...(extra.idNumber ? { idType: 'ghana_card' as const, idNumber: extra.idNumber } : {}),
      contacts: [
        {
          kind: 'next_of_kin',
          name: `${name} Kin`,
          phone: `${phone.slice(0, -1)}9`,
          relationship: 'Sister',
          consent: { sms: true },
        },
      ],
    })
  ).tenant.id;
}

async function lease(
  actor: Parameters<TenancyServices['leases']['recordPaper']>[0],
  unitId: string,
  tenantId: string,
  start: string,
) {
  return billedLease(ctx, s, b, actor, {
    unitId,
    tenantId,
    startDate: start,
    endDate: plusDays(plusMonths(start, 12), -1),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    depositMinor: null,
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
}

/** Queues a broadcast to a tenant and runs the send job for every queued message. */
async function message(
  companyId: string,
  tenantId: string,
  body: string,
  extra: Partial<Parameters<typeof queueMessage>[2]> = {},
) {
  const id = await system(companyId, (tx) =>
    queueMessage(tx, companyId, {
      recipient: { type: 'tenant', tenantId },
      purpose: 'broadcast',
      body,
      channels: ['sms'],
      ...extra,
    }),
  );
  const [event] = await system(companyId, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(
        sql`${schema.outboxEvent.type} = ${MESSAGE_SEND_JOB} and ${schema.outboxEvent.idempotencyKey} = ${`${MESSAGE_SEND_JOB}:${id}`}`,
      ),
  );
  const outcome = await s.messaging.deliver(companyId, messageRequestSchema.parse(event!.payload));
  const [last] = (
    await system(companyId, (tx) =>
      tx.execute<{ status: string; reason: string | null }>(
        sql`select status, reason from message_event where message_id = ${id}::uuid
            order by occurred_at desc, id desc limit 1`,
      ),
    )
  ).rows;
  return { id, outcome, status: last?.status, reason: last?.reason ?? null };
}

/** Reads a ZIP archive's entries by name. */
function unzip(file: Buffer): Map<string, Buffer> {
  let end = file.length - 22;
  while (end >= 0 && file.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const out = new Map<string, Buffer>();
  let at = file.readUInt32LE(end + 16);
  for (let i = 0; i < file.readUInt16LE(end + 10); i += 1) {
    const method = file.readUInt16LE(at + 10);
    const size = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const local = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const data = file.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength;
  }
  return out;
}

let platformCompanyId: string;
/** Adds a rules row as `pnpm rules:add` would: a new verified row, newer than the seed's. */
async function verifiedRule(key: string, value: unknown) {
  await s.rules.add(
    {
      country: 'GH',
      key,
      value,
      effectiveFrom: '2000-01-01',
      source: 'M11 test: counsel’s confirmation stands in',
      verificationStatus: 'verified',
      verifiedBy: 'Test counsel',
      createdBy: 'm11-data-protection.int.test',
    },
    platformCompanyId,
  );
}

/** A newer row with no value, unverified: as if counsel withdrew a confirmation. */
async function unverifiedRule(key: string) {
  await s.rules.add(
    {
      country: 'GH',
      key,
      value: null,
      effectiveFrom: '2000-01-01',
      source: 'M11 test: confirmation withdrawn',
      verificationStatus: 'unverified',
      createdBy: 'm11-data-protection.int.test',
    },
    platformCompanyId,
  );
}

let extraProperty = 0;
/** A tenant who moved out a month after their lease started, on a unit of its own. */
async function movedOut(name: string, phone: string, extra: { idNumber?: string } = {}) {
  extraProperty += 1;
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `Owner ${name}` })
  ).id;
  const place = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `DX${extraProperty}`,
    ownerId,
    units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
  });
  const tenantId = await tenant(c.admin, name, phone, extra);
  const start = plusMonths(today, -3);
  const ended = await lease(c.manager, Object.values(place.units)[0]!, tenantId, start);
  await s.lifecycle.runTransitions(c.companyId);
  await s.lifecycle.recordMoveOut(c.manager, ended.id, { moveOutDate: plusMonths(start, 1) });
  return { tenantId, lease: ended };
}

let t1: string; // Ama: an access request; a live lease, a payment, messages.
let t2: string; // Kwesi: another tenant of the same company, with records of his own.
let t3: string; // Efua: a tenant of another company.
let leaseT1: Awaited<ReturnType<typeof lease>>;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  dp = new DataProtectionService(
    ctx.database,
    s.policy,
    s.rules,
    s.documents,
    ctx.audit,
    ctx.clock,
    ctx.storage,
    ctx.config,
  );
  review = new RetentionReviewService(ctx.database, s.rules, s.policy, ctx.clock);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  platformCompanyId = await company(ctx, 'platform', 'Privacy Platform');
  c = await moneyCompany(ctx, s, 'agency', 'Privacy Agency');
  other = await moneyCompany(ctx, s, 'landlord', 'Other Landlord');
  const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner P' }))
    .id;
  const place = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'DPA',
    ownerId,
    units: [{ unitType: 'apartment', count: 4, bedrooms: 1 }],
  });
  units = Object.values(place.units);
  const otherOwner = (
    await s.owners.create(other.admin, { kind: 'individual', displayName: 'Owner Q' })
  ).id;
  const otherPlace = await propertyWithUnits(s, other.manager, {
    areaCode: 'ACC',
    propertyPart: 'DPB',
    ownerId: otherOwner,
    units: [{ unitType: 'single_room', count: 1 }],
  });

  t1 = await tenant(c.admin, 'Ama Datasubject', '+233241110001');
  t2 = await tenant(c.admin, 'Kwesi Othertenant', '+233241110002');
  t3 = await tenant(other.admin, 'Efua Othercompany', '+233241110003');
  const start = plusMonths(today, -2);
  leaseT1 = await lease(c.manager, units[0]!, t1, start);
  const leaseT2 = await lease(c.manager, units[1]!, t2, start);
  const leaseT3 = await lease(other.manager, Object.values(otherPlace.units)[0]!, t3, start);
  for (const company of [c.companyId, other.companyId]) await s.lifecycle.runTransitions(company);
  await approvedCash(ctx, s, b, c.manager, c.accountant, {
    leaseId: leaseT1.id,
    amountMinor: 100_000,
    receivedOn: today,
  });
  await approvedCash(ctx, s, b, c.manager, c.accountant, {
    leaseId: leaseT2.id,
    amountMinor: 70_000,
    receivedOn: today,
  });
  await approvedCash(ctx, s, b, other.manager, other.accountant, {
    leaseId: leaseT3.id,
    amountMinor: 55_000,
    receivedOn: today,
  });
  expect((await message(c.companyId, t1, 'Water is off on Saturday, Ama')).status).toBe('sent');
  expect((await message(c.companyId, t2, 'Kwesi, your rent is due')).status).toBe('sent');
  expect((await message(other.companyId, t3, 'Efua, welcome')).status).toBe('sent');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('NFR-DP the request register (M11 decision 5)', () => {
  it('records a request for company admins only, with no due date while the response time has no value', async () => {
    const req = await dp.create(c.admin, { tenantId: t1, kind: 'access', receivedOn: today });
    expect(req).toMatchObject({
      tenant: { id: t1, name: 'Ama Datasubject' },
      kind: 'access',
      receivedOn: today,
      dueOn: null,
      dueRuleUnverified: true,
      status: 'received',
      messagingStopped: false,
      anonymised: [],
      held: [],
      export: null,
      createdBy: { id: c.admin.personId },
    });
    // The rules row used is recorded, even with no value (OQ-65).
    const [row] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ due_rule_id: string | null }>(
          sql`select due_rule_id from data_protection_request where id = ${req.id}::uuid`,
        ),
      )
    ).rows;
    expect(row?.due_rule_id).not.toBeNull();
    expect((await dp.list(c.admin, { tenantId: t1 })).map((r) => r.id)).toContain(req.id);
    // Managers, accountants and caretakers are refused; another company sees nothing of it.
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'DP caretaker');
    for (const actor of [c.manager, c.accountant, caretaker])
      await expect(dp.list(actor)).rejects.toMatchObject({ status: 403 });
    await expect(dp.get(other.admin, req.id)).rejects.toMatchObject({ status: 404 });
    expect(await dp.list(other.admin)).toEqual([]);
    await expect(
      dp.create(other.admin, { tenantId: t1, kind: 'access', receivedOn: today }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      dp.create(c.admin, { tenantId: t1, kind: 'access', receivedOn: plusDays(today, 1) }),
    ).rejects.toMatchObject({ status: 400, code: 'received_in_future' });
  });

  it('moves a request on, needs an outcome to close it, and a closed request never changes', async () => {
    const req = await dp.create(c.admin, {
      tenantId: t2,
      kind: 'correction',
      receivedOn: plusDays(today, -3),
      notes: 'Spelling of the surname',
    });
    expect((await dp.update(c.admin, req.id, { status: 'in_progress' })).status).toBe(
      'in_progress',
    );
    await expect(dp.update(c.admin, req.id, { status: 'completed' })).rejects.toMatchObject({
      status: 400,
      code: 'outcome_required',
    });
    const done = await dp.update(c.admin, req.id, {
      status: 'completed',
      outcome: 'Surname corrected on the tenant record',
    });
    expect(done).toMatchObject({ status: 'completed', outcome: expect.any(String) });
    expect(done.completedAt).toBeInstanceOf(Date);
    await expect(
      dp.update(c.admin, req.id, { status: 'refused', outcome: 'x' }),
    ).rejects.toMatchObject({ status: 409, code: 'request_closed' });
    await expect(dp.exportCreate(c.admin, req.id)).rejects.toMatchObject({
      status: 409,
      code: 'not_access_request',
    });
    await expect(dp.erase(c.admin, req.id)).rejects.toMatchObject({
      status: 409,
      code: 'not_erasure_request',
    });
  });
});

describe('NFR-DP ★ the export holds only that tenant’s records (cross-company and cross-tenant)', () => {
  it('prepares one archive in a job: the workbook and the stored lease PDF, of that tenant alone', async () => {
    const req = await dp.create(c.admin, { tenantId: t1, kind: 'access', receivedOn: today });
    const started = await dp.exportCreate(c.admin, req.id);
    expect(started).toMatchObject({ status: 'preparing', url: null, expiresAt: null });
    // Asked again while it prepares, the same export.
    expect((await dp.exportCreate(c.admin, req.id)).id).toBe(started.id);
    const events = await system(c.companyId, (tx) =>
      tx.execute<{ payload: { exportId: string } }>(
        sql`select payload from outbox_event where type = ${DATA_PROTECTION_EXPORT_JOB}
            and payload->>'exportId' = ${started.id}`,
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect((await dp.get(c.admin, req.id)).status).toBe('in_progress');

    expect(await dp.prepareExport(c.companyId, started.id)).toBe('ready');
    // Run again (a retry or a replay), nothing changes.
    expect(await dp.prepareExport(c.companyId, started.id)).toBe('skipped');
    const ready = await dp.exportGet(c.admin, started.id);
    expect(ready.status).toBe('ready');
    expect(ready.url).toEqual(expect.any(String));
    expect(ready.expiresAt!.getTime() - ctx.clock.now().getTime()).toBe(300_000);
    expect((await dp.get(c.admin, req.id)).export).toEqual({
      id: started.id,
      status: 'ready',
      url: null,
      expiresAt: null,
      // Review round (B7): nothing was left out of this one.
      split: false,
      leftOut: 0,
    });

    const [row] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ document_id: string; write_once: boolean; content_type: string }>(
          sql`select e.document_id, d.write_once, d.content_type from data_protection_export e
              join document d on d.company_id = e.company_id and d.id = e.document_id
              where e.id = ${started.id}::uuid`,
        ),
      )
    ).rows;
    // Founder decision 5 (review round): the ordinary files bucket for 7 days, not write-once.
    expect(row).toMatchObject({ write_once: false, content_type: 'application/zip' });
    const file = await s.documents.documentFile(c.companyId, row!.document_id);
    expect(file?.intact).toBe(true);
    const entries = unzip(file!.bytes);
    expect([...entries.keys()].some((n) => n.startsWith('leases/') && n.endsWith('.pdf'))).toBe(
      true,
    );
    const pdf = [...entries.entries()].find(([n]) => n.startsWith('leases/'))![1];
    expect(pdf.equals(SAMPLE_PDF)).toBe(true);

    const sheets = (await readXlsxFile(entries.get('personal-data.xlsx')!)) as unknown as {
      sheet: string;
      data: unknown[][];
    }[];
    expect(sheets.map((x) => x.sheet)).toEqual([
      'About',
      'Profile',
      'Contacts',
      'Consent',
      'Leases',
      'Invoices',
      'Payments',
      'Receipts',
      'Notices',
      'Messages',
    ]);
    const all = JSON.stringify(sheets.map((x) => x.data));
    // Hers: her name, phone, contact, lease, payment and message.
    for (const mine of [
      'Ama Datasubject',
      '+233241110001',
      'Ama Datasubject Kin',
      'Water is off on Saturday, Ama',
      '1000.00',
    ])
      expect(all).toContain(mine);
    // Never another tenant's, in her company or another.
    for (const theirs of [
      'Kwesi',
      'Othertenant',
      '+233241110002',
      'Kwesi, your rent is due',
      '700.00',
      'Efua',
      '+233241110003',
      'Efua, welcome',
      '550.00',
    ])
      expect(all).not.toContain(theirs);
    const sheet = (name: string) => sheets.find((x) => x.sheet === name)!.data;
    expect(sheet('Leases')).toHaveLength(2);
    expect(sheet('Payments')).toHaveLength(2);
    expect(sheet('Messages')).toHaveLength(2);

    // Another company's admin, and people without the permission, get nothing.
    await expect(dp.exportGet(other.admin, started.id)).rejects.toMatchObject({ status: 404 });
    await expect(dp.exportGet(c.manager, started.id)).rejects.toMatchObject({ status: 403 });
    await expect(dp.exportCreate(other.admin, req.id)).rejects.toMatchObject({ status: 404 });
  });

  it('★ writes nothing personal into its audit events, and says when a link was issued', async () => {
    const rows = await system(c.companyId, (tx) =>
      tx.execute<{ action: string; data: unknown }>(
        sql`select action, data from audit_event where action like 'data_protection.%' order by seq`,
      ),
    );
    const actions = rows.rows.map((r) => r.action);
    for (const action of [
      'data_protection.request_recorded',
      'data_protection.export_requested',
      'data_protection.export_prepared',
      'data_protection.export_link_issued',
    ])
      expect(actions).toContain(action);
    const text = JSON.stringify(rows.rows.map((r) => r.data));
    for (const personal of ['Ama', '+233', 'example.test', 'Water is off'])
      expect(text).not.toContain(personal);
  });
});

describe('NFR-DP CM-09 erasure stops messaging at once, and is limited while retention is unverified', () => {
  it('withdraws consent on every channel, refuses every send to the tenant and their contacts, and anonymises nothing', async () => {
    const before = s.sms.sent.length;
    const req = await dp.create(c.admin, { tenantId: t1, kind: 'erasure', receivedOn: today });
    expect(req.messagingStopped).toBe(true);
    const consent = await system(c.companyId, (tx) =>
      tx.execute<{ contact: string | null; channel: string; action: string; source: string }>(
        sql`select distinct on (tenant_contact_id, channel) tenant_contact_id as contact, channel, action, source
            from consent_event where tenant_id = ${t1}::uuid
            order by tenant_contact_id, channel, recorded_at desc, id desc`,
      ),
    );
    const latest = consent.rows.filter((r) => r.source === 'data_protection');
    expect(
      latest
        .filter((r) => r.contact === null)
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['email', 'push', 'sms', 'whatsapp']);
    expect(
      latest
        .filter((r) => r.contact !== null)
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['email', 'sms', 'whatsapp']);
    expect(consent.rows.every((r) => r.action === 'withdraw')).toBe(true);

    // A business message, a notice's message on the lease's service clause: neither goes.
    expect(await message(c.companyId, t1, 'Erased tenant reminder')).toMatchObject({
      status: 'not_sent',
      reason: 'messaging_stopped',
    });
    expect(
      await message(c.companyId, t1, 'A notice for you', {
        purpose: 'notice_link',
        serviceClause: true,
        related: null,
      }),
    ).toMatchObject({ status: 'not_sent', reason: 'messaging_stopped' });
    // Even after staff record consent again, while the request stands.
    await system(c.companyId, (tx) =>
      s.tenants.recordSystemConsent(tx, c.companyId, {
        tenantId: t1,
        contactId: null,
        channel: 'sms',
        action: 'grant',
        source: 'staff',
        textVersion: 'messages.v1',
        recordedBy: c.admin.personId,
      }),
    );
    expect(await message(c.companyId, t1, 'After consent again')).toMatchObject({
      status: 'not_sent',
      reason: 'messaging_stopped',
    });
    expect(s.sms.sent.length).toBe(before);
    expect(
      await system(c.companyId, (tx) =>
        s.messaging.plannedChannels(tx, c.companyId, {
          recipient: { type: 'tenant', tenantId: t1 },
          purpose: 'broadcast',
          channels: ['sms', 'email'],
        }),
      ),
    ).toEqual([]);
    // The legal notice's outcome is recorded as withheld; the ladder serves it physically.
    const notSent = await system(c.companyId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from outbox_event where type = 'messaging.not_sent'
            and payload->>'reason' = 'messaging_stopped'`,
      ),
    );
    expect(notSent.rows[0]!.n).toBe(3);
    // Other tenants still get their messages.
    expect((await message(c.companyId, t2, 'Kwesi, a second note')).status).toBe('sent');

    // Erasure with today's rules (none verified): nothing anonymised, each category held.
    const erased = await dp.erase(c.admin, req.id);
    expect(erased.anonymised).toEqual([]);
    expect(erased.status).toBe('in_progress');
    const held = new Map(erased.held.map((h) => [h.category, h]));
    for (const category of ['financial_and_notices', 'messages', 'tenant_profile'] as const) {
      expect(held.get(category)).toMatchObject({ until: null, records: expect.any(Number) });
      expect(held.get(category)!.reason).toMatch(/not verified|no value/);
    }
    expect(held.get('tenant_profile')!.records).toBe(2);
    // No ID number, no provider payment: nothing in those categories to hold.
    expect(held.has('identity')).toBe(false);
    expect(held.has('webhook_bodies')).toBe(false);
    const [row] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ display_name: string; phone: string | null; anonymised_at: Date | null }>(
          sql`select display_name, phone, anonymised_at from tenant where id = ${t1}::uuid`,
        ),
      )
    ).rows;
    expect(row).toMatchObject({
      display_name: 'Ama Datasubject',
      phone: '+233241110001',
      anonymised_at: null,
    });
    // Run again: the same outcome, nothing twice.
    const again = await dp.erase(c.admin, req.id);
    expect(again.anonymised).toEqual([]);
    expect(again.held).toEqual(erased.held);
  });
});

describe('NFR-DP the nightly retention review counts only (decision 5)', () => {
  it('stores one row a day, with nothing counted while no rule is verified, for platform admins', async () => {
    const first = await review.run();
    expect(first.stored).toBe(true);
    expect(first.categories.map((x) => x.category)).toEqual([
      'financial_and_notices',
      'messages',
      'identity',
      'webhook_bodies',
      'tenant_profile',
      'photos_and_recordings',
    ]);
    expect(first.categories.every((x) => !x.verified && x.pastRetention === 0)).toBe(true);
    expect(first.categories.find((x) => x.category === 'financial_and_notices')!.years).toBe(6);
    expect((await review.run()).stored).toBe(false);
    const admin = await platform(ctx);
    const latest = await review.latest(admin);
    expect(latest.checkedAt).toBeInstanceOf(Date);
    expect(latest.categories).toEqual(first.categories);
    await expect(review.latest(c.admin)).rejects.toMatchObject({ status: 403 });
    await expect(review.latest(null)).rejects.toMatchObject({ status: 403 });
  });
});

describe('NFR-DP NFR-AUDIT anonymisation where a verified rule allows it keeps the books balanced and the audit chain verifying', () => {
  it('anonymises the profile and identity in place once their periods have passed, and holds the rest', async () => {
    // A tenant who moved out a month after the lease started, with an ID number and a payment.
    const yaw = await tenant(c.admin, 'Yaw Movedout', '+233241110004', {
      idNumber: 'GHA-123456789-0',
    });
    const start = plusMonths(today, -3);
    const ended = await lease(c.manager, units[2]!, yaw, start);
    await s.lifecycle.runTransitions(c.companyId);
    await approvedCash(ctx, s, b, c.manager, c.accountant, {
      leaseId: ended.id,
      amountMinor: 100_000,
      receivedOn: plusMonths(start, 1),
    });
    await s.lifecycle.recordMoveOut(c.manager, ended.id, { moveOutDate: plusMonths(start, 1) });
    expect((await message(c.companyId, yaw, 'Yaw, your deposit')).status).toBe('sent');

    // Counsel confirms the profile and identity periods (0 years, so they have passed); the
    // financial and message rules stay unverified.
    await verifiedRule('data_retention.other.tenant_profile', { years: 0 });
    await verifiedRule('data_retention.other.identity_data', { years: 0 });

    const books = () =>
      system(c.companyId, (tx) =>
        tx.execute<{ book_id: string; account_code: string; total: number }>(
          sql`select l.book_id, l.account_code, sum(l.amount_minor)::bigint as total
              from journal_line l group by l.book_id, l.account_code order by 1, 2`,
        ),
      ).then((r) => r.rows.map((x) => ({ ...x, total: Number(x.total) })));
    const before = await books();
    const money = () =>
      system(c.companyId, (tx) =>
        tx.execute<{ payments: number; amount: number; invoices: number }>(
          sql`select (select count(*) from payment where tenant_id = ${yaw}::uuid)::int as payments,
                (select sum(amount_minor) from payment where tenant_id = ${yaw}::uuid)::bigint as amount,
                (select count(*) from invoice where tenant_id = ${yaw}::uuid)::int as invoices`,
        ),
      ).then((r) => r.rows[0]);
    const moneyBefore = await money();

    const req = await dp.create(c.admin, { tenantId: yaw, kind: 'erasure', receivedOn: today });
    const erased = await dp.erase(c.admin, req.id);
    expect(erased.anonymised).toEqual([
      { category: 'identity', records: 1 },
      { category: 'tenant_profile', records: 2 },
    ]);
    const held = new Map(erased.held.map((h) => [h.category, h]));
    expect(held.get('financial_and_notices')).toMatchObject({ until: null });
    expect(held.get('messages')).toMatchObject({ until: null });
    expect(held.has('tenant_profile')).toBe(false);

    const [t] = (
      await system(c.companyId, (tx) =>
        tx.execute<Record<string, unknown>>(
          sql`select display_name, phone, whatsapp_phone, email, occupation, notes, person_id, id_type,
                id_number_encrypted, id_number_index, id_number_masked, id_status, anonymised_at
              from tenant where id = ${yaw}::uuid`,
        ),
      )
    ).rows;
    expect(t).toMatchObject({
      display_name: 'Anonymised tenant',
      phone: null,
      whatsapp_phone: null,
      email: null,
      occupation: null,
      notes: null,
      person_id: null,
      id_type: null,
      id_number_encrypted: null,
      id_number_index: null,
      id_number_masked: null,
      id_status: 'none',
    });
    expect(t!.anonymised_at).not.toBeNull();
    const contacts = await system(c.companyId, (tx) =>
      tx.execute<{ name: string; phone: string | null; relationship: string | null }>(
        sql`select name, phone, relationship from tenant_contact where tenant_id = ${yaw}::uuid`,
      ),
    );
    expect(contacts.rows).toEqual([
      { name: 'Anonymised contact', phone: null, relationship: null },
    ]);

    // The books: every line as it was, every book still summing to zero; amounts and references stay.
    expect(await books()).toEqual(before);
    const perBook = await system(c.companyId, (tx) =>
      tx.execute<{ total: number }>(
        sql`select sum(amount_minor)::bigint as total from journal_line group by book_id`,
      ),
    );
    expect(perBook.rows.every((r) => Number(r.total) === 0)).toBe(true);
    expect(await money()).toEqual(moneyBefore);
    // The audit chain verifies, and the anonymising updates (identity, then the profile) record
    // phone, email and the ID only as changed (the 0011 trigger), never by value.
    expect((await ctx.audit.verifyChain(c.companyId)).ok).toBe(true);
    const updates = (
      await system(c.companyId, (tx) =>
        tx.execute<{ data: { redacted_changed?: string[] } }>(
          sql`select e.data from audit_event e where e.record_type = 'tenant' and e.record_id = ${yaw}
              and e.action = 'tenant.update'
              and e.seq > (select max(x.seq) from audit_event x where x.record_id = ${req.id}
                           and x.action = 'data_protection.request_recorded')
              order by e.seq`,
        ),
      )
    ).rows;
    // B8 (review round): identity and profile are cleared in one update, which sets anonymised_at.
    expect(updates).toHaveLength(1);
    expect(updates.flatMap((u) => u.data.redacted_changed ?? [])).toEqual(
      expect.arrayContaining(['phone', 'email', 'id_number_encrypted', 'id_number_masked']),
    );
    expect(JSON.stringify(updates)).not.toContain('+233241110004');
    expect(JSON.stringify(updates)).not.toContain('movedout@example.test');

    // Erasing again changes nothing more, and lists what was anonymised.
    const again = await dp.erase(c.admin, req.id);
    expect(again.anonymised).toEqual(erased.anonymised);
    expect((await ctx.audit.verifyChain(c.companyId)).ok).toBe(true);

    // The next night's review counts records past a verified period; still nothing deleted.
    ctx.clock.advance(86_400_000);
    const next = await review.run();
    expect(next.stored).toBe(true);
    const profile = next.categories.find((x) => x.category === 'tenant_profile')!;
    expect(profile).toMatchObject({ verified: true, years: 0 });
    // Tenants whose tenancies have not started or ended, and Yaw already anonymised: none past.
    expect(next.categories.find((x) => x.category === 'financial_and_notices')).toMatchObject({
      verified: false,
      pastRetention: 0,
    });
    expect(await money()).toEqual(moneyBefore);
  });
});

describe('NFR-DP photos and recordings the tenant sent (M11 follow-up, 0074)', () => {
  it('counts them, puts them in the export, and holds them: documents are write-once', async () => {
    const abena = await tenant(c.admin, 'Abena Photos', '+233241110005');
    const start = plusMonths(today, -3);
    const ended = await lease(c.manager, units[3]!, abena, start);
    await s.lifecycle.runTransitions(c.companyId);
    await s.lifecycle.recordMoveOut(c.manager, ended.id, { moveOutDate: plusMonths(start, 1) });
    // A photo she added to a repair report in the tenant app, stored as the app stores it.
    const photo = Buffer.from('a leaking tap, as a picture');
    const stored = await s.documents.storeWriteOnce({
      companyId: c.companyId,
      countryCode: 'GH',
      key: `documents/${c.companyId}/test-media/${ended.id}.jpg`,
      bytes: photo,
      contentType: 'image/jpeg',
    });
    const documentId = await system(c.companyId, (tx) =>
      s.documents.recordWriteOnce(tx, stored, { kind: 'job_media' }),
    );
    const [job] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ id: string }>(
          sql`insert into maintenance_job (company_id, property_id, unit_id, lease_id, tenant_id, source, description)
              values (${c.companyId}::uuid, ${ended.unit.propertyId}::uuid, ${units[3]!}::uuid, ${ended.id}::uuid,
                      ${abena}::uuid, 'app', 'The kitchen tap leaks') returning id`,
        ),
      )
    ).rows;
    await system(c.companyId, (tx) =>
      tx.execute(
        sql`insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind, stage, added_by_kind)
            values (${c.companyId}::uuid, ${ended.unit.propertyId}::uuid, ${job!.id}::uuid, ${documentId}::uuid,
                    'image', 'report', 'tenant')`,
      ),
    );

    // Access: the photo is in her archive.
    const access = await dp.create(c.admin, { tenantId: abena, kind: 'access', receivedOn: today });
    const started = await dp.exportCreate(c.admin, access.id);
    expect(await dp.prepareExport(c.companyId, started.id)).toBe('ready');
    const [row] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ document_id: string }>(
          sql`select document_id from data_protection_export where id = ${started.id}::uuid`,
        ),
      )
    ).rows;
    const entries = unzip((await s.documents.documentFile(c.companyId, row!.document_id))!.bytes);
    const media = [...entries.entries()].filter(([n]) => n.startsWith('photos-and-recordings/'));
    expect(media.map(([n]) => n)).toEqual([`photos-and-recordings/repair-${today}-001.jpg`]);
    expect(media[0]![1].equals(photo)).toBe(true);

    // Erasure: held while the rule has no value, and still held once a verified period has
    // passed, because documents are stored write-once.
    const erasure = await dp.create(c.admin, {
      tenantId: abena,
      kind: 'erasure',
      receivedOn: today,
    });
    const first = await dp.erase(c.admin, erasure.id);
    expect(first.held.find((h) => h.category === 'photos_and_recordings')).toMatchObject({
      records: 1,
      until: null,
      reason: expect.stringMatching(/no value/),
    });
    await verifiedRule('data_retention.other.photos_and_recordings', { years: 0 });
    const second = await dp.erase(c.admin, erasure.id);
    expect(second.anonymised.map((a) => a.category)).not.toContain('photos_and_recordings');
    expect(second.held.find((h) => h.category === 'photos_and_recordings')).toMatchObject({
      records: 1,
      until: today,
      reason: expect.stringMatching(/write-once/),
    });
    // The stored photo is untouched.
    expect((await s.documents.documentFile(c.companyId, documentId))!.bytes.equals(photo)).toBe(
      true,
    );
  });
});

describe('NFR-DP CM-09 after erasure, the contacts and legal notices (M11 review round)', () => {
  it('stops messages to the tenant’s contacts as well as to the tenant', async () => {
    const [contact] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from tenant_contact where tenant_id = ${t1}::uuid order by created_at limit 1`,
        ),
      )
    ).rows;
    const before = s.sms.sent.length;
    expect(
      await message(c.companyId, t1, 'For the next of kin', {
        recipient: { type: 'tenant_contact', tenantId: t1, contactId: contact!.id },
      }),
    ).toMatchObject({ status: 'not_sent', reason: 'messaging_stopped' });
    expect(s.sms.sent.length).toBe(before);
    // Another tenant's contact still gets theirs.
    const [kwesiKin] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from tenant_contact where tenant_id = ${t2}::uuid order by created_at limit 1`,
        ),
      )
    ).rows;
    expect(
      (
        await message(c.companyId, t2, 'For Kwesi’s next of kin', {
          recipient: { type: 'tenant_contact', tenantId: t2, contactId: kwesiKin!.id },
        })
      ).status,
    ).toBe('sent');
  });

  it('serves a legal notice physically: every channel withheld, the physical-service task made, nothing sent', async () => {
    const n = noticesServices(ctx, s, b);
    const worker = new NoticesWorker(ctx, s, n, () => Promise.resolve(SAMPLE_PDF));
    const before = s.sms.sent.filter((m) => m.to === '+233241110001').length;
    const draft = await n.notices.create(c.manager, {
      type: 'breach',
      subtype: 'damage',
      leaseId: leaseT1.id,
      fields: { particulars: 'Broken window', remedyBy: plusDays(today, 7) },
    });
    await n.notices.issue(c.manager, draft.id);
    await worker.run(c.companyId);
    const notice = await n.notices.get(c.manager, draft.id);
    expect(notice.electronicService).toBe(false);
    expect(notice.recipients[0]).toMatchObject({ physicalServicePlanned: true });
    for (const channel of notice.recipients[0]!.channels)
      expect(channel.mode === 'withheld' && channel.reason).toMatch(/opted_out|no_address/);
    expect(notice.tasks.map((t) => t.kind)).toContain('notice_physical_service');
    // Never blocked: issued, and served in person.
    expect(notice.status).not.toBe('draft');
    expect(s.sms.sent.filter((m) => m.to === '+233241110001').length).toBe(before);
  });
});

describe('NFR-DP B8 an anonymised tenant stays anonymous (M11 review round, RA127)', () => {
  it('refuses to fill an anonymised tenant’s or contact’s details in again, in the service and the database', async () => {
    const yaw = (
      await system(c.companyId, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from tenant where anonymised_at is not null order by anonymised_at limit 1`,
        ),
      )
    ).rows[0]!.id;
    await expect(
      s.tenants.update(c.admin, yaw, { displayName: 'Yaw Again', phone: '+233241110004' }),
    ).rejects.toMatchObject({ status: 409, code: 'tenant_anonymised' });
    await expect(
      s.tenants.addContact(c.admin, yaw, { kind: 'guarantor', name: 'A new guarantor' }),
    ).rejects.toMatchObject({ status: 409, code: 'tenant_anonymised' });
    const [contact] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from tenant_contact where tenant_id = ${yaw}::uuid limit 1`,
        ),
      )
    ).rows;
    await expect(
      s.tenants.updateContact(c.admin, yaw, contact!.id, { name: 'Named again' }),
    ).rejects.toMatchObject({ status: 409, code: 'tenant_anonymised' });
    // The database refuses it below the service too (RA127), mapped to the same 409.
    const refused = await system(c.companyId, (tx) =>
      tx.execute(sql`update tenant set occupation = 'Banker' where id = ${yaw}::uuid`),
    ).catch((error: unknown) => error);
    expect(tenantCheckConflict(refused)).toMatchObject({ status: 409, code: 'tenant_anonymised' });
    const [t] = (
      await system(c.companyId, (tx) =>
        tx.execute<{ display_name: string; occupation: string | null }>(
          sql`select display_name, occupation from tenant where id = ${yaw}::uuid`,
        ),
      )
    ).rows;
    expect(t).toEqual({ display_name: 'Anonymised tenant', occupation: null });
  });

  it('clears ID numbers still held on an anonymised tenant once their own period passes, and nothing else ever changes', async () => {
    // Identity's confirmation is withdrawn: the profile is anonymised and the ID number held.
    await unverifiedRule('data_retention.other.identity_data');
    const kofi = await movedOut('Kofi Frozen', '+233241110006', { idNumber: 'GHA-987654321-0' });
    const req = await dp.create(c.admin, {
      tenantId: kofi.tenantId,
      kind: 'erasure',
      receivedOn: today,
    });
    const first = await dp.erase(c.admin, req.id);
    expect(first.anonymised.map((a) => a.category)).toEqual(['tenant_profile']);
    expect(first.held.find((h) => h.category === 'identity')).toMatchObject({ until: null });
    const identityOf = () =>
      system(c.companyId, (tx) =>
        tx.execute<Record<string, unknown>>(
          sql`select id_type, id_number_encrypted, id_number_index, id_number_masked, id_status,
                display_name, anonymised_at
              from tenant where id = ${kofi.tenantId}::uuid`,
        ),
      ).then((r) => r.rows[0]!);
    const held = await identityOf();
    expect(held.id_number_masked).not.toBeNull();
    // While held, the ID number cannot be changed on the anonymised record (RA127), only cleared.
    const changed = await system(c.companyId, (tx) =>
      tx.execute(
        sql`update tenant set id_number_masked = 'GHA-*********-1' where id = ${kofi.tenantId}::uuid`,
      ),
    ).catch((error: unknown) => error);
    expect(tenantCheckConflict(changed)).toMatchObject({ status: 409, code: 'tenant_anonymised' });

    // Confirmed again: the ID number is past its period (0 years from the move-out) and is cleared.
    await verifiedRule('data_retention.other.identity_data', { years: 0 });
    const second = await dp.erase(c.admin, req.id);
    expect(second.anonymised).toEqual([
      { category: 'identity', records: 1 },
      { category: 'tenant_profile', records: 2 },
    ]);
    expect(second.held.find((h) => h.category === 'identity')).toBeUndefined();
    const cleared = await identityOf();
    expect(cleared).toMatchObject({
      id_type: null,
      id_number_encrypted: null,
      id_number_index: null,
      id_number_masked: null,
      id_status: 'none',
      display_name: 'Anonymised tenant',
    });
    expect(cleared.anonymised_at).toEqual(held.anonymised_at);
    // Cleared once: setting an ID again, or any other value, is still refused (RA127).
    for (const statement of [
      sql`update tenant set id_status = 'pending', id_type = 'ghana_card' where id = ${kofi.tenantId}::uuid`,
      sql`update tenant set display_name = 'Kofi' where id = ${kofi.tenantId}::uuid`,
    ]) {
      const refused = await system(c.companyId, (tx) => tx.execute(statement)).catch(
        (error: unknown) => error,
      );
      expect(tenantCheckConflict(refused)).toMatchObject({ status: 409 });
    }
    // Erasing again changes nothing more.
    expect((await dp.erase(c.admin, req.id)).anonymised).toEqual(second.anonymised);
    expect((await ctx.audit.verifyChain(c.companyId)).ok).toBe(true);
  });
});

/** A repair the tenant reported in the app, with photos they added, stored as the app stores them. */
async function repairPhotos(
  who: Awaited<ReturnType<typeof movedOut>>,
  photos: readonly Buffer[],
): Promise<string> {
  const propertyId = who.lease.unit.propertyId;
  const [job] = (
    await system(c.companyId, (tx) =>
      tx.execute<{ id: string; ticket_number: number }>(
        sql`insert into maintenance_job (company_id, property_id, unit_id, lease_id, tenant_id, source, description)
            values (${c.companyId}::uuid, ${propertyId}::uuid, ${who.lease.unit.id}::uuid, ${who.lease.id}::uuid,
                    ${who.tenantId}::uuid, 'app', 'The ceiling leaks') returning id, ticket_number`,
      ),
    )
  ).rows;
  for (const [i, photo] of photos.entries()) {
    const stored = await s.documents.storeWriteOnce({
      companyId: c.companyId,
      countryCode: 'GH',
      key: `documents/${c.companyId}/test-media/${job!.id}-${i}.jpg`,
      bytes: photo,
      contentType: 'image/jpeg',
    });
    // One transaction each, so each photo has its own time (the export names them in order).
    const documentId = await system(c.companyId, (tx) =>
      s.documents.recordWriteOnce(tx, stored, { kind: 'job_media' }),
    );
    await system(c.companyId, (tx) =>
      tx.execute(
        sql`insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind, stage, added_by_kind)
            values (${c.companyId}::uuid, ${propertyId}::uuid, ${job!.id}::uuid, ${documentId}::uuid,
                    'image', 'report', 'tenant')`,
      ),
    );
  }
  return `MT-${String(job!.ticket_number).padStart(4, '0')}`;
}

describe('NFR-DP B7 an export over the size cap still answers the request (M11 review round)', () => {
  it('leaves out the largest photos and recordings until it fits, lists them, and the register shows it split', async () => {
    const esi = await movedOut('Esi Media', '+233241110007');
    const big = Buffer.alloc(400, 'b');
    const small = Buffer.alloc(200, 's');
    const ticket = await repairPhotos(esi, [big, small]);
    // Room for the lease scan and one photo, not both.
    const capped = new DataProtectionService(
      ctx.database,
      s.policy,
      s.rules,
      s.documents,
      ctx.audit,
      ctx.clock,
      ctx.storage,
      ctx.config,
      { maxExportBytes: SAMPLE_PDF.length + 250 },
    );
    const req = await dp.create(c.admin, {
      tenantId: esi.tenantId,
      kind: 'access',
      receivedOn: today,
    });
    // Never refused.
    const started = await capped.exportCreate(c.admin, req.id);
    expect(await capped.prepareExport(c.companyId, started.id)).toBe('ready');
    expect(await capped.exportGet(c.admin, started.id)).toMatchObject({
      status: 'ready',
      url: expect.any(String),
      split: true,
      leftOut: 1,
    });
    expect((await dp.get(c.admin, req.id)).export).toMatchObject({ split: true, leftOut: 1 });

    const archiveOf = async (exportId: string) => {
      const [row] = (
        await system(c.companyId, (tx) =>
          tx.execute<{ document_id: string }>(
            sql`select document_id from data_protection_export where id = ${exportId}::uuid`,
          ),
        )
      ).rows;
      return unzip((await s.documents.documentFile(c.companyId, row!.document_id))!.bytes);
    };
    const entries = await archiveOf(started.id);
    const media = [...entries.keys()].filter((n) => n.startsWith('photos-and-recordings/'));
    expect(media).toEqual([`photos-and-recordings/repair-${today}-002.jpg`]);
    expect(entries.get(media[0]!)!.equals(small)).toBe(true);
    // Every record and the lease scan are still there.
    expect([...entries.keys()].some((n) => n.startsWith('leases/'))).toBe(true);
    const [about] = (await readXlsxFile(entries.get('personal-data.xlsx')!)) as unknown as {
      sheet: string;
      data: unknown[][];
    }[];
    expect(about!.sheet).toBe('About');
    const rows = about!.data.map((r) => r.map((cell) => (cell === null ? null : String(cell))));
    const heading = rows.findIndex((r) => r[0] === 'Not included in this archive');
    expect(heading).toBeGreaterThan(0);
    expect(rows[heading + 1]![0]).toMatch(/staff can download each one from the record/);
    const listed = rows.slice(heading + 3);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.slice(0, 4)).toEqual([
      `photos-and-recordings/repair-${today}-001.jpg`,
      'Added to a repair report',
      today,
      `Repair ${ticket}`,
    ]);

    // Under the cap, nothing is left out.
    const whole = await dp.create(c.admin, {
      tenantId: esi.tenantId,
      kind: 'access',
      receivedOn: today,
    });
    const full = await dp.exportCreate(c.admin, whole.id);
    expect(await dp.prepareExport(c.companyId, full.id)).toBe('ready');
    expect(await dp.exportGet(c.admin, full.id)).toMatchObject({ split: false, leftOut: 0 });
    const fullEntries = await archiveOf(full.id);
    expect(
      [...fullEntries.keys()].filter((n) => n.startsWith('photos-and-recordings/')),
    ).toHaveLength(2);
    const [fullAbout] = (await readXlsxFile(fullEntries.get('personal-data.xlsx')!)) as unknown as {
      data: unknown[][];
    }[];
    expect(JSON.stringify(fullAbout!.data)).not.toContain('Not included in this archive');
  });
});

describe('NFR-DP B6 exports are kept 7 days in the ordinary bucket, then deleted (founder, review round)', () => {
  it('records one copy with its SHA-256, a retry never stores a second, and it is refused and deleted after 7 days', async () => {
    const req = await dp.create(c.admin, { tenantId: t2, kind: 'access', receivedOn: today });
    const started = await dp.exportCreate(c.admin, req.id);
    const ref = {
      bucket: ctx.config.S3_BUCKET_FILES,
      key: `${EXPORT_PREFIX}/${c.companyId}/${started.id}.zip`,
    };
    // A run that stored the archive and then stopped before recording it.
    const crashed = Buffer.from('PK an archive a crashed run stored');
    await ctx.storage.put({ ...ref, body: crashed, contentType: 'application/zip' });
    expect(await dp.prepareExport(c.companyId, started.id)).toBe('ready');
    expect(await dp.prepareExport(c.companyId, started.id)).toBe('skipped');
    expect((await ctx.storage.listVersions(ref)).length).toBe(1);
    const [doc] = (
      await system(c.companyId, (tx) =>
        tx.execute<{
          id: string;
          sha256: string;
          bucket: string;
          storage_key: string;
          storage_version_id: string | null;
          write_once: boolean;
        }>(
          sql`select d.id, d.sha256, d.bucket, d.storage_key, d.storage_version_id, d.write_once
              from data_protection_export e join document d on d.company_id = e.company_id and d.id = e.document_id
              where e.id = ${started.id}::uuid`,
        ),
      )
    ).rows;
    expect(doc).toMatchObject({ bucket: ref.bucket, storage_key: ref.key, write_once: false });
    expect(doc!.sha256).toBe(createHash('sha256').update(crashed).digest('hex'));
    expect((await dp.exportGet(c.admin, started.id)).status).toBe('ready');

    const saved = ctx.clock.now();
    try {
      ctx.clock.advance(7 * 86_400_000 + 60_000);
      await expect(dp.exportGet(c.admin, started.id)).rejects.toMatchObject({
        status: 410,
        code: 'export_expired',
      });
      // The register offers no download, and a new export can be prepared.
      expect((await dp.get(c.admin, req.id)).export).toBeNull();
      const fresh = await dp.exportCreate(c.admin, req.id);
      expect(fresh.id).not.toBe(started.id);
      // The daily cleanup deletes the object (that exact version); the fingerprint stays.
      const cleaned = await dp.cleanupExports();
      expect(cleaned.deleted).toBeGreaterThanOrEqual(1);
      expect(
        await ctx.storage.head({
          ...ref,
          ...(doc!.storage_version_id ? { versionId: doc!.storage_version_id } : {}),
        }),
      ).toBeNull();
      const [kept] = (
        await system(c.companyId, (tx) =>
          tx.execute<{ sha256: string }>(
            sql`select sha256 from document where id = ${doc!.id}::uuid`,
          ),
        )
      ).rows;
      expect(kept?.sha256).toBe(doc!.sha256);
      expect((await dp.cleanupExports()).deleted).toBe(0);
      const deletedEvents = await system(c.companyId, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_event where action = 'data_protection.export_deleted'
              and record_id = ${started.id}`,
        ),
      );
      expect(deletedEvents.rows[0]!.n).toBe(1);
    } finally {
      ctx.clock.set(saved);
    }
  });
});
