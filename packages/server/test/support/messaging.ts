import { createHash } from 'node:crypto';
import { schema, sql, withCompany, withSystem } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { CallbackAlert, InMemoryPush, InMemoryWhatsApp, type Alert } from '@rent/integrations';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { DEV_WEBHOOK_SECRET, DEV_WHATSAPP_APP_SECRET } from '../../src/core/config';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import { TasksService } from '../../src/tasks/tasks.service';
import { MaintenanceService } from '../../src/maintenance/maintenance.service';
import { BotService } from '../../src/messaging/bot.service';
import { BROADCAST_FANOUT_JOB, BroadcastsService } from '../../src/messaging/broadcasts.service';
import { MessagingConsentService } from '../../src/messaging/consent.service';
import {
  FETCH_MEDIA_JOB,
  InboundService,
  type MessagingWebhookKind,
} from '../../src/messaging/inbound.service';
import { InboxStreamService } from '../../src/messaging/inbox-stream.service';
import { InboxService } from '../../src/messaging/inbox.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { MessagingOperationsService } from '../../src/messaging/operations.service';
import { MessagingSettingsService } from '../../src/messaging/settings.service';
import { registerSigningRecipients } from '../../src/messaging/signing-recipients';
import { TemplatesService } from '../../src/messaging/templates.service';
import { TenantMessagingService } from '../../src/messaging/tenant-messaging.service';
import { registerMessageTimeline } from '../../src/messaging/timeline';
import type { BillingServices } from './billing';
import { company, member, person, type ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

export const SHARED_NUMBER = '100000000000001';
export const SHARED_WABA = '200000000000001';

const silentLogger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as never;

/** The M6 services wired as Nest wires them, with in-memory WhatsApp and push (CLAUDE.md 12). */
export function messagingServices(ctx: ServerTestContext, s: TenancyServices, b: BillingServices) {
  const whatsapp = new InMemoryWhatsApp(DEV_WHATSAPP_APP_SECRET);
  const push = new InMemoryPush();
  const alerts: Alert[] = [];
  const alertPort = new CallbackAlert((alert) => {
    alerts.push(alert);
  });
  const entitlements = new EntitlementsService(ctx.database, s.policy);
  const maintenance = new MaintenanceService(
    ctx.database,
    s.policy,
    entitlements,
    s.documents,
    new TasksService(ctx.database, s.policy, ctx.clock),
    ctx.clock,
  );
  const messaging = new MessagingService(
    ctx.database,
    s.sms,
    s.email,
    ctx.config,
    s.tenants,
    s.idChecks,
    whatsapp,
    push,
    s.documents,
    ctx.clock,
  );
  registerSigningRecipients(messaging, s.esign, s.tenants);
  registerMessageTimeline(s.tenants, messaging);
  const templates = new TemplatesService(ctx.database, s.policy, whatsapp);
  const bot = new BotService(
    ctx.database,
    s.policy,
    b.read,
    s.documents,
    maintenance,
    entitlements,
  );
  const inbound = new InboundService(
    ctx.database,
    ctx.config,
    ctx.clock,
    alertPort,
    s.sms,
    s.email,
    s.tenants,
    entitlements,
    s.policy,
    maintenance,
    s.documents,
    messaging,
    bot,
    templates,
    whatsapp,
  );
  const inbox = new InboxService(
    ctx.database,
    ctx.clock,
    s.policy,
    entitlements,
    s.tenants,
    s.documents,
  );
  return {
    whatsapp,
    push,
    alerts,
    entitlements,
    maintenance,
    messaging,
    templates,
    bot,
    inbound,
    inbox,
    broadcasts: new BroadcastsService(
      ctx.database,
      ctx.config,
      ctx.clock,
      s.policy,
      entitlements,
      s.tenants,
    ),
    consent: new MessagingConsentService(ctx.database, ctx.clock, ctx.config, s.policy, s.tenants),
    settings: new MessagingSettingsService(ctx.database, s.policy, entitlements),
    tenantMessaging: new TenantMessagingService(
      ctx.database,
      ctx.clock,
      s.policy,
      s.documents,
      inbox,
      inbound,
    ),
    operations: new MessagingOperationsService(
      ctx.database,
      ctx.config,
      ctx.clock,
      s.policy,
      bot,
      messaging,
      push,
    ),
    stream: new InboxStreamService(ctx.database, s.policy, entitlements, silentLogger),
    delivered: new Set<string>(),
  };
}

export type MessagingServices = ReturnType<typeof messagingServices>;

/** A platform company and its admin, who registers numbers and sets plans. */
export async function platform(
  ctx: ServerTestContext,
): Promise<Extract<Actor, { kind: 'platform_admin' }>> {
  const platformId = await company(ctx, 'platform', 'Platform');
  const adminId = await person(ctx, 'Platform admin');
  return {
    kind: 'platform_admin',
    personId: adminId,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminId, 'platform_admin'),
    authMethod: 'password_totp',
  };
}

