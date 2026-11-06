import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { runSql } from '@rent/db/testing';
import { MAINTENANCE_JOB_TRANSITIONS } from '@rent/domain/maintenance';
import { TEMPLATE_DEFINITIONS } from '@rent/domain/messaging';
import { MOVE_OUT_STATUSES, nextMoveOutStatus, type MoveOutAction } from '@rent/domain/moveout';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { INSPECTION_RENDER_REPORT_JOB } from '../src/maintenance/inspections.service';
import { MAINTENANCE_EMERGENCY_ALERT_JOB } from '../src/maintenance/maintenance.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  leaseAccount,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { registerMaintenanceRecipients } from '../src/messaging/maintenance-recipients';
import {
  JPEG,
  maintenanceServices,
  outboxOf,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import { taxServices, type TaxServices } from './support/tax';
import {
  deliverMessages,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Maintenance, job sheets, inspections and expenses against the real database (MI-01 to MI-06,
 * MI-10, CM-04, AC-03; M8 plan section 6). Every test makes its own company.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let today: string;
const HOUR = 3_600_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const client = { ip: '203.0.113.9', userAgent: 'test' };

async function setup(name: string, part: string) {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const a = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
  });
  const other = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `${part}X`,
    ownerId,
    units: [{ unitType: 'single_room', count: 1 }],
  });
  const caretakerA = await staffIn(ctx, c.companyId, 'agency', 'caretaker', `${name} caretaker A`, {
    properties: [a.propertyId],
  });
  const caretakerB = await staffIn(ctx, c.companyId, 'agency', 'caretaker', `${name} caretaker B`, {
    properties: [other.propertyId],
  });
  const units = Object.values(a.units);
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `${name} tenant`,
    phone: '+233200000555',
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
  return {
    ...c,
    ownerId,
    property: a.propertyId,
    units,
    other,
    caretakerA,
    caretakerB,
    tenant,
    lease,
  };
}

async function jpegUpload(
  actor: Parameters<MaintenanceServices['maintenance']['createUpload']>[0],
) {
  const upload = await m.maintenance.createUpload(actor, {
    contentType: 'image/jpeg',
    sizeBytes: JPEG.length,
  });
  return putUpload(ctx, upload, 'image/jpeg', JPEG);
}

