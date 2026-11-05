import { createHmac } from 'node:crypto';
import { schema, sql, withCompany, withSystem } from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_WHATSAPP_APP_SECRET } from '../src/core/config';
import { queueMessage } from '../src/core/messages';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  conversationsOf,
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
import {
  messagesOf,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M6 messaging pipeline against the real database with RLS (plan section 6): webhooks into
 * the inbox and conversations, shared-number routing across companies, STOP, the WhatsApp window
 * and templates, the bot's repair tickets, response targets, broadcasts, email reply tokens,
 * unsubscribe links, decision 8 and the tenant app's conversations.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MessagingServices;
let today: string;
const MINUTE = 60_000;

type Company = Awaited<ReturnType<typeof moneyCompany>> & {
  propertyId: string;
  units: string[];
  next: number;
};
let agency: Company;
let landlord: Company;
let admin: Awaited<ReturnType<typeof platform>>;
let phones = 0;
const phone = () => `+2332000${String(5000 + ++phones).padStart(5, '0')}`;

async function companyWithUnits(
  kind: 'agency' | 'landlord',
  name: string,
  part: string,
): Promise<Company> {
  const c = await moneyCompany(ctx, s, kind, name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 20, bedrooms: 1 }],
  });
  return { ...c, propertyId: property.propertyId, units: Object.values(property.units), next: 0 };
}

/** A tenant of the company with a current lease, and the consent asked for. */
async function tenant(
  c: Company,
  input: {
    phone?: string;
    email?: string;
    consent?: ('sms' | 'email' | 'whatsapp')[];
    name?: string;
  } = {},
) {
  const { tenant: t } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: input.name ?? `Tenant ${c.next + 1} of ${c.companyId.slice(-4)}`,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.email ? { email: input.email } : {}),
  });
  for (const channel of input.consent ?? [])
    if (channel === 'whatsapp')
      await m.consent.record(c.manager, t.id, { channel, action: 'grant' });
    else await s.tenants.recordConsent(c.manager, t.id, { channel, action: 'grant' });
  const lease = await billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId: t.id,
    startDate: today,
    endDate: toIsoDate(addDays(parseBusinessDate(today), 364)),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: today,
  });
  return { id: t.id, leaseId: lease.id, phone: input.phone ?? null, email: input.email ?? null };
}

const inSystem = <T>(companyId: string, fn: Parameters<typeof withCompany<T>>[2]) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

async function messagesOfTenant(companyId: string, tenantId: string) {
  return inSystem(
    companyId,
    async (tx) =>
      (
        await tx.execute<{
          id: string;
          direction: string;
          purpose: string;
          body: string;
          channel: string | null;
          conversation_id: string | null;
        }>(
          sql`select id, direction, purpose, body, channel, conversation_id from message where tenant_id = ${tenantId}::uuid order by created_at, id`,
        )
      ).rows,
  );
}

