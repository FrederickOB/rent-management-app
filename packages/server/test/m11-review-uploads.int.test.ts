import { createHash } from 'node:crypto';
import { eq, schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_PHOTO_UPLOAD } from '../src/documents/documents.service';
import { tokenHash } from '../src/esign/secrets';
import { registerMaintenanceRecipients } from '../src/messaging/maintenance-recipients';
import { DocumentScansService } from '../src/tenancy/document-scans.service';
import { startServerTest, type ServerTestContext } from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import {
  JPEG,
  maintenanceServices,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import {
  messagingServices,
  platform,
  receive,
  SHARED_NUMBER,
  SHARED_WABA,
  whatsappNumber,
  work,
  type MessagingServices,
} from './support/messaging';
import { taxServices } from './support/tax';
import {
  deliverMessages,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M11 review round's upload fixes against the real database:
 * - founder decision 1: a photo re-encoded before it is stored (F10) records the original's
 *   SHA-256 and byte count on its document and in its audit event, and the staff attachment
 *   details show them, so the original is shown to have arrived whole;
 * - B13: the job sheet's check answers whether the sheet is live and records nothing;
 * - the scan status follows property scope (AD-02).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let msg: MessagingServices;
let scans: DocumentScansService;
let today: string;
let seq = 0;
const DAY = 24 * 60 * 60_000;
const client = () => ({ ip: `203.0.113.${150 + (seq += 1)}`, userAgent: 'test' });
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A real JPEG with EXIF and a GPS position, as a phone writes it. */
const photoWithLocation = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#357' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'ReviewPhoneMaker' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '5/1 34/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 13/1 0/1',
      },
    })
    .toBuffer();

/** An agency with two properties, a manager, an admin and a caretaker on the first only. */
async function agency(name: string, parts: [string, string]) {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const first = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: parts[0],
    ownerId,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const second = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: parts[1],
    ownerId,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', `${name} caretaker`, {
    properties: [first.propertyId],
  });
  return { ...c, ownerId, first, second, caretaker };
}

const documentRow = async (companyId: string, documentId: string) =>
  (
    await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx: Tx) =>
      tx.select().from(schema.document).where(eq(schema.document.id, documentId)),
    )
  )[0]!;

const storedEvent = async (companyId: string, documentId: string) =>
  (
    await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx: Tx) =>
      tx
        .select({ data: schema.auditEvent.data })
        .from(schema.auditEvent)
        .where(
          sql`${schema.auditEvent.recordId} = ${documentId} and ${schema.auditEvent.action} = 'document.stored'`,
        ),
    )
  )[0]!.data as Record<string, unknown>;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = maintenanceServices(ctx, s, b, taxServices(ctx, s, b));
  msg = messagingServices(ctx, s, b);
  scans = new DocumentScansService(ctx.database, s.policy, s.documents);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  await whatsappNumber(ctx, msg, await platform(ctx), {
    phoneNumberId: SHARED_NUMBER,
    wabaId: SHARED_WABA,
    kind: 'shared',
    companyId: null,
    name: 'Rent Platform',
  });
});

afterAll(async () => {
  await msg?.stream.onModuleDestroy();
  await ctx?.close();
});

