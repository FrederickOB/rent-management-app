import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  and,
  eq,
  isNull,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { instantFrom } from '@rent/domain/dates';
import { sniffContentType } from '@rent/domain/maintenance';
import { providerCostToMinor } from '@rent/domain/money';
import {
  applyConversationEvent,
  isAffirmative,
  keywordEffect,
  landlordChoice,
  landlordQuestion,
  appKeywordEffect,
  appOptOutConfirmationText,
  optOutConfirmationText,
  parseKeyword,
  routeInbound,
  shouldAskWhatsAppConsent,
  consentFactsOf,
  type Channel,
  type InboundChannel,
} from '@rent/domain/messaging';
import { messagingSettingsOf, parseCompanySettings, planHas } from '@rent/domain/settings';
import {
  emailAddressOf,
  META_PERMANENT_CODES,
  parseHubtelDeliveryReport,
  parseHubtelInbound,
  parseMetaTemplateStatus,
  parseMetaWebhookDetailed,
  parsePostmarkEvent,
  parsePostmarkInbound,
  ProviderError,
  webhookSecretMatches,
  verifyMetaSignature,
  type AlertPort,
  type EmailPort,
  type SmsPort,
  type WhatsAppInboundMessage,
  type WhatsAppPort,
  type WhatsAppStatusUpdate,
} from '@rent/integrations';
import { v5 as uuidv5 } from 'uuid';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { messagingWebhookSecretOf, whatsappAppSecretOf, type AppConfig } from '../core/config';
import { MESSAGING_INBOUND_JOB, queueMessage, type NewMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { consumeRateLimit } from '../core/rate-limit';
import {
  ALERT_PORT,
  CLOCK,
  CONFIG,
  DATABASE,
  EMAIL_PORT,
  SMS_PORT,
  WHATSAPP_PORT,
} from '../core/tokens';
import {
  DocumentsService,
  reencodeImage,
  type StagedEvidence,
} from '../documents/documents.service';
import { SigningHasher } from '../esign/secrets';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { PolicyService } from '../policy/policy.service';
import { TenantsService } from '../tenancy/tenants.service';
import { BotService } from './bot.service';
import { MessagingService } from './messaging.service';
import { TemplatesService } from './templates.service';
import {
  applyEvent,
  conversationOfTenant,
  fitChoices,
  touchChannel,
  type ConversationRow,
  messagePropertyOf,
} from './store';

export const FETCH_MEDIA_JOB = 'messaging.fetch-media';
/** Raw messaging webhooks are a few kilobytes; a batch of many messages stays under this. */
export const MESSAGING_WEBHOOK_MAX_BYTES = 256 * 1024;
/** Inbound email carries its attachments: up to the API's body limit (photos of a repair). */
export const EMAIL_INBOUND_WEBHOOK_MAX_BYTES = 1_000_000;
/** Media we copy (plan 4.4): what tenants send for repairs and proof, and its size limit. */
export const MEDIA_TYPES: Readonly<Record<string, 'image' | 'video' | 'audio' | 'document'>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/aac': 'audio',
  'audio/amr': 'audio',
  'audio/mp4': 'audio',
  'application/pdf': 'document',
};
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const NAMESPACE = '0c6f8f3e-6f1d-4f3a-9d6f-2a0d5b1e7c41';

export type MessagingWebhookKind =
  'whatsapp' | 'sms_inbound' | 'sms_status' | 'email_inbound' | 'email_events';

export type MessagingIntakeResult =
  'stored' | 'duplicate' | 'rejected' | 'too_large' | 'ignored' | 'rate_limited';

/** One inbound message, whatever its channel, as the pipeline records it. */
interface Inbound {
  readonly channel: Exclude<InboundChannel, 'in_app'>;
  readonly provider: string;
  readonly providerMessageId: string;
  /** E.164 phone, or lower-case email. */
  readonly from: string;
  readonly text: string;
  readonly choiceId?: string;
  readonly media: readonly {
    id: string;
    kind: string;
    mimeType?: string;
    filename?: string;
    caption?: string;
  }[];
  readonly subject?: string;
  readonly fullBody?: string;
  readonly inboxId: string;
  /** WhatsApp: the number written to. SMS: the code written to (`to`). */
  readonly phoneNumberId?: string;
  readonly to?: string;
  /** The provider's time for the message, and when our webhook got it (review S4). */
  readonly sentAt?: Date;
  readonly receivedAt?: Date;
  /** Email: the reply token's company and conversation, when the address carried one. */
  readonly replyTo?: { companyId: string; conversationId: string } | null;
}

export type Sender =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | {
      readonly kind: 'contact';
      readonly tenantId: string;
      readonly contactId: string;
      readonly contactKind: string;
    };

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const SHARED_ROUTING_HOURS = 24;
/** Media an unknown sender may have copied (review S11): a product choice. */
const UNKNOWN_MEDIA_PER_MESSAGE = 3;
const UNKNOWN_MEDIA_PER_DAY = 10;

/**
 * The inbound pipeline (CM-01, CM-02, CM-09, CM-10; M6 plan 4.4). The webhook endpoints store
 * each message or status of a batch as its own row in the global inbox, after checking the
 * provider's signature or our secret, and answer at once; the relay queues
 * `messaging.process-inbound`, which resolves the company (decision 4), matches the sender,
 * records the message and its media once, recognises STOP and START, and hands the rest to the
 * bot or the inbox. A repeated webhook makes nothing new: rows are unique by provider and event
 * id, and messages by provider and message id.
 */
@Injectable()
export class InboundService {
  /** M11 review R3 F6: addresses and phones in rate-limit keys are keyed hashes, not SHA-256. */
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(BotService) private readonly bot: BotService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Optional() @Inject(WHATSAPP_PORT) private readonly whatsapp: WhatsAppPort | null = null,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  /** M8 review: the maintenance module honours STOP and START from artisans and staff. */
  private readonly contactKeywords: ((
    tx: Tx,
    companyId: string,
    phone: string,
    effect: { readonly action: 'grant' | 'withdraw'; readonly channels: readonly string[] },
  ) => Promise<boolean>)[] = [];

  useContactKeywords(honour: InboundService['contactKeywords'][number]): void {
    this.contactKeywords.push(honour);
  }

  // Intake (the API) ----------------------------------------------------------------------------