function metaBody(value: Record<string, unknown>, phoneNumberId = SHARED_NUMBER) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: SHARED_WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '233302000001', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  });
}
const sign = (raw: string) =>
  `sha256=${createHmac('sha256', DEV_WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = messagingServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now())));
  admin = await platform(ctx);
  agency = await companyWithUnits('agency', 'Osu Messaging Agency', 'MSG');
  landlord = await companyWithUnits('landlord', 'Kwame Messaging Landlord', 'MSL');
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

describe('CM-02 duplicate webhooks', () => {
  it('makes one message of a repeated webhook, and two messages and one event of a batch with two messages and a status', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp', 'sms'] });
    await whatsappFrom(ctx, m, t.phone!, 'Hi');
    await work(ctx, m, agency.companyId);
    const reply = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    const waId = t.phone!.slice(1);
    const raw = metaBody({
      contacts: [{ profile: { name: 'T' }, wa_id: waId }],
      messages: [
        {
          from: waId,
          id: 'wamid.batch-1',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'BALANCE' },
        },
        {
          from: waId,
          id: 'wamid.batch-2',
          timestamp: '1700000001',
          type: 'text',
          text: { body: 'Thanks' },
        },
      ],
      statuses: [
        {
          id: reply.providerMessageId,
          status: 'delivered',
          timestamp: '1700000002',
          recipient_id: waId,
        },
      ],
    });
    const first = await receive(ctx, m, 'whatsapp', raw, sign(raw));
    expect(first.stored).toBe('stored');
    expect(first.outcomes).toHaveLength(3);
    const again = await receive(ctx, m, 'whatsapp', raw, sign(raw));
    expect(again).toEqual({ stored: 'duplicate', outcomes: [] });
    const inbound = (await messagesOfTenant(agency.companyId, t.id)).filter(
      (x) => x.direction === 'inbound',
    );
    expect(inbound.map((x) => x.body)).toEqual(['Hi', 'BALANCE', 'Thanks']);
    const delivered = await inSystem(agency.companyId, (tx) =>
      tx.execute(
        sql`select 1 from message_event where status = 'delivered' and message_id =
              (select message_id from message_event where provider_message_id = ${reply.providerMessageId} and status = 'sent')`,
      ),
    );
    expect(delivered.rows).toHaveLength(1);
  });

  it('refuses a changed body: stored as rejected, without its text, and nothing processed', async () => {
    const raw = metaBody({
      messages: [
        {
          from: '233200009999',
          id: 'wamid.forged',
          timestamp: '1',
          type: 'text',
          text: { body: 'x' },
        },
      ],
    });
    const result = await receive(ctx, m, 'whatsapp', raw.replace('"x"', '"y"'), sign(raw));
    expect(result).toEqual({ stored: 'rejected', outcomes: [] });
  });
});

describe('CM-01 TL-12 shared-number routing (decision 4)', () => {
  it('asks a phone renting from two companies which landlord, writes nothing anywhere before the answer, and neither company sees the other’s messages', async () => {
    const both = phone();
    const atAgency = await tenant(agency, { phone: both, consent: ['whatsapp'] });
    const atLandlord = await tenant(landlord, { phone: both, consent: ['whatsapp'] });
    const asked = await whatsappFrom(ctx, m, both, 'My tap is leaking');
    expect(asked.outcomes).toEqual(['asked_landlord']);
    const question = m.whatsapp.sent.filter((x) => x.to === both).at(-1)!;
    expect(question.body).toContain('Which landlord');
    expect(question.choices?.map((c) => c.id).sort()).toEqual(
      [`landlord:${agency.companyId}`, `landlord:${landlord.companyId}`].sort(),
    );
    expect(await messagesOfTenant(agency.companyId, atAgency.id)).toEqual([]);
    expect(await messagesOfTenant(landlord.companyId, atLandlord.id)).toEqual([]);

    const answered = await whatsappFrom(ctx, m, both, 'Kwame', {
      choiceId: `landlord:${landlord.companyId}`,
    });
    expect(answered.outcomes.at(-1)).not.toBe('asked_landlord');
    const there = await messagesOfTenant(landlord.companyId, atLandlord.id);
    expect(there.filter((x) => x.direction === 'inbound').map((x) => x.body)).toContain(
      'My tap is leaking',
    );
    expect(await messagesOfTenant(agency.companyId, atAgency.id)).toEqual([]);
    // The agency's staff cannot open the landlord's conversation (RLS, cross-company isolation).
    const conversation = there.find((x) => x.conversation_id)!.conversation_id!;
    await expect(m.inbox.conversation(agency.manager, conversation)).rejects.toMatchObject({
      status: 404,
    });
    const listed = await m.inbox.conversations(agency.manager, { view: 'all', limit: 100 });
    expect(listed.items.map((c) => c.id)).not.toContain(conversation);

    // The landlord answered on the shared number within the day: the next message goes there.
    await work(ctx, m, landlord.companyId);
    // The send job stamps real time; the test clock is fixed at the start, so move it past that.
    ctx.clock.advance(MINUTE);
    const next = await whatsappFrom(ctx, m, both, 'Also the door');
    expect(next.outcomes).not.toContain('asked_landlord');
    expect(
      (await messagesOfTenant(landlord.companyId, atLandlord.id)).map((x) => x.body),
    ).toContain('Also the door');
  });

  it('routes an unknown number on a company’s own number to that company’s triage', async () => {
    const unknown = phone();
    // A company number makes it the agency's sending number; the shared one stays for the rest.
    const own = await whatsappNumber(ctx, m, admin, {
      phoneNumberId: '100000000000777',
      wabaId: '200000000000777',
      kind: 'company',
      companyId: landlord.companyId,
      name: 'Landlord number',
    });
    expect(own.kind).toBe('company');
    const result = await whatsappFrom(ctx, m, unknown, 'Is a shop available?', {
      phoneNumberId: '100000000000777',
    });
    expect(result.outcomes).toEqual(['triage']);
    const triage = (await conversationsOf(ctx, landlord.companyId)).filter(
      (c) => c.state === 'triage',
    );
    expect(triage.map((c) => c.triage_address)).toContain(unknown);
  });
});

describe('CM-09 STOP and replies (decisions 6 and 7)', () => {
  it('STOP withdraws the channel it came on at once and STOP ALL every channel, with one confirmation each; a reply goes within 24 hours of a new message; START grants that channel again', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp', 'sms'] });
    const own = async () =>
      Object.fromEntries(
        (await m.consent.get(agency.manager, t.id)).subjects
          .find((x) => x.contactId === null)!
          .channels.map((c) => [c.channel, { granted: c.granted, source: c.source }]),
      );
    const notice = (body: string) =>
      inSystem(agency.companyId, (tx) =>
        queueMessage(tx, agency.companyId, {
          recipient: { type: 'tenant', tenantId: t.id },
          purpose: 'broadcast',
          body,
          templateParams: { topic: 'water', notice: body },
        }),
      );

    expect((await whatsappFrom(ctx, m, t.phone!, 'STOP')).outcomes).toEqual(['stop']);
    expect(await own()).toMatchObject({
      whatsapp: { granted: false, source: 'stop_keyword' },
      sms: { granted: true },
    });
    await work(ctx, m, agency.companyId);
    // The business message skips WhatsApp now and goes by SMS, where consent stands.
    const afterStop = await notice('The water is off on Saturday.');
    await work(ctx, m, agency.companyId);
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === afterStop)!.channel).toBe(
      'sms',
    );

    expect((await whatsappFrom(ctx, m, t.phone!, 'STOP ALL')).outcomes).toEqual(['stop']);
    for (const c of Object.values(await own())) expect(c.granted).toBe(false);
    await work(ctx, m, agency.companyId);
    const confirmations = (await messagesOfTenant(agency.companyId, t.id)).filter(
      (x) => x.purpose === 'opt_out_confirmation',
    );
    expect(confirmations).toHaveLength(2);
    const stopped = await notice('The water is back.');
    await work(ctx, m, agency.companyId);
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === stopped)!.status).toBe(
      'not_sent',
    );

    // The tenant writes again: a reply may go for 24 hours after it (decision 6 with decision 7).
    // Consent events take the database's time; the test clock is fixed, so move it past them.
    ctx.clock.advance(MINUTE);
    await whatsappFrom(ctx, m, t.phone!, 'Is the water back yet?');
    const conversation = (await m.inbox.tenantConversation(agency.manager, t.id)).conversation!;
    const answer = await m.inbox.reply(agency.manager, conversation.id, {
      clientMessageId: crypto.randomUUID(),
      channel: 'whatsapp',
      body: 'Yes, since this morning.',
    });
    await work(ctx, m, agency.companyId);
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === answer.id)!.status).toBe(
      'sent',
    );

    expect((await whatsappFrom(ctx, m, t.phone!, 'START')).outcomes).toEqual(['start']);
    expect(await own()).toMatchObject({
      whatsapp: { granted: true, source: 'start_keyword' },
      sms: { granted: false },
    });
  });
});

describe('CM-07 the 24-hour window and templates', () => {
  it('sends the approved template outside the window, and the next channel when it is not approved', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp', 'sms'] });
    const notice = (body: string) =>
      inSystem(agency.companyId, (tx) =>
        queueMessage(tx, agency.companyId, {
          recipient: { type: 'tenant', tenantId: t.id },
          purpose: 'broadcast',
          body,
          templateParams: { topic: 'fumigation', notice: body },
        }),
      );
    const approved = await notice('Fumigation on Monday.');
    await work(ctx, m, agency.companyId);
    const viaTemplate = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    expect(viaTemplate.type).toBe('template');
    expect(viaTemplate.template).toBe('building_notice_v1');
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === approved)!.channel).toBe(
      'whatsapp',
    );

    await setTemplateStatus('building_notice', 'pending');
    try {
      const pending = await notice('Fumigation moved to Tuesday.');
      await work(ctx, m, agency.companyId);
      const row = (await messagesOf(ctx, agency.companyId)).find((x) => x.id === pending)!;
      expect(row.channel).toBe('sms');
      expect(s.sms.sent.filter((x) => x.to === t.phone).at(-1)!.body).toContain('Tuesday');
    } finally {
      await setTemplateStatus('building_notice', 'approved');
    }
  });
});

async function setTemplateStatus(key: string, status: 'approved' | 'pending') {
  await withSystem(
    ctx.database,
    { personId: admin.personId, actorKind: 'platform_admin' },
    async (tx) => {
      const accounts = await tx.execute<{ id: string; phone_number_id: string }>(
        sql`select id, phone_number_id from app.whatsapp_accounts()`,
      );
      const [template] = await tx
        .select()
        .from(schema.messageTemplate)
        .where(sql`${schema.messageTemplate.key} = ${key}`);
      for (const a of accounts.rows)
        await tx.execute(
          sql`select app.record_whatsapp_template_status(${a.id}::uuid, ${template!.id}::uuid, ${status}, 'utility', null, null)`,
        );
    },
  );
}

describe('CM-04 a repair reported to the bot', () => {
  it('makes one ticket with the photo attached and answers with its number; a retried job makes no second ticket', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp'] });
    await whatsappFrom(ctx, m, t.phone!, 'Hi');
    await whatsappFrom(ctx, m, t.phone!, 'REPAIR');
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
      'hex',
    );
    const photo = await m.whatsapp.simulateInbound({
      from: t.phone!,
      text: 'The tap',
      phoneNumberId: SHARED_NUMBER,
      media: { contentType: 'image/png', bytes: png },
    });
    await receive(ctx, m, 'whatsapp', photo.rawBody, photo.signature);
    await work(ctx, m, agency.companyId);
    await whatsappFrom(ctx, m, t.phone!, 'DONE');
    await work(ctx, m, agency.companyId);
    const jobs = await inSystem(agency.companyId, (tx) =>
      tx
        .select()
        .from(schema.maintenanceJob)
        .where(sql`${schema.maintenanceJob.tenantId} = ${t.id}`),
    );
    expect(jobs).toHaveLength(1);
    const attachments = await inSystem(agency.companyId, (tx) =>
      tx
        .select()
        .from(schema.maintenanceJobAttachment)
        .where(sql`${schema.maintenanceJobAttachment.jobId} = ${jobs[0]!.id}`),
    );
    expect(attachments).toHaveLength(1);
    const answer = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    expect(answer.body).toMatch(/MT-\d{4}/);
    // The same webhook again (a provider retry) and the same job again make nothing new.
    await receive(ctx, m, 'whatsapp', photo.rawBody, photo.signature);
    const rows = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from webhook_inbox where provider = 'messaging.whatsapp'`,
      ),
    );
    for (const r of rows.rows) await m.inbound.process(r.id);
    const again = await inSystem(agency.companyId, (tx) =>
      tx
        .select()
        .from(schema.maintenanceJob)
        .where(sql`${schema.maintenanceJob.tenantId} = ${t.id}`),
    );
    expect(again).toHaveLength(1);
  });
});