/** The messages queued for a company: their purpose, recipient and channels. */
async function queued(companyId: string) {
  return (await outboxOf(ctx, companyId, MESSAGE_SEND_JOB)).map(
    (e) =>
      e.payload as {
        messageId: string;
        purpose: string;
        recipient: { type: string; personId?: string; artisanId?: string; tenantId?: string };
        channels: string[];
        link: { purpose: string; targetId: string } | null;
        body: string;
      },
  );
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

describe('MI-06 and CM-04 a job from report to close', () => {
  it('★ starts only with a before photo or a reason, is done only with an after photo and a note, and the tenant confirms', async () => {
    const c = await setup('Board Agency', 'MBA');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'The kitchen tap leaks',
      category: 'plumbing',
      priority: 'urgent',
      uploadIds: [],
      messageIds: [],
    });
    expect(job).toMatchObject({
      status: 'triaged',
      tenant: { id: c.tenant.id },
      priority: 'urgent',
    });
    expect(job.targets?.respondBy).toBeTruthy();
    const assigned = await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'staff', personId: c.caretakerA.personId },
    });
    expect(assigned.status).toBe('assigned');
    expect(assigned.tasks).toHaveLength(1);
    // A caretaker of another property cannot be given it.
    await expect(
      m.maintenance.assign(c.manager, job.id, {
        assignee: { kind: 'staff', personId: c.caretakerB.personId },
      }),
    ).rejects.toMatchObject({ code: 'assignee_not_eligible' });
    await expect(
      m.maintenance.start(c.caretakerA, job.id, { uploadIds: [] }),
    ).rejects.toMatchObject({ status: 400, code: 'maintenance_before_photo_required' });
    await m.maintenance.start(c.caretakerA, job.id, {
      uploadIds: [],
      beforePhotoReason: 'Emergency: no time',
    });
    await expect(
      m.maintenance.complete(c.caretakerA, job.id, { uploadIds: [], completionNote: 'Fixed' }),
    ).rejects.toMatchObject({ status: 400, code: 'maintenance_after_photo_required' });
    const done = await m.maintenance.complete(c.caretakerA, job.id, {
      uploadIds: [await jpegUpload(c.caretakerA)],
      completionNote: 'Replaced the washer',
    });
    expect(done.status).toBe('work_done');
    expect(done.tasks[0]!.status).toBe('done');
    // The tenant heard about each step on their channel (CM-04).
    const updates = (await queued(c.companyId)).filter((q) => q.purpose === 'repair_update');
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.every((u) => u.recipient.tenantId === c.tenant.id)).toBe(true);
    const disputed = await m.maintenance.recordResponse(c.manager, job.id, {
      response: 'disputed',
      reason: 'Still dripping',
    });
    expect(disputed.status).toBe('in_progress');
    await m.maintenance.complete(c.caretakerA, job.id, {
      uploadIds: [await jpegUpload(c.caretakerA)],
      completionNote: 'Tightened it again',
    });
    const closed = await m.maintenance.recordResponse(c.manager, job.id, { response: 'confirmed' });
    expect(closed.status).toBe('closed');
    expect(closed.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'reported',
        'triaged',
        'assigned',
        'started',
        'work_done',
        'disputed',
        'confirmed',
        'closed',
      ]),
    );
    await expect(m.maintenance.addNote(c.manager, job.id, 'Too late')).resolves.toBeTruthy();
    await expect(m.maintenance.cancel(c.manager, job.id, 'Duplicate')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('closes a job with no tenant by staff, and refuses a tenant response on it', async () => {
    const c = await setup('Common Agency', 'MCA');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      description: 'The gate hinge is broken',
      category: 'carpentry',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'staff', personId: c.caretakerA.personId },
    });
    await m.maintenance.start(c.caretakerA, job.id, {
      uploadIds: [await jpegUpload(c.caretakerA)],
    });
    await m.maintenance.complete(c.caretakerA, job.id, {
      uploadIds: [await jpegUpload(c.caretakerA)],
      completionNote: 'New hinge',
    });
    await expect(
      m.maintenance.recordResponse(c.manager, job.id, { response: 'confirmed' }),
    ).rejects.toMatchObject({ code: 'no_tenant' });
    const closed = await m.maintenance.close(c.manager, job.id, 'Checked it');
    expect(closed.status).toBe('closed');
  });

  it('refuses a renamed file by its first bytes (decision 2)', async () => {
    const c = await setup('Media Agency', 'MMA');
    const upload = await m.maintenance.createUpload(c.manager, {
      contentType: 'video/mp4',
      sizeBytes: JPEG.length,
      durationSeconds: 10,
    });
    await putUpload(ctx, upload, 'video/mp4', JPEG);
    await expect(
      m.maintenance.logRepair(c.manager, {
        propertyId: c.property,
        description: 'A video that is a photo',
        uploadIds: [upload.uploadId],
        messageIds: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'media_type_mismatch' });
    await expect(
      m.maintenance.createUpload(c.manager, {
        contentType: 'video/mp4',
        sizeBytes: 1000,
        durationSeconds: 91,
      }),
    ).rejects.toMatchObject({ code: 'media_too_long' });
  });
});

describe('MI-02 emergency alerts and SLA warnings (decisions 4 and 5)', () => {
  it('★ alerts every manager and caretaker of the property on WhatsApp and SMS once each, and nobody of another property', async () => {
    const c = await setup('Alert Agency', 'MAA');
    const job = await m.maintenance.logRepair(c.caretakerA, {
      propertyId: c.property,
      unitId: c.units[1]!,
      description: 'Water pouring through the ceiling',
      category: 'plumbing',
      priority: 'emergency',
      uploadIds: [],
      messageIds: [],
    });
    expect(await outboxOf(ctx, c.companyId, MAINTENANCE_EMERGENCY_ALERT_JOB)).toHaveLength(1);
    await m.maintenance.emergencyAlert(c.companyId, job.id);
    await m.maintenance.emergencyAlert(c.companyId, job.id);
    const alerts = (await queued(c.companyId)).filter((q) => q.purpose === 'maintenance_alert');
    const people = new Set(alerts.map((a) => a.recipient.personId));
    expect(people.has(c.caretakerA.personId)).toBe(true);
    expect(people.has(c.manager.personId)).toBe(true);
    expect(people.has(c.caretakerB.personId)).toBe(false);
    for (const p of people) {
      const theirs = alerts.filter((a) => a.recipient.personId === p);
      expect(theirs.map((a) => a.channels.join()).sort()).toEqual(['sms', 'whatsapp']);
    }
    const detail = await m.maintenance.get(c.manager, job.id);
    expect(detail.events.filter((e) => e.kind === 'alerted')).toHaveLength(people.size);
  });

  it('warns once per target and stage as a target nears and is missed, and closes work done after the quiet days', async () => {
    const c = await setup('SLA Agency', 'MSA');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      description: 'No power in the block',
      category: 'electrical',
      priority: 'emergency',
      uploadIds: [],
      messageIds: [],
    });
    const startedAt = ctx.clock.now();
    ctx.clock.advance(1.6 * HOUR);
    expect(await m.maintenance.slaCheck(c.companyId)).toBe(1);
    expect(await m.maintenance.slaCheck(c.companyId)).toBe(0);
    ctx.clock.advance(0.5 * HOUR);
    expect(await m.maintenance.slaCheck(c.companyId)).toBe(1);
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'staff', personId: c.caretakerA.personId },
    });
    await m.maintenance.start(c.caretakerA, job.id, { uploadIds: [], beforePhotoReason: 'Urgent' });
    await m.maintenance.complete(c.caretakerA, job.id, {
      uploadIds: [await jpegUpload(c.caretakerA)],
      completionNote: 'Fuse replaced',
    });
    ctx.clock.advance(7 * 24 * HOUR);
    expect(await m.maintenance.autoClose(c.companyId)).toBeGreaterThanOrEqual(1);
    const closed = await m.maintenance.get(c.manager, job.id);
    expect(closed.status).toBe('closed');
    expect(closed.events.some((e) => e.kind === 'auto_closed')).toBe(true);
    // Every test makes its own data: the clock goes back for the others.
    ctx.clock.set(startedAt);
  });
});

