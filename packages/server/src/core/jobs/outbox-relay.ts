import { sql, withSystem, type Database, type PoolClient } from '@rent/db';
import type { AppLogger } from '../logging/logger';
import type { JobsService } from './jobs.service';

interface ClaimedEvent extends Record<string, unknown> {
  id: string;
  company_id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Publishes outbox events to pg-boss (ADR-005). The claim (which marks events published) and
 * the enqueue share one transaction, so each event is published exactly once even with several
 * relays running; consumers are at-least-once and idempotent. Wakes on NOTIFY, polls every second.
 */
export class OutboxRelay {
  private listener: PoolClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly database: Database,
    private readonly jobs: JobsService,
    private readonly logger: AppLogger,
    /** Event types with a consumer. Others are logged and left as the event log. */
    private readonly routes: ReadonlySet<string>,
    private readonly batchSize = 50,
  ) {}

  async start(): Promise<void> {
    this.listener = await this.database.pool.connect();
    this.listener.on('notification', () => this.kick());
    await this.listener.query('listen outbox');
    this.timer = setInterval(() => this.kick(), 1_000);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.listener) {
      await this.listener.query('unlisten outbox').catch(() => undefined);
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
      .catch((error: unknown) => this.logger.error({ err: error }, 'outbox relay failed'))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Publishes until the outbox is empty. Returns the number of events published. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.publishBatch();
      total += published;
      if (published < this.batchSize) return total;
    }
  }

  private async publishBatch(): Promise<number> {
    return withSystem(this.database, {}, async (tx) => {
      const claimed = await tx.execute<ClaimedEvent>(
        sql`select * from app.claim_outbox_events(${this.batchSize})`,
      );
      for (const event of claimed.rows) {
        if (!this.routes.has(event.type)) {
          this.logger.debug(
            { eventType: event.type, eventId: event.id },
            'outbox event has no consumer',
          );
          continue;
        }
        await this.jobs.send(
          event.type,
          { ...event.payload, companyId: event.company_id, eventId: event.id },
          { singletonKey: event.id, tx },
        );
      }
      return claimed.rows.length;
    });
  }
}
