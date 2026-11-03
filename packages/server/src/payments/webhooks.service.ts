import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withSystem, type Database, type PoolClient } from '@rent/db';
import type { AlertPort, WebhookHeaders } from '@rent/integrations';
import type { JobsService } from '../core/jobs/jobs.service';
import type { AppLogger } from '../core/logging/logger';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, DATABASE, PAYMENT_PROVIDERS } from '../core/tokens';
import { ProviderPaymentsService } from './provider-payments.service';

export const PROCESS_WEBHOOK_JOB = 'payments.process-webhook';

/** Event types that mean a charge was paid, and those that mean it was taken back. */
const PAID_EVENTS = new Set(['charge.success']);
const REVERSED_EVENTS = new Set(['charge.dispute.resolve', 'refund.processed']);

/** The headers kept with a stored webhook: the signature only, never anything else sent. */
const KEPT_HEADERS = ['x-paystack-signature'];

export type IntakeResult = 'stored' | 'duplicate' | 'rejected' | 'unknown_provider';

/**
 * Provider webhooks (CLAUDE.md section 8; M4b plan 4.4). The intake stores the raw request in the
 * global inbox, verifies its signature, and answers; a relay in the worker queues processing.
 * Processing never reads money from the body: it verifies the reference with the provider and
 * posts what the provider says, through ProviderPaymentsService. A bad signature is stored as
 * rejected, posts nothing and raises a security alert. A replayed event is a no-op.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
  ) {}

  async intake(provider: string, rawBody: Buffer, headers: WebhookHeaders): Promise<IntakeResult> {
    if (!this.providers.has(provider)) return 'unknown_provider';
    const port = this.providers.get(provider);
    const valid = port.verifyWebhookSignature(rawBody, headers);
    const event = valid ? port.parseWebhook(rawBody) : null;
    const raw = rawBody.toString('utf8');
    const eventId =
      event?.eventId ?? `unparsed:${createHash('sha256').update(rawBody).digest('hex')}`;
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers))
      if (KEPT_HEADERS.includes(name.toLowerCase()) && typeof value === 'string')
        kept[name.toLowerCase()] = value.slice(0, 512);
    const inserted = await withSystem(this.database, {}, (tx) =>
      tx
        .insert(schema.webhookInbox)
        .values({
          provider,
          eventId: eventId.slice(0, 200),
          eventType: event?.type.slice(0, 100) ?? null,
          reference: event?.reference.slice(0, 120) ?? null,
          rawBody: raw,
          headers: kept,
          signatureValid: valid,
          status: valid ? (event ? 'received' : 'ignored') : 'rejected',
          outcome: valid ? (event ? null : 'unparsed') : 'bad_signature',
        })
        .onConflictDoNothing({
          target: [schema.webhookInbox.provider, schema.webhookInbox.eventId],
          where: sql`${schema.webhookInbox.signatureValid}`,
        })
        .returning({ id: schema.webhookInbox.id }),
    );
    if (!valid) {
      await this.alerts.raise({
        severity: 'critical',
        code: 'payments.webhook_bad_signature',
        message: 'A payments webhook arrived with a bad signature; it was stored as rejected',
        context: { provider, inboxId: inserted[0]?.id ?? null },
      });
      return 'rejected';
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
    else if (row.eventType && REVERSED_EVENTS.has(row.eventType))
      outcome = await this.payments.recordChargeback(row.provider, row.reference);
    else {
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
