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
import { CODE_LOCKOUTS_BEFORE_REVOKE, SIGNING_CODE } from '@rent/domain/esign';
import type { ObjectRef } from '@rent/integrations';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INSPECTION_PHOTO_UPLOAD,
  JOB_MEDIA_UPLOAD,
  MESSAGE_PHOTO_UPLOAD,
} from '../src/documents/documents.service';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { registerMaintenanceRecipients } from '../src/messaging/maintenance-recipients';
import { PAY_LINK_DAYS } from '@rent/domain/payments';
import { tokenHash } from '../src/esign/secrets';
import { RECEIPT_LINK_DAYS } from '../src/payments/receipts.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  JPEG,
  maintenanceServices,
  outboxOf,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import {
  issueReceipts,
  paymentsServices,
  sendQueued,
  type PaymentsServices,
} from './support/payments';
import { taxServices } from './support/tax';
import {
  deliverMessages,
  propertyWithUnits,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M11 security review's findings in the backend's files (reviewer 3: F3, F7, F9, F10), each
 * against the real database. F5 is in packages/integrations (storage-m11.test.ts) and the scan
 * tests; F11 in the domain (tax/m11-csv.test.ts); F7 for signing links in
 * m11-signing-lockout.int.test.ts.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let p: PaymentsServices;
let today: string;
let seq = 0;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const client = () => ({ ip: `203.0.113.${100 + (seq += 1)}`, userAgent: 'test' });
const phone = () => `+2332008${String((seq += 1)).padStart(5, '0')}`;
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

/** A company with an owner, units and a tenant on a billed monthly lease. */
async function setup(name: string, part: string, tenantOptions: { consent?: boolean } = {}) {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const units = Object.values(property.units);
  const tenantPhone = phone();
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `${name} tenant`,
    phone: tenantPhone,
    ...(tenantOptions.consent ? { consent: { sms: true } } : {}),
  });
  const lease = await billedLease(ctx, s, b, c.manager, {
    unitId: units[0]!,
    tenantId: tenant.id,
    startDate: today,
    endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(today), 12)), -1),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: plusDays(today, -1),
    billingStartDate: today,
  });
  return { ...c, ownerId, propertyId: property.propertyId, units, tenant, tenantPhone, lease };
}

/** A real JPEG carrying EXIF (the camera's make) and a GPS position, as a phone writes it. */
async function photoWithLocation(): Promise<Buffer> {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: '#4a7' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestPhoneMaker' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '5/1 36/1 12/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 11/1 30/1',
      },
    })
    .toBuffer();
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = maintenanceServices(ctx, s, b, taxServices(ctx, s, b));
  p = paymentsServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await ctx?.close();
});