describe('CM-06 the first-response target (decision 10)', () => {
  it('alerts once when an unanswered conversation passes its target, and not again on a retry', async () => {
    const c = await companyWithUnits('agency', 'Response Agency', 'SLA');
    const t = await tenant(c, { phone: phone(), consent: ['sms'] });
    const sms = (id: string, text: string) =>
      receive(
        ctx,
        m,
        'sms_inbound',
        JSON.stringify({ from: t.phone!.slice(1), to: '1440', content: text, messageId: id }),
      );
    expect((await sms(`sla-${t.id}`, 'Please call me about the gate')).outcomes).toEqual(['inbox']);
    expect((await m.operations.slaCheck(c.companyId)).alerted).toBe(0);
    ctx.clock.advance(241 * MINUTE);
    try {
      const first = await m.operations.slaCheck(c.companyId);
      expect(first.alerted).toBe(1);
      expect((await m.operations.slaCheck(c.companyId)).alerted).toBe(0);
      await work(ctx, m, c.companyId);
      const alerts = (await messagesOf(ctx, c.companyId)).filter(
        (x) => x.purpose === 'overdue_alert',
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const overdue = await m.inbox.conversations(c.manager, { view: 'overdue', limit: 100 });
      expect(overdue.items.map((c) => c.tenant?.id)).toContain(t.id);
    } finally {
      ctx.clock.advance(-241 * MINUTE);
    }
  });
});

describe('CM-08 broadcasts', () => {
  it('reaches only current, consented tenants in scope; the counts add up; the same confirmation twice is one broadcast', async () => {
    const c = await companyWithUnits('agency', 'Broadcast Agency', 'BRC');
    const reachable = await tenant(c, { phone: phone(), consent: ['sms'] });
    const silent = await tenant(c, { phone: phone() });
    const content = {
      audience: { kind: 'property' as const, propertyId: c.propertyId },
      topic: 'water supply',
      body: 'No water on Saturday.',
    };
    const preview = await m.broadcasts.preview(c.manager, content);
    expect(preview.audienceCount).toBe(2);
    expect(preview.reachableCount).toBe(1);
    expect(preview.unreachable.map((u) => [u.tenantId, u.reason])).toEqual([
      [silent.id, 'no_consent'],
    ]);
    const created = await m.broadcasts.create(c.manager, {
      ...content,
      previewToken: preview.previewToken,
    });
    const twice = await m.broadcasts.create(c.manager, {
      ...content,
      previewToken: preview.previewToken,
    });
    expect(twice.id).toBe(created.id);
    await work(ctx, m, c.companyId);
    const detail = await m.broadcasts.get(c.manager, created.id);
    const { stats } = detail;
    expect(
      stats.queued + stats.sent + stats.delivered + stats.read + stats.failed + stats.notSent,
    ).toBe(detail.audienceCount);
    expect(stats.sent).toBe(1);
    expect(stats.notSent).toBe(1);
    expect(detail.recipients.find((r) => r.tenantId === reachable.id)!.channel).toBe('sms');
    // A manager scoped to another property reaches no one here.
    const scoped = await staffIn(ctx, c.companyId, 'agency', 'property_manager', 'Scoped manager', {
      properties: [agency.propertyId],
    });
    expect((await m.broadcasts.preview(scoped, content)).audienceCount).toBe(0);
    // A used preview with other words, or a preview whose audience changed since, is refused.
    await expect(
      m.broadcasts.create(c.manager, {
        ...content,
        body: 'Changed',
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await m.broadcasts.preview(c.manager, {
      ...content,
      body: 'Fumigation on Monday.',
    });
    await tenant(c, { phone: phone(), consent: ['sms'] });
    await expect(
      m.broadcasts.create(c.manager, {
        ...content,
        body: 'Fumigation on Monday.',
        previewToken: fresh.previewToken,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'audience_changed' });
  });
});

describe('CM-10 email replies and CM-09 unsubscribe links', () => {
  it('threads a reply back by its token; another sender or a forged token goes to triage; the unsubscribe link withdraws email once', async () => {
    const email = `tenant-${phones}@example.org`;
    const t = await tenant(agency, { email, consent: ['email'] });
    const id = await inSystem(agency.companyId, (tx) =>
      queueMessage(tx, agency.companyId, {
        recipient: { type: 'tenant', tenantId: t.id },
        purpose: 'broadcast',
        subject: 'Water',
        body: 'The water is off on Saturday.',
        channels: ['email'],
        templateParams: { topic: 'water', notice: 'off' },
      }),
    );
    await work(ctx, m, agency.companyId);
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === id)!.status).toBe('sent');
    const sent = s.email.lastTo(email)!;
    const replyTo = sent.replyTo!;
    expect(replyTo).toMatch(/^reply\+[a-z2-7]{52}@/);
    const inboundEmail = (from: string, to: string, messageId: string) =>
      receive(
        ctx,
        m,
        'email_inbound',
        JSON.stringify({
          From: from,
          FromFull: { Email: from, Name: '' },
          To: to,
          ToFull: [{ Email: to, Name: '' }],
          Subject: 'Re: Water',
          MessageID: messageId,
          TextBody: 'Thanks, noted.',
          StrippedTextReply: 'Thanks, noted.',
          Attachments: [],
        }),
      );
    // Mail systems may change the address's case: the token still matches.
    expect(
      (await inboundEmail(email, replyTo.toUpperCase().replace('REPLY+', 'reply+'), `e1-${t.id}`))
        .outcomes,
    ).toEqual(['inbox']);
    const own = await messagesOfTenant(agency.companyId, t.id);
    expect(own.filter((x) => x.direction === 'inbound').map((x) => x.body)).toEqual([
      'Thanks, noted.',
    ]);
    expect(
      (await inboundEmail('someone.else@example.org', replyTo, `e2-${t.id}`)).outcomes,
    ).toEqual(['triage']);
    expect(
      (await inboundEmail(email, `reply+${'a'.repeat(52)}@inbound.rent.invalid`, `e3-${t.id}`))
        .outcomes,
    ).toEqual(['triage']);

    const header = sent.headers?.['List-Unsubscribe'] ?? '';
    expect(header).toMatch(new RegExp(`^<${ctx.config.LINKS_ORIGIN}/u/[A-Za-z0-9_-]+/confirm>$`));
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const token = header.split('/u/')[1]!.split('/')[0]!;
    expect(await m.consent.unsubscribe(token, false)).toMatchObject({ screen: 'confirm' });
    expect(await m.consent.unsubscribe(token, true)).toMatchObject({ screen: 'done' });
    expect(await m.consent.unsubscribe(token, true)).toMatchObject({ screen: 'done' });
    expect(await m.consent.unsubscribe('not-a-token', false)).toEqual({
      screen: 'invalid',
      landlordName: null,
      emailMasked: null,
    });
    const after = (await m.consent.get(agency.manager, t.id)).subjects.find(
      (x) => x.contactId === null,
    )!;
    expect(after.channels.find((c) => c.channel === 'email')).toMatchObject({
      granted: false,
      source: 'email_unsubscribe',
    });
    const withdrawals = await inSystem(agency.companyId, (tx) =>
      tx.execute(
        sql`select 1 from consent_event where tenant_id = ${t.id}::uuid and source = 'email_unsubscribe'`,
      ),
    );
    expect(withdrawals.rows).toHaveLength(1);
  });
});

describe('CM-09 decision 8 (OQ-54): a changed phone or email starts with no consent', () => {
  it('withdraws SMS and WhatsApp when the phone changes, and leaves email alone', async () => {
    const t = await tenant(agency, {
      phone: phone(),
      email: `kept-${phones}@example.org`,
      consent: ['sms', 'whatsapp', 'email'],
    });
    await s.tenants.update(agency.manager, t.id, { phone: phone() });
    const own = (await m.consent.get(agency.manager, t.id)).subjects.find(
      (x) => x.contactId === null,
    )!;
    const granted = Object.fromEntries(own.channels.map((c) => [c.channel, c.granted]));
    expect(granted).toMatchObject({ sms: false, whatsapp: false, email: true });
  });
});

describe('CM-05 TL-12 the tenant app’s conversations', () => {
  it('shows each landlord’s conversation apart, sends once per client id, and never opens another landlord’s attachment', async () => {
    const both = phone();
    const atAgency = await tenant(agency, { phone: both, consent: ['sms'] });
    await tenant(landlord, { phone: both, consent: ['sms'] });
    const [row] = await inSystem(agency.companyId, (tx) =>
      tx
        .select({ personId: schema.tenant.personId })
        .from(schema.tenant)
        .where(sql`${schema.tenant.id} = ${atAgency.id}`),
    );
    const me = {
      kind: 'tenant' as const,
      personId: row!.personId!,
      authMethod: 'phone_otp' as const,
    };
    const clientMessageId = crypto.randomUUID();
    const first = await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId,
      body: 'Hello from the app',
      uploadIds: [],
    });
    const again = await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId,
      body: 'Hello from the app',
      uploadIds: [],
    });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ clientMessageId, deliveryStatus: 'sent', fromLandlord: false });
    const conversations = await m.tenantMessaging.conversations(me);
    expect(conversations.map((c) => c.companyId).sort()).toEqual(
      [agency.companyId, landlord.companyId].sort(),
    );
    const atLandlordView = await m.tenantMessaging.messages(me, landlord.companyId, { limit: 50 });
    expect(atLandlordView.items.map((x) => x.body)).not.toContain('Hello from the app');
    // Staff reply in the app: it reaches the tenant's thread, and opening it marks it read.
    const conversation = (await m.inbox.tenantConversation(agency.manager, atAgency.id))
      .conversation!;
    await m.inbox.reply(agency.manager, conversation.id, {
      clientMessageId: crypto.randomUUID(),
      channel: 'in_app',
      body: 'We have seen it.',
    });
    await work(ctx, m, agency.companyId);
    expect(
      (await m.tenantMessaging.conversations(me)).find((c) => c.companyId === agency.companyId)!
        .unreadCount,
    ).toBe(1);
    const thread = await m.tenantMessaging.messages(me, agency.companyId, { limit: 50 });
    expect(thread.items.map((x) => x.body)).toContain('We have seen it.');
    expect(thread.items.find((x) => x.id === first.id)!.deliveryStatus).toBe('read');
    expect(
      (await m.tenantMessaging.conversations(me)).find((c) => c.companyId === agency.companyId)!
        .unreadCount,
    ).toBe(0);
    // Someone else's upload, or another landlord's attachment, is not found.
    await expect(
      m.tenantMessaging.send(me, agency.companyId, {
        clientMessageId: crypto.randomUUID(),
        body: '',
        uploadIds: [crypto.randomUUID()],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      m.tenantMessaging.attachmentDownload(me, landlord.companyId, first.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    // The staff timeline has the messages too (decision 9, every plan).
    const timeline = await s.tenants.timeline(agency.manager, atAgency.id);
    expect(timeline.map((e) => e.action)).toEqual(
      expect.arrayContaining(['message.inbound', 'message.outbound']),
    );
  });
});

describe('CM-06 the live inbox is scoped (plan 4.6)', () => {
  it('tells a caretaker only of their properties’ conversations', async () => {
    const caretaker = await staffIn(
      ctx,
      agency.companyId,
      'agency',
      'caretaker',
      'Stream caretaker',
      { properties: [landlord.propertyId] },
    );
    const manager = agency.manager;
    const forManager: string[] = [];
    const forCaretaker: string[] = [];
    const stopManager = await m.stream.subscribe(manager, (e) => forManager.push(e.conversationId));
    const stopCaretaker = await m.stream.subscribe(caretaker, (e) =>
      forCaretaker.push(e.conversationId),
    );
    try {
      const t = await tenant(agency, { phone: phone(), consent: ['sms'] });
      await receive(
        ctx,
        m,
        'sms_inbound',
        JSON.stringify({
          from: t.phone!.slice(1),
          to: '1440',
          content: 'Hello',
          messageId: `stream-${t.id}`,
        }),
      );
      const conversation = (await m.inbox.tenantConversation(manager, t.id)).conversation!;
      for (let i = 0; i < 50 && !forManager.includes(conversation.id); i += 1)
        await new Promise((r) => setTimeout(r, 20));
      expect(forManager).toContain(conversation.id);
      expect(forCaretaker).not.toContain(conversation.id);
    } finally {
      stopManager();
      stopCaretaker();
    }
  });
});
