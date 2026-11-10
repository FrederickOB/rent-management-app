import { createHash } from 'node:crypto';
import { schema, sql, withCompany, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { DEV_WEBHOOK_SECRET } from '../src/core/config';
import { SigningHasher } from '../src/esign/secrets';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  messagingServices,
  platform,
  receive,
  SHARED_NUMBER,
  SHARED_WABA,
  whatsappFrom,
  whatsappNumber,
  work,
  type MessagingServices,
} from './support/messaging';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * M11 security review findings in the operations area (docs/plans/M11.md section 9, Backend):
 * - reviewer 3 F4: inbound email and WhatsApp attachments were stored by the type they declared;
 *   now the bytes decide, and a file whose bytes are not what it says is kept as refused;
 * - reviewer 3 F6: rate-limit keys held an unkeyed SHA-256 of an IP address (and, found beside it,
 *   of an unknown sender's phone), which a list of every IPv4 address or Ghanaian number reverses;
 *   now a keyed hash;
 * - reviewer 2 F6: webhook bodies are readable and writable only in a system transaction, never
 *   in a company's (staff, tenant or a company job).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MessagingServices;
let admin: Awaited<ReturnType<typeof platform>>;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let units: string[];
let hasher: SigningHasher;
let phones = 0;
const phone = () => `+2332001${String(7000 + ++phones).padStart(5, '0')}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);
/** A Windows executable's first bytes: what a "photo" must never be stored as. */
const EXE = Buffer.from('4d5a90000300000004000000ffff0000b800000000000000', 'hex');

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = messagingServices(ctx, s, b);
  hasher = new SigningHasher(ctx.config.BETTER_AUTH_SECRET);
  admin = await platform(ctx);
  agency = await moneyCompany(ctx, s, 'agency', 'Ops Security Agency');
  const ownerId = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Ops Security Owner' })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'OPS',
    ownerId,
    units: [{ unitType: 'apartment', count: 4, bedrooms: 1 }],
  });
  units = Object.values(property.units);
  await whatsappNumber(ctx, m, admin, {
    phoneNumberId: SHARED_NUMBER,
    wabaId: SHARED_WABA,
    kind: 'shared',
    companyId: null,
    name: 'Rent Platform',
  });
});

afterAll(async () => {
  await m?.stream.onModuleDestroy();
  await ctx?.close();
});

/** A tenant with a current lease and WhatsApp consent, who writes to the shared number. */
async function whatsappTenant() {
  const number = phone();
  const { tenant } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: `Media Tenant ${phones}`,
    phone: number,
  });
  await m.consent.record(agency.manager, tenant.id, { channel: 'whatsapp', action: 'grant' });
  const today = isoNow(ctx.clock, 'Africa/Accra');
  await billedLease(ctx, s, b, agency.manager, {
    unitId: units.shift()!,
    tenantId: tenant.id,
    startDate: today,
    endDate: toIsoDate(addDays(parseBusinessDate(today), 364)),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: today,
  });
  return number;
}

/** The attachments copied for a company, newest last. */
async function attachments(companyId: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({
        status: schema.messageAttachment.status,
        rejectReason: schema.messageAttachment.rejectReason,
        contentType: schema.messageAttachment.contentType,
        documentId: schema.messageAttachment.documentId,
        providerMediaId: schema.messageAttachment.providerMediaId,
      })
      .from(schema.messageAttachment)
      .orderBy(schema.messageAttachment.createdAt),
  );
}

async function rateLimitKeys(prefix: string): Promise<string[]> {
  const rows = await withSystem(ctx.database, {}, (tx) =>
    tx.execute<{ key: string }>(sql`select key from rate_limit where key like ${`${prefix}%`}`),
  );
  return rows.rows.map((r) => r.key);
}

describe('NFR-SEC inbound media is stored by what its bytes are (M11 review R3 F4)', () => {
  it('refuses a WhatsApp "photo" whose bytes are a program, and stores a real one by its sniffed type', async () => {
    const from = await whatsappTenant();
    const before = (await attachments(agency.companyId)).length;
    await whatsappFrom(ctx, m, from, 'The broken window', {
      media: { contentType: 'image/png', bytes: EXE },
    });
    await work(ctx, m, agency.companyId);
    const forged = (await attachments(agency.companyId)).slice(before);
    expect(forged).toHaveLength(1);
    expect(forged[0]).toMatchObject({
      status: 'rejected',
      rejectReason: 'type_mismatch',
      documentId: null,
    });

    // A PNG sent as a JPEG is an image either way: stored, under the type its bytes show.
    await whatsappFrom(ctx, m, from, 'The window again', {
      media: { contentType: 'image/jpeg', bytes: PNG },
    });
    await work(ctx, m, agency.companyId);
    const real = (await attachments(agency.companyId)).slice(before + 1);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ status: 'stored', contentType: 'image/png' });
    expect(real[0]!.documentId).not.toBeNull();
  });

  it('refuses an email attachment declared a PDF whose bytes are a web page', async () => {
    const before = (await attachments(admin.companyId)).length;
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const body = JSON.stringify({
      MessageID: `f4-${Date.now()}`,
      From: 'Stranger <stranger@example.invalid>',
      To: 'hello@inbound.rent.invalid',
      Subject: 'Invoice',
      TextBody: 'Please see the attached invoice',
      Attachments: [
        { Name: 'invoice.pdf', Content: html.toString('base64'), ContentType: 'application/pdf' },
        {
          Name: 'photo.png',
          Content: PNG.toString('base64'),
          ContentType: 'image/png',
        },
      ],
    });
    const stored = await receive(ctx, m, 'email_inbound', body);
    expect(stored.stored).toBe('stored');
    await work(ctx, m, admin.companyId);
    const copied = (await attachments(admin.companyId)).slice(before);
    expect(copied.map((a) => [a.status, a.rejectReason, a.contentType])).toEqual(
      expect.arrayContaining([
        ['rejected', 'type_mismatch', 'application/pdf'],
        ['stored', null, 'image/png'],
      ]),
    );
    expect(copied).toHaveLength(2);
  });
});

describe('NFR-SEC rate-limit keys hold a keyed hash, never a plain SHA-256 of an address (M11 review R3 F6)', () => {
  it('counts the unsubscribe page per browser address by a keyed hash', async () => {
    const ip = '198.51.100.77';
    await m.consent.unsubscribe('A'.repeat(43), false, { ip });
    const keys = await rateLimitKeys('unsubscribe-ip:');
    expect(keys).not.toContain(`unsubscribe-ip:${sha256(ip)}`);
    expect(keys).toContain(`unsubscribe-ip:${hasher.address(ip)}`);
  });

  it('counts bad messaging webhooks per sender address by a keyed hash', async () => {
    const ip = '203.0.113.201';
    const result = await m.inbound.intake('sms_inbound', Buffer.from('{"from":"x"}'), {
      headers: {},
      secret: 'not-the-secret',
      ip,
    });
    expect(result).toBe('rejected');
    const keys = await rateLimitKeys('messaging-webhook:bad:');
    expect(keys).not.toContain(`messaging-webhook:bad:${sha256(ip)}`);
    expect(keys).toContain(`messaging-webhook:bad:${hasher.address(ip)}`);
  });

  it('counts an unknown sender’s media by a keyed hash of the phone, never its plain SHA-256', async () => {
    const stranger = phone();
    await whatsappFrom(ctx, m, stranger, 'Who is this', {
      media: { contentType: 'image/png', bytes: PNG },
    });
    const keys = await rateLimitKeys('messaging-media:unknown:');
    expect(keys).not.toContain(`messaging-media:unknown:${sha256(stranger)}`);
    expect(keys).toContain(`messaging-media:unknown:${hasher.destination(stranger)}`);
  });
});

describe('NFR-SEC webhook bodies are only for the system (M11 review R2 F6)', () => {
  it('a company transaction as the application role sees no stored webhook and cannot store one; the system paths can', async () => {
    // A signed webhook stored through the intake (a system path).
    expect(
      await m.inbound.intake('sms_inbound', Buffer.from(JSON.stringify({ x: 1 })), {
        headers: {},
        secret: DEV_WEBHOOK_SECRET,
      }),
    ).toMatch(/^(ignored|stored)$/);
    const system = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from webhook_inbox`),
    );
    expect(system.rows[0]!.n).toBeGreaterThan(0);

    for (const actorKind of ['staff', 'system'] as const) {
      const context = {
        companyId: agency.companyId,
        actorKind,
        ...(actorKind === 'staff' ? { personId: agency.manager.personId } : {}),
      };
      const seen = await withCompany(ctx.database, context, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from webhook_inbox`),
      );
      expect(seen.rows[0]!.n, actorKind).toBe(0);
      await expect(
        withCompany(ctx.database, context, (tx) =>
          tx.insert(schema.webhookInbox).values({
            provider: 'paystack',
            eventId: `forged-${actorKind}-${Date.now()}`,
            rawBody: '{}',
            headers: {},
            signatureValid: true,
            status: 'received',
          }),
        ),
        actorKind,
        // 42501: new row violates row-level security policy.
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    // A platform admin outside the system path sees none either.
    const platformSeen = await withSystem(
      ctx.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from webhook_inbox`),
    );
    expect(platformSeen.rows[0]!.n).toBe(0);
  });
});