describe('MI-04 NFR-DP founder decision (review round): a re-encoded photo keeps the original’s hash and size', () => {
  it('★ records them on the document and its audit event, and the staff attachment details show them', async () => {
    const c = await agency('Original Repair', ['ORA', 'ORB']);
    const original = await photoWithLocation();
    const photo = await m.maintenance.createUpload(c.manager, {
      contentType: 'image/jpeg',
      sizeBytes: original.length,
    });
    const fixture = await m.maintenance.createUpload(c.manager, {
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.first.propertyId,
      unitId: Object.values(c.first.units)[0]!,
      description: 'Damp in the corner',
      category: 'other',
      priority: 'routine',
      uploadIds: [
        await putUpload(ctx, photo, 'image/jpeg', original),
        await putUpload(ctx, fixture, 'image/jpeg', JPEG),
      ],
      messageIds: [],
    });
    const detail = await m.maintenance.get(c.manager, job.id);
    const originals = detail.attachments
      .map((a) => a.original)
      .sort((x, y) => (x ? -1 : y ? 1 : 0));
    // The real photo was re-encoded: its original is shown. The fixture does not decode, so it is
    // stored as it came, and has no original apart from itself.
    expect(originals).toEqual([{ sha256: sha256(original), bytes: original.length }, null]);
    const reencoded = detail.attachments.find((a) => a.original)!;
    expect(reencoded.sizeBytes).not.toBe(original.length);
    const [attachment] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ documentId: schema.maintenanceJobAttachment.documentId })
          .from(schema.maintenanceJobAttachment)
          .where(eq(schema.maintenanceJobAttachment.id, reencoded.id)),
    );
    const doc = await documentRow(c.companyId, attachment!.documentId);
    expect(doc).toMatchObject({ originalSha256: sha256(original), originalBytes: original.length });
    expect(doc.sha256).not.toBe(sha256(original));
    expect(await storedEvent(c.companyId, doc.id)).toMatchObject({
      sha256: doc.sha256,
      originalSha256: sha256(original),
      originalBytes: original.length,
    });
  });

  it('records them for a photo sent in the app’s conversation and for one sent by WhatsApp', async () => {
    const c = await agency('Original Message', ['OMA', 'OMB']);
    const original = await photoWithLocation();
    const who = { companyId: c.companyId, personId: c.manager.personId };
    const upload = await s.documents.createUpload(
      who,
      MESSAGE_PHOTO_UPLOAD,
      'image/jpeg',
      original.length,
    );
    await putUpload(ctx, upload, 'image/jpeg', original);
    const staged = await s.documents.stageEvidenceUpload(
      who,
      upload.uploadId,
      MESSAGE_PHOTO_UPLOAD,
    );
    expect(staged).toMatchObject({
      originalSha256: sha256(original),
      originalBytes: original.length,
    });
    const evidenceId = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) => s.documents.recordStagedEvidence(tx, staged, 'message_media'),
    );
    expect(await documentRow(c.companyId, evidenceId)).toMatchObject({
      originalSha256: sha256(original),
      originalBytes: original.length,
    });
    expect(await storedEvent(c.companyId, evidenceId)).toMatchObject({
      originalSha256: sha256(original),
      originalBytes: original.length,
    });

    // WhatsApp: a tenant with consent on a lease sends the photo.
    const { tenant } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: 'Original WhatsApp tenant',
      phone: '+233200075001',
    });
    await msg.consent.record(c.manager, tenant.id, { channel: 'whatsapp', action: 'grant' });
    await s.leases.recordPaper(c.manager, {
      unitId: Object.values(c.first.units)[0]!,
      tenantId: tenant.id,
      startDate: today,
      endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(today), 12)), -1),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
      signedOn: today,
      parties: [{ role: 'tenant', name: 'Tenant' }],
      scanUploadId: await uploadLeaseFile(ctx, s, c.manager),
    });
    const hook = await msg.whatsapp.simulateInbound({
      from: '+233200075001',
      text: 'The crack',
      phoneNumberId: SHARED_NUMBER,
      media: { contentType: 'image/jpeg', bytes: original },
    });
    await receive(ctx, msg, 'whatsapp', hook.rawBody, hook.signature);
    await work(ctx, msg, c.companyId);
    const [inbound] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ documentId: schema.messageAttachment.documentId })
          .from(schema.messageAttachment)
          .where(sql`${schema.messageAttachment.documentId} is not null`),
    );
    expect(await documentRow(c.companyId, inbound!.documentId!)).toMatchObject({
      originalSha256: sha256(original),
      originalBytes: original.length,
    });
    expect(await storedEvent(c.companyId, inbound!.documentId!)).toMatchObject({
      originalSha256: sha256(original),
      originalBytes: original.length,
    });
  });
});

