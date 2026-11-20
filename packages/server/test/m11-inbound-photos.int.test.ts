import { createHash } from 'node:crypto';
import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueMessage } from '../src/core/messages';
import { UPLOADS_SCAN_JOB } from '../src/documents/documents.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { outboxOf } from './support/maintenance';
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
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * M11 security review R3 F10 for inbound media: a photo a tenant sends by WhatsApp or email is
 * re-encoded before it is stored, so its EXIF and GPS position are gone; the audit event keeps the
 * original's hash. The stored copy is what the attachment records, and it is scanned as an upload
 * (M11 decision 6).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MessagingServices;
let today: string;
let company: Awaited<ReturnType<typeof moneyCompany>> & { units: string[] };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const system = <T>(fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId: company.companyId, actorKind: 'system' }, fn);

/** A real JPEG with EXIF (the camera's make) and a GPS position, as a phone writes it. */
const photoWithLocation = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#a63' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'InboundPhoneMaker' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '5/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 12/1 0/1',
      },
    })
    .toBuffer();

/** A tenant on a lease, with consent on the channels asked for. */
async function tenant(input: { phone?: string; email?: string }, unit: number) {
  const { tenant: t } = await s.tenants.create(company.manager, {
    kind: 'individual',
    displayName: `Inbound photo tenant ${unit}`,
    ...input,
  });
  if (input.phone)
    await m.consent.record(company.manager, t.id, { channel: 'whatsapp', action: 'grant' });
  if (input.email)
    await s.tenants.recordConsent(company.manager, t.id, { channel: 'email', action: 'grant' });
  await billedLease(ctx, s, b, company.manager, {
    unitId: company.units[unit]!,
    tenantId: t.id,
    startDate: today,
    endDate: toIsoDate(addDays(parseBusinessDate(today), 364)),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: today,
  });
  return t;
}

/** The newest stored attachment, its document, the stored bytes and the audit event's data. */
async function storedAttachment() {
  const [row] = await system((tx) =>
    tx
      .select({ attachment: schema.messageAttachment, document: schema.document })
      .from(schema.messageAttachment)
      .innerJoin(
        schema.document,
        sql`${schema.document.companyId} = ${schema.messageAttachment.companyId} and ${schema.document.id} = ${schema.messageAttachment.documentId}`,
      )
      .orderBy(sql`${schema.messageAttachment.copiedAt} desc`)
      .limit(1),
  );
  const bytes = await ctx.storage.get({
    bucket: row!.document.bucket,
    key: row!.document.storageKey,
    versionId: row!.document.storageVersionId!,
  });
  const [event] = await system((tx) =>
    tx
      .select({ data: schema.auditEvent.data })
      .from(schema.auditEvent)
      .where(
        sql`${schema.auditEvent.recordId} = ${row!.document.id} and ${schema.auditEvent.action} = 'document.stored'`,
      ),
  );
  return { ...row!, bytes, audit: event!.data as Record<string, unknown> };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = messagingServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now())));
  const admin = await platform(ctx);
  const c = await moneyCompany(ctx, s, 'agency', 'Inbound Photos Agency');
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: 'Inbound photos owner' })
  ).id;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'IPH',
    ownerId,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
  });
  company = { ...c, units: Object.values(property.units) };
  await whatsappNumber(ctx, m, admin, {
    phoneNumberId: SHARED_NUMBER,
    wabaId: SHARED_WABA,
    kind: 'shared',
    companyId: null,
    name: 'Rent Platform',
  });
});

afterAll(async () => {
  await m.stream.onModuleDestroy();
  await ctx?.close();
});

describe('CM-01 NFR-DP M11 review R3 F10: inbound photos lose their EXIF and location', () => {
  it('★ re-encodes a WhatsApp photo before it is stored, and keeps the original’s hash in the audit', async () => {
    const t = await tenant({ phone: '+233200076001' }, 0);
    const original = await photoWithLocation();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const hook = await m.whatsapp.simulateInbound({
      from: t.phone!,
      text: 'The ceiling',
      phoneNumberId: SHARED_NUMBER,
      media: { contentType: 'image/jpeg', bytes: original },
    });
    await receive(ctx, m, 'whatsapp', hook.rawBody, hook.signature);
    await work(ctx, m, company.companyId);
    const stored = await storedAttachment();
    expect(stored.attachment).toMatchObject({ status: 'stored', contentType: 'image/jpeg' });
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined();
    expect(stored.bytes.includes(Buffer.from('InboundPhoneMaker'))).toBe(false);
    expect(stored.document.sha256).toBe(sha256(stored.bytes));
    expect(stored.attachment.sizeBytes).toBe(stored.bytes.length);
    expect(stored.audit).toMatchObject({
      sha256: sha256(stored.bytes),
      originalSha256: sha256(original),
    });
    // An upload from outside: queued for the malware scan with its document (decision 6).
    expect(
      (await outboxOf(ctx, company.companyId, UPLOADS_SCAN_JOB)).map((e) => e.idempotencyKey),
    ).toContain(`${UPLOADS_SCAN_JOB}:${stored.document.id}`);
  });

  it('re-encodes a photo attached to a tenant’s email reply', async () => {
    const email = 'inbound.photo@tenants.invalid';
    const t = await tenant({ email }, 1);
    await system((tx) =>
      queueMessage(tx, company.companyId, {
        recipient: { type: 'tenant', tenantId: t.id },
        purpose: 'broadcast',
        subject: 'Water',
        body: 'The water is off on Saturday.',
        channels: ['email'],
        templateParams: { topic: 'water', notice: 'off' },
      }),
    );
    await work(ctx, m, company.companyId);
    const replyTo = s.email.lastTo(email)!.replyTo!;
    const original = await photoWithLocation();
    const { outcomes } = await receive(
      ctx,
      m,
      'email_inbound',
      JSON.stringify({
        From: email,
        FromFull: { Email: email, Name: '' },
        To: replyTo,
        ToFull: [{ Email: replyTo, Name: '' }],
        Subject: 'Re: Water',
        MessageID: `photo-${t.id}`,
        TextBody: 'The leak, photographed.',
        StrippedTextReply: 'The leak, photographed.',
        Attachments: [
          {
            Name: 'leak.jpg',
            Content: original.toString('base64'),
            ContentType: 'image/jpeg',
            ContentLength: original.length,
          },
        ],
      }),
    );
    expect(outcomes).toEqual(['inbox']);
    await work(ctx, m, company.companyId);
    const stored = await storedAttachment();
    expect(stored.attachment).toMatchObject({ status: 'stored', filename: 'leak.jpg' });
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined();
    expect(stored.audit).toMatchObject({ originalSha256: sha256(original) });
  });
});