describe('MI-04 the artisan’s job sheet (decision 6)', () => {
  it('★ serves one artisan and one job, completes only with the one-time code, and stops working when the job closes', async () => {
    const c = await setup('Sheet Agency', 'MSH');
    const artisan = await m.artisans.create(c.manager, {
      name: 'Kofi Plumber',
      phone: '0244111222',
      trades: ['plumbing'],
      consent: { whatsapp: true, sms: true },
    });
    expect(artisan.consent).toEqual({ whatsapp: true, sms: true });
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'Blocked drain',
      category: 'plumbing',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'artisan', artisanId: artisan.id },
    });
    const sheet = (await queued(c.companyId)).find((q) => q.purpose === 'job_sheet_link')!;
    expect(sheet).toMatchObject({
      recipient: { type: 'artisan', artisanId: artisan.id },
      link: { purpose: 'job_sheet', targetId: job.id },
    });
    // The link is made as the message is sent, on the artisan's consented channel; only its hash
    // is stored, and the message as recorded never holds it.
    registerMaintenanceRecipients(s.messaging, m.artisans, m.sheets);
    await deliverMessages(ctx, s, c.companyId);
    const text = s.sms.sent.find((x) => x.to === '+233244111222')!.body;
    const token = /\/j\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;
    const [stored] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ body: schema.message.body })
          .from(schema.message)
          .where(sql`id = ${sheet.messageId}`),
    );
    expect(stored!.body).not.toContain(token);
    const opened = await m.sheets.open(token, client);
    expect(opened).toMatchObject({ screen: 'sheet', actions: { accept: true } });
    // The sheet never shows the tenant's own phone.
    expect(JSON.stringify(opened)).not.toContain('233200000555');
    await m.sheets.respond(token, client, { response: 'accepted' });
    await m.sheets.start(token, client, {
      uploadIds: [],
      beforePhotoReason: 'Blocked, no photo possible',
    });
    const sent = await m.sheets.sendCode(token, client);
    expect(sent.destinationMasked).toContain('1222');
    const code = /\b(\d{6})\b/.exec(s.sms.sent.at(-1)!.body)![1]!;
    const upload = await m.sheets.createUpload(token, client, {
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    await putUpload(ctx, upload, 'image/jpeg', JPEG);
    await expect(
      m.sheets.complete(token, client, {
        code: code === '000000' ? '111111' : '000000',
        uploadIds: [upload.uploadId],
        completionNote: 'Cleared the drain',
      }),
    ).rejects.toMatchObject({ code: 'code_wrong' });
    const done = await m.sheets.complete(token, client, {
      code,
      uploadIds: [upload.uploadId],
      completionNote: 'Cleared the drain',
    });
    expect(done.screen).toBe('done');
    await m.maintenance.recordResponse(c.manager, job.id, { response: 'confirmed' });
    expect((await m.sheets.open(token, client)).screen).toBe('closed');
    await expect(m.sheets.respond(token, client, { response: 'declined' })).rejects.toMatchObject({
      status: 410,
    });
  });
});

