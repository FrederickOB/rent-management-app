import { createHash, createHmac } from 'node:crypto';
import { and, eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import type { InterimPlan } from '@rent/domain/settings';
import { v5 as uuidv5 } from 'uuid';
import type { EntitlementsService } from '../src/companies/entitlements.service';
import type { Clock } from '../src/core/clock';
import {
  emailInboundDomainOf,
  messagingWebhookSecretOf,
  whatsappAppSecretOf,
  type AppConfig,
} from '../src/core/config';
import type {
  BroadcastsService,
  InboundService,
  InboxService,
  MessagingConsentService,
  MessagingSettingsService,
  MessagingWebhookKind,
} from '../src/messaging';
import { base32Lower, ensureTenantConversation } from '../src/messaging/store';

/**
 * The M6 demo data (plan 4.14): the shared WhatsApp number and the agency's own, template
 * approvals (one pending), WhatsApp consent for most tenants and one STOP, conversations (a bot
 * exchange with a handover, an SMS thread, an email reply by token, an unknown number in triage,
 * an overdue unassigned conversation), a repair reported on WhatsApp, a broadcast to ACC-LEG,
 * and the interim plans (decision 9: the agency on Growth, the landlord on Starter).
 *
 * Messages come in through the real pipeline (signed webhooks, the inbox, the process step), so
 * the bot answers and the conversations take their states as they would live. Every inbound
 * message has a fixed provider id, so a second run stores nothing new. Replies the bot and staff
 * queue go out when the worker runs, through the fake providers; the broadcast's stats fill then.
 */

/** The fake provider's default numbers (apps/fake-providers whatsapp.ts). */
export const SHARED_PHONE_NUMBER_ID = '100000000000001';
export const SHARED_WABA_ID = '200000000000001';
export const AGENCY_PHONE_NUMBER_ID = '100000000000002';
export const AGENCY_WABA_ID = '200000000000002';
/** The template left pending on both numbers, so the composer's fallback shows (CM-07). */
const PENDING_TEMPLATE = 'renewal_reminder';
const NAMESPACE = '7d3d0f0e-3b9a-4f7e-9a55-5c1f1d0b6a21';
/** Tenants without WhatsApp consent in the demo (M6 review E2). */
const SMS_ONLY = ['Kwesi Queue', 'Kofi Arrears-45', 'Ama Tenant', 'Yaw No-Clause'];

export interface MessagingSeedDeps {
  readonly database: Database;
  readonly config: AppConfig;
  readonly clock: Clock & { offsetMs: number };
  readonly entitlements: EntitlementsService;
  readonly settings: MessagingSettingsService;
  readonly consent: MessagingConsentService;
  readonly inbound: InboundService;
  readonly inbox: InboxService;
  readonly broadcasts: BroadcastsService;
  readonly companies: {
    readonly platform: string;
    readonly agency: string;
    readonly landlord: string;
  };
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
}

export interface MessagingSeedResult {
  readonly numbers: number;
  readonly consents: number;
  readonly inbound: Record<string, string>;
  readonly broadcast: 'created' | 'exists' | 'none';
  readonly conversations: Record<string, number>;
  readonly repairs: number;
}

export async function ensureMessaging(deps: MessagingSeedDeps): Promise<MessagingSeedResult> {
  const { database, companies } = deps;
  const admin = await platformAdmin(database, companies.platform);

  // Plans (decision 9).
  const plans: [string, InterimPlan][] = [
    [companies.agency, 'growth'],
    [companies.landlord, 'starter'],
  ];
  for (const [companyId, plan] of plans)
    await deps.entitlements.setCompanyPlan(admin, companyId, plan);

  // Numbers (decision 3).
  const existing = await deps.settings.numbers(admin);
  const wanted = [
    {
      phoneNumberId: SHARED_PHONE_NUMBER_ID,
      wabaId: SHARED_WABA_ID,
      displayPhone: '+233302000001',
      displayName: 'Rent Platform',
      kind: 'shared' as const,
      companyId: null,
    },
    {
      phoneNumberId: AGENCY_PHONE_NUMBER_ID,
      wabaId: AGENCY_WABA_ID,
      displayPhone: '+233302000002',
      displayName: 'Osu Ridge Property Managers',
      kind: 'company' as const,
      companyId: companies.agency,
    },
  ];
  let numbers = 0;
  for (const n of wanted) {
    if (existing.some((e) => e.phoneNumberId === n.phoneNumberId && e.status === 'active'))
      continue;
    await deps.settings.registerNumber(admin, n);
    numbers += 1;
  }

  // Template approvals on both numbers: all approved but one (CM-07).
  await withSystem(
    database,
    { personId: admin.personId, actorKind: 'platform_admin' },
    async (tx) => {
      const accounts = await tx.execute<{ id: string; phone_number_id: string; status: string }>(
        sql`select id, phone_number_id, status from app.whatsapp_accounts()`,
      );
      const templates = await tx.select().from(schema.messageTemplate);
      for (const a of accounts.rows.filter((r) => r.status === 'active'))
        for (const t of templates)
          await tx.execute(
            sql`select app.record_whatsapp_template_status(${a.id}::uuid, ${t.id}::uuid,
                ${t.key === PENDING_TEMPLATE ? 'pending' : 'approved'}, ${t.category}, ${`seed-${a.phone_number_id}-${t.whatsappName}`}, null)`,
          );
    },
  );

  // WhatsApp consent for most of the agency's tenants, and the landlord's. Kwesi Queue has none;
  // Kofi Arrears-45 and Ama Tenant stay SMS-only, as the M4b seed and its pay-link and receipt
  // specs describe them (M6 review E2). Yaw No-Clause, whom the M7 seed adds after this runs, stays
  // SMS-only too, or a second seed would grant him WhatsApp.
  const manager = await deps.actor(companies.agency, 'manager.one@demo.invalid');
  const landlord = await deps.actor(companies.landlord, 'landlord@demo.invalid');
  let consents = 0;
  for (const [actor, companyId] of [
    [manager, companies.agency],
    [landlord, companies.landlord],
  ] as const) {
    const tenants = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select({
          id: schema.tenant.id,
          name: schema.tenant.displayName,
          phone: schema.tenant.phone,
        })
        .from(schema.tenant),
    );
    for (const t of tenants) {
      if (!t.phone || SMS_ONLY.some((name) => t.name.startsWith(name))) continue;
      const current = await deps.consent.get(actor, t.id);
      const whatsapp = current.subjects
        .find((s) => s.contactId === null)
        ?.channels.find((c) => c.channel === 'whatsapp');
      // Granted already, or withdrawn (the STOP below): left as it is.
      if (whatsapp?.source) continue;
      await deps.consent.record(actor, t.id, { channel: 'whatsapp', action: 'grant' });
      consents += 1;
    }
  }

  // Conversations, through the real pipeline.
  const inbound: Record<string, string> = {};
  const wa = (n: number, from: string, text: string, phoneNumberId = AGENCY_PHONE_NUMBER_ID) =>
    deliver(deps, 'whatsapp', whatsappBody(n, from, text, phoneNumberId), `msg:wamid.seed.${n}`);

  // A bot exchange with a handover: Kwame asks for his balance, then for a person.
  inbound.botHi = await wa(1, '+233200000031', 'Hi');
  inbound.botBalance = await wa(2, '+233200000031', 'BALANCE');
  inbound.botPerson = await wa(3, '+233200000031', 'AGENT');

  // A repair on WhatsApp: the bot makes the ticket and answers with its number (CM-04).
  inbound.repairHi = await wa(10, '+233200000038', 'Hello');
  inbound.repairStart = await wa(11, '+233200000038', 'REPAIR');
  inbound.repairText = await wa(
    12,
    '+233200000038',
    'The kitchen tap is leaking and the cabinet under the sink is wet.',
  );
  inbound.repairDone = await wa(13, '+233200000038', 'DONE');

  // One tenant sent STOP (decision 7): every channel withdrawn, one confirmation.
  inbound.stop = await wa(20, '+233200000039', 'STOP');

  // An unknown number on the agency's number: triage (CM-02).
  inbound.triage = await wa(
    30,
    '+233200000099',
    'Hello, I saw your sign at Osu. Is a shop still available to rent?',
  );

  // An SMS thread: Kofi writes, the manager answers by SMS.
  inbound.sms = await deliver(
    deps,
    'sms_inbound',
    JSON.stringify({
      from: '233200000036',
      to: '1440',
      content: 'Sorry for the delay. I will pay the rest on Friday.',
      messageId: 'seed-sms-1',
      date: new Date().toISOString(),
    }),
    'in:seed-sms-1',
  );
  const kofi = await tenantByPhone(database, companies.agency, '+233200000036');
  if (kofi) {
    const conversation = (await deps.inbox.tenantConversation(manager, kofi)).conversation;
    if (conversation)
      await deps.inbox.reply(manager, conversation.id, {
        clientMessageId: uuidv5('seed-sms-reply-1', NAMESPACE),
        channel: 'sms',
        body: 'Thank you, Kofi. Friday is fine; we will send your receipt when it arrives.',
      });
  }

  // An email reply that threads back by its reply token (CM-10): the pharmacy answers an email.
  const pharmacy = await tenantByEmail(database, companies.agency, 'accounts@pharmacy.invalid');
  if (pharmacy) {
    const token = base32Lower(
      createHmac('sha256', deps.config.BETTER_AUTH_SECRET).update('seed-reply-token-1').digest(),
    );
    await withCompany(
      database,
      { companyId: companies.agency, actorKind: 'system' },
      async (tx) => {
        const conversation = await ensureTenantConversation(tx, companies.agency, pharmacy);
        await tx
          .insert(schema.replyAddress)
          .values({
            companyId: companies.agency,
            conversationId: conversation.id,
            tokenHash: createHash('sha256').update(token).digest('hex'),
          })
          .onConflictDoNothing();
      },
    );
    inbound.email = await deliver(
      deps,
      'email_inbound',
      JSON.stringify({
        From: 'Osu Pharmacy Accounts <accounts@pharmacy.invalid>',
        FromFull: { Email: 'accounts@pharmacy.invalid', Name: 'Osu Pharmacy Accounts' },
        To: `reply+${token}@${emailInboundDomainOf(deps.config)}`,
        ToFull: [{ Email: `reply+${token}@${emailInboundDomainOf(deps.config)}`, Name: '' }],
        Subject: 'Re: Your receipt',
        MessageID: 'seed-email-1',
        TextBody:
          'Thank you for the receipt. Our withholding certificate for October follows next week.\n\nOn Monday you wrote: ...',
        StrippedTextReply:
          'Thank you for the receipt. Our withholding certificate for October follows next week.',
        Attachments: [],
      }),
      'in:seed-email-1',
    );
  }

  // An overdue, unassigned conversation: Esi's SMS arrived six hours ago (the target is 4 hours).
  deps.clock.offsetMs -= 6 * 3_600_000;
  try {
    inbound.overdue = await deliver(
      deps,
      'sms_inbound',
      JSON.stringify({
        from: '233200000037',
        to: '1440',
        content: 'Good morning. The water has been off in our block since yesterday. Please help.',
        messageId: 'seed-sms-2',
        date: new Date(deps.clock.now()).toISOString(),
      }),
      'in:seed-sms-2',
    );
  } finally {
    deps.clock.offsetMs += 6 * 3_600_000;
  }

  // A broadcast to ACC-LEG (CM-08), once.
  let broadcast: MessagingSeedResult['broadcast'] = 'none';
  const leg = await withCompany(
    database,
    { companyId: companies.agency, actorKind: 'system' },
    async (tx) => {
      const [p] = await tx
        .select({ id: schema.property.id })
        .from(schema.property)
        .where(eq(schema.property.code, 'ACC-LEG'));
      if (!p) return null;
      const [b] = await tx
        .select({ id: schema.broadcast.id })
        .from(schema.broadcast)
        .where(
          and(eq(schema.broadcast.propertyId, p.id), eq(schema.broadcast.topic, 'water supply')),
        );
      return { propertyId: p.id, exists: Boolean(b) };
    },
  );
  if (leg?.exists) broadcast = 'exists';
  else if (leg) {
    const content = {
      audience: { kind: 'property' as const, propertyId: leg.propertyId },
      topic: 'water supply',
      body: 'Ghana Water will cut the supply to the compound on Saturday from 8 a.m. to 2 p.m. for pipe repairs. Please store water on Friday evening.',
    };
    const preview = await deps.broadcasts.preview(manager, content);
    const created = await deps.broadcasts.create(manager, {
      ...content,
      previewToken: preview.previewToken,
    });
    for (let batch = 0; batch < Math.ceil(created.queuedCount / 50); batch += 1)
      await deps.broadcasts.fanout(companies.agency, created.id, batch);
    broadcast = 'created';
  }

  const conversations = await withCompany(
    database,
    { companyId: companies.agency, actorKind: 'system' },
    async (tx) => {
      const rows = await tx.execute<{ state: string; n: number }>(
        sql`select state, count(*)::int as n from conversation group by state`,
      );
      return Object.fromEntries(rows.rows.map((r) => [r.state, r.n]));
    },
  );
  const repairs = await withCompany(
    database,
    { companyId: companies.agency, actorKind: 'system' },
    async (tx) =>
      (await tx.select({ id: schema.maintenanceJob.id }).from(schema.maintenanceJob)).length,
  );
  return { numbers, consents, inbound, broadcast, conversations, repairs };
}

