import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { instantFrom, type Instant } from '@rent/domain/dates';
import {
  CONSENT_CHANNELS,
  isConsentChannel,
  NO_CONSENT,
  planOutbound,
  planReply,
  pushNotice,
  renderTemplate,
  type ChannelReach,
  type ConsentChannel,
  type ConsentFacts,
  type InboundChannel,
  type MessageChannel,
  type TemplateDefinition,
  type WhatsAppContent,
} from '@rent/domain/messaging';
import { providerCostToMinor } from '@rent/domain/money';
import {
  ProviderError,
  type EmailAttachment,
  type EmailPort,
  type PushPort,
  type SmsPort,
  type WhatsAppPort,
} from '@rent/integrations';
import type { AppConfig } from '../core/config';
import { emailInboundDomainOf } from '../core/config';
import { AppError } from '../core/errors';
import {
  LINK_PLACEHOLDER,
  MESSAGE_SEND_JOB,
  messageRequestSchema,
  queueMessage,
  storedBody,
  type MessageRecipient,
  type MessageRequest,
} from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import type { Clock } from '../core/clock';
import type { AppLogger } from '../core/logging/logger';
import {
  CLOCK,
  CONFIG,
  DATABASE,
  EMAIL_PORT,
  LOGGER,
  PUSH_PORT,
  SMS_PORT,
  WHATSAPP_PORT,
} from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { personContact } from '../identity/person-directory';
import { IdChecksService } from '../tenancy/id-checks.service';
import { TenantsService } from '../tenancy/tenants.service';
import {
  base32Lower,
  companyAccounts,
  fitChoices,
  unsubscribeAddressHash,
  whatsappRoute,
  conversationOfTenant,
  ensureTenantConversation,
  maskAddress,
  purposeTemplate,
  sendingAccount,
  templateOnSendingNumber,
  touchChannel,
  type TemplateOnAccount,
} from './store';

/** Sends per channel before the next consented channel is tried (plan 4.17). */
export const SENDS_PER_CHANNEL = 5;
export const MESSAGE_NOT_SENT_EVENT = 'messaging.not_sent';
/** M7: delivery reports on notice messages, for the notices module (plan 4.12). */
export const NOTICE_DELIVERY_STATUS_JOB = 'notices.delivery-status';
/** Unsubscribe links in email stay open this long (M6 decision 7; a product choice, not law). */
const UNSUBSCRIBE_DAYS = 365;

/** Who a message can reach, and how (CM-09). */
export interface Reach {
  readonly name: string;
  /** Addresses per channel: a phone for WhatsApp and SMS, an email; for push, the tenant's person. */
  readonly addresses: Partial<Record<ConsentChannel, string>>;
  /** Channels with consent now. Staff, the company's own people, need none. */
  readonly consented: ReadonlySet<ConsentChannel>;
  /** M6: each channel's latest consent event with its time, where the resolver knows it. */
  readonly consent?: Partial<Record<ConsentChannel, ConsentFacts>>;
  readonly isTestContact: boolean;
  readonly tenantId: string | null;
  readonly propertyId: string | null;
  /** M6: the tenancy person this is (business email gets reply and unsubscribe addresses). */
  readonly subject?: { readonly tenantId: string; readonly contactId: string | null } | null;
}

/** Finds a recipient's addresses and consent inside the send job's company transaction. */
export interface RecipientResolver {
  /** M8: the purpose too, for channels kept to one purpose (staff WhatsApp for emergency alerts). */
  reach(
    tx: Tx,
    companyId: string,
    recipient: MessageRecipient,
    purpose?: MessageRequest['purpose'],
  ): Promise<Reach | null>;
}

/**
 * Makes the link a message carries, at send time and outside any transaction, so its raw token
 * is never stored (CLAUDE.md section 9). The e-signing phase adds the `sign` resolver. `sent` and
 * `notSent` run in the transaction that records how the send went: a new link replaces the
 * recipient's earlier one only once it is sent, and one that was never sent is withdrawn, so a
 * failed reminder never costs a signer their working link (M3 review finding 10).
 */
export interface LinkResolver {
  url(companyId: string, targetId: string, messageId: string): Promise<string>;
  sent?(tx: Tx, companyId: string, targetId: string, messageId: string): Promise<void>;
  notSent?(tx: Tx, companyId: string, targetId: string, messageId: string): Promise<void>;
}

type EventRow = typeof schema.messageEvent.$inferSelect;
type Outcome = 'sent' | 'not_sent' | 'failed' | 'retry';

/** A consent with no time known (staff and signers resolved the M3 way): granted since always. */
const GRANTED: ConsentFacts = {
  latest: { action: 'grant', at: instantFrom('1970-01-01T00:00:00Z') },
};
const factsOf = (row: { action: 'grant' | 'withdraw'; at: Date } | undefined): ConsentFacts =>
  row ? { latest: { action: row.action, at: instantFrom(row.at) } } : NO_CONSENT;

const token = () => randomBytes(32).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** What the send job worked out in its first transaction. */
interface Prepared {
  readonly reach: Reach | null;
  readonly events: EventRow[];
  readonly companyName: string;
  readonly pushTokens: readonly string[];
  readonly lastInbound: Partial<Record<InboundChannel, Instant | null>>;
  readonly account: Awaited<ReturnType<typeof sendingAccount>>;
  readonly template: TemplateOnAccount | null;
  readonly conversationId: string | null;
  /** M11 decision 5: an erasure request stopped messaging to this tenant on every channel. */
  readonly messagingStopped: boolean;
}

/**
 * M11 decision 5 (CM-09): whether an erasure request stopped messaging to the tenant. It stands
 * until the request is refused; consent was withdrawn on every channel too, so a refused request
 * needs staff to record the tenant's consent again before anything is sent.
 */
