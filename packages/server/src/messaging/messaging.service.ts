import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, schema, withCompany, type Database, type Tx } from '@rent/db';
import { chooseChannel, MESSAGE_CHANNELS, type MessageChannel } from '@rent/domain/messaging';
import { maskPhone } from '@rent/domain/phone';
import { ProviderError, type EmailPort, type SmsPort } from '@rent/integrations';
import type { AppConfig } from '../core/config';
import { AppError } from '../core/errors';
import {
  LINK_PLACEHOLDER,
  queueMessage,
  storedBody,
  type MessageRecipient,
  type MessageRequest,
} from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CONFIG, DATABASE, EMAIL_PORT, SMS_PORT } from '../core/tokens';
import { personContact } from '../identity/person-directory';
import { IdChecksService } from '../tenancy/id-checks.service';
import { TenantsService } from '../tenancy/tenants.service';

/** Sends per channel before the next consented channel is tried (plan 4.17). */
export const SENDS_PER_CHANNEL = 5;
export const MESSAGE_NOT_SENT_EVENT = 'messaging.not_sent';

/** Who a message can reach, and how (CM-09). */
export interface Reach {
  readonly name: string;
  readonly addresses: Partial<Record<MessageChannel, string>>;
  /** Channels with consent now. Staff, the company's own people, need none. */
  readonly consented: ReadonlySet<MessageChannel>;
  readonly isTestContact: boolean;
  readonly tenantId: string | null;
  readonly propertyId: string | null;
}

