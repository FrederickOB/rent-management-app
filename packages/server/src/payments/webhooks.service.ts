import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withSystem, type Database, type PoolClient } from '@rent/db';
import type { AlertPort, WebhookHeaders } from '@rent/integrations';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import type { JobsService } from '../core/jobs/jobs.service';
import type { AppLogger } from '../core/logging/logger';
import type { PaymentProviders } from '../core/payment-providers';
import { consumeRateLimit, type RateLimit } from '../core/rate-limit';
import { ALERT_PORT, CLOCK, CONFIG, DATABASE, PAYMENT_PROVIDERS } from '../core/tokens';
import { SigningHasher } from '../esign/secrets';
import { ProviderPaymentsService } from './provider-payments.service';
import { QueueService } from './queue.service';

export const PROCESS_WEBHOOK_JOB = 'payments.process-webhook';

/** Event types that mean a charge was paid, and those about money taken back from one. */
const PAID_EVENTS = new Set(['charge.success']);
const REVERSED_EVENTS = new Set([
  'charge.dispute.resolve',
  'refund.processed',
  'refund.failed',
  'refund.pending',
  'refund.processing',
]);

/** The headers kept with a stored webhook: the signature, and what identifies the sender's software. */
const KEPT_HEADERS = ['x-paystack-signature', 'user-agent', 'content-type'];

/** The largest body a provider sends (Paystack's events are a few kilobytes): 64 KB. */
export const WEBHOOK_MAX_BYTES = 64 * 1024;

/**
 * Bad-signature requests (M4b review 6): each address may send a few before it is refused
 * without being stored, and the security alert goes at most once per provider in a window.
 */
export const WEBHOOK_LIMITS = {
  rejectedPerAddress: { count: 20, windowMinutes: 10 },
  alertsPerProvider: { count: 1, windowMinutes: 15 },
} as const satisfies Record<string, RateLimit>;

export type IntakeResult =
  'stored' | 'duplicate' | 'rejected' | 'too_large' | 'rate_limited' | 'unknown_provider';

/**
 * Provider webhooks (CLAUDE.md section 8; M4b plan 4.4). The intake stores the raw request in the
 * global inbox, verifies its signature, and answers; a relay in the worker queues processing.
 * Processing never reads money from the body: it verifies the reference with the provider and
 * posts what the provider says, through ProviderPaymentsService. A bad signature is stored as
 * rejected, posts nothing and raises a security alert. A replayed event is a no-op.
 */