/** Registers a WhatsApp number and records every template's status on it. */
export async function whatsappNumber(
  ctx: ServerTestContext,
  m: MessagingServices,
  admin: Extract<Actor, { kind: 'platform_admin' }>,
  number: {
    phoneNumberId: string;
    wabaId: string;
    kind: 'shared' | 'company';
    companyId: string | null;
    name: string;
  },
  statuses: (key: string) => 'approved' | 'pending' | 'rejected' = () => 'approved',
) {
  const registered = await m.settings.registerNumber(admin, {
    phoneNumberId: number.phoneNumberId,
    wabaId: number.wabaId,
    displayPhone: `+2333020${number.phoneNumberId.slice(-5)}`,
    displayName: number.name,
    kind: number.kind,
    companyId: number.companyId,
  });
  await withSystem(
    ctx.database,
    { personId: admin.personId, actorKind: 'platform_admin' },
    async (tx) => {
      const templates = await tx.select().from(schema.messageTemplate);
      for (const t of templates)
        await tx.execute(
          sql`select app.record_whatsapp_template_status(${registered.id}::uuid, ${t.id}::uuid, ${statuses(t.key)}, ${t.category}, ${`test-${t.whatsappName}`}, null)`,
        );
    },
  );
  return registered;
}

/** Stores a messaging webhook as the API would, then processes every new row as the worker would. */
export async function receive(
  ctx: ServerTestContext,
  m: MessagingServices,
  kind: MessagingWebhookKind,
  rawBody: string,
  signature?: string,
): Promise<{ stored: string; outcomes: string[] }> {
  const stored = await m.inbound.intake(kind, Buffer.from(rawBody), {
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    secret: kind === 'whatsapp' ? null : DEV_WEBHOOK_SECRET,
  });
  const rows = await withSystem(ctx.database, {}, (tx) =>
    tx.execute<{ id: string }>(
      sql`select id from webhook_inbox where provider like 'messaging.%' and status = 'received' order by received_at, id`,
    ),
  );
  const outcomes: string[] = [];
  for (const r of rows.rows) outcomes.push(await m.inbound.process(r.id));
  return { stored, outcomes };
}

/** A tenant writes on WhatsApp (to the shared number unless another is given). */
export async function whatsappFrom(
  ctx: ServerTestContext,
  m: MessagingServices,
  from: string,
  text: string,
  extra: {
    phoneNumberId?: string;
    media?: { contentType: string; bytes: Buffer };
    choiceId?: string;
  } = {},
) {
  const hook = await m.whatsapp.simulateInbound({
    from,
    text,
    phoneNumberId: SHARED_NUMBER,
    ...extra,
  });
  return receive(ctx, m, 'whatsapp', hook.rawBody, hook.signature);
}

/** Runs queued sends (once each) and media copies, as the worker would. */
export async function work(
  ctx: ServerTestContext,
  m: MessagingServices,
  companyId: string,
): Promise<number> {
  let ran = 0;
  for (;;) {
    const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select({
          id: schema.outboxEvent.id,
          type: schema.outboxEvent.type,
          payload: schema.outboxEvent.payload,
        })
        .from(schema.outboxEvent)
        .where(
          sql`${schema.outboxEvent.type} in (${MESSAGE_SEND_JOB}, ${FETCH_MEDIA_JOB}, ${BROADCAST_FANOUT_JOB})`,
        )
        .orderBy(schema.outboxEvent.createdAt, schema.outboxEvent.id),
    );
    const fresh = events.filter((e) => !m.delivered.has(e.id));
    if (fresh.length === 0) return ran;
    for (const e of fresh) {
      m.delivered.add(e.id);
      ran += 1;
      const payload = e.payload as Record<string, unknown>;
      if (e.type === MESSAGE_SEND_JOB)
        await m.messaging.deliver(companyId, messageRequestSchema.parse(payload));
      else if (e.type === FETCH_MEDIA_JOB)
        await m.inbound.fetchMedia(
          companyId,
          payload as Parameters<MessagingServices['inbound']['fetchMedia']>[1],
        );
      else
        await m.broadcasts.fanout(
          companyId,
          payload.broadcastId as string,
          payload.batch as number,
        );
    }
  }
}

/** A company's conversations with their tenant's name, as the system sees them. */
export async function conversationsOf(ctx: ServerTestContext, companyId: string) {
  return withCompany(
    ctx.database,
    { companyId, actorKind: 'system' },
    async (tx) =>
      (
        await tx.execute<{
          id: string;
          tenant_id: string | null;
          state: string;
          triage_address: string | null;
        }>(sql`select id, tenant_id, state, triage_address from conversation order by created_at`)
      ).rows,
  );
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