  /**
   * Stores a messaging webhook, one inbox row per message or status (plan 4.4). WhatsApp is
   * checked by Meta's signature; Hubtel and Postmark by our secret on the webhook URL. A bad
   * request is stored as rejected, without its body, and raises an alert at most once a window.
   */
  async intake(
    kind: MessagingWebhookKind,
    rawBody: Buffer,
    request: { headers: Record<string, unknown>; secret?: string | null; ip?: string },
  ): Promise<MessagingIntakeResult> {
    const provider = `messaging.${kind.startsWith('sms') ? 'sms' : kind.startsWith('email') ? 'email' : 'whatsapp'}`;
    const tooLarge =
      rawBody.length >
      (kind === 'email_inbound' ? EMAIL_INBOUND_WEBHOOK_MAX_BYTES : MESSAGING_WEBHOOK_MAX_BYTES);
    const valid = !tooLarge && this.verify(kind, rawBody, request);
    const hash = sha256(rawBody);
    if (!valid) {
      // Review S-2: a sender of many bad requests is refused without anything being stored, as
      // the payments webhooks do.
      if (
        request.ip &&
        !(await consumeRateLimit(
          this.database,
          `messaging-webhook:bad:${this.hasher.address(request.ip)}`,
          { count: 20, windowMinutes: 15 },
          this.clock.now().getTime(),
        ))
      )
        return 'rate_limited';
      const ok = await consumeRateLimit(
        this.database,
        `messaging-webhook:alert:${provider}`,
        { count: 1, windowMinutes: 15 },
        this.clock.now().getTime(),
      );
      await withSystem(this.database, {}, (tx) =>
        tx
          .insert(schema.webhookInbox)
          .values({
            provider,
            eventId: `rejected:${hash}`,
            rawBody: null,
            bodySha256: hash,
            bodyBytes: rawBody.length,
            headers: {},
            signatureValid: false,
            status: 'rejected',
            outcome: tooLarge ? 'too_large' : 'bad_signature',
          })
          .onConflictDoNothing(),
      );
      if (ok)
        await this.alerts.raise({
          severity: 'critical',
          code: 'messaging.webhook_bad_signature',
          message:
            'Messaging webhooks are arriving with a bad signature or secret; they are stored as rejected (body not kept).',
          context: { provider },
        });
      return tooLarge ? 'too_large' : 'rejected';
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Review S-3: a signed body we cannot read is kept, as M4b keeps one, for a person to see.
      await withSystem(this.database, {}, (tx) =>
        tx
          .insert(schema.webhookInbox)
          .values({
            provider,
            eventId: `unparsed:${hash}`,
            rawBody: rawBody.toString('utf8'),
            bodySha256: hash,
            bodyBytes: rawBody.length,
            headers: {},
            signatureValid: true,
            status: 'ignored',
            outcome: 'unparsed',
          })
          .onConflictDoNothing(),
      );
      return 'ignored';
    }
    const events = this.split(kind, body);
    if (events.length === 0) return 'ignored';
    let stored = 0;
    await withSystem(this.database, {}, async (tx) => {
      for (const e of events) {
        const rows = await tx
          .insert(schema.webhookInbox)
          .values({
            provider,
            eventId: e.eventId.slice(0, 200),
            eventType: e.type,
            reference: e.reference.slice(0, 120),
            rawBody: rawBody.toString('utf8'),
            bodySha256: hash,
            bodyBytes: rawBody.length,
            headers: {},
            signatureValid: true,
            status: 'received',
          })
          .onConflictDoNothing({
            target: [schema.webhookInbox.provider, schema.webhookInbox.eventId],
            where: sql`${schema.webhookInbox.signatureValid}`,
          })
          .returning({ id: schema.webhookInbox.id });
        stored += rows.length;
      }
    });
    return stored > 0 ? 'stored' : 'duplicate';
  }

  private verify(
    kind: MessagingWebhookKind,
    rawBody: Buffer,
    request: { headers: Record<string, unknown>; secret?: string | null },
  ): boolean {
    if (kind === 'whatsapp') {
      const secret = whatsappAppSecretOf(this.config);
      const header = request.headers['x-hub-signature-256'];
      return (
        !!secret &&
        verifyMetaSignature(rawBody, typeof header === 'string' ? header : undefined, secret)
      );
    }
    const which = {
      sms_inbound: 'sms_inbound',
      sms_status: 'sms_status',
      email_inbound: 'email_inbound',
      email_events: 'email_events',
    } as const;
    return webhookSecretMatches(
      request.secret ?? null,
      messagingWebhookSecretOf(this.config, which[kind]) ?? undefined,
    );
  }

  /** One inbox row per message or status in a provider's batch. */
  private split(
    kind: MessagingWebhookKind,
    body: unknown,
  ): { eventId: string; type: string; reference: string }[] {
    switch (kind) {
      case 'whatsapp':
        return [
          ...parseMetaWebhookDetailed(body).map((e) =>
            e.kind === 'message'
              ? {
                  eventId: `msg:${e.providerMessageId}`,
                  type: 'message',
                  reference: e.providerMessageId,
                }
              : {
                  eventId: `status:${e.providerMessageId}:${e.status}`,
                  type: 'status',
                  reference: e.providerMessageId,
                },
          ),
          ...parseMetaTemplateStatus(body).map((e) => ({
            eventId: `template:${e.metaTemplateId}:${e.status}:${sha256(JSON.stringify(body)).slice(0, 16)}`,
            type: 'template_status',
            reference: e.name,
          })),
        ];
      case 'sms_inbound': {
        const m = parseHubtelInbound(body);
        return m
          ? [
              {
                eventId: `in:${m.providerMessageId}`,
                type: 'message',
                reference: m.providerMessageId,
              },
            ]
          : [];
      }
      case 'sms_status': {
        const r = parseHubtelDeliveryReport(body);
        return r
          ? [
              {
                eventId: `status:${r.providerMessageId}:${r.status}`,
                type: 'status',
                reference: r.providerMessageId,
              },
            ]
          : [];
      }
      case 'email_inbound': {
        const m = parsePostmarkInbound(body);
        return m
          ? [
              {
                eventId: `in:${m.providerMessageId}`,
                type: 'message',
                reference: m.providerMessageId,
              },
            ]
          : [];
      }
      case 'email_events': {
        const e = parsePostmarkEvent(body);
        return e ? [{ eventId: e.eventId, type: 'status', reference: e.providerMessageId }] : [];
      }
    }
  }

  // Processing (the worker) -------------------------------------------------------------------