describe('MI-01 a repair from the tenant app', () => {
  it('makes one job however often the app sends the same request', async () => {
    const c = await setup('App Agency', 'MAP');
    const input = {
      leaseId: c.lease.id,
      tenantId: c.tenant.id,
      personId: c.manager.personId,
      clientId: '0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e6f',
      category: 'electrical' as const,
      description: 'The socket sparks',
      emergency: true,
      media: [],
    };
    const first = await m.maintenance.tenantReport(c.companyId, input);
    const again = await m.maintenance.tenantReport(c.companyId, input);
    expect(again.jobId).toBe(first.jobId);
    // Flagged an emergency with its category: emergency at once, so triaged (decision 5).
    expect(first).toMatchObject({ emergency: true, forwarded: false, status: 'triaged' });
    const jobs = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.maintenanceJob)
          .where(sql`client_id = ${input.clientId}`),
    );
    expect(jobs).toHaveLength(1);
  });
});

describe('MI-01 and TL-12 a tenant sees the files of their own repairs in the app (0042)', () => {
  it('lists and serves the report, before and after files of the tenant’s own job, never a staff file or another tenant’s job', async () => {
    const c = await setup('Files Agency', 'MFI');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      unitId: c.units[0]!,
      description: 'The window is cracked',
      category: 'other',
      priority: 'routine',
      uploadIds: [await jpegUpload(c.manager)],
      messageIds: [],
    });
    await m.maintenance.addMedia(c.manager, job.id, {
      stage: 'before',
      uploadIds: [await jpegUpload(c.manager)],
    });
    await m.maintenance.addMedia(c.manager, job.id, {
      stage: 'other',
      uploadIds: [await jpegUpload(c.manager)],
    });
    const staffView = await m.maintenance.get(c.manager, job.id);
    expect(staffView.attachments.map((a) => a.stage).sort()).toEqual(['before', 'other', 'report']);
    const staffFile = staffView.attachments.find((a) => a.stage === 'other')!;
    const tenantActor = async (tenantId: string) => {
      const [row] = await withCompany(
        ctx.database,
        { companyId: c.companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ personId: schema.tenant.personId })
            .from(schema.tenant)
            .where(sql`${schema.tenant.id} = ${tenantId}`),
      );
      return {
        kind: 'tenant' as const,
        personId: row!.personId!,
        authMethod: 'phone_otp' as const,
      };
    };
    const repairsOf = async (actor: Awaited<ReturnType<typeof tenantActor>>) =>
      (await m.tenantRepairs.list(actor))
        .filter((g) => g.landlord.companyId === c.companyId)
        .flatMap((g) => g.repairs);

    const mine = await tenantActor(c.tenant.id);
    const repair = (await repairsOf(mine)).find((r) => r.jobId === job.id)!;
    expect(repair.attachments.map((a) => a.stage).sort()).toEqual(['before', 'report']);
    for (const file of repair.attachments)
      await expect(m.tenantRepairs.attachmentUrl(mine, job.id, file.id)).resolves.toMatchObject({
        url: expect.any(String),
      });
    await expect(m.tenantRepairs.attachmentUrl(mine, job.id, staffFile.id)).rejects.toMatchObject({
      status: 404,
    });

    // Another tenant of the same landlord sees neither the job nor its files.
    const { tenant: neighbour } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: 'Files Agency neighbour',
      phone: '+233200000556',
    });
    const start = toIsoDate(addMonths(parseBusinessDate(today), -1));
    await billedLease(ctx, s, b, c.manager, {
      unitId: c.units[1]!,
      tenantId: neighbour.id,
      startDate: start,
      endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(start), 12)), -1),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    const theirs = await tenantActor(neighbour.id);
    expect((await repairsOf(theirs)).map((r) => r.jobId)).not.toContain(job.id);
    await expect(
      m.tenantRepairs.attachmentUrl(theirs, job.id, repair.attachments[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('MI-10 and TL-08 inspections and the move-in report', () => {
  it('freezes a submitted inspection and opens the move-in report for every party', async () => {
    const c = await setup('Inspect Agency', 'MIN');
    const started = await m.inspections.start(c.manager, {
      unitId: c.units[0]!,
      kind: 'move_in',
      leaseId: c.lease.id,
    });
    expect(started.items.length).toBeGreaterThan(5);
    await expect(m.inspections.submit(c.manager, started.id)).rejects.toMatchObject({
      status: 400,
    });
    for (const item of started.items)
      await m.inspections.updateItem(c.manager, started.id, item.id, { condition: 'good' });
    const submitted = await m.inspections.submit(c.manager, started.id);
    expect(submitted.status).toBe('submitted');
    await expect(
      m.inspections.updateItem(c.manager, started.id, started.items[0]!.id, { condition: 'poor' }),
    ).rejects.toMatchObject({ code: 'inspection_submitted' });
    expect(await outboxOf(ctx, c.companyId, INSPECTION_RENDER_REPORT_JOB)).toHaveLength(1);
    expect(await m.reports.render(c.companyId, started.id, c.manager.personId)).toBe(true);
    expect(await m.reports.render(c.companyId, started.id, c.manager.personId)).toBe(false);
    const report = await m.reports.forLease(c.manager, c.lease.id);
    expect(report.status).toBe('rendering');
    expect(report.signers.length).toBeGreaterThanOrEqual(1);
    // A move-out inspection pairs each item with its move-in result.
    const out = await m.inspections.start(c.manager, {
      unitId: c.units[0]!,
      kind: 'move_out',
      leaseId: c.lease.id,
    });
    expect(out.moveInInspectionId).toBe(started.id);
    expect(out.items[0]!.moveIn?.condition).toBe('good');
  });
});

describe('AC-03 expenses (P15)', () => {
  it('posts an unpaid expense to 2500, its payment from 1010, and a reversal of both', async () => {
    const c = await setup('Expense Agency', 'MEX');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.property,
      description: 'Roof leak',
      category: 'roofing',
      priority: 'urgent',
      uploadIds: [],
      messageIds: [],
    });
    const sum = async (account: string) =>
      withCompany(ctx.database, { companyId: c.companyId, actorKind: 'system' }, async (tx) =>
        Number(
          (
            await tx.execute<{ n: string }>(
              sql`select coalesce(sum(amount_minor), 0)::bigint as n from journal_line where account_code = ${account} and property_id = ${c.property}`,
            )
          ).rows[0]!.n,
        ),
      );
    const { expenseId } = await m.expenses.record(c.accountant, {
      propertyId: c.property,
      category: 'repairs',
      supplierName: 'Ama Roofing',
      amountMinor: 12_000,
      expenseDate: today,
      paidBy: 'unpaid',
      jobId: job.id,
    });
    expect(await sum('5000')).toBe(12_000);
    expect(await sum('2500')).toBe(-12_000);
    expect((await m.maintenance.get(c.manager, job.id)).costMinor).toBe(12_000);
    await m.expenses.pay(c.accountant, expenseId, { paidOn: today, paidFrom: 'owner_account' });
    expect(await sum('2500')).toBe(0);
    expect(await sum('1010')).toBe(-12_000);
    const reversed = await m.expenses.reverse(
      c.accountant,
      expenseId,
      'Recorded on the wrong property',
    );
    expect((await m.expenses.get(c.accountant, reversed.expenseId)).status).toBe('reversed');
    expect(await sum('5000')).toBe(0);
    expect(await sum('1010')).toBe(0);
    expect((await m.maintenance.get(c.manager, job.id)).costMinor).toBe(0);
    await expect(
      m.expenses.pay(c.accountant, expenseId, { paidOn: today, paidFrom: 'owner_account' }),
    ).rejects.toMatchObject({ status: 409 });
    void leaseAccount;
  });
});

describe('MI-06 and TL-11 the database keeps the domain’s machines and templates', () => {
  it('has the same job and move-out moves as the domain, and every M8 template as defined', async () => {
    const [row] = await runSql<{ jobs: string[]; moves: string[] }>(
      ctx.db.superuserUrl,
      'select app.maintenance_job_moves() as jobs, app.move_out_moves() as moves',
    );
    expect(new Set(row!.jobs)).toEqual(
      new Set(MAINTENANCE_JOB_TRANSITIONS.map(([from, to]) => `${from}>${to}`)),
    );
    const actions: MoveOutAction[] = [
      'inspect',
      'draft',
      'submit',
      'return',
      'approve',
      'pay_refund',
      'close',
      'cancel',
    ];
    const domain = new Set<string>();
    for (const from of MOVE_OUT_STATUSES)
      for (const action of actions) {
        try {
          const to = nextMoveOutStatus(from, action);
          if (to !== from) domain.add(`${from}>${to}`);
        } catch {
          // not a move
        }
      }
    expect(new Set(row!.moves)).toEqual(domain);
    const templates = await runSql<{ key: string; body: string; whatsapp_name: string }>(
      ctx.db.superuserUrl,
      "select key, body, whatsapp_name from message_template where key in ('maintenance_alert', 'job_sheet_link', 'repair_update', 'final_statement_ready')",
    );
    for (const t of templates) {
      const d = TEMPLATE_DEFINITIONS.find((x) => x.key === t.key)!;
      expect({ body: t.body, name: t.whatsapp_name }).toEqual({
        body: d.body,
        name: d.whatsappName,
      });
    }
    expect(templates).toHaveLength(4);
  });
});
