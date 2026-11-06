import { schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import type { AlertPort } from '@rent/integrations';
import { fromDrizzle, PgBoss, type Job } from 'pg-boss';
import { z } from 'zod';
import type { AppLogger } from '../logging/logger';
import { DEAD_LETTER_QUEUE, SCHEDULE_TIME_ZONE, type JobContext, type JobDefinition } from './job';

const companyPayload = z.object({ companyId: z.string().uuid() }).passthrough();

export const PGBOSS_SCHEMA = 'pgboss';

/**
 * pg-boss on our PostgreSQL (ADR-005), connected as the application role. Queues, retries,
 * dead letters and schedules are declared by the job definitions registered here.
 */
export class JobsService {
  readonly boss: PgBoss;
  private readonly definitions = new Map<string, JobDefinition<unknown>>();
  private readonly pollingIntervalSeconds: number;

  constructor(
    private readonly database: Database,
    private readonly logger: AppLogger,
    private readonly alerts: AlertPort,
    connectionString: string,
    options: { pollingIntervalSeconds?: number } = {},
  ) {
    this.boss = new PgBoss({
      connectionString,
      schema: PGBOSS_SCHEMA,
      migrate: false,
      application_name: 'rent-jobs',
      max: 5,
    });
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 1;
    this.boss.on('error', (error) => this.logger.error({ err: error }, 'pg-boss error'));
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.ensureQueue(DEAD_LETTER_QUEUE, { retryLimit: 0 });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  private async ensureQueue(
    name: string,
    options: Parameters<PgBoss['createQueue']>[1],
  ): Promise<void> {
    if (!(await this.boss.getQueue(name))) await this.boss.createQueue(name, options);
  }

  /** Creates the queue (idempotent) and, unless `workers` is false, starts consuming it. */
  async register<T>(
    definition: JobDefinition<T>,
    options: { workers?: boolean } = {},
  ): Promise<void> {
    this.definitions.set(definition.name, definition as JobDefinition<unknown>);
    await this.ensureQueue(definition.name, {
      retryLimit: definition.retry.limit,
      retryDelay: definition.retry.delaySeconds,
      retryBackoff: definition.retry.backoff,
      ...(definition.retry.maxDelaySeconds
        ? { retryDelayMax: definition.retry.maxDelaySeconds }
        : {}),
      deadLetter: DEAD_LETTER_QUEUE,
    });
    if (options.workers === false) return;
    // A draining queue (JobDefinition.drain) wakes its own worker as each job ends
    // (`notifyWorker`), so the next fetch runs at once; only a fetch that finds nothing waits out
    // the polling interval. Each fetch still takes one job, the next in queue order. pg-boss 12's
    // burst option, `burstWhenReadyExceeds`, reads queue stats the monitor refreshes and the
    // instance caches every 60 seconds, so a backlog queued at start-up could wait two minutes.
    let workerId: string | null = null;
    workerId = await this.boss.work<Record<string, unknown>>(
      definition.name,
      { batchSize: 1, pollingIntervalSeconds: this.pollingIntervalSeconds },
      async ([job]) => {
        if (!job) return;
        try {
          await this.run(definition, job);
        } finally {
          if (definition.drain && workerId) this.boss.notifyWorker(workerId);
        }
      },
    );
    if (definition.cron) {
      await this.boss.schedule(definition.name, definition.cron, {}, { tz: SCHEDULE_TIME_ZONE });
    }
  }

  /** Raises an alert for every job that exhausted its retries (CLAUDE.md section 8). */
  async watchDeadLetters(): Promise<void> {
    await this.boss.work<Record<string, unknown>>(
      DEAD_LETTER_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: this.pollingIntervalSeconds },
      async ([job]) => {
        if (!job) return;
        const source = typeof job.data.__job === 'string' ? job.data.__job : 'unknown';
        await this.alerts.raise({
          severity: 'critical',
          code: 'job.dead_lettered',
          message: `Job ${source} failed after all retries`,
          context: {
            job: source,
            deadLetterJobId: job.id,
            companyId: typeof job.data.companyId === 'string' ? job.data.companyId : null,
          },
        });
        await this.afterDeadLetter(source, job);
      },
    );
  }

  /** Lets the job type record its final failure (JobDefinition.onDeadLetter). */
  private async afterDeadLetter(source: string, job: Job<Record<string, unknown>>): Promise<void> {
    const definition = this.definitions.get(source);
    if (!definition?.onDeadLetter) return;
    const logger = this.logger.child({ job: source, deadLetterJobId: job.id });
    const payload = definition.schema.safeParse(job.data);
    if (!payload.success) {
      logger.error('dead-lettered job payload does not parse; its failure was not recorded');
      return;
    }
    try {
      await definition.onDeadLetter(payload.data, { logger });
    } catch (error) {
      // The alert has gone out already; a person follows up from there.
      logger.error({ err: error }, 'recording the failure of a dead-lettered job failed');
    }
  }

  /** Enqueues a job, inside `tx` when given, so it commits or rolls back with the caller's work. */
  async send(
    name: string,
    payload: Record<string, unknown>,
    options: { singletonKey?: string; tx?: Tx; startAfter?: Date } = {},
  ): Promise<void> {
    await this.boss.send(
      name,
      { ...payload, __job: name },
      {
        ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
        ...(options.startAfter ? { startAfter: options.startAfter } : {}),
        ...(options.tx ? { db: fromDrizzle(options.tx, sql) } : {}),
      },
    );
  }

  private async run<T>(
    definition: JobDefinition<T>,
    job: Job<Record<string, unknown>>,
  ): Promise<void> {
    const logger = this.logger.child({ job: definition.name, jobId: job.id });
    let companyId: string | null = null;
    if (definition.scope === 'company') {
      const parsed = companyPayload.safeParse(job.data);
      if (!parsed.success) throw new Error(`${definition.name} needs a companyId in its payload`);
      companyId = parsed.data.companyId;
    }
    const payload = definition.schema.parse(job.data);
    const scoped = <R>(fn: (tx: Tx) => Promise<R>): Promise<R> => {
      if (!companyId)
        throw new Error(`${definition.name} is a system job and has no company context`);
      return withCompany(
        this.database,
        { companyId, actorKind: 'system', requestId: `job:${job.id}` },
        fn,
      );
    };
    const ctx: JobContext = {
      jobId: job.id,
      logger,
      companyId,
      withCompany: scoped,
      once: async (key, fn) =>
        scoped(async (tx) => {
          const inserted = await tx
            .insert(schema.processedJob)
            .values({ companyId: companyId!, key, jobName: definition.name })
            .onConflictDoNothing()
            .returning({ key: schema.processedJob.key });
          if (inserted.length === 0) return false;
          await fn(tx);
          return true;
        }),
      enqueue: (name, data, options) => this.send(name, data, options),
    };
    const started = Date.now();
    try {
      await definition.handle(payload, ctx);
      logger.info({ ms: Date.now() - started }, 'job done');
    } catch (error) {
      logger.error({ err: error, ms: Date.now() - started }, 'job failed');
      throw error;
    }
  }
}