export async function messagingStoppedFor(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.execute<{ stopped: boolean }>(
    sql`select exists (select 1 from data_protection_request r
                       where r.tenant_id = ${tenantId}::uuid and r.kind = 'erasure'
                         and r.messaging_stopped_at is not null and r.status <> 'refused') as stopped`,
  );
  return rows.rows[0]?.stopped === true;
}

/**
 * The outbound messaging core (M3 decision 1; M6 decision 5 and plan 4.3; CLAUDE.md section 8).
 * The `messaging.send` job records each queued message once, then picks a channel with
 * `planOutbound` (push, WhatsApp, SMS, email: an address, consent, and on WhatsApp the window or
 * an approved template) or, for a reply, `planReply` on the tenant's channel. It adds the link,
 * sends, and records what happened as events, with the provider's cost where it gives one. A
 * failing channel is tried up to five times, a refusing one not again; then the next channel. With
 * none left the message is "not sent" and whoever queued it is told.
 */
@Injectable()
export class MessagingService {
  private readonly recipients = new Map<MessageRecipient['type'], RecipientResolver>();
  private readonly links = new Map<NonNullable<MessageRequest['link']>['purpose'], LinkResolver>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(TenantsService) tenants: TenantsService,
    @Inject(IdChecksService) idChecks: IdChecksService,
    @Optional() @Inject(WHATSAPP_PORT) private readonly whatsapp: WhatsAppPort | null = null,
    @Optional() @Inject(PUSH_PORT) private readonly push: PushPort | null = null,
    @Optional()
    @Inject(DocumentsService)
    private readonly documents: DocumentsService | null = null,
    /** M6: the windows and routing compare with the inbound pipeline's times, so one clock. */
    @Optional() @Inject(CLOCK) private readonly clock: Clock | null = null,
    @Optional() @Inject(LOGGER) private readonly logger: AppLogger | null = null,
  ) {
    const tenancy: RecipientResolver = {
      async reach(tx, _companyId, recipient) {
        const subject = tenancySubject(recipient);
        if (!subject) return null;
        const point = await tenants.messagingPoint(tx, subject);
        if (!point) return null;
        const consent: Partial<Record<ConsentChannel, ConsentFacts>> = {};
        for (const channel of CONSENT_CHANNELS) consent[channel] = factsOf(point.consent[channel]);
        return {
          name: point.name,
          addresses: {
            ...(point.phone ? { sms: point.phone } : {}),
            ...(point.whatsappPhone ? { whatsapp: point.whatsappPhone } : {}),
            ...(point.email ? { email: point.email } : {}),
            ...(point.personId ? { push: point.personId } : {}),
          },
          consented: new Set(CONSENT_CHANNELS.filter((c) => point.consent[c]?.action === 'grant')),
          consent,
          isTestContact: point.isTestContact,
          tenantId: subject.tenantId,
          propertyId: point.propertyId,
          subject: { tenantId: subject.tenantId, contactId: subject.contactId },
        };
      },
    };
    this.recipients.set('tenant', tenancy);
    this.recipients.set('tenant_contact', tenancy);
    // Staff by email and phone, which they need not consent to; WhatsApp only once they opt in
    // (OQ-33), which nothing records yet, so never.
    this.recipients.set('staff', {
      async reach(tx, _companyId, recipient) {
        const personId = staffPersonOf(recipient);
        if (!personId) return null;
        const person = await personContact(tx, personId);
        if (!person) return null;
        const addresses = {
          ...(person.email ? { email: person.email } : {}),
          ...(person.phone ? { sms: person.phone } : {}),
        };
        return {
          name: person.name,
          addresses,
          consented: new Set(Object.keys(addresses) as MessageChannel[]),
          isTestContact: person.isTestContact,
          tenantId: null,
          propertyId: null,
        };
      },
    });
    this.links.set('id_capture', {
      url: (companyId, checkId) => idChecks.captureUrl(companyId, checkId),
    });
  }

  private now(): Date {
    return this.clock?.now() ?? new Date();
  }

  /** The e-signing phase registers the `signer` recipients (from its signer snapshots). */
  useRecipients(type: MessageRecipient['type'], resolver: RecipientResolver): void {
    this.recipients.set(type, resolver);
  }

  /** The e-signing phase registers the `sign` links (it mints the secure link at send time). */
  useLinks(purpose: NonNullable<MessageRequest['link']>['purpose'], resolver: LinkResolver): void {
    this.links.set(purpose, resolver);
  }

  /**
   * The `messaging.send` job (plan 4.17): idempotent by message id. Throws only to have a failed
   * send retried with backoff; every other outcome is recorded as an event.
   */
  async deliver(companyId: string, request: MessageRequest): Promise<Outcome> {
    const ctx = { companyId, actorKind: 'system' as const };
    const prepared = await withCompany(this.database, ctx, (tx) =>
      this.prepare(tx, companyId, request),
    );
    const { reach, events } = prepared;
    if (settled(events)) return 'sent';
    if (events.some((e) => e.status === 'failed' && e.reason === 'delivery_failed'))
      return 'failed';
    if (!reach) return this.finish(companyId, request, 'not_sent', 'no_recipient');
    // M11 decision 5: nothing goes to a tenant (or their contacts) once an erasure request has
    // stopped messaging, whatever the purpose or channel. A notice's message is withheld the same
    // way, and its ladder falls back to physical service (`messaging.not_sent`).
    if (prepared.messagingStopped)
      return this.finish(companyId, request, 'not_sent', 'messaging_stopped');
    // Real adapters never send to test contacts (as in M1); fakes capture everything locally.
    if (reach.isTestContact && this.config.NODE_ENV === 'production')
      return this.finish(companyId, request, 'not_sent', 'test_contact');

    const failures = countFailures(events);
    const exhausted = new Set<ConsentChannel>(
      CONSENT_CHANNELS.filter(
        (c) => failures.count[c] >= SENDS_PER_CHANNEL || failures.permanent.has(c),
      ),
    );
    const now = instantFrom(this.now());
    const reachOf = (channel: ConsentChannel): ChannelReach => {
      const reach = this.channelReach(prepared, channel);
      // M7 (decision 4): on the electronic-service clause the clause is the consent, for the one
      // channel listed; an opt-out there still withholds it (decision 5; CLAUDE.md section 8).
      if (
        request.serviceClause &&
        request.channels.includes(channel) &&
        reach.consent.latest?.action !== 'withdraw'
      )
        return { ...reach, consent: GRANTED };
      return reach;
    };

    let channel: InboundChannel | 'push';
    let whatsapp: WhatsAppContent | null;
    // Business-initiated (consent was the basis): email carries the unsubscribe link (decision 7).
    let businessInitiated: boolean;
    if (request.reply) {
      channel = request.reply.channel;
      if (channel !== 'in_app' && exhausted.has(channel)) {
        const tried = failures.count[channel] > 0;
        return this.finish(
          companyId,
          request,
          tried ? 'failed' : 'not_sent',
          tried ? 'delivery_failed' : 'no_address',
        );
      }
      const plan = planReply({
        purpose: request.purpose,
        channel,
        reach:
          channel === 'in_app'
            ? { address: true, consent: NO_CONSENT, lastInboundAt: null }
            : reachOf(channel),
        whatsappTemplate: prepared.template,
        now,
      });
      if (!plan.send) return this.finish(companyId, request, 'not_sent', plan.reason);
      whatsapp = plan.whatsapp;
      businessInitiated = plan.basis === 'consent';
      if (channel === 'whatsapp' && request.reply.template === 'conversation_reopen') {
        if (prepared.template?.status !== 'approved')
          return this.finish(companyId, request, 'not_sent', 'no_approved_template');
        whatsapp = {
          kind: 'template',
          templateKey: 'conversation_reopen',
          language: prepared.template.language,
        };
      }
    } else {
      const plan = planOutbound({
        purpose: request.purpose,
        channels: request.channels,
        reach: Object.fromEntries(CONSENT_CHANNELS.map((c) => [c, reachOf(c)])),
        whatsappTemplate: prepared.template,
        exhausted,
        now,
      });
      if (!plan.send) {
        if (
          plan.reason === 'delivery_failed' &&
          Object.values(failures.count).every((n) => n === 0)
        )
          return this.finish(companyId, request, 'not_sent', 'no_address');
        return this.finish(
          companyId,
          request,
          plan.reason === 'delivery_failed' ? 'failed' : 'not_sent',
          plan.reason,
        );
      }
      channel = plan.channel;
      whatsapp = plan.whatsapp;
      businessInitiated = plan.basis === 'consent';
    }
    return this.sendOn(
      companyId,
      request,
      prepared,
      channel,
      whatsapp,
      failures.count,
      businessInitiated,
    );
  }

  /** Whether a channel has a provider in this deployment. */
  private available(channel: ConsentChannel): boolean {
    if (channel === 'whatsapp') return this.whatsapp !== null;
    if (channel === 'push') return this.push !== null;
    return true;
  }

  private async prepare(tx: Tx, companyId: string, request: MessageRequest): Promise<Prepared> {
    const resolver = this.recipients.get(request.recipient.type);
    const reach = resolver
      ? await resolver.reach(tx, companyId, request.recipient, request.purpose)
      : null;
    await this.record(tx, companyId, request, reach);
    const events = await tx
      .select()
      .from(schema.messageEvent)
      .where(eq(schema.messageEvent.messageId, request.messageId))
      .orderBy(asc(schema.messageEvent.occurredAt), asc(schema.messageEvent.id));
    return this.gather(tx, companyId, request, reach, events);
  }

  /** What the send job needs to choose a channel, without recording anything. */
  private async gather(
    tx: Tx,
    companyId: string,
    request: Pick<MessageRequest, 'purpose' | 'channels' | 'reply' | 'link'>,
    reach: Reach | null,
    events: EventRow[],
  ): Promise<Prepared> {
    const [company] = await tx
      .select({ name: schema.company.displayName })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    let pushTokens: string[] = [];
    const lastInbound: Partial<Record<InboundChannel, Instant | null>> = {};
    let conversationId: string | null = request.reply?.conversationId ?? null;
    const subject = reach?.subject ?? null;
    if (
      subject &&
      !subject.contactId &&
      reach?.addresses.push &&
      (request.channels.includes('push') || request.reply)
    )
      pushTokens = (
        await tx.execute<{ token: string }>(
          sql`select token from app.push_tokens_for_tenant(${subject.tenantId}::uuid)`,
        )
      ).rows.map((r) => r.token);
    let activity: (typeof schema.conversationChannel.$inferSelect)[] = [];
    if (subject) {
      const conversation = await conversationOfTenant(tx, subject.tenantId);
      conversationId ??= conversation?.id ?? null;
      if (conversationId)
        activity = await tx
          .select()
          .from(schema.conversationChannel)
          .where(eq(schema.conversationChannel.conversationId, conversationId));
      for (const row of activity) {
        const channel = row.channel as InboundChannel;
        // WhatsApp's window is per number: worked out below for the number it will go from.
        if (channel === 'whatsapp') continue;
        const address =
          channel === 'sms'
            ? reach?.addresses.sms
            : channel === 'email'
              ? reach?.addresses.email
              : null;
        if (channel !== 'in_app' && row.address !== address) continue;
        const at = row.lastInboundAt ? instantFrom(row.lastInboundAt) : null;
        const known = lastInbound[channel];
        if (at && (!known || at.epochMilliseconds > known.epochMilliseconds))
          lastInbound[channel] = at;
      }
    }
    // M6 review M4: each number has its own window. A reply goes from the number the tenant
    // last wrote to; anything else from the company's sending number.
    const route = this.whatsapp
      ? whatsappRoute({
          accounts: await companyAccounts(tx, companyId),
          activity,
          address: reach?.addresses.whatsapp,
          reply: Boolean(request.reply),
        })
      : { account: null, lastInboundAt: null };
    if (route.lastInboundAt) lastInbound.whatsapp = instantFrom(route.lastInboundAt);
    const account = route.account;
    const found = request.reply
      ? await templateOnSendingNumber(tx, companyId, 'conversation_reopen', account?.accountId)
      : await purposeTemplate(tx, companyId, request.purpose, account?.accountId);
    // A template that carries a link cannot go without one (a rent reminder with no pay link):
    // outside the window WhatsApp is then skipped, rather than failing every time.
    const template = found && found.parameters.includes('link') && !request.link ? null : found;
    return {
      reach,
      events,
      companyName: company?.name ?? this.config.APP_NAME,
      pushTokens,
      lastInbound,
      account,
      template,
      conversationId,
      // The tenant or contact themselves (`subject`), never a staff or witness signer of their lease.
      messagingStopped: reach?.subject
        ? await messagingStoppedFor(tx, reach.subject.tenantId)
        : false,
    };
  }

  /**
   * The channels a message would be tried on, in order, for a tenant or contact now: the pay
   * link's answer (M6 review C2). Each needs an address, consent and, on WhatsApp, the window or
   * an approved template; a channel without a provider here is left out.
   */
  async plannedChannels(
    tx: Tx,
    companyId: string,
    input: {
      readonly recipient: MessageRecipient;
      readonly purpose: MessageRequest['purpose'];
      readonly channels: readonly ConsentChannel[];
      readonly link?: MessageRequest['link'];
    },
  ): Promise<ConsentChannel[]> {
    const resolver = this.recipients.get(input.recipient.type);
    const reach = resolver
      ? await resolver.reach(tx, companyId, input.recipient, input.purpose)
      : null;
    if (!reach) return [];
    if (reach.subject && (await messagingStoppedFor(tx, reach.subject.tenantId))) return [];
    const prepared = await this.gather(
      tx,
      companyId,
      { purpose: input.purpose, channels: [...input.channels], link: input.link ?? null },
      reach,
      [],
    );
    const now = instantFrom(this.now());
    const out: ConsentChannel[] = [];
    const exhausted = new Set<ConsentChannel>();
    for (;;) {
      const plan = planOutbound({
        purpose: input.purpose,
        channels: input.channels,
        reach: Object.fromEntries(CONSENT_CHANNELS.map((c) => [c, this.channelReach(prepared, c)])),
        whatsappTemplate: prepared.template,
        exhausted,
        now,
      });
      if (!plan.send) return out;
      out.push(plan.channel);
      exhausted.add(plan.channel);
    }
  }

  /** One channel's address, consent and last inbound time, as the planner needs them. */
  private channelReach(prepared: Prepared, channel: ConsentChannel): ChannelReach {
    const reach = prepared.reach!;
    return {
      // A channel with no provider in this deployment has no address to send to.
      address: !this.available(channel)
        ? false
        : channel === 'push'
          ? prepared.pushTokens.length > 0
          : channel === 'whatsapp'
            ? Boolean(reach.addresses.whatsapp) && prepared.account !== null
            : Boolean(reach.addresses[channel]),
      consent: reach.consent?.[channel] ?? (reach.consented.has(channel) ? GRANTED : NO_CONSENT),
      lastInboundAt: channel === 'push' ? null : (prepared.lastInbound[channel] ?? null),
    };
  }

  private async sendOn(
    companyId: string,
    request: MessageRequest,
    prepared: Prepared,
    channel: InboundChannel | 'push',
    whatsapp: WhatsAppContent | null,
    failureCount: Record<ConsentChannel, number>,
    businessInitiated: boolean,
  ): Promise<Outcome> {
    const reach = prepared.reach!;
    const ctx = { companyId, actorKind: 'system' as const };
    // Push names what arrived; the details open in the app, so no link is made (decision 5).
    const link =
      request.link && channel !== 'push' && channel !== 'in_app'
        ? (this.links.get(request.link.purpose) ?? null)
        : null;
    let url: string | null = null;
    if (request.link && channel !== 'push' && channel !== 'in_app') {
      if (!link) return this.finish(companyId, request, 'not_sent', 'link_unavailable');
      try {
        url = await link.url(companyId, request.link.targetId, request.messageId);
      } catch (error) {
        // What the link was for is gone (a check cancelled, a request closed): nothing to send.
        // Anything else is retried.
        if (error instanceof AppError && error.status < 500)
          return this.finish(companyId, request, 'not_sent', 'link_unavailable');
        throw error;
      }
    }
    const body = url === null ? request.body : request.body.split(LINK_PLACEHOLDER).join(url);
    const address =
      channel === 'push' ? 'app' : channel === 'in_app' ? 'app' : (reach.addresses[channel] ?? '');
    let sent: Awaited<ReturnType<MessagingService['dispatch']>>;
    try {
      sent = await this.dispatch(
        companyId,
        request,
        prepared,
        channel,
        whatsapp,
        body,
        url,
        address,
        businessInitiated,
      );
    } catch (error) {
      if (channel === 'in_app') throw error;
      const retryable = !(error instanceof ProviderError) || error.retryable;
      await withCompany(this.database, ctx, async (tx) => {
        await this.event(tx, companyId, request.messageId, {
          status: 'failed',
          channel,
          reason: retryable ? 'provider_error' : 'provider_refused',
          destinationMasked: channel === 'push' ? 'app' : maskAddress(channel, address),
        });
        // This attempt's link reached nobody; a retry, or the next channel, makes a fresh one.
        if (request.link && link?.notSent)
          await link.notSent(tx, companyId, request.link.targetId, request.messageId);
      });
      // A retryable failure is tried again after a pause; the next channel only once this one
      // has failed five times or refused outright. A fixed-channel reply has no next channel.
      if (retryable && failureCount[channel] + 1 < SENDS_PER_CHANNEL) throw error;
      return this.deliver(companyId, request);
    }
    // M6 review S8: the send happened. It is recorded first, on its own, so nothing after it can
    // turn a delivered message into a failure (or withdraw the link it carried).
    await withCompany(this.database, ctx, async (tx) => {
      for (const result of sent.results)
        await this.event(tx, companyId, request.messageId, {
          status: 'sent',
          channel,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          destinationMasked:
            channel === 'push' || channel === 'in_app' ? 'app' : maskAddress(channel, address),
          ...(result.costMinor === undefined
            ? {}
            : { costMinor: result.costMinor, currency: 'GHS' }),
          ...(sent.templateKey ? { templateKey: sent.templateKey } : {}),
        });
      for (const notice of sent.extra)
        await this.event(tx, companyId, request.messageId, {
          status: 'sent',
          channel: 'push',
          provider: notice.provider,
          providerMessageId: notice.providerMessageId,
          destinationMasked: 'app',
        });
    });
    await withCompany(this.database, ctx, async (tx) => {
      if (request.link && link?.sent)
        await link.sent(tx, companyId, request.link.targetId, request.messageId);
      // WhatsApp and email need the tenant's conversation: routing on the shared number and
      // email replies find their way back through it (decision 4, CM-10).
      const conversationId =
        prepared.conversationId ??
        (reach.subject && (channel === 'whatsapp' || channel === 'email')
          ? (await ensureTenantConversation(tx, companyId, reach.subject.tenantId)).id
          : null);
      if (reach.subject && conversationId && channel !== 'push')
        await touchChannel(tx, {
          companyId,
          conversationId,
          channel,
          address:
            channel === 'in_app' ? (reach.addresses.push ?? reach.subject.tenantId) : address,
          whatsappAccountId: channel === 'whatsapp' ? (prepared.account?.accountId ?? null) : null,
          direction: 'outbound',
          at: this.now(),
        });
    }).catch((error: unknown) => {
      // The message went and is recorded; what follows it is bookkeeping, never a resend.
      this.logger?.warn(
        { err: error, messageId: request.messageId },
        'post-send bookkeeping failed',
      );
    });
    return 'sent';
  }

  /** One send through the channel's port. Throws ProviderError on a provider's refusal. */
  private async dispatch(
    companyId: string,
    request: MessageRequest,
    prepared: Prepared,
    channel: InboundChannel | 'push',
    whatsapp: WhatsAppContent | null,
    body: string,
    url: string | null,
    address: string,
    businessInitiated = true,
  ): Promise<{
    results: { provider: string; providerMessageId: string; costMinor?: number }[];
    extra: { provider: string; providerMessageId: string }[];
    templateKey?: string;
  }> {
    const reach = prepared.reach!;
    switch (channel) {
      case 'push': {
        const notice = pushNotice(request.purpose, prepared.companyName);
        const tickets = await this.push!.send({
          tokens: prepared.pushTokens,
          title: notice.title,
          body: notice.body,
          // The app's push data (contracts `pushDataSchema`): a screen and the landlord, never a
          // path, a link or a figure (decision 5).
          data: {
            screen: notice.screen,
            companyId,
            ...(request.related?.type === 'lease' ? { leaseId: request.related.id } : {}),
          },
        });
        await this.forgetDeadTokens(tickets);
        const ok = tickets.flatMap((t) =>
          'ticketId' in t ? [{ provider: this.push!.provider, providerMessageId: t.ticketId }] : [],
        );
        if (ok.length === 0)
          throw new ProviderError(
            this.push!.provider,
            'no device accepted the notification',
            false,
          );
        return { results: ok, extra: [] };
      }
      case 'in_app': {
        // The tenant reads it in the app; a notification says it is there, where they agreed.
        const extra: { provider: string; providerMessageId: string }[] = [];
        if (
          this.push &&
          prepared.pushTokens.length > 0 &&
          reach.consent?.push?.latest?.action === 'grant'
        ) {
          const notice = pushNotice(request.purpose, prepared.companyName);
          const tickets = await this.push
            .send({
              tokens: prepared.pushTokens,
              title: notice.title,
              body: notice.body,
              data: { screen: 'messages', companyId },
            })
            .catch(() => []);
          await this.forgetDeadTokens(tickets);
          for (const t of tickets)
            if ('ticketId' in t)
              extra.push({ provider: this.push.provider, providerMessageId: t.ticketId });
        }
        return { results: [{ provider: 'in_app', providerMessageId: request.messageId }], extra };
      }
      case 'whatsapp': {
        const port = this.whatsapp!;
        const from = prepared.account?.phoneNumberId;
        const base = { to: address, reference: request.messageId, ...(from ? { from } : {}) };
        if (whatsapp?.kind === 'template') {
          const template = prepared.template;
          if (!template || template.key !== whatsapp.templateKey)
            throw new ProviderError(port.provider, 'template unavailable', false);
          const definition: TemplateDefinition = {
            key: template.key,
            version: template.version,
            whatsappName: template.whatsappName,
            category: 'utility',
            language: template.language,
            body: template.body,
            parameters: template.parameters,
          };
          let parameters: readonly string[];
          try {
            parameters = renderTemplate(definition, {
              landlord: prepared.companyName,
              tenant: reach.name,
              ...(url ? { link: url } : {}),
              ...(request.templateParams ?? {}),
            }).parameters;
          } catch {
            throw new ProviderError(port.provider, 'template parameters missing', false);
          }
          const result = await port.sendTemplate({
            ...base,
            template: template.whatsappName,
            language: template.language,
            parameters,
          });
          return { results: [result], extra: [], templateKey: template.key };
        }
        if (request.document && this.documents) {
          const link = await this.documents.downloadUrl(
            companyId,
            request.document.documentId,
            request.document.filename,
          );
          if (link) {
            if (body.length > 1024) await port.sendText({ ...base, body: body.slice(0, 4096) });
            const result = await port.sendMedia({
              ...base,
              mediaUrl: link,
              kind: 'document',
              filename: request.document.filename,
              ...(body.length <= 1024 ? { caption: body } : {}),
            });
            return { results: [result], extra: [] };
          }
        }
        const choices = request.reply?.choices ?? [];
        if (choices.length > 0 && body.length <= 1024) {
          const result = await port.sendInteractive({
            ...base,
            body,
            choices: fitChoices(choices),
            listButton: 'Menu',
          });
          return { results: [result], extra: [] };
        }
        return {
          results: [await port.sendText({ ...base, body: body.slice(0, 4096) })],
          extra: [],
        };
      }
      case 'sms': {
        const result = await this.sms.send({ to: address, body, reference: request.messageId });
        return {
          results: [
            {
              provider: result.provider,
              providerMessageId: result.providerMessageId,
              ...(result.cost?.currency === 'GHS'
                ? { costMinor: providerCostToMinor(result.cost.decimal).amountMinor }
                : {}),
            },
          ],
          extra: [],
        };
      }
      case 'email': {
        const extras = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
          this.emailExtras(tx, companyId, request, reach, businessInitiated),
        );
        const attachments: EmailAttachment[] = [];
        if (request.document && this.documents) {
          const file = await this.documents.documentFile(companyId, request.document.documentId);
          if (file?.intact)
            attachments.push({
              filename: request.document.filename,
              contentType: file.contentType,
              content: file.bytes,
            });
        }
        const result = await this.email.send({
          to: address,
          subject: request.subject ?? `${prepared.companyName}`,
          text: extras.footer ? `${body}\n\n${extras.footer}` : body,
          ...(extras.replyTo ? { replyTo: extras.replyTo } : {}),
          ...(extras.headers ? { headers: extras.headers } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          reference: request.messageId,
        });
        return { results: [result], extra: [] };
      }
    }
  }

  /**
   * CM-10 and decision 7: business email to a tenant or contact carries a reply address that
   * threads the answer back, and an unsubscribe link and `List-Unsubscribe` header. Only the
   * tokens' hashes are stored; the tokens themselves live only in the email.
   */
  private async emailExtras(
    tx: Tx,
    companyId: string,
    request: MessageRequest,
    reach: Reach,
    businessInitiated: boolean,
  ): Promise<{ replyTo?: string; headers?: Record<string, string>; footer?: string }> {
    const subject = reach.subject;
    if (!subject) return {};
    const conversation = await ensureTenantConversation(tx, companyId, subject.tenantId);
    // Case-proof: mail systems lower-case the address it travels in (CM-10).
    const reply = base32Lower(randomBytes(32));
    await tx.insert(schema.replyAddress).values({
      companyId,
      conversationId: conversation.id,
      messageId: request.messageId,
      tokenHash: sha256(reply),
    });
    const out: { replyTo: string; headers?: Record<string, string>; footer?: string } = {
      replyTo: `reply+${reply}@${emailInboundDomainOf(this.config)}`,
    };
    // A reply within the tenant's reply window answers them; outside it (consent was the basis),
    // or for anything the business starts, it is business-initiated and carries the link
    // (decision 7; M6 review L1).
    if (request.reply && !businessInitiated) return out;
    const email = reach.addresses.email;
    if (!email) return out;
    const unsubscribe = token();
    await tx.insert(schema.unsubscribeToken).values({
      companyId,
      tenantId: subject.tenantId,
      tenantContactId: subject.contactId,
      messageId: request.messageId,
      tokenHash: sha256(unsubscribe),
      addressHash: unsubscribeAddressHash(this.config, email),
      expiresAt: new Date(this.now().getTime() + UNSUBSCRIBE_DAYS * 24 * 3600 * 1000),
    });
    // apps/links: GET /u/{token} shows the page; POST /u/{token}/confirm unsubscribes, which is
    // what a mail client's one-click unsubscribe (RFC 8058) posts to.
    const link = `${this.config.LINKS_ORIGIN}/u/${unsubscribe}`;
    out.headers = {
      'List-Unsubscribe': `<${link}/confirm>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
    out.footer = `To stop these emails: ${link}`;
    return out;
  }

  /** Expo said a device is gone: its token is forgotten everywhere. */
  private async forgetDeadTokens(
    tickets: readonly ({ token: string } & ({ ticketId: string } | { error: string }))[],
  ) {
    const dead = tickets
      .filter((t) => 'error' in t && t.error === 'DeviceNotRegistered')
      .map((t) => t.token);
    if (dead.length === 0) return;
    await withSystem(this.database, {}, async (tx) => {
      for (const t of dead) await tx.execute(sql`select app.drop_push_token(${t})`);
    }).catch(() => undefined);
  }

  /**
   * A message whose WhatsApp delivery failed after it was sent (Meta's status webhook): the next
   * channel is tried, through the send job again (plan 4.3, the SMS fallback in CM-09).
   */
  async redeliver(tx: Tx, companyId: string, messageId: string, attempt: string): Promise<boolean> {
    const [m] = await tx.select().from(schema.message).where(eq(schema.message.id, messageId));
    if (!m || m.direction !== 'outbound' || !m.recipientType) return false;
    const recipient = recipientOf(m);
    if (!recipient) return false;
    // Review note: the request as first queued, so its template values, PDF and reply details
    // survive the fallback; rebuilt from the message only when that is gone.
    const [queued] = await tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(eq(schema.outboxEvent.idempotencyKey, `${MESSAGE_SEND_JOB}:${m.id}`))
      .limit(1);
    const original = queued ? messageRequestSchema.safeParse(stripEnvelope(queued.payload)) : null;
    if (original?.success) {
      await enqueueOutbox(tx, {
        companyId,
        type: MESSAGE_SEND_JOB,
        payload: original.data as unknown as Record<string, unknown>,
        idempotencyKey: `${MESSAGE_SEND_JOB}:${m.id}:redeliver:${attempt}`,
      });
      return true;
    }
    const channels = m.channels.filter(isConsentChannel);
    await enqueueOutbox(tx, {
      companyId,
      type: 'messaging.send',
      payload: {
        messageId: m.id,
        recipient,
        purpose: m.purpose,
        subject: m.subject,
        body: m.linkPurpose ? m.body.split('[link]').join(LINK_PLACEHOLDER) : m.body,
        link:
          m.linkPurpose && m.linkTargetId
            ? { purpose: m.linkPurpose, targetId: m.linkTargetId }
            : null,
        channels: channels.length > 0 ? channels : ['sms', 'email'],
        propertyId: m.propertyId,
        related: m.relatedType && m.relatedId ? { type: m.relatedType, id: m.relatedId } : null,
        requestedBy: m.requestedBy,
      },
      idempotencyKey: `messaging.send:${m.id}:redeliver:${attempt}`,
    });
    return true;
  }

  /**
   * M7 (plan 4.6 and 4.12): a delivery report on a message about a notice goes to the notices
   * module, which records the confirming channel (`notices.delivery-status`, by event id).
   */
  async reportToRelated(
    tx: Tx,
    companyId: string,
    messageId: string,
    eventId: string,
    report: { readonly status: string; readonly channel: string | null },
  ): Promise<void> {
    const [m] = await tx
      .select({ relatedType: schema.message.relatedType, relatedId: schema.message.relatedId })
      .from(schema.message)
      .where(eq(schema.message.id, messageId));
    if (m?.relatedType !== 'notice_recipient' || !m.relatedId) return;
    await enqueueOutbox(tx, {
      companyId,
      type: NOTICE_DELIVERY_STATUS_JOB,
      payload: {
        recipientId: m.relatedId,
        messageId,
        eventId,
        status: report.status,
        channel: report.channel,
        at: this.now().toISOString(),
      },
      idempotencyKey: `${NOTICE_DELIVERY_STATUS_JOB}:${eventId}`,
    });
  }

  /** The latest status of each message, for timelines and signing progress. */
  async statuses(
    tx: Tx,
    messageIds: readonly string[],
  ): Promise<
    Map<string, { status: string; channel: string | null; reason: string | null; at: Date }>
  > {
    const out = new Map<
      string,
      { status: string; channel: string | null; reason: string | null; at: Date }
    >();
    if (messageIds.length === 0) return out;
    const rows = await tx
      .select()
      .from(schema.messageEvent)
      .where(inArray(schema.messageEvent.messageId, [...messageIds]))
      .orderBy(asc(schema.messageEvent.occurredAt), asc(schema.messageEvent.id));
    for (const e of rows)
      out.set(e.messageId, {
        status: e.status,
        channel: e.channel,
        reason: e.reason,
        at: e.occurredAt,
      });
    return out;
  }

  /** Records the message once, as composed, with its first event. */
  private async record(
    tx: Tx,
    companyId: string,
    request: MessageRequest,
    reach: Reach | null,
  ): Promise<void> {
    const r = request.recipient;
    const subject = tenancySubject(r);
    const reply = request.reply;
    const inserted = await tx
      .insert(schema.message)
      .values({
        id: request.messageId,
        companyId,
        propertyId: request.propertyId ?? reach?.propertyId ?? null,
        tenantId: subject?.tenantId ?? reach?.tenantId ?? null,
        recipientType: r.type,
        tenantContactId: subject?.contactId ?? null,
        staffPersonId: staffPersonOf(r),
        signerId: signerOf(r),
        ownerId: 'ownerId' in r ? r.ownerId : null,
        artisanId: 'artisanId' in r ? r.artisanId : null,
        purpose: request.purpose,
        subject: request.subject,
        body: storedBody(request.body),
        linkPurpose: request.link?.purpose ?? null,
        linkTargetId: request.link?.targetId ?? null,
        channels: reply ? [reply.channel] : request.channels,
        isTestContact: reach?.isTestContact ?? false,
        relatedType: request.related?.type ?? null,
        relatedId: request.related?.id ?? null,
        requestedBy: request.requestedBy,
        ...(reply
          ? {
              conversationId: reply.conversationId,
              channel: reply.channel,
              authorType: reply.authorType,
              authorPersonId: reply.authorPersonId,
              ...(reply.template ? { templateKey: reply.template, templateVersion: 1 } : {}),
            }
          : {}),
      })
      .onConflictDoNothing()
      .returning({ id: schema.message.id });
    if (inserted.length > 0)
      await this.event(tx, companyId, request.messageId, { status: 'queued' });
  }

  /**
   * Records the end of the road for a message. "Not sent: no consent" tells whoever queued it, by
   * email, so they can hand a link over in person (decision 2), and emits an event for the module
   * that asked.
   */
  private async finish(
    companyId: string,
    request: MessageRequest,
    status: 'not_sent' | 'failed',
    reason: string,
  ): Promise<Outcome> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const already = await tx
        .select({ id: schema.messageEvent.id })
        .from(schema.messageEvent)
        .where(
          and(
            eq(schema.messageEvent.messageId, request.messageId),
            eq(schema.messageEvent.status, status),
          ),
        );
      if (already.length > 0) return;
      await this.event(tx, companyId, request.messageId, { status, reason });
      if (request.purpose === 'staff_notice' || request.purpose === 'overdue_alert') return;
      await enqueueOutbox(tx, {
        companyId,
        type: MESSAGE_NOT_SENT_EVENT,
        payload: {
          messageId: request.messageId,
          purpose: request.purpose,
          reason,
          related: request.related,
        },
        idempotencyKey: `${MESSAGE_NOT_SENT_EVENT}:${request.messageId}`,
      });
      if (
        request.requestedBy &&
        !request.reply &&
        (reason === 'no_consent' || reason === 'no_address')
      )
        await queueMessage(tx, companyId, {
          recipient: { type: 'staff', personId: request.requestedBy },
          purpose: 'staff_notice',
          subject: 'A message was not sent',
          body:
            reason === 'no_consent'
              ? 'A message you started was not sent: the person has not agreed to messages by the channels it could use. Record their consent, or hand the link over in person.'
              : 'A message you started was not sent: there is no phone number or email for the person on the channels it could use.',
          channels: ['email'],
          propertyId: request.propertyId,
          related: request.related,
        });
    });
    return status;
  }

  private async event(
    tx: Tx,
    companyId: string,
    messageId: string,
    event: Partial<typeof schema.messageEvent.$inferInsert> & { status: string },
  ): Promise<void> {
    await tx.insert(schema.messageEvent).values({ ...event, companyId, messageId });
  }
}

/**
 * Whether a message's journey is over: not sent, or sent on a channel that has not failed since
 * (a WhatsApp message Meta later reports undeliverable is tried on the next channel).
 */
/** The outbox and job runner's own keys, around a queued message request. */
function stripEnvelope(payload: unknown): Record<string, unknown> {
  const body = { ...(payload as Record<string, unknown>) };
  for (const key of ['companyId', 'eventId', '__job']) delete body[key];
  return body;
}

/** Failure reasons after which a channel is not tried again for the message (review S6). */
const PERMANENT_FAILURES = new Set(['provider_refused', 'delivery_failed_report']);

function settled(events: readonly EventRow[]): boolean {
  if (events.some((e) => e.status === 'not_sent')) return true;
  const live = new Set<string>();
  for (const e of events) {
    if (e.status === 'sent' && e.channel) live.add(e.channel);
    // A refusal, or a delivery failure the provider reported later: that channel is done.
    if (e.status === 'failed' && e.channel && PERMANENT_FAILURES.has(e.reason ?? ''))
      live.delete(e.channel);
  }
  return live.size > 0;
}

function countFailures(events: readonly EventRow[]) {
  const count: Record<ConsentChannel, number> = { push: 0, whatsapp: 0, sms: 0, email: 0 };
  const permanent = new Set<ConsentChannel>();
  for (const e of events) {
    if (e.status !== 'failed' || !e.channel || !isConsentChannel(e.channel)) continue;
    count[e.channel] += 1;
    if (PERMANENT_FAILURES.has(e.reason ?? '')) permanent.add(e.channel);
  }
  return { count, permanent };
}

/** The tenant (and contact) a recipient is, if it is one of the tenancy's people. */
function tenancySubject(
  recipient: MessageRecipient,
): { tenantId: string; contactId: string | null } | null {
  switch (recipient.type) {
    case 'tenant':
      return { tenantId: recipient.tenantId, contactId: null };
    case 'tenant_contact':
      return { tenantId: recipient.tenantId, contactId: recipient.contactId };
    default:
      return null;
  }
}

function staffPersonOf(recipient: MessageRecipient): string | null {
  switch (recipient.type) {
    case 'staff':
      return recipient.personId;
    default:
      return null;
  }
}

function signerOf(recipient: MessageRecipient): string | null {
  switch (recipient.type) {
    case 'signer':
      return recipient.signerId;
    default:
      return null;
  }
}

/** The recipient a stored message was for, to send it again on another channel. */
function recipientOf(m: typeof schema.message.$inferSelect): MessageRecipient | null {
  switch (m.recipientType) {
    case 'tenant':
      return m.tenantId ? { type: 'tenant', tenantId: m.tenantId } : null;
    case 'tenant_contact':
      return m.tenantId && m.tenantContactId
        ? { type: 'tenant_contact', tenantId: m.tenantId, contactId: m.tenantContactId }
        : null;
    case 'staff':
      return m.staffPersonId ? { type: 'staff', personId: m.staffPersonId } : null;
    case 'signer':
      return m.signerId ? { type: 'signer', signerId: m.signerId } : null;
    case 'owner':
      return m.ownerId ? { type: 'owner', ownerId: m.ownerId } : null;
    case 'artisan':
      return m.artisanId ? { type: 'artisan', artisanId: m.artisanId } : null;
    default:
      return null;
  }
}
