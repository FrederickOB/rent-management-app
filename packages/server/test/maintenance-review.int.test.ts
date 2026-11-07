import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyStore, requestHash } from '../src/core/idempotency';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { registerMaintenanceRecipients } from '../src/messaging/maintenance-recipients';
import type { Reach } from '../src/messaging/messaging.service';
import { startServerTest, type ServerTestContext } from './support';
import { asSuperuser } from './support';
import {
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  JPEG,
  MP4,
  maintenanceServices,
  outboxOf,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import { fundAgentCash } from './support/owner-funding';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  deliverMessages,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M8 review's maintenance fixes against the real database: the job sheet's files and dead
 * links (BE 5, F1), its code lock and its link's artisan, write-once files staged only after the
 * checks (F2 among them), logging a repair from a conversation, evidence, a lease's one move-in
 * report, expenses, emergency alerts, SLAs on Reported jobs, STOP from artisans and staff, and a
 * former tenant's repairs. Every test makes its own company.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let today: string;
let ip = 10;
/** Each test its own address, so the per-address limits of one never reach another. */
const client = () => ({ ip: `203.0.113.${ip++}`, userAgent: 'test' });
const M4A = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypM4A '),
  Buffer.alloc(300, 3),
]);

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

async function setup(name: string, part: string, kind: 'agency' | 'landlord' = 'agency') {
  const c = await moneyCompany(ctx, s, kind, name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const a = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
  });
  const units = Object.values(a.units);
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `${name} tenant`,
    phone: `+2332000${String(ip).padStart(5, '0')}`,
  });
  const start = toIsoDate(addMonths(parseBusinessDate(today), -1));
  const lease = await billedLease(ctx, s, b, c.manager, {
    unitId: units[0]!,
    tenantId: tenant.id,
    startDate: start,
    endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(start), 12)), -1),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
  return { ...c, ownerId, property: a.propertyId, units, tenant, lease };
}

async function upload(
  actor: Parameters<MaintenanceServices['maintenance']['createUpload']>[0],
  contentType = 'image/jpeg',
  bytes = JPEG,
) {
  const u = await m.maintenance.createUpload(actor, {
    contentType,
    sizeBytes: bytes.length,
    ...(contentType.startsWith('image') ? {} : { durationSeconds: 10 }),
  });
  return putUpload(ctx, u, contentType, bytes);
}

async function tenantActor(companyId: string, tenantId: string) {
  const [row] = await system(companyId, (tx) =>
    tx
      .select({ personId: schema.tenant.personId })
      .from(schema.tenant)
      .where(sql`id = ${tenantId}`),
  );
  return { kind: 'tenant' as const, personId: row!.personId!, authMethod: 'phone_otp' as const };
}