  /** `messaging.process-inbound`: one stored row, once. */
  async process(inboxId: string): Promise<string> {
    // M11 decision 9: read under the row's lock, so a replay still committing is waited for.
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx
        .select()
        .from(schema.webhookInbox)
        .where(eq(schema.webhookInbox.id, inboxId))
        .for('update'),
    );
    if (!row || row.status !== 'received' || !row.signatureValid || !row.rawBody) return 'skipped';
    const body = JSON.parse(row.rawBody) as unknown;
    let outcome = 'not_handled';
    if (row.provider === 'messaging.whatsapp') {
      if (row.eventType === 'template_status') {
        outcome = await this.templates.fromWebhook(parseMetaTemplateStatus(body));
      } else {
        const event = parseMetaWebhookDetailed(body).find((e) =>
          e.kind === 'message'
            ? row.eventId === `msg:${e.providerMessageId}`
            : row.eventId === `status:${e.providerMessageId}:${e.status}`,
        );
        if (event?.kind === 'message')
          outcome = await this.handle(
            this.whatsappInbound(event, row.id, new Date(row.receivedAt)),
          );
        else if (event?.kind === 'status') outcome = await this.whatsappStatus(event);
      }
    } else if (row.provider === 'messaging.sms') {
      if (row.eventType === 'message') {
        const inbound = this.inboundOfRow(row);
        if (inbound) outcome = await this.handle(inbound);
      } else {
        const r = this.sms.parseDeliveryReport(body) ?? parseHubtelDeliveryReport(body);
        if (r)
          outcome = await this.deliveryReport(this.sms.provider, r.providerMessageId, {
            status: r.status === 'sent' ? null : r.status,
            reason: r.reason ?? null,
            costDecimal: r.cost?.currency === 'GHS' ? r.cost.decimal : null,
          });
      }
    } else if (row.provider === 'messaging.email') {
      if (row.eventType === 'message') {
        const m = this.email.parseInbound(body) ?? parsePostmarkInbound(body);
        if (m) outcome = await this.inboundEmail(m, row.id);
      } else {
        const e = this.email.parseEvent?.(body) ?? parsePostmarkEvent(body);
        if (e && e.status !== 'opened')
          outcome = await this.deliveryReport(this.email.provider, e.providerMessageId, {
            status: e.status,
            reason: e.reason ?? null,
            costDecimal: null,
          });
        else if (e) outcome = 'opened';
      }
    }
    await withSystem(this.database, {}, (tx) =>
      tx
        .update(schema.webhookInbox)
        .set({
          status: outcome === 'not_handled' ? 'ignored' : 'processed',
          outcome: outcome.slice(0, 60),
          processedAt: new Date(),
        })
        .where(eq(schema.webhookInbox.id, inboxId)),
    );
    return outcome;
  }

  /** The job's dead letter: the row is failed, with why (M11 decision 9: a code, never a body). */
  async failed(inboxId: string, lastError: string | null = null): Promise<void> {
    await withSystem(this.database, {}, (tx) =>
      tx
        .update(schema.webhookInbox)
        .set({
          status: 'failed',
          outcome: 'dead_lettered',
          processedAt: new Date(),
          lastError: lastError?.slice(0, 200) ?? null,
        })
        .where(eq(schema.webhookInbox.id, inboxId)),
    );
  }

  /** A WhatsApp message as the pipeline records it: its choice, captions and file names kept. */
  private whatsappInbound(m: WhatsAppInboundMessage, inboxId: string, receivedAt?: Date): Inbound {
    return {
      channel: 'whatsapp',
      provider: this.whatsapp?.provider ?? 'meta',
      providerMessageId: m.providerMessageId,
      from: m.from,
      text: m.text ?? '',
      ...(m.choiceId ? { choiceId: m.choiceId } : {}),
      media: (m.media ?? m.mediaIds.map((id) => ({ id, kind: 'document' as const }))).map(
        (x: {
          id: string;
          kind: string;
          mimeType?: string;
          filename?: string;
          caption?: string;
        }) => ({
          id: x.id,
          kind: x.kind,
          ...(x.mimeType ? { mimeType: x.mimeType } : {}),
          ...(x.filename ? { filename: x.filename } : {}),
          ...(x.caption ? { caption: x.caption } : {}),
        }),
      ),
      inboxId,
      ...(m.phoneNumberId ? { phoneNumberId: m.phoneNumberId } : {}),
      ...(m.at ? { sentAt: new Date(m.at) } : {}),
      ...(receivedAt ? { receivedAt } : {}),
    };
  }

  private async inboundEmail(
    m: NonNullable<ReturnType<EmailPort['parseInbound']>>,
    inboxId: string,
  ): Promise<string> {
    const domain = `@${(this.config.EMAIL_INBOUND_DOMAIN ?? 'inbound.rent.invalid').toLowerCase()}`;
    const recipients = m.recipients ?? [m.to];
    const tokenAddress = recipients
      .map((r) => emailAddressOf(r).toLowerCase())
      .find((r) => r.startsWith('reply+') && r.endsWith(domain));
    const replyToken = tokenAddress?.slice('reply+'.length, tokenAddress.length - domain.length);
    let replyTo: Inbound['replyTo'] = null;
    if (replyToken) {
      const found = await withSystem(this.database, {}, (tx) =>
        tx.execute<{ company_id: string; conversation_id: string }>(
          sql`select company_id, conversation_id from app.reply_address_company(${sha256(replyToken)})`,
        ),
      );
      const r = found.rows[0];
      if (r) replyTo = { companyId: r.company_id, conversationId: r.conversation_id };
    }
    return this.handle({
      channel: 'email',
      provider: this.email.provider,
      providerMessageId: m.providerMessageId,
      from: emailAddressOf(m.from).toLowerCase(),
      text: (m.strippedReply ?? m.text ?? '').trim().slice(0, 10_000),
      media: m.attachments.map((a, i) => ({
        id: `email:${inboxId}:${i}`,
        kind: MEDIA_TYPES[a.contentType] ?? 'document',
        mimeType: a.contentType,
        filename: a.filename,
      })),
      subject: m.subject,
      ...(m.text ? { fullBody: m.text.slice(0, 100_000) } : {}),
      inboxId,
      replyTo,
    });
  }

  /** Resolves the company (decision 4; CM-10), then records and answers the message there. */
  private async handle(inbound: Inbound): Promise<string> {
    const now = this.clock.now();
    let companyId: string | null = null;
    let forcedConversation: string | null = null;
    let triageOnly = false;
    let routingAnswer = false;
    if (inbound.channel === 'email') {
      // CM-10: the token in the reply address finds the conversation; anything else is triage.
      if (inbound.replyTo) {
        companyId = inbound.replyTo.companyId;
        forcedConversation = inbound.replyTo.conversationId;
      }
    } else {
      // The founder's decision (2026-11-04): on the shared number, routing comes first, and a
      // STOP, STOP ALL or START applies in the routed or chosen company only. A phone known to
      // several companies is asked "which landlord?" first; until it answers, every landlord can
      // still send to it. The waiting keyword applies once the answer comes (in the replay).
      // An answer to a question still open goes to it first, whatever rule 1 would say now
      // (a landlord may have written to the phone meanwhile).
      const answering = await this.answersOpenQuestion(inbound);
      const routed = answering
        ? { kind: 'ask' as const, offered: answering }
        : await this.route(inbound, now);
      if (routed.kind === 'ask') {
        const answer = await this.landlordAnswer(inbound, routed.offered, now);
        if (!answer) return 'asked_landlord';
        companyId = answer.companyId;
        // The answer itself ("1", or the list row) is recorded, never read as a menu choice.
        routingAnswer = true;
      } else {
        companyId = routed.companyId;
        triageOnly = routed.triage;
      }
    }
    companyId ??= await this.platformCompany();
    if (!companyId) return 'no_company';
    return withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      this.recordAndAnswer(tx, companyId!, inbound, {
        forcedConversation,
        triageOnly,
        now,
        routingAnswer,
      }),
    );
  }

  /** The companies an open "which landlord?" question offered, when this message answers it. */
  private async answersOpenQuestion(
    inbound: Inbound,
  ): Promise<{ companyId: string; name: string }[] | null> {
    const platform = await this.platformCompany();
    if (!platform) return null;
    return withCompany(this.database, { companyId: platform, actorKind: 'system' }, async (tx) => {
      const rows = await tx.execute<{ context: { landlord?: { companyIds: string[] } } }>(
        sql`select s.context from bot_session s
            join conversation c on c.company_id = s.company_id and c.id = s.conversation_id
            where c.tenant_id is null and c.triage_channel = ${inbound.channel}
              and c.triage_address = ${inbound.from}`,
      );
      const offered = rows.rows[0]?.context?.landlord?.companyIds;
      if (!offered?.length) return null;
      const chosen = landlordChoice(
        { choiceId: inbound.choiceId ?? null, text: inbound.text },
        offered,
      );
      return chosen ? offered.map((companyId) => ({ companyId, name: '' })) : null;
    });
  }

  private async platformCompany(): Promise<string | null> {
    const rows = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
    );
    return rows.rows[0]?.id ?? null;
  }

  /**
   * A message from the platform itself, to the number that wrote: the "which landlord?" question,
   * which belongs to no company yet. After every transaction has committed, once per message
   * (review S-1); on SMS from the code the person wrote to, not the one-way sender ID.
   */
  private async sendDirect(
    inbound: Inbound,
    body: string,
    choices?: readonly { id: string; title: string }[],
  ): Promise<void> {
    try {
      if (inbound.channel === 'whatsapp' && this.whatsapp) {
        const from = inbound.phoneNumberId ? { from: inbound.phoneNumberId } : {};
        if (choices?.length)
          await this.whatsapp
            .sendInteractive({
              to: inbound.from,
              body,
              choices: fitChoices(choices),
              listButton: 'Landlords',
              ...from,
            })
            .catch(() => this.whatsapp!.sendText({ to: inbound.from, body, ...from }));
        else await this.whatsapp.sendText({ to: inbound.from, body, ...from });
      } else if (inbound.channel === 'sms')
        await this.sms.send({
          to: inbound.from,
          body,
          ...(inbound.to && /^[A-Za-z0-9 ]{1,11}$/.test(inbound.to)
            ? { senderId: inbound.to }
            : {}),
          reference: `${inbound.providerMessageId}`.slice(0, 100),
        });
    } catch (error) {
      // Answering the platform's own question is best effort; the message is safe in the inbox.
      await this.alerts
        .raise({
          severity: 'warning',
          code: 'messaging.direct_send_failed',
          message: 'A platform message to a person on the shared number could not be sent',
          context: { channel: inbound.channel, error: (error as Error).name },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Decision 4: a company number's messages are that company's; on the shared number (and the
   * shared SMS short code) the company that wrote to this phone in the last day, then the only one
   * that knows it, then the person is asked which landlord, naming only those.
   */
  private async route(
    inbound: Inbound,
    now: Date,
  ): Promise<
    | { kind: 'company'; companyId: string | null; triage: boolean }
    | { kind: 'ask'; offered: { companyId: string; name: string }[] }
  > {
    const since = new Date(now.getTime() - SHARED_ROUTING_HOURS * 3600_000);
    return withSystem(this.database, {}, async (tx) => {
      let account: { account_id: string; kind: string; company_id: string | null } | undefined;
      if (inbound.channel === 'whatsapp' && inbound.phoneNumberId) {
        account = (
          await tx.execute<{ account_id: string; kind: string; company_id: string | null }>(
            sql`select * from app.whatsapp_account_by_number(${inbound.phoneNumberId})`,
          )
        ).rows[0];
        if (!account) return { kind: 'company' as const, companyId: null, triage: true };
      }
      const recent =
        inbound.channel === 'whatsapp' && account
          ? await tx.execute<{ company_id: string; last_outbound_at: Date }>(
              sql`select * from app.recent_whatsapp_companies(${account.account_id}::uuid, ${inbound.from}, ${since}::timestamptz)`,
            )
          : await tx.execute<{ company_id: string; last_outbound_at: Date }>(
              sql`select * from app.recent_channel_companies(${inbound.channel}, ${inbound.from}, ${since}::timestamptz)`,
            );
      const known = await tx.execute<{ company_id: string; display_name: string }>(
        sql`select * from app.companies_for_phone(${inbound.from})`,
      );
      const route = routeInbound({
        number:
          account?.kind === 'company' && account.company_id
            ? { kind: 'company', companyId: account.company_id }
            : { kind: 'shared' },
        recentOutbound: recent.rows.map((r) => ({
          companyId: r.company_id,
          at: instantFrom(r.last_outbound_at),
        })),
        knownIn: known.rows.map((r) => r.company_id),
        now: instantFrom(now),
      });
      if (route.kind === 'company')
        return { kind: 'company' as const, companyId: route.companyId, triage: false };
      if (route.kind === 'triage')
        return { kind: 'company' as const, companyId: null, triage: true };
      // Rule 3: ask, or take the answer to the question asked before (outside this transaction).
      return {
        kind: 'ask' as const,
        offered: known.rows.map((r) => ({ companyId: r.company_id, name: r.display_name })),
      };
    });
  }

  /**
   * The "which landlord?" question (decision 4). The question goes from the shared number and
   * names only the companies that know this phone; the messages waiting for the answer stay in
   * the inbox, however long the answer takes, and are processed into the chosen company once it
   * comes. Nothing of them is written to any company before then. The session row is locked, so
   * two messages at once never lose one of the waiting ids.
   */
  private async landlordAnswer(
    inbound: Inbound,
    offered: { companyId: string; name: string }[],
    now: Date,
  ): Promise<{ companyId: string } | null> {
    const platform = await this.platformCompany();
    if (!platform) return null;
    const ids = offered.map((o) => o.companyId);
    const pending = await withCompany(
      this.database,
      { companyId: platform, actorKind: 'system' },
      async (tx) => {
        const conversation = await this.triageConversation(
          tx,
          platform,
          inbound.channel,
          inbound.from,
        );
        await tx
          .insert(schema.botSession)
          .values({
            companyId: platform,
            conversationId: conversation.id,
            state: 'menu',
            context: {},
            expiresAt: new Date(now.getTime() + 24 * 3600_000),
          })
          .onConflictDoNothing();
        const [session] = await tx
          .select()
          .from(schema.botSession)
          .where(eq(schema.botSession.conversationId, conversation.id))
          .for('update');
        const previous = (
          (session?.context ?? {}) as {
            landlord?: { companyIds: string[]; inboxIds: string[]; askedAt: string };
          }
        ).landlord;
        // An answer counts whenever it comes; the waiting messages are never dropped.
        const chosen = previous
          ? landlordChoice(
              { choiceId: inbound.choiceId ?? null, text: inbound.text },
              previous.companyIds.filter((id) => ids.includes(id)),
            )
          : null;
        const waiting = chosen
          ? previous!.inboxIds
          : [...new Set([...(previous?.inboxIds ?? []), inbound.inboxId])];
        const next = chosen
          ? {}
          : { landlord: { companyIds: ids, inboxIds: waiting, askedAt: now.toISOString() } };
        await tx
          .update(schema.botSession)
          .set({
            context: next,
            lastActivityAt: now,
            expiresAt: new Date(now.getTime() + 24 * 3600_000),
            updatedAt: now,
          })
          .where(eq(schema.botSession.id, session!.id));
        // The question once per message, whatever the retries.
        const ask = chosen
          ? []
          : await tx
              .insert(schema.processedJob)
              .values({
                companyId: platform,
                key: `messaging.landlord-question:${inbound.inboxId}`,
                jobName: MESSAGING_INBOUND_JOB,
              })
              .onConflictDoNothing()
              .returning({ key: schema.processedJob.key });
        return { chosen, waiting, ask: ask.length > 0 };
      },
    );
    if (!pending.chosen) {
      if (pending.ask) {
        const question = landlordQuestion(offered);
        await this.sendDirect(inbound, question.text, question.choices);
      }
      return null;
    }
    // The answer: the waiting messages go to the chosen company first, then the answer itself.
    for (const inboxId of pending.waiting)
      if (inboxId !== inbound.inboxId) await this.replay(inboxId, pending.chosen);
    return { companyId: pending.chosen };
  }

  /** A stored message row as the pipeline reads it, for WhatsApp and SMS alike. */
  private inboundOfRow(row: typeof schema.webhookInbox.$inferSelect): Inbound | null {
    if (!row.rawBody) return null;
    const body = JSON.parse(row.rawBody) as unknown;
    if (row.provider === 'messaging.whatsapp') {
      const event = parseMetaWebhookDetailed(body).find(
        (e) => e.kind === 'message' && row.eventId === `msg:${e.providerMessageId}`,
      );
      return event?.kind === 'message'
        ? this.whatsappInbound(event, row.id, new Date(row.receivedAt))
        : null;
    }
    if (row.provider === 'messaging.sms') {
      const m = this.sms.parseInbound?.(body) ?? parseHubtelInbound(body);
      return m
        ? {
            channel: 'sms',
            provider: this.sms.provider,
            providerMessageId: m.providerMessageId,
            from: m.from,
            ...(m.to ? { to: m.to } : {}),
            text: m.text,
            media: [],
            inboxId: row.id,
            receivedAt: new Date(row.receivedAt),
          }
        : null;
    }
    return null;
  }

  /** Processes a waiting inbox row into the company chosen for it. */
  private async replay(inboxId: string, companyId: string): Promise<void> {
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx.select().from(schema.webhookInbox).where(eq(schema.webhookInbox.id, inboxId)),
    );
    const inbound = row ? this.inboundOfRow(row) : null;
    if (!inbound) return;
    await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      this.recordAndAnswer(tx, companyId, inbound, {
        forcedConversation: null,
        triageOnly: false,
        now: this.clock.now(),
      }),
    );
    await withSystem(this.database, {}, (tx) =>
      tx
        .update(schema.webhookInbox)
        .set({ status: 'processed', outcome: 'routed_after_choice', processedAt: new Date() })
        .where(eq(schema.webhookInbox.id, inboxId)),
    );
  }

  private async triageConversation(
    tx: Tx,
    companyId: string,
    channel: Channel,
    address: string,
  ): Promise<ConversationRow> {
    const find = async () =>
      (
        await tx
          .select()
          .from(schema.conversation)
          .where(
            and(
              isNull(schema.conversation.tenantId),
              isNull(schema.conversation.mergedIntoId),
              eq(schema.conversation.triageChannel, channel),
              eq(schema.conversation.triageAddress, address),
            ),
          )
      )[0];
    const existing = await find();
    if (existing) return existing;
    await tx
      .insert(schema.conversation)
      .values({ companyId, state: 'triage', triageChannel: channel, triageAddress: address })
      .onConflictDoNothing();
    return (await find())!;
  }

  /** The tenant or contact a phone or email belongs to in this company (CM-02). */
  async senderOf(tx: Tx, channel: Channel, address: string): Promise<Sender | null> {
    const phone = channel !== 'email';
    const tenant = await tx.execute<{ id: string }>(
      phone
        ? sql`select id from tenant where archived_at is null and (phone = ${address} or whatsapp_phone = ${address}) order by created_at limit 1`
        : sql`select id from tenant where archived_at is null and lower(email) = ${address} order by created_at limit 1`,
    );
    if (tenant.rows[0]) return { kind: 'tenant', tenantId: tenant.rows[0].id };
    const identity = await tx.execute<{
      tenant_id: string;
      tenant_contact_id: string | null;
      kind: string | null;
    }>(
      sql`select i.tenant_id, i.tenant_contact_id, c.kind from channel_identity i
          left join tenant_contact c on c.company_id = i.company_id and c.id = i.tenant_contact_id
          where i.revoked_at is null and i.address = ${address}
            and i.channel = any(${phone ? '{whatsapp,sms}' : '{email}'}::text[])
          order by i.linked_at desc limit 1`,
    );
    const i = identity.rows[0];
    if (i)
      return i.tenant_contact_id
        ? {
            kind: 'contact',
            tenantId: i.tenant_id,
            contactId: i.tenant_contact_id,
            contactKind: i.kind ?? 'guarantor',
          }
        : { kind: 'tenant', tenantId: i.tenant_id };
    const contact = await tx.execute<{ id: string; tenant_id: string; kind: string }>(
      phone
        ? sql`select c.id, c.tenant_id, c.kind from tenant_contact c join tenant t on t.company_id = c.company_id and t.id = c.tenant_id
              where c.archived_at is null and t.archived_at is null and c.phone = ${address} order by c.created_at limit 1`
        : sql`select c.id, c.tenant_id, c.kind from tenant_contact c join tenant t on t.company_id = c.company_id and t.id = c.tenant_id
              where c.archived_at is null and t.archived_at is null and lower(c.email) = ${address} order by c.created_at limit 1`,
    );
    const c = contact.rows[0];
    return c
      ? { kind: 'contact', tenantId: c.tenant_id, contactId: c.id, contactKind: c.kind }
      : null;
  }

  /** The property and unit of the tenant's current lease, for scope and repairs. */
  private async currentLease(tx: Tx, tenantId: string) {
    const rows = await tx.execute<{ id: string; property_id: string; unit_id: string }>(
      sql`select id, property_id, unit_id from lease where tenant_id = ${tenantId}
          and status in ('signed', 'active', 'ending', 'holding_over') order by start_date desc limit 1`,
    );
    return rows.rows[0] ?? null;
  }

  /** Records the message, updates the conversation and answers it, in one transaction. */
  async recordAndAnswer(
    tx: Tx,
    companyId: string,
    inbound: Inbound,
    options: {
      forcedConversation: string | null;
      triageOnly: boolean;
      now: Date;
      /** The answer to "which landlord?": recorded, never read as a menu choice (review N-3). */
      routingAnswer?: boolean;
    },
  ): Promise<string> {
    const { now } = options;
    // Review S4: the window runs from when the person wrote. A message held up on its way (at
    // the provider, or waiting here for a retry) is dated back by that delay, measured from the
    // provider's time and capped at when our webhook got it. Under a minute, the pipeline's own
    // time stands: provider times are to the second, and our records order to the millisecond.
    const sent = Math.min(
      inbound.sentAt?.getTime() ?? Number.POSITIVE_INFINITY,
      inbound.receivedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    const delay = Number.isFinite(sent) ? Date.now() - sent : 0;
    const inboundAt = delay > 60_000 ? new Date(now.getTime() - delay) : now;
    const [company] = await tx
      .select()
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    if (!company) return 'no_company';
    const settings = messagingSettingsOf(parseCompanySettings(company.settings));
    const plan = await this.entitlements.planIn(tx, companyId);
    let sender =
      company.kind === 'platform' || options.triageOnly
        ? null
        : await this.senderOf(tx, inbound.channel, inbound.from);
    let conversation: ConversationRow;
    let started = false;
    if (options.forcedConversation) {
      const [found] = await tx
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.id, options.forcedConversation));
      // CM-10: the sender must be the tenant's or a contact's email on record; anyone else is triage.
      const target = found?.mergedIntoId
        ? (
            await tx
              .select()
              .from(schema.conversation)
              .where(eq(schema.conversation.id, found.mergedIntoId))
          )[0]
        : found;
      if (target?.tenantId && sender && sender.tenantId === target.tenantId) conversation = target;
      else {
        sender = null;
        conversation = await this.triageConversation(tx, companyId, inbound.channel, inbound.from);
      }
    } else if (sender) {
      const existing = await conversationOfTenant(tx, sender.tenantId);
      conversation =
        existing ??
        (await this.startConversation(
          tx,
          companyId,
          sender.tenantId,
          inbound.channel,
          now,
          settings.inboxFirstResponseMinutes,
        ));
      started = !existing;
    } else
      conversation = await this.triageConversation(tx, companyId, inbound.channel, inbound.from);

    const lease = sender ? await this.currentLease(tx, sender.tenantId) : null;
    // M6 review MF-2: a tenant between leases files under their latest issued lease's property.
    const messageProperty = sender ? await messagePropertyOf(tx, sender.tenantId) : null;
    const messageId = uuidv5(`${inbound.provider}:${inbound.providerMessageId}`, NAMESPACE);
    const inserted = await tx
      .insert(schema.message)
      .values({
        id: messageId,
        companyId,
        propertyId: messageProperty,
        tenantId: sender?.tenantId ?? null,
        tenantContactId: sender?.kind === 'contact' ? sender.contactId : null,
        purpose: 'inbound',
        subject: inbound.subject ?? null,
        body: inbound.text,
        fullBody: inbound.fullBody ?? null,
        channels: [inbound.channel],
        direction: 'inbound',
        conversationId: conversation.id,
        authorType: sender ? (sender.kind === 'contact' ? 'contact' : 'tenant') : 'unknown',
        channel: inbound.channel,
        provider: inbound.provider,
        providerMessageId: inbound.providerMessageId,
        attachmentCount: Math.min(inbound.media.length, sender ? 20 : UNKNOWN_MEDIA_PER_MESSAGE),
      })
      .onConflictDoNothing()
      .returning({ id: schema.message.id });
    // A repeated webhook (or a retried job) makes nothing new.
    if (inserted.length === 0) return 'duplicate';

    // Review S11: someone no company knows may send a little media, not a flood of it.
    const copies = sender
      ? inbound.media.slice(0, 20)
      : (await consumeRateLimit(
            this.database,
            `messaging-media:unknown:${this.hasher.destination(inbound.from)}`,
            { count: UNKNOWN_MEDIA_PER_DAY, windowMinutes: 24 * 60 },
            now.getTime(),
          ))
        ? inbound.media.slice(0, UNKNOWN_MEDIA_PER_MESSAGE)
        : [];
    for (const media of copies)
      await enqueueOutbox(tx, {
        companyId,
        type: FETCH_MEDIA_JOB,
        payload: {
          messageId,
          channel: inbound.channel,
          provider: inbound.provider,
          mediaId: media.id,
          kind: media.kind,
          mimeType: media.mimeType ?? null,
          filename: media.filename ?? null,
          caption: media.caption ?? null,
          inboxId: inbound.inboxId,
        },
        idempotencyKey: `${FETCH_MEDIA_JOB}:${inbound.provider}:${media.id}`,
      });

    const accountId =
      inbound.channel === 'whatsapp' && inbound.phoneNumberId
        ? ((
            await tx.execute<{ account_id: string }>(
              sql`select account_id from app.whatsapp_account_by_number(${inbound.phoneNumberId})`,
            )
          ).rows[0]?.account_id ?? null)
        : null;
    await touchChannel(tx, {
      companyId,
      conversationId: conversation.id,
      channel: inbound.channel,
      address: inbound.from,
      whatsappAccountId:
        inbound.channel === 'whatsapp'
          ? (accountId ?? (await this.sendingAccountId(tx, companyId)))
          : null,
      direction: 'inbound',
      at: inboundAt,
    });

    const at = instantFrom(inboundAt);
    const activity = {
      lastMessageAt: now,
      lastInboundAt: inboundAt,
      lastInboundChannel: inbound.channel,
    };
    // A conversation just started has its first state already; any other takes the event.
    conversation = started
      ? (
          await tx
            .update(schema.conversation)
            .set({ ...activity, updatedAt: now })
            .where(eq(schema.conversation.id, conversation.id))
            .returning()
        )[0]!
      : await applyEvent(
          tx,
          conversation,
          sender
            ? { type: 'tenant_message', channel: inbound.channel }
            : { type: 'unknown_message', channel: inbound.channel },
          at,
          settings.inboxFirstResponseMinutes,
          activity,
        );
    if (!sender) {
      // STOP, STOP ALL and START from an artisan or a staff member (CM-09; M8 review).
      const keyword = parseKeyword(inbound.text);
      if (keyword && options.routingAnswer !== true)
        for (const honour of this.contactKeywords)
          if (await honour(tx, companyId, inbound.from, keywordEffect(keyword, inbound.channel)))
            return keyword.kind === 'start' ? 'start' : 'stop';
      return 'triage';
    }

    const subject = {
      tenantId: sender.tenantId,
      contactId: sender.kind === 'contact' ? sender.contactId : null,
    };
    const recipient: NewMessage['recipient'] =
      sender.kind === 'contact'
        ? { type: 'tenant_contact', tenantId: sender.tenantId, contactId: sender.contactId }
        : { type: 'tenant', tenantId: sender.tenantId };
    const reply = (
      purpose: 'opt_out_confirmation' | 'bot_reply' | 'consent_request',
      body: string,
      n: number,
    ) =>
      queueMessage(tx, companyId, {
        messageId: uuidv5(`${messageId}:reply:${n}`, NAMESPACE),
        recipient,
        purpose,
        body,
        propertyId: messageProperty,
        reply: {
          conversationId: conversation.id,
          channel: inbound.channel,
          authorType: 'bot',
          authorPersonId: null,
          template: null,
        },
      });

    if (options.routingAnswer) return 'landlord_chosen';

    // STOP and START first, whatever state the conversation is in (decision 7; plan 4.4).
    const keyword = parseKeyword(inbound.text);
    if (keyword) {
      const effect = keywordEffect(keyword, inbound.channel);
      for (const channel of effect.channels)
        await this.tenants.recordSystemConsent(tx, companyId, {
          ...subject,
          channel,
          action: effect.action,
          source: keyword.kind === 'start' ? 'start_keyword' : 'stop_keyword',
          textVersion: keyword.kind === 'start' ? 'start.v1' : 'stop.v1',
          recordedAt: inboundAt,
        });
      await reply(
        'opt_out_confirmation',
        optOutConfirmationText({
          companyName: company.displayName,
          keyword,
          arrivedOn: inbound.channel,
        }),
        0,
      );
      return keyword.kind === 'start' ? 'start' : 'stop';
    }

    // Plan 4.8: YES to the WhatsApp question records consent there.
    if (inbound.channel === 'whatsapp') {
      const point = await this.tenants.messagingPoint(tx, subject);
      const whatsapp = consentFactsOf(
        point?.consent.whatsapp
          ? [{ action: point.consent.whatsapp.action, at: instantFrom(point.consent.whatsapp.at) }]
          : [],
      );
      const [session] = await tx
        .select()
        .from(schema.botSession)
        .where(eq(schema.botSession.conversationId, conversation.id));
      if (session?.consentAskedAt && whatsapp.latest === null && isAffirmative(inbound.text)) {
        await this.tenants.recordSystemConsent(tx, companyId, {
          ...subject,
          channel: 'whatsapp',
          action: 'grant',
          source: 'tenant_reply',
          textVersion: 'whatsapp_reply.v1',
        });
        await reply(
          'bot_reply',
          `Thank you. ${company.displayName} will send your reminders and receipts here on WhatsApp. Reply STOP at any time to stop them.`,
          0,
        );
        return 'consent_granted';
      }
      if (
        shouldAskWhatsAppConsent({
          knownSender: true,
          whatsapp,
          alreadyAsked: Boolean(session?.consentAskedAt),
        })
      ) {
        await this.bot.markConsentAsked(tx, companyId, conversation.id, now);
        await reply(
          'consent_request',
          `Would you like ${company.displayName} to send your rent reminders and receipts here on WhatsApp? Reply YES if so.`,
          9,
        );
      }
    }

    // On WhatsApp the bot has it until a person takes over (plan 4.4, 4.5); Starter has no
    // inbox, so what the bot cannot answer goes to the landlord (decision 9).
    if (
      inbound.channel === 'whatsapp' &&
      (conversation.state === 'bot' || !planHas(plan, 'inbox'))
    ) {
      await this.bot.answer(tx, {
        companyId,
        company,
        plan,
        conversation,
        sender,
        inbound: {
          messageId,
          text: inbound.text,
          ...(inbound.choiceId ? { choiceId: inbound.choiceId } : {}),
          hasMedia: inbound.media.length > 0,
          caption: inbound.media[0]?.caption ?? null,
        },
        lease,
        now,
        firstResponseMinutes: settings.inboxFirstResponseMinutes,
      });
      return 'bot';
    }
    if (!planHas(plan, 'inbox')) {
      await this.bot.forwardToLandlord(tx, company, [messageId], inbound.text, sender.tenantId);
      return 'forwarded';
    }
    return 'inbox';
  }

  /** A tenant's first conversation, in the state the domain gives a first message (CM-05). */
  private async startConversation(
    tx: Tx,
    companyId: string,
    tenantId: string,
    channel: InboundChannel,
    now: Date,
    firstResponseMinutes: number,
  ): Promise<ConversationRow> {
    const first = applyConversationEvent(
      null,
      { type: 'tenant_message', channel },
      instantFrom(now),
      firstResponseMinutes,
    );
    await tx
      .insert(schema.conversation)
      .values({
        companyId,
        tenantId,
        state: first.state,
        firstResponseDueAt: first.firstResponseDueAt ? new Date(first.firstResponseDueAt) : null,
      })
      .onConflictDoNothing();
    return (await conversationOfTenant(tx, tenantId))!;
  }

  private async sendingAccountId(tx: Tx, companyId: string): Promise<string | null> {
    const rows = await tx.execute<{ account_id: string }>(
      sql`select account_id from app.whatsapp_sending_account(${companyId}::uuid)`,
    );
    return rows.rows[0]?.account_id ?? null;
  }

  /** A delivery, read or failure report for a message we sent (plan 4.3). */
  private async whatsappStatus(s: WhatsAppStatusUpdate): Promise<string> {
    if (s.status === 'sent') return 'sent_ack';
    const code = s.errorCode ? Number(s.errorCode) : undefined;
    return this.deliveryReport(this.whatsapp?.provider ?? 'meta', s.providerMessageId, {
      status: s.status,
      reason:
        s.status === 'failed'
          ? code !== undefined && META_PERMANENT_CODES.has(code)
            ? 'provider_refused'
            : 'delivery_failed_report'
          : null,
      costDecimal: null,
      ...(s.pricing ? { pricing: s.pricing } : {}),
    });
  }

  private async deliveryReport(
    provider: string,
    providerMessageId: string,
    report: {
      status: 'delivered' | 'read' | 'failed' | null;
      reason: string | null;
      costDecimal: string | null;
      pricing?: { category: string; billable: boolean };
    },
  ): Promise<string> {
    if (!report.status) return 'sent_ack';
    const found = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string; message_id: string; channel: string }>(
        sql`select * from app.message_by_provider_id(${provider}, ${providerMessageId})`,
      ),
    );
    const m = found.rows[0];
    if (!m) return 'unknown_message';
    return withCompany(
      this.database,
      { companyId: m.company_id, actorKind: 'system' },
      async (tx) => {
        const pricing =
          report.pricing &&
          ['utility', 'marketing', 'authentication', 'service', 'referral_conversion'].includes(
            report.pricing.category,
          )
            ? report.pricing
            : null;
        const inserted = await tx
          .insert(schema.messageEvent)
          .values({
            companyId: m.company_id,
            messageId: m.message_id,
            status: report.status!,
            channel: m.channel,
            provider,
            // Review S-10: the provider's id, so a repeated failure report records nothing new.
            providerMessageId,
            ...(report.status === 'failed'
              ? { reason: report.reason ?? 'delivery_failed_report' }
              : {}),
            ...(pricing ? { pricingCategory: pricing.category, billable: pricing.billable } : {}),
            // CM-12 groundwork: what an SMS delivery report says it cost.
            ...(report.costDecimal && report.status !== 'failed'
              ? { costMinor: providerCostToMinor(report.costDecimal).amountMinor, currency: 'GHS' }
              : {}),
          })
          .onConflictDoNothing()
          .returning({ id: schema.messageEvent.id });
        if (inserted.length === 0) return 'duplicate';
        // CM-09's fallback (review S6): a message the provider reports it could not deliver,
        // for whatever reason, goes by the next channel. The failed one is not tried again.
        if (report.status === 'failed')
          await this.messaging.redeliver(tx, m.company_id, m.message_id, providerMessageId);
        // M7 (plan 4.6; prd-issues 7): a notice's tracker records which channel confirmed delivery.
        await this.messaging.reportToRelated(tx, m.company_id, m.message_id, inserted[0]!.id, {
          status: report.status!,
          channel: m.channel,
        });
        return report.status!;
      },
    );
  }

  // Media (plan 4.4) ---------------------------------------------------------------------------

  /** `messaging.fetch-media`: copies one media item to our storage at once, checked. */
  async fetchMedia(
    companyId: string,
    job: {
      messageId: string;
      channel: string;
      provider: string;
      mediaId: string;
      kind: string;
      mimeType: string | null;
      filename: string | null;
      caption: string | null;
      inboxId: string;
    },
  ): Promise<string> {
    let bytes: Buffer;
    let contentType: string;
    let tooLarge = false;
    if (job.channel === 'email') {
      const [row] = await withSystem(this.database, {}, (tx) =>
        tx.select().from(schema.webhookInbox).where(eq(schema.webhookInbox.id, job.inboxId)),
      );
      const parsed = row?.rawBody
        ? (this.email.parseInbound(JSON.parse(row.rawBody)) ??
          parsePostmarkInbound(JSON.parse(row.rawBody)))
        : null;
      const index = Number(job.mediaId.split(':').at(-1));
      const attachment = parsed?.attachments[index];
      if (!attachment) return 'missing';
      bytes = attachment.content;
      contentType = attachment.contentType;
    } else {
      if (!this.whatsapp) return 'no_provider';
      try {
        const media = await this.whatsapp.fetchMedia(job.mediaId, { maxBytes: MEDIA_MAX_BYTES });
        bytes = media.bytes;
        contentType = media.contentType.split(';')[0]!.trim().toLowerCase();
      } catch (error) {
        // Review S-4: over the limit, nothing is read; the attachment is recorded as refused.
        if (!(error instanceof ProviderError) || error.status !== 413) throw error;
        tooLarge = true;
        bytes = Buffer.alloc(0);
        contentType = (job.mimeType ?? 'application/octet-stream')
          .split(';')[0]!
          .trim()
          .toLowerCase();
      }
    }
    // M11 review R3 F4: the bytes decide what a file is, never the type the sender declared. A
    // file of a type we take is stored under the type its first bytes show, when that is of the
    // same kind as declared (a PNG sent as a JPEG is still an image); anything else is refused.
    const declaredKind = MEDIA_TYPES[contentType];
    const sniffed = tooLarge ? null : sniffContentType(bytes);
    const sniffedKind = sniffed ? MEDIA_TYPES[sniffed] : undefined;
    const kind = declaredKind;
    const reject =
      tooLarge || bytes.length > MEDIA_MAX_BYTES
        ? 'too_large'
        : !declaredKind
          ? 'type_not_accepted'
          : !sniffedKind || sniffedKind !== declaredKind
            ? 'type_mismatch'
            : null;
    if (!reject && sniffed) contentType = sniffed;
    // M11 review R3 F10: a photo sent by WhatsApp or email is re-encoded before it is stored,
    // which drops its EXIF and location; the audit event keeps the original's hash. A sticker
    // (animated, and never a camera's) and a photo that does not decode are kept as they came.
    let originalSha256: string | null = null;
    if (!reject && kind === 'image' && job.kind !== 'sticker') {
      const cleaned = await reencodeImage(bytes, contentType);
      if (cleaned) {
        originalSha256 = sha256(bytes);
        bytes = cleaned;
      }
    }
    const [company] = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select({ countryCode: schema.company.countryCode })
        .from(schema.company)
        .where(eq(schema.company.id, companyId)),
    );
    const file = reject
      ? null
      : await this.documents
          .storeWriteOnce({
            companyId,
            countryCode: company?.countryCode ?? 'GH',
            key: `messages/${companyId}/${job.messageId}/${sha256(job.mediaId).slice(0, 24)}`,
            bytes,
            contentType,
          })
          .catch(async (error: unknown) => {
            // A retry after the copy was made: the object is there already; record a fresh key.
            if ((error as { code?: string }).code !== 'already_exists') throw error;
            return this.documents.storeWriteOnce({
              companyId,
              countryCode: company?.countryCode ?? 'GH',
              key: `messages/${companyId}/${job.messageId}/${sha256(job.mediaId).slice(0, 24)}-${Date.now()}`,
              bytes,
              contentType,
            });
          });
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const documentId = file
        ? await this.documents.recordWriteOnce(tx, file, {
            kind: 'message_media',
            origin: 'upload',
            ...(originalSha256 ? { auditData: { originalSha256 } } : {}),
          })
        : null;
      const [attachment] = await tx
        .insert(schema.messageAttachment)
        .values({
          companyId,
          messageId: job.messageId,
          kind: (kind ??
            (['image', 'video', 'audio', 'document', 'sticker'].includes(job.kind)
              ? job.kind
              : 'document')) as 'image',
          contentType,
          sizeBytes: bytes.length,
          documentId,
          status: documentId ? 'stored' : 'rejected',
          rejectReason: documentId ? null : (reject ?? 'not_stored'),
          provider: job.provider,
          providerMediaId: job.mediaId,
          filename: job.filename?.slice(0, 240) ?? null,
          caption: job.caption?.slice(0, 1024) ?? null,
          copiedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!attachment) return 'duplicate';
      await this.maintenance.attachLate(tx, companyId, attachment);
      return attachment.status;
    });
  }

  // In-app (plan 4.4 step 7) ---------------------------------------------------------------------

  /**
   * A tenant writing in the app: checked as the tenant (their own tenancy in this company), then
   * recorded through the same path as every other channel, in the system's name.
   */
  async recordInApp(
    companyId: string,
    input: {
      readonly tenantId: string;
      readonly personId: string;
      readonly messageId: string;
      readonly body: string;
      /** Photo uploads checked and copied to write-once storage, recorded here as documents. */
      readonly staged: readonly StagedEvidence[];
      readonly record: (tx: Tx, staged: StagedEvidence) => Promise<string>;
    },
  ): Promise<{ messageId: string; conversationId: string; created: boolean }> {
    const now = this.clock.now();
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [company] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      const settings = messagingSettingsOf(parseCompanySettings(company?.settings));
      const existing = await conversationOfTenant(tx, input.tenantId);
      let conversation =
        existing ??
        (await this.startConversation(
          tx,
          companyId,
          input.tenantId,
          'in_app',
          now,
          settings.inboxFirstResponseMinutes,
        ));
      // M6 review MF-2: between leases, the latest issued lease's property, so the tenant's own
      // session reads it back.
      const propertyId = await messagePropertyOf(tx, input.tenantId);
      const inserted = await tx
        .insert(schema.message)
        .values({
          id: input.messageId,
          companyId,
          propertyId,
          tenantId: input.tenantId,
          purpose: 'inbound',
          body: input.body,
          channels: ['in_app'],
          direction: 'inbound',
          conversationId: conversation.id,
          authorType: 'tenant',
          authorPersonId: null,
          channel: 'in_app',
          attachmentCount: input.staged.length,
        })
        .onConflictDoNothing()
        .returning({ id: schema.message.id });
      if (inserted.length === 0)
        return { messageId: input.messageId, conversationId: conversation.id, created: false };
      for (const staged of input.staged)
        await tx.insert(schema.messageAttachment).values({
          companyId,
          messageId: input.messageId,
          kind: 'image',
          contentType: staged.contentType,
          sizeBytes: staged.bytes.length,
          documentId: await input.record(tx, staged),
          status: 'stored',
          provider: 'in_app',
          providerMediaId: staged.uploadId,
          copiedAt: now,
        });
      await touchChannel(tx, {
        companyId,
        conversationId: conversation.id,
        channel: 'in_app',
        address: input.personId,
        whatsappAccountId: null,
        direction: 'inbound',
        at: now,
      });
      const activity = {
        lastMessageAt: now,
        lastInboundAt: now,
        lastInboundChannel: 'in_app' as const,
      };
      conversation = existing
        ? await applyEvent(
            tx,
            conversation,
            { type: 'tenant_message', channel: 'in_app' },
            instantFrom(now),
            settings.inboxFirstResponseMinutes,
            activity,
          )
        : (
            await tx
              .update(schema.conversation)
              .set({ ...activity, updatedAt: now })
              .where(eq(schema.conversation.id, conversation.id))
              .returning()
          )[0]!;
      // M6 review M2: STOP, STOP ALL and START typed in the app (decision 1: until there is an SMS
      // short code, the app is how a tenant stops SMS), confirmed in the thread.
      const keyword = input.staged.length === 0 ? parseKeyword(input.body) : null;
      if (keyword && company) {
        const effect = appKeywordEffect(keyword);
        for (const channel of effect.channels)
          await this.tenants.recordSystemConsent(tx, companyId, {
            tenantId: input.tenantId,
            contactId: null,
            channel,
            action: effect.action,
            source: keyword.kind === 'start' ? 'start_keyword' : 'stop_keyword',
            textVersion: keyword.kind === 'start' ? 'start.v1' : 'stop.v1',
            recordedAt: now,
          });
        await queueMessage(tx, companyId, {
          messageId: uuidv5(`${input.messageId}:app-keyword`, NAMESPACE),
          recipient: { type: 'tenant', tenantId: input.tenantId },
          purpose: 'opt_out_confirmation',
          body: appOptOutConfirmationText({ companyName: company.displayName, keyword }),
          propertyId,
          reply: {
            conversationId: conversation.id,
            channel: 'in_app',
            authorType: 'system',
            authorPersonId: null,
            template: null,
          },
        });
        return { messageId: input.messageId, conversationId: conversation.id, created: true };
      }
      if (company && !planHas(await this.entitlements.planIn(tx, companyId), 'inbox'))
        await this.bot.forwardToLandlord(
          tx,
          company,
          [input.messageId],
          input.body,
          input.tenantId,
        );
      return { messageId: input.messageId, conversationId: conversation.id, created: true };
    });
  }
}

/** The process job's name, for the worker. */
export { MESSAGING_INBOUND_JOB };