async function platformAdmin(
  database: Database,
  platform: string,
): Promise<Extract<Actor, { kind: 'platform_admin' }>> {
  const rows = await withSystem(database, {}, (tx) =>
    tx.execute<{ person_id: string; membership_id: string }>(
      sql`select p.id as person_id, m.membership_id from person p, app.memberships_for_person(p.id) m
          where p.email = 'admin@demo.invalid' and m.company_id = ${platform}::uuid and m.status = 'active'`,
    ),
  );
  const row = rows.rows[0];
  if (!row) throw new Error('no platform admin in the seed');
  return {
    kind: 'platform_admin',
    personId: row.person_id,
    companyId: platform,
    membershipId: row.membership_id,
    authMethod: 'password_totp',
  };
}

/** Stores a webhook as the provider would send it, then processes it as the worker would. */
async function deliver(
  deps: MessagingSeedDeps,
  kind: MessagingWebhookKind,
  rawBody: string,
  eventId: string,
): Promise<string> {
  const bytes = Buffer.from(rawBody, 'utf8');
  const headers: Record<string, string> = {};
  let secret: string | null = null;
  if (kind === 'whatsapp')
    headers['x-hub-signature-256'] = `sha256=${createHmac(
      'sha256',
      whatsappAppSecretOf(deps.config) ?? '',
    )
      .update(bytes)
      .digest('hex')}`;
  else
    secret = messagingWebhookSecretOf(
      deps.config,
      kind === 'sms_inbound'
        ? 'sms_inbound'
        : kind === 'sms_status'
          ? 'sms_status'
          : kind === 'email_inbound'
            ? 'email_inbound'
            : 'email_events',
    );
  const stored = await deps.inbound.intake(kind, bytes, { headers, secret });
  if (stored !== 'stored') return stored;
  const provider = `messaging.${kind.startsWith('sms') ? 'sms' : kind.startsWith('email') ? 'email' : 'whatsapp'}`;
  const [row] = await withSystem(deps.database, {}, (tx) =>
    tx
      .select({ id: schema.webhookInbox.id })
      .from(schema.webhookInbox)
      .where(
        and(eq(schema.webhookInbox.provider, provider), eq(schema.webhookInbox.eventId, eventId)),
      ),
  );
  return row ? deps.inbound.process(row.id) : 'missing';
}

function whatsappBody(n: number, from: string, text: string, phoneNumberId: string): string {
  const waId = from.slice(1);
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: phoneNumberId === SHARED_PHONE_NUMBER_ID ? SHARED_WABA_ID : AGENCY_WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '233302000002', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Seed contact' }, wa_id: waId }],
              messages: [
                {
                  from: waId,
                  id: `wamid.seed.${n}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function tenantByPhone(
  database: Database,
  companyId: string,
  phone: string,
): Promise<string | null> {
  const [t] = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
    tx.select({ id: schema.tenant.id }).from(schema.tenant).where(eq(schema.tenant.phone, phone)),
  );
  return t?.id ?? null;
}

async function tenantByEmail(
  database: Database,
  companyId: string,
  email: string,
): Promise<string | null> {
  const [t] = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
    tx.select({ id: schema.tenant.id }).from(schema.tenant).where(eq(schema.tenant.email, email)),
  );
  return t?.id ?? null;
}