async function documentCount(companyId: string) {
  const [row] = await system(companyId, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from document`),
  ).then((r) => r.rows);
  return row!.n;
}

/** An artisan on the job, and the raw token of the job sheet the message carried. */
async function sheetFor(c: Awaited<ReturnType<typeof setup>>, jobId: string, phone: string) {
  const artisan = await m.artisans.create(c.manager, {
    name: `Artisan ${phone.slice(-4)}`,
    phone,
    trades: ['plumbing'],
    consent: { whatsapp: false, sms: true },
  });
  await m.maintenance.assign(c.manager, jobId, {
    assignee: { kind: 'artisan', artisanId: artisan.id },
  });
  registerMaintenanceRecipients(s.messaging, m.artisans, m.sheets);
  await deliverMessages(ctx, s, c.companyId);
  const e164 = `+233${phone.slice(1)}`;
  const text = s.sms.sent.filter((x) => x.to === e164).at(-1)!.body;
  return { artisan, token: /\/j\/([A-Za-z0-9_-]{43})/.exec(text)![1]! };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('MI-04 the job sheet shows the report’s photos and videos only, and a dead link nothing (BE 5, F1)', () => {
  it('★ lists and serves the report’s photo and video, never a voice note, a before or a staff file, and nothing once the job is cancelled', async () => {
    const c = await setup('Sheet Files', 'RSF');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Burst pipe under the sink',
      category: 'plumbing',
      priority: 'routine',
      uploadIds: [
        await upload(c.manager),
        await upload(c.manager, 'video/mp4', MP4),
        await upload(c.manager, 'audio/mp4', M4A),
      ],
      messageIds: [],
    });
    await m.maintenance.addMedia(c.manager, job.id, {
      stage: 'other',
      uploadIds: [await upload(c.manager)],
    });
    const staffFiles = (await m.maintenance.get(c.manager, job.id)).attachments;
    const { token } = await sheetFor(c, job.id, '0244333111');
    const who = client();
    const opened = await m.sheets.open(token, who);
    expect(opened.attachments.map((a) => a.kind).sort()).toEqual(['image', 'video']);
    expect(opened.attachments.every((a) => a.stage === 'report')).toBe(true);
    for (const file of opened.attachments)
      await expect(m.sheets.attachmentUrl(token, who, file.id)).resolves.toMatchObject({
        url: expect.any(String),
      });
    for (const file of staffFiles.filter((f) => f.kind === 'audio' || f.stage === 'other'))
      await expect(m.sheets.attachmentUrl(token, who, file.id)).rejects.toMatchObject({
        status: 404,
      });
    // Taken off the artisan and cancelled: the link is dead.
    await m.maintenance.unassign(c.manager, job.id, 'Fixed by the tenant');
    await m.maintenance.cancel(c.manager, job.id, 'Fixed by the tenant');
    const dead = await m.sheets.open(token, who);
    expect(dead).toMatchObject({
      screen: 'closed',
      description: null,
      contact: null,
      visitAt: null,
      attachments: [],
      code: null,
      actions: { accept: false, decline: false, start: false, complete: false },
    });
    expect(dead.property.address).toBeNull();
    await expect(
      m.sheets.attachmentUrl(token, who, opened.attachments[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('MI-04 the job sheet’s code locks after five wrong tries (should fix)', () => {
  it('locks the link for 30 minutes across codes, and sends no code while it is locked', async () => {
    const c = await setup('Sheet Lock', 'RSL');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Loose socket',
      category: 'electrical',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    const { token } = await sheetFor(c, job.id, '0244333222');
    const who = client();
    await m.sheets.respond(token, who, { response: 'accepted' });
    // A state check comes before any file is staged.
    const documentsBefore = await documentCount(c.companyId);
    const early = await m.sheets.createUpload(token, who, {
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    await putUpload(ctx, early, 'image/jpeg', JPEG);
    await expect(
      m.sheets.complete(token, who, {
        code: '123456',
        uploadIds: [early.uploadId],
        completionNote: 'Done',
      }),
    ).rejects.toMatchObject({ code: 'job_sheet_not_started' });
    expect(await documentCount(c.companyId)).toBe(documentsBefore);
    await m.sheets.start(token, who, { uploadIds: [], beforePhotoReason: 'Dark, no photo' });
    await m.sheets.sendCode(token, who);
    const code = /\b(\d{6})\b/.exec(s.sms.sent.at(-1)!.body)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    const attempt = () =>
      m.sheets.complete(token, who, { code: wrong, uploadIds: [], completionNote: 'Fixed it' });
    await expect(attempt()).rejects.toMatchObject({ code: 'code_wrong' });
    await expect(attempt()).rejects.toMatchObject({ code: 'code_wrong' });
    // A new code does not reset the count.
    await m.sheets.sendCode(token, who);
    await expect(attempt()).rejects.toMatchObject({ code: 'code_wrong' });
    await expect(attempt()).rejects.toMatchObject({ code: 'code_wrong' });
    await expect(attempt()).rejects.toMatchObject({ status: 429, code: 'code_locked' });
    await expect(m.sheets.sendCode(token, who)).rejects.toMatchObject({ code: 'code_locked' });
    const locked = await m.sheets.open(token, who);
    expect(locked.code?.lockedUntil).toBeTruthy();
  });
});

describe('MI-04 a job-sheet link is the artisan’s the message went to (should fix)', () => {
  it('mints no link for an artisan the job left, and an older message never revokes a newer link', async () => {
    const c = await setup('Sheet Owner', 'RSO');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Gate motor stuck',
      category: 'other',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    const first = await sheetFor(c, job.id, '0244333333');
    const [firstMessage] = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(sql`artisan_id = ${first.artisan.id} and purpose = 'job_sheet_link'`),
    );
    // A newer link of the same artisan's, then the older message reported sent late.
    const newer = await m.sheets.messageLinkUrl(c.companyId, job.id, firstMessage!.id);
    await system(c.companyId, (tx) => m.sheets.messageLinkSent(tx, job.id, firstMessage!.id));
    const newerToken = /\/j\/([A-Za-z0-9_-]{43})/.exec(newer)![1]!;
    expect((await m.sheets.open(newerToken, client())).screen).toBe('sheet');
    // The job moves to another artisan: the first artisan's message mints nothing.
    await m.maintenance.unassign(c.manager, job.id, 'Not available');
    await sheetFor(c, job.id, '0244333444');
    await expect(
      m.sheets.messageLinkUrl(c.companyId, job.id, firstMessage!.id),
    ).rejects.toMatchObject({ code: 'job_sheet_unassigned' });
  });
});

describe('MI-01 and F2 no repair files on Starter, refused before anything is stored', () => {
  it('offers files on Growth only, and refuses a Starter upload or report with files', async () => {
    const c = await setup('Starter Files', 'RST', 'landlord');
    const tenant = await tenantActor(c.companyId, c.tenant.id);
    const groupOf = async () =>
      (await m.tenantRepairs.list(tenant)).find((g) => g.landlord.companyId === c.companyId)!;
    expect((await groupOf()).filesAllowed).toBe(true);
    expect((await groupOf()).landlord.timeZone).toBe('Africa/Accra');
    await asSuperuser(ctx, "update company set interim_plan = 'starter' where id = $1", [
      c.companyId,
    ]);
    expect((await groupOf()).filesAllowed).toBe(false);
    await expect(
      m.tenantRepairs.createUpload(tenant, {
        leaseId: c.lease.id,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'repair_files_not_on_plan' });
    const before = await documentCount(c.companyId);
    await expect(
      m.tenantRepairs.report(tenant, {
        leaseId: c.lease.id,
        clientId: '0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e70',
        category: 'plumbing',
        description: 'The tap drips',
        emergency: false,
        uploadIds: ['0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e71'],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'repair_files_not_on_plan' });
    expect(await documentCount(c.companyId)).toBe(before);
    const words = await m.tenantRepairs.report(tenant, {
      leaseId: c.lease.id,
      clientId: '0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e72',
      category: 'plumbing',
      description: 'The tap drips',
      emergency: false,
      uploadIds: [],
    });
    expect(words.forwarded).toBe(true);
  });
});

describe('MI-01 a former tenant reports repairs for 30 days after the end (should fix)', () => {
  it('accepts a repair on a lease ended within 30 days, and refuses one ended longer ago', async () => {
    const c = await setup('Former Tenant', 'RFT');
    const tenant = await tenantActor(c.companyId, c.tenant.id);
    const endOn = async (day: string) =>
      asSuperuser(
        ctx,
        "update lease set status = 'ended', ended_on = $2, move_out_date = $2, end_reason = 'moved_out' where id = $1",
        [c.lease.id, day],
      );
    await endOn(plusDays(today, -10));
    const report = (n: string) =>
      m.tenantRepairs.report(tenant, {
        leaseId: c.lease.id,
        clientId: `0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e${n}`,
        category: 'plumbing',
        description: 'The tap still drips',
        emergency: false,
        uploadIds: [],
      });
    await expect(report('80')).resolves.toMatchObject({ status: expect.any(String) });
    await endOn(plusDays(today, -31));
    await expect(report('81')).rejects.toMatchObject({ status: 409, code: 'lease_ended' });
  });
});

describe('CM-04 logging a repair from a conversation (should fix)', () => {
  async function conversationWith(companyId: string, tenantId: string, n: number) {
    const [conversation] = await asSuperuser(
      ctx,
      "insert into conversation (id, company_id, tenant_id, state) values (gen_random_uuid(), $1, $2, 'open') returning id",
      [companyId, tenantId],
    );
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [message] = await asSuperuser(
        ctx,
        `insert into message (id, company_id, conversation_id, tenant_id, purpose, body, channels, channel,
           direction, author_type, provider, provider_message_id)
         values (gen_random_uuid(), $1, $2, $3, 'inbound', 'The roof leaks', '{whatsapp}', 'whatsapp', 'inbound',
           'tenant', 'whatsapp', gen_random_uuid()::text)
         returning id`,
        [companyId, (conversation as { id: string }).id, tenantId],
      );
      ids.push((message as { id: string }).id);
    }
    return { conversationId: (conversation as { id: string }).id, messageIds: ids };
  }

  it('refuses another conversation’s messages, makes it the conversation tenant’s repair, and logs it once per key', async () => {
    const c = await setup('Inbox Repair', 'RIR');
    const { tenant: other } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: 'Inbox other tenant',
    });
    const mine = await conversationWith(c.companyId, other.id, 1);
    const theirs = await conversationWith(c.companyId, c.tenant.id, 1);
    const input = {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'The roof leaks',
      category: 'roofing' as const,
      priority: 'emergency' as const,
      uploadIds: [],
      conversationId: mine.conversationId,
    };
    await expect(
      m.maintenance.logRepair(c.manager, { ...input, messageIds: theirs.messageIds }),
    ).rejects.toMatchObject({ status: 400, code: 'messages_not_in_conversation' });
    const store = new IdempotencyStore(ctx.database, { attempts: 50, ms: 50 });
    const body = { ...input, messageIds: mine.messageIds };
    const write = () =>
      store.run(
        {
          companyId: c.companyId,
          personId: c.manager.personId,
          key: 'log-repair-key-0001',
          operation: 'maintenance.report',
          hash: requestHash('maintenance.report', c.manager.personId, body),
        },
        async (claim) => ({
          jobId: (await m.maintenance.logRepair(c.manager, body, { claim })).id,
        }),
      );
    const first = await write();
    const again = await write();
    expect(again.jobId).toBe(first.jobId);
    const job = await m.maintenance.get(c.manager, first.jobId);
    // The unit is let to someone else: the repair is the conversation’s tenant’s.
    expect(job.tenant?.id).toBe(other.id);
    expect(await outboxOf(ctx, c.companyId, 'maintenance.emergency-alert')).toHaveLength(1);
  });
});

describe('MI-06 evidence: before files are seen, a damage deduction shows its inspection (should fix)', () => {
  it('refuses a start with only a voice note before it, and a damage deduction without evidence from the inspection', async () => {
    const c = await setup('Evidence', 'REV');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Cracked window',
      category: 'carpentry',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Evidence caretaker', {
      properties: [c.property],
    });
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'staff', personId: caretaker.personId },
    });
    await expect(
      m.maintenance.start(caretaker, job.id, {
        uploadIds: [await upload(caretaker, 'audio/mp4', M4A)],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'maintenance_before_photo_required' });
    await expect(
      m.maintenance.start(caretaker, job.id, { uploadIds: [await upload(caretaker)] }),
    ).resolves.toMatchObject({ status: 'in_progress' });

    // A move-out with its inspection: damage cites the inspection's items or photos.
    const planned = await m.moveOuts.plan(c.manager, c.lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    const withInspection = await m.moveOuts.startInspection(c.manager, planned.id);
    const inspection = await m.inspections.get(c.manager, withInspection.inspectionId!);
    const damage = {
      kind: 'damage' as const,
      amountMinor: 1_000,
      reason: 'Broken window pane',
      inspectionItemIds: [] as string[],
      photoIds: [],
    };
    await expect(m.moveOuts.addDeduction(c.manager, planned.id, damage)).rejects.toMatchObject({
      status: 400,
      code: 'deduction_evidence_required',
    });
    await expect(
      m.moveOuts.addDeduction(c.manager, planned.id, {
        ...damage,
        inspectionItemIds: [inspection.items[0]!.id],
      }),
    ).rejects.toMatchObject({ code: 'deductions_exceed_deposit' });
  });
});

describe('TL-08 a lease has one move-in report out at a time (should fix)', () => {
  it('cancels the earlier report when a correcting inspection’s report is opened', async () => {
    const c = await setup('One Report', 'ROR');
    const submitIt = async () => {
      const started = await m.inspections.start(c.manager, {
        unitId: c.units[0]!,
        kind: 'move_in',
        leaseId: c.lease.id,
      });
      for (const item of started.items)
        await m.inspections.updateItem(c.manager, started.id, item.id, { condition: 'good' });
      await m.inspections.submit(c.manager, started.id);
      return started.id;
    };
    const first = await submitIt();
    expect(await m.reports.render(c.companyId, first, c.manager.personId)).toBe(true);
    const second = await submitIt();
    expect(await m.reports.render(c.companyId, second, c.manager.personId)).toBe(true);
    const requests = await system(c.companyId, (tx) =>
      tx
        .select({
          inspectionId: schema.signingRequest.inspectionId,
          status: schema.signingRequest.status,
        })
        .from(schema.signingRequest)
        .where(sql`lease_id = ${c.lease.id} and subject_type = 'move_in_report'`),
    );
    expect(requests.find((r) => r.inspectionId === first)!.status).toBe('cancelled');
    expect(requests.find((r) => r.inspectionId === second)!.status).toBe('preparing');
  });
});

describe('AC-03 expenses: who paid is in the right book, and a landlord has no agency account (should fix)', () => {
  it('posts an agent-paid expense to 1070 and an owner-paid one to 1010, and refuses paying a landlord’s from an agency account', async () => {
    const agency = await setup('Expense Books', 'REB');
    const record = (c: typeof agency, paidBy: 'agent' | 'owner' | 'unpaid', key: string) =>
      m.expenses.record(c.accountant, {
        propertyId: c.property,
        category: 'repairs',
        supplierName: `Supplier ${key}`,
        amountMinor: 12_000,
        expenseDate: today,
        paidBy,
      });
    // F3 (founder-approved, 2026-11-07): the owner funds the agency to pay the bill.
    await fundAgentCash(ctx, s, b, agency.accountant, agency.ownerId, 12_000);
    const agent = await record(agency, 'agent', 'agent');
    const owner = await record(agency, 'owner', 'owner');
    const [rowA] = await m.expenses.list(agency.accountant, { propertyId: agency.property });
    expect(rowA).toBeTruthy();
    const book = (expenseId: string, account: string) =>
      journalSum(
        ctx,
        agency.companyId,
        `l.account_code = $1 and e.record_type = 'expense' and e.record_id = $2 and l.book_id = (select book_id from expense where id = $2)`,
        [account, expenseId],
      );
    expect(await book(agent.expenseId, '1070')).toBe(-12_000);
    expect(await book(owner.expenseId, '1010')).toBe(-12_000);
    const listed = await m.expenses.list(agency.accountant, { propertyId: agency.property });
    expect(listed.every((e) => e.noReceipt)).toBe(true);

    const landlord = await setup('Expense Landlord', 'REL', 'landlord');
    const unpaid = await record(landlord, 'unpaid', 'unpaid');
    await expect(
      m.expenses.pay(landlord.accountant, unpaid.expenseId, {
        paidOn: today,
        paidFrom: 'agency_account',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'agency_account_not_available' });
  });
});

describe('MI-02 emergency alerts reach a self-managing landlord, and an agency’s admins when no manager covers the property (should fix)', () => {
  it('alerts the landlord with their managers, and the agency admins only where no manager is scoped', async () => {
    const landlord = await setup('Alert Landlord', 'RAL', 'landlord');
    const job = await m.maintenance.logRepair(landlord.manager, {
      propertyId: landlord.property,
      unitId: landlord.units[0]!,
      description: 'Sparks from the meter',
      category: 'electrical',
      priority: 'emergency',
      uploadIds: [],
      messageIds: [],
    });
    await m.maintenance.emergencyAlert(landlord.companyId, job.id);
    const alerted = async (companyId: string) =>
      new Set(
        (await outboxOf(ctx, companyId, MESSAGE_SEND_JOB))
          .map((e) => e.payload as { purpose: string; recipient: { personId?: string } })
          .filter((p) => p.purpose === 'maintenance_alert')
          .map((p) => p.recipient.personId),
      );
    const people = await alerted(landlord.companyId);
    expect(people.has(landlord.admin.personId)).toBe(true);
    expect(people.has(landlord.manager.personId)).toBe(true);

    // An agency whose only manager is scoped to another property: its admin is alerted instead.
    const agency = await moneyCompany(ctx, s, 'agency', 'Alert Admins');
    const ownerId = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Alert admins owner' })
    ).id;
    const covered = await propertyWithUnits(s, agency.admin, {
      areaCode: 'ACC',
      propertyPart: 'RAA',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const elsewhere = await propertyWithUnits(s, agency.admin, {
      areaCode: 'ACC',
      propertyPart: 'RAB',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    await asSuperuser(ctx, 'update membership set scope = $2 where id = $1', [
      agency.manager.membershipId,
      JSON.stringify({ properties: [elsewhere.propertyId] }),
    ]);
    const emergency = await m.maintenance.logRepair(agency.admin, {
      propertyId: covered.propertyId,
      unitId: Object.values(covered.units)[0]!,
      description: 'Gas smell in the hall',
      category: 'other',
      priority: 'emergency',
      uploadIds: [],
      messageIds: [],
    });
    await m.maintenance.emergencyAlert(agency.companyId, emergency.id);
    const reached = await alerted(agency.companyId);
    expect(reached.has(agency.admin.personId)).toBe(true);
    expect(reached.has(agency.manager.personId)).toBe(false);
  });
});

describe('MI-02 a Reported job with a priority has its targets checked (should fix)', () => {
  it('warns on a staff-logged emergency that nobody has triaged', async () => {
    const c = await setup('Reported SLA', 'RRS');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Water everywhere',
      priority: 'emergency',
      uploadIds: [],
      messageIds: [],
    });
    expect(job.status).toBe('reported');
    ctx.clock.advance(3 * 3_600_000);
    try {
      expect(await m.maintenance.slaCheck(c.companyId)).toBeGreaterThan(0);
    } finally {
      ctx.clock.advance(-3 * 3_600_000);
    }
    const detail = await m.maintenance.get(c.manager, job.id);
    expect(detail.events.some((e) => e.kind === 'sla_warned')).toBe(true);
  });
});

describe('CM-09 STOP and START from artisans and staff, and staff WhatsApp only with an opt-in (should fix)', () => {
  it('withdraws and restores an artisan’s channels, stops a staff member’s SMS, and sends staff WhatsApp alerts only with an opt-in', async () => {
    const c = await setup('Keyword Contacts', 'RKC');
    const artisan = await m.artisans.create(c.manager, {
      name: 'Keyword Artisan',
      phone: '0244555666',
      trades: ['plumbing'],
      consent: { whatsapp: true, sms: true },
    });
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Keyword caretaker', {
      properties: [c.property],
    });
    await asSuperuser(ctx, 'update person set phone_number = $2 where id = $1', [
      caretaker.personId,
      '+233244555777',
    ]);
    const honour = (phone: string, action: 'grant' | 'withdraw', channels: string[]) =>
      system(c.companyId, (tx) =>
        m.artisans.honourKeyword(tx, c.companyId, phone, { action, channels }),
      );
    expect(await honour('+233244555666', 'withdraw', ['sms', 'whatsapp', 'email'])).toBe(true);
    expect(
      (await m.artisans.list(c.manager, {})).find((a) => a.id === artisan.id)!.consent,
    ).toEqual({
      whatsapp: false,
      sms: false,
    });
    expect(await honour('+233244555666', 'grant', ['sms'])).toBe(true);
    expect(
      (await m.artisans.list(c.manager, {})).find((a) => a.id === artisan.id)!.consent,
    ).toEqual({
      whatsapp: false,
      sms: true,
    });
    expect(await honour('+233200999999', 'withdraw', ['sms'])).toBe(false);

    // The staff recipient as messaging sees it.
    let staffReach:
      | ((tx: Tx, companyId: string, recipient: never, purpose: string) => Promise<Reach | null>)
      | null = null;
    registerMaintenanceRecipients(
      {
        useRecipients: (kind: string, handler: { reach: never }) => {
          if (kind === 'staff') staffReach = handler.reach;
        },
        useLinks: () => undefined,
      } as never,
      m.artisans,
      m.sheets,
    );
    const reach = () =>
      system(c.companyId, (tx) =>
        staffReach!(
          tx,
          c.companyId,
          { type: 'staff', personId: caretaker.personId } as never,
          'maintenance_alert',
        ),
      );
    expect([...(await reach())!.consented].sort()).toEqual(['email', 'sms']);
    await m.artisans.setStaffWhatsApp(c.admin, caretaker.membershipId, true);
    expect([...(await reach())!.consented].sort()).toEqual(['email', 'sms', 'whatsapp']);
    expect(await honour('+233244555777', 'withdraw', ['sms'])).toBe(true);
    expect([...(await reach())!.consented].sort()).toEqual(['email', 'whatsapp']);
    expect(await honour('+233244555777', 'grant', ['sms'])).toBe(true);
    expect([...(await reach())!.consented].sort()).toEqual(['email', 'sms', 'whatsapp']);
  });
});

describe('MI-11 expense receipts are optional, flagged when missing (F3)', () => {
  it('flags an expense without a receipt, and not one with', async () => {
    const c = await setup('Receipt Flag', 'RRF');
    const proof = await uploadEvidence(ctx, (i) => m.expenses.createUpload(c.accountant, i));
    const withReceipt = await m.expenses.record(c.accountant, {
      propertyId: c.property,
      category: 'repairs',
      supplierName: 'With Receipt',
      amountMinor: 5_000,
      expenseDate: today,
      paidBy: 'owner',
      receiptUploadId: proof,
    });
    const without = await m.expenses.record(c.accountant, {
      propertyId: c.property,
      category: 'repairs',
      supplierName: 'No Receipt',
      amountMinor: 5_000,
      expenseDate: today,
      paidBy: 'owner',
    });
    expect((await m.expenses.get(c.accountant, withReceipt.expenseId)).noReceipt).toBe(false);
    expect((await m.expenses.get(c.accountant, without.expenseId)).noReceipt).toBe(true);
  });
});

describe('MI-06 a disputed job is done again only with a new after photo (founder, 2026-11-06)', () => {
  it('refuses the re-completion with the first completion’s photos only, and accepts it with a new one', async () => {
    const c = await setup('Disputed Again', 'RDA');
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Disputed caretaker', {
      properties: [c.property],
    });
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Shower drains slowly',
      category: 'plumbing',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'staff', personId: caretaker.personId },
    });
    await m.maintenance.start(caretaker, job.id, { uploadIds: [await upload(caretaker)] });
    await m.maintenance.complete(caretaker, job.id, {
      uploadIds: [await upload(caretaker)],
      completionNote: 'Cleared the trap',
    });
    await m.maintenance.recordResponse(c.manager, job.id, {
      response: 'disputed',
      reason: 'Still slow',
    });
    await expect(
      m.maintenance.complete(caretaker, job.id, { uploadIds: [], completionNote: 'Cleared again' }),
    ).rejects.toMatchObject({ status: 400, code: 'maintenance_after_photo_required' });
    await expect(
      m.maintenance.complete(caretaker, job.id, {
        uploadIds: [await upload(caretaker)],
        completionNote: 'Cleared again and flushed',
      }),
    ).resolves.toMatchObject({ status: 'work_done' });
  });
});
