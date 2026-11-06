import { createHmac, randomUUID } from 'node:crypto';
import { schema, sql, withCompany } from '@rent/db';
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
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCard,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { format, money } from '@rent/domain/money';
import { formatBusinessDate } from '@rent/domain/dates';
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
 * The M6 review's backend fixes against the real database with RLS (findings in the review
 * round): keywords before routing on the shared number, the "which landlord?" answer, STOP in the
 * app, the WhatsApp window per number, tenants between leases, replies to resolved conversations,
 * reused client ids, broadcast previews, unsubscribe links bound to their address, the pay link's
 * channels, and what a tenant and a caretaker may see.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MessagingServices;
let today: string;
let admin: Awaited<ReturnType<typeof platform>>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Company = Awaited<ReturnType<typeof moneyCompany>> & {
  propertyId: string;
  units: string[];
  next: number;
};
let agency: Company;
let landlord: Company;
let phones = 0;
const phone = () => `+2332000${String(7000 + ++phones).padStart(5, '0')}`;

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

async function tenant(
  c: Company,
  input: { phone?: string; email?: string; consent?: ('sms' | 'email' | 'whatsapp')[] } = {},
) {
  const { tenant: t } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Review tenant ${c.next + 1}`,
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
        }>(
          sql`select id, direction, purpose, body, channel from message where tenant_id = ${tenantId}::uuid order by created_at, id`,
        )
      ).rows,
  );
}

const own = async (c: Company, tenantId: string) =>
  Object.fromEntries(
    (await m.consent.get(c.manager, tenantId)).subjects
      .find((x) => x.contactId === null)!
      .channels.map((x) => [x.channel, x.granted]),
  );

async function tenantActor(companyId: string, tenantId: string) {
  const [row] = await inSystem(companyId, (tx) =>
    tx
      .select({ personId: schema.tenant.personId })
      .from(schema.tenant)
      .where(sql`${schema.tenant.id} = ${tenantId}`),
  );
  return { kind: 'tenant' as const, personId: row!.personId!, authMethod: 'phone_otp' as const };
}

const smsFrom = (from: string, text: string, id: string) =>
  receive(
    ctx,
    m,
    'sms_inbound',
    JSON.stringify({ from: from.slice(1), to: '1440', content: text, messageId: id }),
  );

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = messagingServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now())));
  admin = await platform(ctx);
  agency = await companyWithUnits('agency', 'Review Agency', 'RVA');
  landlord = await companyWithUnits('landlord', 'Review Landlord', 'RVL');
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

describe('CM-09 MF-1 a keyword on the shared number goes to one landlord (founder decision, 2026-11-04)', () => {
  const notice = (companyId: string, tenantId: string, body: string) =>
    inSystem(companyId, (tx) =>
      queueMessage(tx, companyId, {
        recipient: { type: 'tenant', tenantId },
        purpose: 'broadcast',
        body,
        channels: ['whatsapp'],
        templateParams: { topic: 'water', notice: body },
      }),
    );
  const statusOf = async (companyId: string, id: string) =>
    (await messagesOf(ctx, companyId)).find((x) => x.id === id)!.status;

  it('withdraws nothing until the tenant picks a landlord, then only the picked one, which confirms in its own thread', async () => {
    const both = phone();
    const a = await tenant(agency, { phone: both, consent: ['whatsapp', 'sms'] });
    const l = await tenant(landlord, { phone: both, consent: ['whatsapp', 'sms'] });
    expect((await whatsappFrom(ctx, m, both, 'STOP')).outcomes).toEqual(['asked_landlord']);
    const question = m.whatsapp.sent.filter((x) => x.to === both).at(-1)!;
    expect(question.body).toContain('Which landlord');
    expect(await own(agency, a.id)).toMatchObject({ whatsapp: true });
    expect(await own(landlord, l.id)).toMatchObject({ whatsapp: true });
    // Until the answer, every landlord can still send.
    const before = await notice(agency.companyId, a.id, 'Water off on Saturday.');
    await work(ctx, m, agency.companyId);
    expect(await statusOf(agency.companyId, before)).toBe('sent');

    const answer = await whatsappFrom(ctx, m, both, 'Review Landlord', {
      choiceId: `landlord:${landlord.companyId}`,
    });
    expect(answer.outcomes).toEqual(['landlord_chosen']);
    expect(await own(landlord, l.id)).toMatchObject({ whatsapp: false, sms: true });
    expect(await own(agency, a.id)).toMatchObject({ whatsapp: true, sms: true });
    await work(ctx, m, landlord.companyId);
    const confirmation = (await messagesOfTenant(landlord.companyId, l.id)).find(
      (x) => x.purpose === 'opt_out_confirmation',
    )!;
    expect(confirmation.body).toContain('Review Landlord');
    expect(confirmation.body).not.toContain('Review Agency');
    expect((await messagesOfTenant(agency.companyId, a.id)).map((x) => x.body)).not.toContain(
      'STOP',
    );
    const after = await notice(agency.companyId, a.id, 'Water back on Sunday.');
    await work(ctx, m, agency.companyId);
    expect(await statusOf(agency.companyId, after)).toBe('sent');
  });

  it('applies an SMS STOP that waited on the question once the tenant answers, to the picked landlord only', async () => {
    const both = phone();
    const a = await tenant(agency, { phone: both, consent: ['sms'] });
    const l = await tenant(landlord, { phone: both, consent: ['sms'] });
    expect((await smsFrom(both, 'STOP', `stop-${a.id}`)).outcomes).toEqual(['asked_landlord']);
    expect(await own(agency, a.id)).toMatchObject({ sms: true });
    expect(await own(landlord, l.id)).toMatchObject({ sms: true });
    const question = s.sms.sent.filter((x) => x.to === both).at(-1)!;
    const number =
      question.body
        .split('\n')
        .slice(1)
        .findIndex((line) => line.includes('Review Landlord')) + 1;
    expect((await smsFrom(both, String(number), `stop-answer-${a.id}`)).outcomes).toEqual([
      'landlord_chosen',
    ]);
    expect(await own(landlord, l.id)).toMatchObject({ sms: false });
    expect(await own(agency, a.id)).toMatchObject({ sms: true });
  });

  it('applies a STOP at once when only one company knows the phone (rule 2)', async () => {
    const only = phone();
    const a = await tenant(agency, { phone: only, consent: ['whatsapp', 'sms'] });
    expect((await whatsappFrom(ctx, m, only, 'STOP')).outcomes).toEqual(['stop']);
    expect(await own(agency, a.id)).toMatchObject({ whatsapp: false, sms: true });
    expect(
      m.whatsapp.sent.filter((x) => x.to === only && x.body?.includes('Which landlord')),
    ).toEqual([]);
  });

  it('applies a STOP at once to the company that messaged the phone on this number in the last day (rule 1)', async () => {
    const both = phone();
    const a = await tenant(agency, { phone: both, consent: ['whatsapp', 'sms'] });
    const l = await tenant(landlord, { phone: both, consent: ['whatsapp', 'sms'] });
    const sent = await notice(agency.companyId, a.id, 'Fumigation on Monday.');
    await work(ctx, m, agency.companyId);
    expect(await statusOf(agency.companyId, sent)).toBe('sent');
    expect((await whatsappFrom(ctx, m, both, 'STOP')).outcomes).toEqual(['stop']);
    expect(await own(agency, a.id)).toMatchObject({ whatsapp: false });
    expect(await own(landlord, l.id)).toMatchObject({ whatsapp: true });
  });
});

describe('CM-01 MF-1 the "which landlord?" answer', () => {
  it('keeps every waiting message however long the answer takes, routes SMS too, asks from the code, and never reads the answer as a menu choice', async () => {
    const both = phone();
    await tenant(agency, { phone: both, consent: ['sms'] });
    const l = await tenant(landlord, { phone: both, consent: ['sms'] });
    expect((await smsFrom(both, 'The gate is broken', `ask-1-${l.id}`)).outcomes).toEqual([
      'asked_landlord',
    ]);
    const question = s.sms.sent.filter((x) => x.to === both).at(-1)!;
    expect(question.body).toContain('Which landlord');
    expect(question.senderId).toBe('1440');
    // The same message again (a provider retry) asks no second time.
    await smsFrom(both, 'The gate is broken', `ask-1-${l.id}`);
    expect(
      s.sms.sent.filter((x) => x.to === both && x.body.includes('Which landlord')),
    ).toHaveLength(1);
    ctx.clock.advance(25 * HOUR);
    try {
      expect((await smsFrom(both, 'And the tap', `ask-2-${l.id}`)).outcomes).toEqual([
        'asked_landlord',
      ]);
      const options = question.body.split('\n').slice(1);
      const number = options.findIndex((line) => line.includes('Review Landlord')) + 1;
      const answer = await smsFrom(both, String(number), `ask-3-${l.id}`);
      expect(answer.outcomes).toEqual(['landlord_chosen']);
    } finally {
      ctx.clock.advance(-25 * HOUR);
    }
    const there = (await messagesOfTenant(landlord.companyId, l.id)).filter(
      (x) => x.direction === 'inbound',
    );
    expect(there.map((x) => x.body)).toEqual([
      'The gate is broken',
      'And the tap',
      expect.stringMatching(/^\d$/),
    ]);
    // The bot never took the number as "1 Balance": no bot reply went for the answer.
    const replies = (await messagesOfTenant(landlord.companyId, l.id)).filter(
      (x) => x.purpose === 'bot_reply',
    );
    expect(replies).toEqual([]);
  });
});

describe('CM-09 M2 keywords typed in the app', () => {
  it('stops SMS with STOP, every channel with STOP ALL, and confirms in the thread', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['sms', 'whatsapp'] });
    const me = await tenantActor(agency.companyId, t.id);
    await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId: randomUUID(),
      body: 'stop',
      uploadIds: [],
    });
    expect(await own(agency, t.id)).toMatchObject({ sms: false, whatsapp: true });
    await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId: randomUUID(),
      body: 'STOP ALL',
      uploadIds: [],
    });
    expect(Object.values(await own(agency, t.id)).every((g) => g === false)).toBe(true);
    await work(ctx, m, agency.companyId);
    const thread = await m.tenantMessaging.messages(me, agency.companyId, { limit: 50 });
    expect(
      thread.items
        .filter((x) => x.fromLandlord)
        .map((x) => x.body)
        .join(' '),
    ).toContain('no longer');
  });
});

describe('CM-07 M4 the WhatsApp window is per number', () => {
  it('replies from the number the tenant wrote to, and starts a business message on the company number with a template', async () => {
    const c = await companyWithUnits('agency', 'Own Number Agency', 'OWN');
    await whatsappNumber(ctx, m, admin, {
      phoneNumberId: '100000000000888',
      wabaId: '200000000000888',
      kind: 'company',
      companyId: c.companyId,
      name: 'Own number',
    });
    const t = await tenant(c, { phone: phone(), consent: ['whatsapp'] });
    await whatsappFrom(ctx, m, t.phone!, 'AGENT');
    await work(ctx, m, c.companyId);
    const conversation = (await m.inbox.tenantConversation(c.manager, t.id)).conversation!;
    const detail = await m.inbox.conversation(c.manager, conversation.id);
    expect(detail.channels.find((x) => x.channel === 'whatsapp')!.mode).toBe('free_text');
    await m.inbox.reply(c.manager, conversation.id, {
      clientMessageId: randomUUID(),
      channel: 'whatsapp',
      body: 'On our way.',
    });
    await work(ctx, m, c.companyId);
    const reply = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    expect(reply).toMatchObject({ from: SHARED_NUMBER, type: 'text' });
    await inSystem(c.companyId, (tx) =>
      queueMessage(tx, c.companyId, {
        recipient: { type: 'tenant', tenantId: t.id },
        purpose: 'broadcast',
        body: 'Fumigation on Monday.',
        templateParams: { topic: 'fumigation', notice: 'Fumigation on Monday.' },
      }),
    );
    await work(ctx, m, c.companyId);
    const notice = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    expect(notice).toMatchObject({ from: '100000000000888', type: 'template' });
  });
});

describe('CM-05 MF-2 a tenant between leases', () => {
  it('reads back their own app message and the staff reply after the lease has ended', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['sms'] });
    await asSuperuser(ctx, `update lease set status = 'ended' where id = $1`, [t.leaseId]);
    const me = await tenantActor(agency.companyId, t.id);
    const sent = await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId: randomUUID(),
      body: 'Can I have my deposit back?',
      uploadIds: [],
    });
    expect(sent.body).toBe('Can I have my deposit back?');
    const conversation = (await m.inbox.tenantConversation(agency.manager, t.id)).conversation!;
    await m.inbox.reply(agency.manager, conversation.id, {
      clientMessageId: randomUUID(),
      channel: 'in_app',
      body: 'Yes, this week.',
    });
    await work(ctx, m, agency.companyId);
    const thread = await m.tenantMessaging.messages(me, agency.companyId, { limit: 50 });
    expect(thread.items.map((x) => x.body)).toEqual(
      expect.arrayContaining(['Can I have my deposit back?', 'Yes, this week.']),
    );
  });
});

describe('CM-05 C4 C5 replies', () => {
  it('answers 409 to a reply on a resolved conversation and 422 to a reused id with other words', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['sms'] });
    await smsFrom(t.phone!, 'Hello', `c4-${t.id}`);
    const conversation = (await m.inbox.tenantConversation(agency.manager, t.id)).conversation!;
    const id = randomUUID();
    await m.inbox.reply(agency.manager, conversation.id, {
      clientMessageId: id,
      channel: 'sms',
      body: 'Hi there.',
    });
    await expect(
      m.inbox.reply(agency.manager, conversation.id, {
        clientMessageId: id,
        channel: 'sms',
        body: 'Something else.',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    const again = await m.inbox.reply(agency.manager, conversation.id, {
      clientMessageId: id,
      channel: 'sms',
      body: 'Hi there.',
    });
    expect(again.id).toBe(id);
    await m.inbox.resolve(agency.manager, conversation.id);
    await expect(
      m.inbox.reply(agency.manager, conversation.id, {
        clientMessageId: randomUUID(),
        channel: 'sms',
        body: 'One more thing.',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conversation_resolved' });
    // The tenant app's send follows the same rule.
    const me = await tenantActor(agency.companyId, t.id);
    const appId = randomUUID();
    await m.tenantMessaging.send(me, agency.companyId, {
      clientMessageId: appId,
      body: 'First',
      uploadIds: [],
    });
    await expect(
      m.tenantMessaging.send(me, agency.companyId, {
        clientMessageId: appId,
        body: 'Second',
        uploadIds: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
  });
});

describe('CM-09 a reply right after STOP, and a message queued before it', () => {
  it('refuses a WhatsApp reply to the STOP itself and withholds a message queued before the STOP', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp'] });
    const queued = await inSystem(agency.companyId, (tx) =>
      queueMessage(tx, agency.companyId, {
        recipient: { type: 'tenant', tenantId: t.id },
        purpose: 'broadcast',
        body: 'Water off on Saturday.',
        channels: ['whatsapp'],
        templateParams: { topic: 'water', notice: 'Water off on Saturday.' },
      }),
    );
    await whatsappFrom(ctx, m, t.phone!, 'STOP');
    await work(ctx, m, agency.companyId);
    expect((await messagesOf(ctx, agency.companyId)).find((x) => x.id === queued)!.status).toBe(
      'not_sent',
    );
    const conversation = (await m.inbox.tenantConversation(agency.manager, t.id)).conversation!;
    await expect(
      m.inbox.reply(agency.manager, conversation.id, {
        clientMessageId: randomUUID(),
        channel: 'whatsapp',
        body: 'Sorry to see you go.',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'channel_unavailable' });
  });
});

describe('CM-08 W3 broadcast previews', () => {
  it('makes a new broadcast of the same words previewed later, one of two confirmations at once, and leaves former tenants out', async () => {
    const c = await companyWithUnits('agency', 'Preview Agency', 'PRV');
    await tenant(c, { phone: phone(), consent: ['sms'] });
    const former = await tenant(c, { phone: phone(), consent: ['sms'] });
    await asSuperuser(ctx, `update lease set status = 'ended' where id = $1`, [former.leaseId]);
    const content = {
      audience: { kind: 'property' as const, propertyId: c.propertyId },
      topic: 'water',
      body: 'No water on Saturday.',
    };
    const first = await m.broadcasts.preview(c.manager, content);
    expect(first.audienceCount).toBe(1);
    const [x, y] = await Promise.all([
      m.broadcasts.create(c.manager, { ...content, previewToken: first.previewToken }),
      m.broadcasts.create(c.manager, { ...content, previewToken: first.previewToken }),
    ]);
    expect(x.id).toBe(y.id);
    ctx.clock.advance(MINUTE);
    try {
      const later = await m.broadcasts.preview(c.manager, content);
      expect(later.previewToken).not.toBe(first.previewToken);
      const second = await m.broadcasts.create(c.manager, {
        ...content,
        previewToken: later.previewToken,
      });
      expect(second.id).not.toBe(x.id);
      ctx.clock.advance(31 * MINUTE);
      await expect(
        m.broadcasts.create(c.manager, { ...content, previewToken: later.previewToken }),
      ).resolves.toMatchObject({ id: second.id });
      const stale = await m.broadcasts.preview(c.manager, { ...content, body: 'Stale' });
      ctx.clock.advance(31 * MINUTE);
      await expect(
        m.broadcasts.create(c.manager, {
          ...content,
          body: 'Stale',
          previewToken: stale.previewToken,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'preview_expired' });
    } finally {
      ctx.clock.advance(-63 * MINUTE);
    }
  });
});

describe('CM-09 L1 L3 L5 email: the unsubscribe link', () => {
  it('goes on a staff email reply outside the reply window, works past its date while the address matches, and changes nothing once the address changed', async () => {
    const email = `review-${phones}@example.org`;
    const t = await tenant(agency, { email, consent: ['email'] });
    const started = await m.inbox.startConversation(agency.manager, t.id);
    await m.inbox
      .reply(agency.manager, started.id, {
        clientMessageId: randomUUID(),
        channel: 'email',
        subject: 'Your gate',
        body: 'The gate is fixed.',
      })
      .catch(async (error: { code?: string }) => {
        if (error.code !== 'conversation_resolved') throw error;
        await m.inbox.reopen(agency.manager, started.id);
        return m.inbox.reply(agency.manager, started.id, {
          clientMessageId: randomUUID(),
          channel: 'email',
          subject: 'Your gate',
          body: 'The gate is fixed.',
        });
      });
    await work(ctx, m, agency.companyId);
    const sent = s.email.lastTo(email)!;
    const header = sent.headers?.['List-Unsubscribe'] ?? '';
    expect(header).toContain('/u/');
    const token = header.split('/u/')[1]!.split('/')[0]!;
    ctx.clock.advance(400 * 24 * HOUR);
    try {
      expect(await m.consent.unsubscribe(token, false)).toMatchObject({ screen: 'confirm' });
    } finally {
      ctx.clock.advance(-400 * 24 * HOUR);
    }
    await s.tenants.update(agency.manager, t.id, { email: `changed-${phones}@example.org` });
    expect(await m.consent.unsubscribe(token, true)).toEqual({
      screen: 'address_changed',
      landlordName: expect.any(String),
      emailMasked: null,
    });
    const rows = await inSystem(agency.companyId, (tx) =>
      tx.execute(
        sql`select 1 from consent_event where tenant_id = ${t.id}::uuid and source = 'email_unsubscribe'`,
      ),
    );
    expect(rows.rows).toEqual([]);
  });
});

describe('BC-04 C2 the pay link’s channels', () => {
  it('names the consented channels in the order they will be tried', async () => {
    const both = await tenant(agency, { phone: phone(), consent: ['whatsapp', 'sms'] });
    const smsOnly = await tenant(agency, { phone: phone(), consent: ['sms'] });
    const planned = (tenantId: string) =>
      inSystem(agency.companyId, (tx) =>
        m.messaging.plannedChannels(tx, agency.companyId, {
          recipient: { type: 'tenant', tenantId },
          purpose: 'pay_link',
          channels: ['push', 'whatsapp', 'sms', 'email'],
          link: { purpose: 'pay', targetId: tenantId },
        }),
      );
    expect(await planned(both.id)).toEqual(['whatsapp', 'sms']);
    expect(await planned(smsOnly.id)).toEqual(['sms']);
  });
});

describe('TL-12 S-5 T-1 what a tenant sees in the app', () => {
  it('shows no contact’s messages, and no attachment or upload across landlords, with real ids', async () => {
    const both = phone();
    const a = await tenant(agency, { phone: both, consent: ['sms'] });
    const l = await tenant(landlord, { phone: both, consent: ['sms'] });
    const contact = await s.tenants.addContact(agency.manager, a.id, {
      kind: 'guarantor',
      name: 'Guarantor',
      phone: phone(),
    });
    await smsFrom(contact.phone!, 'I am the guarantor', `g-${a.id}`);
    const me = await tenantActor(agency.companyId, a.id);
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
      'hex',
    );
    const upload = await m.tenantMessaging.createPhotoUpload(me, landlord.companyId, {
      contentType: 'image/png',
      sizeBytes: png.length,
    });
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: png,
      contentType: 'image/png',
    });
    // The landlord's upload cannot be sent to the agency.
    await expect(
      m.tenantMessaging.send(me, agency.companyId, {
        clientMessageId: randomUUID(),
        body: '',
        uploadIds: [upload.uploadId],
      }),
    ).rejects.toMatchObject({ status: 404 });
    const photo = await m.tenantMessaging.send(me, landlord.companyId, {
      clientMessageId: randomUUID(),
      body: 'The tap',
      uploadIds: [upload.uploadId],
    });
    const attachment = photo.attachments[0]!;
    await expect(
      m.tenantMessaging.attachmentDownload(me, landlord.companyId, photo.id, attachment.id),
    ).resolves.toMatchObject({ url: expect.any(String) });
    await expect(
      m.tenantMessaging.attachmentDownload(me, agency.companyId, photo.id, attachment.id),
    ).rejects.toMatchObject({ status: 404 });
    const thread = await m.tenantMessaging.messages(me, agency.companyId, { limit: 50 });
    expect(thread.items.map((x) => x.body)).not.toContain('I am the guarantor');
    expect(l.id).toBeTruthy();
  });
});

describe('CM-06 S-9 T-2 the live inbox with a caretaker of the same company', () => {
  it('tells a caretaker of their own property, not of another', async () => {
    const c = await companyWithUnits('agency', 'Stream Agency', 'STR');
    const otherOwner = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Second owner' })
    ).id;
    const other = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'ST2',
      ownerId: otherOwner,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
    });
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Stream caretaker', {
      properties: [c.propertyId],
    });
    const seen: string[] = [];
    const stop = await m.stream.subscribe(caretaker, (e) => seen.push(e.conversationId));
    try {
      const mine = await tenant(c, { phone: phone(), consent: ['sms'] });
      const { tenant: elsewhere } = await s.tenants.create(c.manager, {
        kind: 'individual',
        displayName: 'Elsewhere',
        phone: phone(),
      });
      await billedLease(ctx, s, b, c.manager, {
        unitId: Object.values(other.units)[0]!,
        tenantId: elsewhere.id,
        startDate: today,
        endDate: toIsoDate(addDays(parseBusinessDate(today), 364)),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        signedOn: today,
      });
      await smsFrom(mine.phone!, 'Mine', `str-1-${mine.id}`);
      await smsFrom(elsewhere.phone!, 'Elsewhere', `str-2-${elsewhere.id}`);
      const mineConversation = (await m.inbox.tenantConversation(c.manager, mine.id)).conversation!;
      const otherConversation = (await m.inbox.tenantConversation(c.manager, elsewhere.id))
        .conversation!;
      for (let i = 0; i < 50 && !seen.includes(mineConversation.id); i += 1)
        await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toContain(mineConversation.id);
      expect(seen).not.toContain(otherConversation.id);
      expect(await m.stream.stillAllowed(caretaker)).toBe(true);
      await asSuperuser(ctx, `update membership set status = 'revoked' where id = $1`, [
        caretaker.membershipId,
      ]);
      expect(await m.stream.stillAllowed(caretaker)).toBe(false);
    } finally {
      stop();
    }
  });
});

describe('CM-02 S-3 a signed body that cannot be read', () => {
  it('is kept as ignored and unparsed', async () => {
    const raw = '{"object": "whatsapp_business_account", "entry": [';
    const signature = `sha256=${createHmac('sha256', DEV_WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
    expect((await receive(ctx, m, 'whatsapp', raw, signature)).stored).toBe('ignored');
    const rows = await import('@rent/db').then(({ withSystem }) =>
      withSystem(ctx.database, {}, (tx) =>
        tx.execute<{ status: string; outcome: string }>(
          sql`select status, outcome from webhook_inbox where event_id like 'unparsed:%'`,
        ),
      ),
    );
    expect(rows.rows).toEqual([{ status: 'ignored', outcome: 'unparsed' }]);
    expect(await conversationsOf(ctx, agency.companyId)).toBeDefined();
  });
});