describe('NFR-SEC M11 review R3 F3: media staging reads only the version it checked', () => {
  it('a second POST to the same presigned upload, after the check, never becomes the evidence copy', async () => {
    const c = await setup('F3 Pin', 'FTP');
    const staff = {
      companyId: c.companyId,
      personId: c.manager.personId,
      actorKind: 'staff' as const,
    };
    const upload = await s.documents.createMediaUpload(
      staff,
      c.manager.personId,
      INSPECTION_PHOTO_UPLOAD,
      {
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
      },
    );
    const key = upload.fields.key!;
    await putUpload(ctx, upload, 'image/jpeg', JPEG);
    // Same size and type, different bytes: swapped in right after the first HEAD saw the original.
    const swapped = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(JPEG.length - 4, 9)]);
    const head = ctx.storage.head.bind(ctx.storage);
    let swaps = 0;
    const spy = vi.spyOn(ctx.storage, 'head').mockImplementation(async (ref: ObjectRef) => {
      const info = await head(ref);
      if (ref.key === key && !ref.versionId && swaps === 0) {
        swaps += 1;
        await ctx.storage.put({
          bucket: ctx.config.S3_BUCKET_FILES,
          key,
          body: swapped,
          contentType: 'image/jpeg',
        });
      }
      return info;
    });
    try {
      const staged = await s.documents.stageMediaUpload(
        staff,
        c.manager.personId,
        upload.uploadId,
        INSPECTION_PHOTO_UPLOAD,
      );
      expect(swaps).toBe(1);
      expect(staged.sha256).toBe(sha256(JPEG));
      const stored = await ctx.storage.get({
        bucket: ctx.config.S3_BUCKET_EVIDENCE,
        key: staged.storageKey,
        versionId: staged.storageVersionId,
      });
      expect(stored.equals(JPEG)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('MI-04 NFR-SEC M11 review R3 F7: a job-sheet link is revoked after three code lockouts', () => {
  it('★ keeps a running total of wrong codes across lockouts, revokes the link at the third, and tells staff', async () => {
    const c = await setup('F7 Sheet', 'FTS');
    const job = await m.maintenance.logRepair(c.manager, {
      propertyId: c.propertyId,
      unitId: c.units[0]!,
      description: 'Tap will not close',
      category: 'plumbing',
      priority: 'routine',
      uploadIds: [],
      messageIds: [],
    });
    const artisan = await m.artisans.create(c.manager, {
      name: 'Lockout Plumber',
      phone: '0244777888',
      trades: ['plumbing'],
      consent: { whatsapp: false, sms: true },
    });
    await m.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'artisan', artisanId: artisan.id },
    });
    registerMaintenanceRecipients(s.messaging, m.artisans, m.sheets);
    await deliverMessages(ctx, s, c.companyId);
    const sms = () => s.sms.sent.filter((x) => x.to === '+233244777888');
    const token = /\/j\/([A-Za-z0-9_-]{43})/.exec(sms().at(-1)!.body)![1]!;
    const who = client();
    await m.sheets.respond(token, who, { response: 'accepted' });
    await m.sheets.start(token, who, { uploadIds: [], beforePhotoReason: 'No light' });
    const attempt = (code: string) =>
      m.sheets.complete(token, who, { code, uploadIds: [], completionNote: 'Fixed' });
    const advanced: number[] = [];
    try {
      for (let lockout = 1; lockout <= CODE_LOCKOUTS_BEFORE_REVOKE; lockout += 1) {
        await m.sheets.sendCode(token, who);
        const code = /\b(\d{6})\b/.exec(sms().at(-1)!.body)![1]!;
        const wrong = code === '000000' ? '111111' : '000000';
        for (let i = 1; i < SIGNING_CODE.maxAttempts; i += 1)
          await expect(attempt(wrong)).rejects.toMatchObject({ code: 'code_wrong' });
        if (lockout < CODE_LOCKOUTS_BEFORE_REVOKE) {
          await expect(attempt(wrong)).rejects.toMatchObject({ code: 'code_locked' });
          // The lock lifts after 30 minutes; the failures are not forgotten.
          ctx.clock.advance((SIGNING_CODE.lockMinutes + 1) * MINUTE);
          advanced.push((SIGNING_CODE.lockMinutes + 1) * MINUTE);
        } else {
          await expect(attempt(wrong)).rejects.toMatchObject({
            status: 410,
            code: 'job_sheet_revoked',
          });
        }
      }
      // The link is dead, and even the right code is refused now.
      expect((await m.sheets.open(token, who)).screen).toBe('revoked');
      await expect(m.sheets.sendCode(token, who)).rejects.toMatchObject({ status: 410 });
      const [link] = await system(c.companyId, (tx) =>
        tx
          .select()
          .from(schema.secureLink)
          .where(sql`${schema.secureLink.jobId} = ${job.id} and purpose = 'job_sheet'`),
      );
      expect(link).toMatchObject({ revokeReason: 'code_lockout', codeLockedUntil: null });
      // Whoever assigned the artisan is told, so they can send the job sheet again.
      const notices = (await outboxOf(ctx, c.companyId, MESSAGE_SEND_JOB))
        .map((e) => e.payload as { purpose: string; subject: string | null; recipient: unknown })
        .filter(
          (x) =>
            x.purpose === 'staff_notice' && x.subject?.startsWith('A job sheet link was withdrawn'),
        );
      expect(notices).toEqual([
        expect.objectContaining({
          recipient: { type: 'staff', personId: c.manager.personId },
        }),
      ]);
    } finally {
      for (const ms of advanced) ctx.clock.advance(-ms);
    }
  });
});

describe('BC-04 NFR-SEC M11 review R3 F9: a revoked or expired pay link returns only the closed screen', () => {
  it('sends the landlord’s contact and nothing about the tenancy once the link is closed', async () => {
    const c = await setup('F9 Pay', 'FTY');
    const [invoice] = await system(c.companyId, (tx) =>
      tx.select().from(schema.invoice).where(eq(schema.invoice.leaseId, c.lease.id)),
    );
    const mint = async () =>
      (
        await system(c.companyId, async (tx) =>
          p.links.mint(tx, await p.links.invoice(tx, invoice!.id)),
        )
      ).url.split('/p/')[1]!;
    const open = await p.page.open(await mint(), client());
    expect(open.tenantName).toBe(`F9 Pay tenant`);
    const closedFacts = {
      tenantName: '',
      unitCode: '',
      propertyName: '',
      paymentReference: '',
      invoiceNumber: '',
      dueNowMinor: 0,
      paidUntil: null,
      partial: null,
      amounts: { prefillMinor: 0, minMinor: 0, maxMinor: 0 },
      methods: [],
      advance: null,
      latest: null,
    };
    const revokedToken = await mint();
    // A newer link replaced it (the links module revokes the older one as `superseded`).
    await asSuperuser(
      ctx,
      `update secure_link set revoked_at = now(), revoke_reason = 'superseded' where token_hash = $1`,
      [tokenHash(revokedToken)],
    );
    const revoked = await p.page.open(revokedToken, client());
    expect(revoked).toMatchObject({ screen: 'revoked', ...closedFacts });
    expect(revoked.landlord.name).toBeTruthy();

    const expiring = await mint();
    ctx.clock.advance((PAY_LINK_DAYS + 1) * DAY);
    try {
      const expired = await p.page.open(expiring, client());
      expect(expired).toMatchObject({ screen: 'expired', ...closedFacts });
      expect(JSON.stringify(expired)).not.toContain('F9 Pay tenant');
    } finally {
      ctx.clock.advance(-(PAY_LINK_DAYS + 1) * DAY);
    }
  });
});

describe('BC-06 NFR-SEC M11 review R3 F9: an expired or revoked receipt link returns only the closed screen', () => {
  it('keeps the receipt number and the landlord’s contact, and sends nothing about the tenant or the money', async () => {
    const c = await setup('F9 Receipt', 'FTR', { consent: true });
    await approvedCash(ctx, s, b, c.manager, c.admin, {
      leaseId: c.lease.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    await issueReceipts(ctx, p, c.companyId);
    await sendQueued(ctx, s, c.companyId);
    const body = s.sms.sent
      .filter((x) => x.to === c.tenantPhone)
      .find((x) => x.body.includes('/r/'))!.body;
    const token = /\/r\/([A-Za-z0-9_-]{43})/.exec(body)![1]!;
    const live = await p.receipts.open(token, client());
    expect(live).toMatchObject({
      screen: expect.stringMatching(/^(receipt|preparing)$/),
      amountMinor: 100_000,
    });
    ctx.clock.advance((RECEIPT_LINK_DAYS + 1) * DAY);
    try {
      const expired = await p.receipts.open(token, client());
      expect(expired).toMatchObject({
        screen: 'expired',
        receiptNumber: live.receiptNumber,
        amountMinor: 0,
        tenantName: '',
        unitCode: '',
        propertyName: '',
        paidUntil: null,
        downloadable: false,
      });
      expect(expired.landlord.name).toBeTruthy();
      expect(JSON.stringify(expired)).not.toContain('F9 Receipt tenant');
    } finally {
      ctx.clock.advance(-(RECEIPT_LINK_DAYS + 1) * DAY);
    }
  });
});

describe('MI-04 CM-07 NFR-DP M11 review R3 F10: tenants’ and artisans’ photos lose their EXIF and location', () => {
  it('re-encodes a repair photo before the evidence copy, keeps the original’s hash, and removes the original', async () => {
    const c = await setup('F10 Repair', 'FTX');
    const original = await photoWithLocation();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const staff = { companyId: c.companyId, personId: null, actorKind: 'system' as const };
    const uploader = c.manager.personId;
    const upload = await s.documents.createMediaUpload(staff, uploader, JOB_MEDIA_UPLOAD, {
      contentType: 'image/jpeg',
      sizeBytes: original.length,
    });
    await putUpload(ctx, upload, 'image/jpeg', original);
    const staged = await s.documents.stageMediaUpload(
      staff,
      uploader,
      upload.uploadId,
      JOB_MEDIA_UPLOAD,
    );
    const stored = await ctx.storage.get({
      bucket: ctx.config.S3_BUCKET_EVIDENCE,
      key: staged.storageKey,
      versionId: staged.storageVersionId,
    });
    expect(stored.equals(original)).toBe(false);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('TestPhoneMaker'))).toBe(false);
    expect(staged).toMatchObject({
      contentType: 'image/jpeg',
      sha256: sha256(stored),
      sizeBytes: stored.length,
      originalSha256: sha256(original),
    });
    const documentId = await system(c.companyId, (tx) =>
      s.documents.recordStagedMedia(tx, staged, 'maintenance_media'),
    );
    await s.documents.discardStagedMedia(staged);
    // The original, with its location, is gone in every version; the audit names its hash.
    expect(
      await ctx.storage.listVersions({ bucket: ctx.config.S3_BUCKET_FILES, key: staged.uploadKey }),
    ).toEqual([]);
    const [event] = await system(c.companyId, (tx) =>
      tx
        .select({ data: schema.auditEvent.data })
        .from(schema.auditEvent)
        .where(
          sql`${schema.auditEvent.recordId} = ${documentId} and ${schema.auditEvent.action} = 'document.stored'`,
        ),
    );
    expect(event!.data).toMatchObject({ sha256: sha256(stored), originalSha256: sha256(original) });
  });

  it('re-encodes a photo a tenant sends in the app’s conversation', async () => {
    const c = await setup('F10 Message', 'FTM');
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
    expect((await sharp(staged.bytes).metadata()).exif).toBeUndefined();
    expect(staged.originalSha256).toBe(sha256(original));
    const stored = await ctx.storage.get({
      bucket: ctx.config.S3_BUCKET_EVIDENCE,
      key: staged.storageKey,
      versionId: staged.storageVersionId,
    });
    expect(stored.equals(staged.bytes)).toBe(true);
  });

  it('keeps a staff inspection photo as it came (its location is the inspection’s evidence)', async () => {
    const c = await setup('F10 Inspection', 'FTI');
    const original = await photoWithLocation();
    const staff = {
      companyId: c.companyId,
      personId: c.manager.personId,
      actorKind: 'staff' as const,
    };
    const upload = await s.documents.createMediaUpload(
      staff,
      c.manager.personId,
      INSPECTION_PHOTO_UPLOAD,
      {
        contentType: 'image/jpeg',
        sizeBytes: original.length,
      },
    );
    await putUpload(ctx, upload, 'image/jpeg', original);
    const staged = await s.documents.stageMediaUpload(
      staff,
      c.manager.personId,
      upload.uploadId,
      INSPECTION_PHOTO_UPLOAD,
    );
    expect(staged).toMatchObject({ sha256: sha256(original), originalSha256: null });
  });
});