@Injectable()
export class WebhooksService {
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  /**
   * Stores a webhook (M4b review 6): a signed one whole; a bad-signature or oversized one only as
   * its size, its hash, a few headers and the sender's address as a keyed hash, never its body.
   * An address sending many bad ones is refused without anything stored, and the security alert
   * is raised at most once per provider in a window.
   */
  async intake(
    provider: string,
    rawBody: Buffer,
    headers: WebhookHeaders,
    clientIp = 'unknown',
  ): Promise<IntakeResult> {
    if (!this.providers.has(provider)) return 'unknown_provider';
    const port = this.providers.get(provider);
    const tooLarge = rawBody.length > WEBHOOK_MAX_BYTES;
    const valid = !tooLarge && port.verifyWebhookSignature(rawBody, headers);
    const now = this.clock.now().getTime();
    const address = this.hasher.address(clientIp);
    if (
      !valid &&
      !(await consumeRateLimit(
        this.database,
        `webhook:rejected:${address}`,
        WEBHOOK_LIMITS.rejectedPerAddress,
        now,
      ))
    )
      return 'rate_limited';
    const event = valid ? port.parseWebhook(rawBody) : null;
    const hash = createHash('sha256').update(rawBody).digest('hex');
    const eventId = event?.eventId ?? `unparsed:${hash}`;
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers))
      if (KEPT_HEADERS.includes(name.toLowerCase()) && typeof value === 'string')
        kept[name.toLowerCase()] = value.slice(0, 512);
    if (!valid) kept['x-sender-address-hash'] = address;
    const inserted = await withSystem(this.database, {}, (tx) =>
      tx
        .insert(schema.webhookInbox)
        .values({
          provider,
          eventId: eventId.slice(0, 200),
          eventType: event?.type.slice(0, 100) ?? null,
          reference: event?.reference.slice(0, 120) ?? null,
          rawBody: valid ? rawBody.toString('utf8') : null,
          bodySha256: hash,
          bodyBytes: rawBody.length,
          headers: kept,
          signatureValid: valid,
          status: valid ? (event ? 'received' : 'ignored') : 'rejected',
          outcome: valid ? (event ? null : 'unparsed') : tooLarge ? 'too_large' : 'bad_signature',
        })
        .onConflictDoNothing({
          target: [schema.webhookInbox.provider, schema.webhookInbox.eventId],
          where: sql`${schema.webhookInbox.signatureValid}`,
        })
        .returning({ id: schema.webhookInbox.id }),
    );
    if (!valid) {
      if (
        await consumeRateLimit(
          this.database,
          `webhook:alert:${provider}`,
          WEBHOOK_LIMITS.alertsPerProvider,
          now,
        )
      )
        await this.alerts.raise({
          severity: 'critical',
          code: 'payments.webhook_bad_signature',
          message:
            'Payments webhooks are arriving with a bad signature or too large; they are stored as rejected (body not kept). Further ones in the next 15 minutes are not alerted again.',
          context: { provider, inboxId: inserted[0]?.id ?? null },
        });
      return tooLarge ? 'too_large' : 'rejected';
    }
    return inserted.length > 0 ? 'stored' : 'duplicate';
  }

  /**
   * `payments.process-webhook` (plan 4.12): one stored event, once. The company is resolved from
   * the reference (its intent) or the verified subaccount, never from the body.
   */
  async process(inboxId: string): Promise<string> {
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx.select().from(schema.webhookInbox).where(eq(schema.webhookInbox.id, inboxId)),
    );
    if (!row || row.status !== 'received' || !row.signatureValid || !row.reference)
      return 'skipped';
    let outcome: string;
    let status: 'processed' | 'ignored' = 'processed';
    if (row.eventType && PAID_EVENTS.has(row.eventType))
      outcome = await this.payments.processReference(row.provider, row.reference);
    else if (row.eventType && REVERSED_EVENTS.has(row.eventType)) {
      // Our own refund of unmatched money is followed to its end (P31 posts only once the
      // provider says it is processed); anything else may be a chargeback (review item 2).
      const own = await this.payments.ownRefund(row.provider, row.reference);
      outcome = own
        ? `refund_${await this.queue.refundWithProvider(own.companyId, own.refundId)}`
        : await this.payments.recordChargeback(row.provider, row.reference);
    } else {
      outcome = 'not_handled';
      status = 'ignored';
    }
    await withSystem(this.database, {}, (tx) =>
      tx
        .update(schema.webhookInbox)
        .set({ status, outcome: outcome.slice(0, 60), processedAt: new Date() })
        .where(eq(schema.webhookInbox.id, inboxId)),
    );
    return outcome;
  }

  /** Records that processing gave up (the job's dead letter), so the row does not look busy. */
  async failed(inboxId: string): Promise<void> {
    await withSystem(this.database, {}, (tx) =>
      tx
        .update(schema.webhookInbox)
        .set({ status: 'failed', outcome: 'dead_lettered', processedAt: new Date() })
        .where(eq(schema.webhookInbox.id, inboxId)),
    );
  }
}

/**
 * Publishes stored webhooks to the processing queue, as the outbox relay publishes events
 * (ADR-005): the claim and the enqueue share one transaction, so each is queued once. Wakes on
 * NOTIFY and polls every second, so a payment is processed within moments of its webhook.
 */
export class WebhookInboxRelay {
  private listener: PoolClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly database: Database,
    private readonly jobs: JobsService,
    private readonly logger: AppLogger,
    private readonly batchSize = 50,
  ) {}

  async start(): Promise<void> {
    this.listener = await this.database.pool.connect();
    this.listener.on('notification', () => this.kick());
    await this.listener.query('listen webhook_inbox');
    this.timer = setInterval(() => this.kick(), 1_000);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.listener) {
      await this.listener.query('unlisten webhook_inbox').catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.drain()
      .catch((error: unknown) => this.logger.error({ err: error }, 'webhook inbox relay failed'))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await withSystem(this.database, {}, async (tx) => {
        const claimed = await tx.execute<{ id: string }>(
          sql`select id from app.claim_webhook_inbox(${this.batchSize})`,
        );
        for (const row of claimed.rows)
          await this.jobs.send(
            PROCESS_WEBHOOK_JOB,
            { inboxId: row.id },
            { singletonKey: row.id, tx },
          );
        return claimed.rows.length;
      });
      total += published;
      if (published < this.batchSize) return total;
    }
  }
}