describe('CM-03 the bot’s figures and Starter', () => {
  it('states the amount due and paid-until exactly as the billing reads have them', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp'] });
    await whatsappFrom(ctx, m, t.phone!, 'Hi');
    await whatsappFrom(ctx, m, t.phone!, 'BALANCE');
    await work(ctx, m, agency.companyId);
    const card = await moneyCard(ctx, b, agency.companyId, t.leaseId);
    const reply = m.whatsapp.sent.filter((x) => x.to === t.phone).at(-1)!;
    expect(reply.body).toContain(
      card.dueNowMinor > 0 ? format(money(card.dueNowMinor)) : 'Nothing is due now.',
    );
    if (card.paidUntil) expect(reply.body).toContain(formatBusinessDate(card.paidUntil));
  });

  it('passes a Starter tenant’s message to the landlord by email and SMS, and opens no inbox', async () => {
    const c = await companyWithUnits('landlord', 'Starter Landlord', 'STL');
    await m.entitlements.setCompanyPlan(admin, c.companyId, 'starter');
    const t = await tenant(c, { phone: phone(), consent: ['sms'] });
    expect((await smsFrom(t.phone!, 'The roof leaks', `starter-${t.id}`)).outcomes).toEqual([
      'forwarded',
    ]);
    await work(ctx, m, c.companyId);
    const forwarded = (await messagesOf(ctx, c.companyId)).filter(
      (x) => x.recipient_type === 'staff',
    );
    expect(forwarded.length).toBeGreaterThanOrEqual(1);
    expect(forwarded[0]!.body).toContain('The roof leaks');
    await expect(
      m.inbox.conversations(c.manager, { view: 'all', limit: 10 }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('CM-04 a repair on real reprocessing', () => {
  it('makes one ticket when the whole conversation is processed again', async () => {
    const t = await tenant(agency, { phone: phone(), consent: ['whatsapp'] });
    for (const text of ['Hi', 'REPAIR', 'The window will not close', 'DONE'])
      await whatsappFrom(ctx, m, t.phone!, text);
    const { withSystem } = await import('@rent/db');
    const rows = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from webhook_inbox where provider = 'messaging.whatsapp' order by received_at`,
      ),
    );
    // As a worker would after a crash: the rows again, as received.
    await withSystem(ctx.database, {}, (tx) =>
      tx.execute(
        sql`update webhook_inbox set status = 'received' where provider = 'messaging.whatsapp'`,
      ),
    ).catch(() => undefined);
    for (const r of rows.rows) await m.inbound.process(r.id).catch(() => 'skipped');
    const jobs = await inSystem(agency.companyId, (tx) =>
      tx
        .select()
        .from(schema.maintenanceJob)
        .where(sql`${schema.maintenanceJob.tenantId} = ${t.id}`),
    );
    expect(jobs).toHaveLength(1);
  });
});