describe('MI-04 NFR-SEC M11 review B13: the job sheet check answers live or not, and records nothing', () => {
  it('★ is live for a working sheet, not for a revoked, closed or expired one, and never counts an open', async () => {
    const c = await agency('Sheet Check', ['SCA', 'SCB']);
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.first.propertyId,
      unitId: Object.values(c.first.units)[0]!,
      description: 'Door will not lock',
      category: 'other',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    const assign = async (phone: string) => {
      const artisan = await m.artisans.create(c.manager, {
        name: `Check artisan ${phone.slice(-3)}`,
        phone,
        trades: ['other'],
        consent: { whatsapp: false, sms: true },
      });
      await m.maintenance.assign(c.manager, job.id, {
        assignee: { kind: 'artisan', artisanId: artisan.id },
      });
      registerMaintenanceRecipients(s.messaging, m.artisans, m.sheets);
      await deliverMessages(ctx, s, c.companyId);
      const text = s.sms.sent.filter((x) => x.to === `+233${phone.slice(1)}`).at(-1)!.body;
      return /\/j\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;
    };
    const link = async (token: string) => {
      const [row] = await withCompany(
        ctx.database,
        { companyId: c.companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select()
            .from(schema.secureLink)
            .where(eq(schema.secureLink.tokenHash, tokenHash(token))),
      );
      return row!;
    };
    const first = await assign('0244600601');
    expect(await m.sheets.check(first, client())).toEqual({ live: true });
    expect(await m.sheets.check(first, client())).toEqual({ live: true });
    // Nothing is recorded: no open, no open count.
    expect(await link(first)).toMatchObject({
      openCount: 0,
      firstOpenedAt: null,
      lastOpenedAt: null,
    });

    // Expired: past its 30 days.
    ctx.clock.advance(31 * DAY);
    try {
      expect(await m.sheets.check(first, client())).toEqual({ live: false });
    } finally {
      ctx.clock.advance(-31 * DAY);
    }
    // Revoked: the job moves to another artisan.
    await m.maintenance.unassign(c.manager, job.id, 'Not available');
    expect(await m.sheets.check(first, client())).toEqual({ live: false });
    const second = await assign('0244600602');
    expect(await m.sheets.check(second, client())).toEqual({ live: true });
    // Closed: the job is cancelled.
    await m.maintenance.unassign(c.manager, job.id, 'Fixed by the owner');
    await m.maintenance.cancel(c.manager, job.id, 'Fixed by the owner');
    expect(await m.sheets.check(second, client())).toEqual({ live: false });
    expect(await link(second)).toMatchObject({ openCount: 0, firstOpenedAt: null });
    await expect(m.sheets.check('Q'.repeat(43), client())).rejects.toMatchObject({ status: 404 });
  });
});

describe('AD-02 NFR-SEC the scan status follows property scope (M11 review)', () => {
  it('★ shows a scoped caretaker only documents of their properties, or their own uploads', async () => {
    const c = await agency('Scan Scope', ['SSA', 'SSB']);
    const lease = async (unitId: string, name: string) => {
      const { tenant } = await s.tenants.create(c.manager, {
        kind: 'individual',
        displayName: name,
      });
      const start = toIsoDate(addMonths(parseBusinessDate(today), -1));
      const recorded = await s.leases.recordPaper(c.manager, {
        unitId,
        tenantId: tenant.id,
        startDate: start,
        endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(start), 12)), -1),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        noticeDays: 30,
        signedOn: plusDays(start, -1),
        parties: [{ role: 'tenant', name: 'Tenant' }],
        scanUploadId: await uploadLeaseFile(ctx, s, c.manager),
      });
      const [row] = await withCompany(
        ctx.database,
        { companyId: c.companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ documentId: schema.lease.signedDocumentId })
            .from(schema.lease)
            .where(eq(schema.lease.id, recorded.id)),
      );
      return row!.documentId!;
    };
    const inScope = await lease(Object.values(c.first.units)[0]!, 'Scope tenant in');
    const outOfScope = await lease(Object.values(c.second.units)[0]!, 'Scope tenant out');
    // The whole company's manager sees both.
    expect(await scans.status(c.manager, inScope)).toMatchObject({ status: 'clean' });
    expect(await scans.status(c.manager, outOfScope)).toMatchObject({ status: 'clean' });
    // The caretaker of the first property sees its lease scan, not the second's.
    expect(await scans.status(c.caretaker, inScope)).toMatchObject({ status: 'clean' });
    await expect(scans.status(c.caretaker, outOfScope)).rejects.toMatchObject({ status: 404 });
    // Their own upload, on their property, they see.
    const upload = await m.maintenance.createUpload(c.caretaker, {
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    const job = await m.maintenance.logRepair(c.caretaker, {
      propertyId: c.first.propertyId,
      unitId: Object.values(c.first.units)[1]!,
      description: 'Broken louvre',
      category: 'other',
      priority: 'routine',
      uploadIds: [await putUpload(ctx, upload, 'image/jpeg', JPEG)],
      messageIds: [],
    });
    const [photo] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ documentId: schema.maintenanceJobAttachment.documentId })
          .from(schema.maintenanceJobAttachment)
          .where(eq(schema.maintenanceJobAttachment.jobId, job.id)),
    );
    expect(await scans.status(c.caretaker, photo!.documentId)).toMatchObject({ status: 'clean' });
  });
});
