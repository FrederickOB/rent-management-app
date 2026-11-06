import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { SYSTEM_PROMPT_PURPOSES } from '@rent/domain/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  messagingServices,
  platform,
  SHARED_NUMBER,
  SHARED_WABA,
  whatsappFrom,
  whatsappNumber,
  work,
  type MessagingServices,
} from './support/messaging';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * CM-06 and the M8 review: an automatic prompt (the WhatsApp consent question, the confirmation
 * after STOP or START) never becomes a conversation's preview or last message. The tenant's own
 * message stays the one shown, and stays unanswered; staff replies and bot answers still show.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MessagingServices;
let today: string;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = messagingServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now())));
  const admin = await platform(ctx);
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

describe('CM-06 an automatic prompt is never a conversation’s preview (M8 review)', () => {
  it('shows the tenant’s message, still unanswered, when the consent question went after it; a staff reply shows', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Preview Agency');
    const ownerId = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Preview owner' })
    ).id;
    const property = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'IPV',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const phone = '+233200077001';
    const { tenant } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: 'Preview tenant',
      phone,
    });
    // SMS agreed, WhatsApp not yet: writing in on WhatsApp brings the consent question.
    await s.tenants.recordConsent(c.manager, tenant.id, { channel: 'sms', action: 'grant' });
    await billedLease(ctx, s, b, c.manager, {
      unitId: Object.values(property.units)[0]!,
      tenantId: tenant.id,
      startDate: today,
      endDate: toIsoDate(addDays(parseBusinessDate(today), 364)),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: today,
    });
    // A conversation a person already has (the bot handed it over): the tenant's message gets
    // no bot answer, only the consent question after it.
    await asSuperuser(
      ctx,
      "insert into conversation (id, company_id, tenant_id, state) values (gen_random_uuid(), $1, $2, 'open')",
      [c.companyId, tenant.id],
    );
    const text = 'The gate lock is broken and will not open';
    await whatsappFrom(ctx, m, phone, text);
    await work(ctx, m, c.companyId);
    const messages = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ purpose: schema.message.purpose, body: schema.message.body })
          .from(schema.message)
          .where(sql`tenant_id = ${tenant.id}`)
          .orderBy(schema.message.createdAt, schema.message.id),
    );
    // The premise: the last message is the automatic question.
    expect(messages.at(-1)!.purpose).toBe('consent_request');
    const real = messages.filter((x) => !SYSTEM_PROMPT_PURPOSES.includes(x.purpose as never));
    const listed = await m.inbox.conversations(c.manager, { view: 'all', limit: 100 });
    const row = listed.items.find((r) => r.tenant?.id === tenant.id)!;
    expect(row.lastMessagePreview).not.toMatch(/Reply YES/);
    expect(real.at(-1)!.body).toBe(text);
    expect(row.lastMessagePreview).toBe(text);
    expect(row.unansweredCount).toBeGreaterThanOrEqual(1);
    // The tenant app shows the same, never the prompt.
    const [person] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(sql`id = ${tenant.id}`),
    );
    const app = await m.tenantMessaging.conversations({
      kind: 'tenant',
      personId: person!.personId!,
      authMethod: 'phone_otp',
    });
    expect(app.find((x) => x.companyId === c.companyId)!.lastMessagePreview).not.toMatch(
      /Reply YES/,
    );
    // A staff reply is a real message: it shows.
    await m.inbox.reply(c.manager, row.id, {
      clientMessageId: crypto.randomUUID(),
      channel: 'whatsapp',
      body: 'A technician will come this afternoon.',
    });
    const after = await m.inbox.conversations(c.manager, { view: 'all', limit: 100 });
    expect(after.items.find((r) => r.id === row.id)!.lastMessagePreview).toBe(
      'A technician will come this afternoon.',
    );
  });
});