/** Finds a recipient's addresses and consent inside the send job's company transaction. */
export interface RecipientResolver {
  reach(tx: Tx, companyId: string, recipient: MessageRecipient): Promise<Reach | null>;
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

const maskEmail = (email: string) => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
const mask = (channel: MessageChannel, address: string) =>
  channel === 'sms' ? maskPhone(address) : maskEmail(address);

/**
 * The outbound messaging core (M3 decision 1; CLAUDE.md section 8). The `messaging.send` job
 * records each queued message once, picks the first channel with an address and consent, adds
 * the link, sends through the SMS or email port, and records what happened as events. A failing
 * channel is tried up to five times, then the next consented channel; with none left the message
 * is "not sent" and whoever queued it is told.
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
  ) {
    const tenancy: RecipientResolver = {
      async reach(tx, _companyId, recipient) {
        const subject = tenancySubject(recipient);
        if (!subject) return null;
        const point = await tenants.reach(tx, subject);
        if (!point) return null;
        return {
          name: point.name,
          addresses: {
            ...(point.phone ? { sms: point.phone } : {}),
            ...(point.email ? { email: point.email } : {}),
          },
          consented: point.consented,
          isTestContact: point.isTestContact,
          tenantId: subject.tenantId,
          propertyId: point.propertyId,
        };
      },
    };
    this.recipients.set('tenant', tenancy);
    this.recipients.set('tenant_contact', tenancy);
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
    const { reach, events } = await withCompany(this.database, ctx, async (tx) => {
      const resolver = this.recipients.get(request.recipient.type);
      const found = resolver ? await resolver.reach(tx, companyId, request.recipient) : null;
      await this.record(tx, companyId, request, found);
      const rows = await tx
        .select()
        .from(schema.messageEvent)
        .where(eq(schema.messageEvent.messageId, request.messageId))
        .orderBy(asc(schema.messageEvent.occurredAt), asc(schema.messageEvent.id));
      return { reach: found, events: rows };
    });
    if (events.some((e) => e.status === 'sent' || e.status === 'not_sent')) return 'sent';
    if (events.some((e) => e.status === 'failed' && e.reason === 'delivery_failed'))
      return 'failed';
    if (!reach) return this.finish(companyId, request, 'not_sent', 'no_recipient');
    // Real adapters never send to test contacts (as in M1); fakes capture everything locally.
    if (reach.isTestContact && this.config.NODE_ENV === 'production')
      return this.finish(companyId, request, 'not_sent', 'test_contact');

    const failures = countFailures(events);
    const skip = new Set<MessageChannel>(
      MESSAGE_CHANNELS.filter(
        (c) =>
          !request.channels.includes(c) ||
          failures.count[c] >= SENDS_PER_CHANNEL ||
          failures.permanent.has(c),
      ),
    );
    const channel = chooseChannel(
      request.purpose,
      {
        addresses: new Set(MESSAGE_CHANNELS.filter((c) => reach.addresses[c])),
        consented: reach.consented,
      },
      skip,
    );
    if (!channel) {
      const reachable = request.channels.some((c) => reach.addresses[c]);
      const tried = Object.values(failures.count).some((n) => n > 0);
      if (tried) return this.finish(companyId, request, 'failed', 'delivery_failed');
      return this.finish(companyId, request, 'not_sent', reachable ? 'no_consent' : 'no_address');
    }

    const address = reach.addresses[channel]!;
    let body = request.body;
    const link = request.link ? (this.links.get(request.link.purpose) ?? null) : null;
    if (request.link) {
      const resolver = link;
      if (!resolver) return this.finish(companyId, request, 'not_sent', 'link_unavailable');
      let url: string;
      try {
        url = await resolver.url(companyId, request.link.targetId, request.messageId);
      } catch (error) {
        // What the link was for is gone (a check cancelled, a request closed): nothing to send.
        // Anything else is retried.
        if (error instanceof AppError && error.status < 500)
          return this.finish(companyId, request, 'not_sent', 'link_unavailable');
        throw error;
      }
      body = body.split(LINK_PLACEHOLDER).join(url);
    }
    try {
      const result =
        channel === 'sms'
          ? await this.sms.send({ to: address, body, reference: request.messageId })
          : await this.email.send({
              to: address,
              subject: request.subject ?? this.config.APP_NAME,
              text: body,
            });
      await withCompany(this.database, ctx, async (tx) => {
        await this.event(tx, companyId, request.messageId, {
          status: 'sent',
          channel,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          destinationMasked: mask(channel, address),
        });
        if (request.link && link?.sent)
          await link.sent(tx, companyId, request.link.targetId, request.messageId);
      });
      return 'sent';
    } catch (error) {
      const retryable = !(error instanceof ProviderError) || error.retryable;
      await withCompany(this.database, ctx, async (tx) => {
        await this.event(tx, companyId, request.messageId, {
          status: 'failed',
          channel,
          reason: retryable ? 'provider_error' : 'provider_refused',
          destinationMasked: mask(channel, address),
        });
        // This attempt's link reached nobody; a retry, or the next channel, makes a fresh one.
        if (request.link && link?.notSent)
          await link.notSent(tx, companyId, request.link.targetId, request.messageId);
      });
      // A retryable failure is tried again after a pause; the next channel only once this one
      // has failed five times or refused outright.
      if (retryable && failures.count[channel] + 1 < SENDS_PER_CHANNEL) throw error;
      return this.deliver(companyId, request);
    }
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
        purpose: request.purpose,
        subject: request.subject,
        body: storedBody(request.body),
        linkPurpose: request.link?.purpose ?? null,
        linkTargetId: request.link?.targetId ?? null,
        channels: request.channels,
        isTestContact: reach?.isTestContact ?? false,
        relatedType: request.related?.type ?? null,
        relatedId: request.related?.id ?? null,
        requestedBy: request.requestedBy,
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
      if (request.purpose === 'staff_notice') return;
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
      if (request.requestedBy && (reason === 'no_consent' || reason === 'no_address'))
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

function countFailures(events: readonly EventRow[]) {
  const count: Record<MessageChannel, number> = { sms: 0, email: 0 };
  const permanent = new Set<MessageChannel>();
  for (const e of events) {
    if (e.status !== 'failed' || !e.channel) continue;
    const channel = e.channel as MessageChannel;
    count[channel] += 1;
    if (e.reason === 'provider_refused') permanent.add(channel);
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
