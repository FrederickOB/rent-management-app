import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, withSystem, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { platformAdminFor } from '../admin/platform-admin';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { conflict, notFound } from '../core/errors';
import { DEAD_LETTER_QUEUE } from '../core/jobs/job';
import { jobErrorSummary } from '../core/jobs/job-error';
import { MESSAGING_INBOUND_JOB } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { PROCESS_WEBHOOK_JOB } from '../payments/webhooks.service';
import { PolicyService } from '../policy/policy.service';
import { platformCompanyId, withPlatform } from '../subscription/platform';
import { OPS_CLI_MAX, OPS_LIST_LIMIT, OPS_RETRY_JOB } from './constants';
import { consoleOperator, isUuid, operatorData, opsReason, type OpsOperator } from './operator';

/** A dead-lettered job as the console shows it (the contract's `opsJobSchema`): no payload. */
export interface OpsJobView {
  /** The job's id in the dead-letter queue. */
  readonly id: string;
  /** The queue it failed on. */
  readonly name: string;
  readonly companyId: string | null;
  /** When it was dead-lettered. */
  readonly failedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  /** When a platform admin retried it (each dead letter is retried once, review B12). */
  readonly retriedAt: Date | null;
  /** M11 review C7: where the retry stands, from its ops_action rows; null before any. */
  readonly retryOutcome: RetryOutcome | null;
}

/** A retry's progress (M11 review C7): asked for, then what the worker's `ops.retry-job` did. */
export type RetryOutcome = 'queued' | 'sent' | 'gone' | 'done_already';
const RETRY_OUTCOMES: readonly string[] = ['queued', 'sent', 'gone', 'done_already'];

/** Which dead-lettered jobs an incident command retries (`pnpm ops:redrive`). */
export interface DeadLetterSelection {
  readonly ids?: readonly string[];
  readonly queue?: string;
  /** Dead-lettered at or after. */
  readonly from?: Date;
  /** Dead-lettered before. */
  readonly to?: Date;
  /** Leave out jobs a platform admin has retried already. */
  readonly skipRetried?: boolean;
  readonly limit?: number;
}

interface DeadRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  company_id: string | null;
  created_on: Date | string;
  source_retry_count: number | null;
  source_output: unknown;
}

/** These queues' jobs process a stored webhook: replay the webhook, which its row records. */
const WEBHOOK_QUEUES = new Set([PROCESS_WEBHOOK_JOB, MESSAGING_INBOUND_JOB]);

const hasJobSchema = async (tx: Tx): Promise<boolean> =>
  (
    await tx.execute<{ ok: boolean }>(
      sql`select to_regclass('pgboss.job') is not null and to_regclass('pgboss.queue') is not null as ok`,
    )
  ).rows[0]?.ok === true;

/**
 * Dead-lettered jobs and their retry (M11 decision 9; plan 4.7). pg-boss copies a job that failed
 * its last retry into `jobs.dead-letter` (the worker alerts on each, then marks it done there);
 * these are listed from that copy, which keeps the original queue, payload, retry count and last
 * error. A retry takes a reason and is recorded as an ops_action in the platform company with an
 * audit event (`ops.job_retried`), and queues `ops.retry-job` through the outbox in the same
 * transaction; the worker then sends the payload to its queue again, once per retry (`requeue`).
 * Every job is idempotent, so a retry of work already done changes nothing. Each dead letter is
 * retried once (409 `already_retried` after that, review B12): a job that fails again comes back
 * as a new dead letter, retried in its turn.
 */
@Injectable()
export class DeadLetterService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The console: dead-lettered jobs, newest first (`health.read`). */
  async list(actor: Actor | null, filter: { readonly name?: string } = {}): Promise<OpsJobView[]> {
    platformAdminFor(this.policy, actor, 'health.read');
    return this.deadLettered({ ...(filter.name ? { queue: filter.name } : {}) });
  }

  /** Dead-lettered jobs, newest first, with each one's last retry (the system path). */
  async deadLettered(selection: DeadLetterSelection = {}): Promise<OpsJobView[]> {
    const rows = await this.rows(selection, 'newest', OPS_LIST_LIMIT);
    const retried = await this.retries(rows.map((r) => r.id));
    return rows.map((r) => viewOf(r, retried.get(r.id) ?? null));
  }

  /** The console's retry (`platform.ops.redrive`), with a reason of 5 to 500 characters. */
  async retry(
    actor: Actor | null,
    jobId: string,
    reason: string,
    requestId?: string | null,
  ): Promise<OpsJobView> {
    return this.retryAs(
      consoleOperator(this.policy, actor, 'platform.ops.redrive', requestId),
      jobId,
      reason,
    );
  }

  /**
   * Retries one dead-lettered job for `operator`: the ops_action, its audit event and the queued
   * `ops.retry-job` commit together in the platform company. A job that processes a stored webhook
   * is refused: its webhook is replayed instead, so the row records it.
   */
  async retryAs(operator: OpsOperator, jobId: string, reason: string): Promise<OpsJobView> {
    const why = opsReason(reason);
    if (!isUuid(jobId)) throw notFound('Dead-lettered job');
    await platformCompanyId(this.database);
    const [row] = await this.rows({ ids: [jobId] }, 'newest', 1);
    if (!row) throw notFound('Dead-lettered job');
    const queue = row.name;
    if (!queue || queue === DEAD_LETTER_QUEUE)
      throw conflict('job_not_retryable', 'This job does not say which queue it came from');
    if (WEBHOOK_QUEUES.has(queue))
      throw conflict(
        'use_webhook_replay',
        'This job processes a stored webhook: replay the webhook instead, so its row records the replay',
      );
    const exists = await withSystem(
      this.database,
      {},
      async (tx) =>
        (await tx.execute(sql`select 1 from pgboss.queue where name = ${queue}`)).rows.length > 0,
    );
    if (!exists) throw conflict('queue_missing', 'The queue this job came from no longer exists');
    const now = this.clock.now();
    await withPlatform(
      this.database,
      {
        personId: operator.personId,
        requestId: operator.requestId ?? null,
        actorKind: operator.via === 'console' ? 'platform_admin' : 'system',
      },
      async (tx, platformId) => {
        // M11 review B12: a dead letter is retried once. Two retries at once take turns on this
        // lock, and the second finds the first's row.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ops:job_retry:${row.id}`}, 0))`,
        );
        const [earlier] = await tx
          .select({ id: schema.opsAction.id })
          .from(schema.opsAction)
          .where(and(eq(schema.opsAction.kind, 'job_retry'), eq(schema.opsAction.targetId, row.id)))
          .limit(1);
        if (earlier)
          throw conflict(
            'already_retried',
            'This dead-lettered job has been retried already; if it failed again, retry its new dead letter',
          );
        const [action] = await tx
          .insert(schema.opsAction)
          .values({
            companyId: platformId,
            kind: 'job_retry',
            targetId: row.id,
            targetName: queue,
            reason: why,
            personId: operator.personId,
            outcome: 'queued',
          })
          .returning({ id: schema.opsAction.id });
        await this.audit.append(tx, {
          companyId: platformId,
          action: 'ops.job_retried',
          recordType: 'pgboss_job',
          recordId: row.id,
          data: {
            opsActionId: action!.id,
            queue,
            jobCompanyId: row.company_id,
            via: operator.via,
            reason: why,
            ...operatorData(operator),
          },
        });
        await enqueueOutbox(tx, {
          companyId: platformId,
          type: OPS_RETRY_JOB,
          payload: { deadLetterJobId: row.id, opsActionId: action!.id },
          idempotencyKey: `ops:job_retry:${action!.id}`,
        });
      },
    );
    return viewOf(row, { at: now, outcome: 'queued' });
  }

  /**
   * `ops.retry-job` (the worker): once per retry (processed_job, keyed on the ops action), sends the
   * dead letter's payload to its queue again through `send`, in the same transaction as a second
   * ops_action row with the outcome (`sent` or `gone`; the table is append-only). A delivery of
   * the job after that finds the key taken and records `done_already`. Answers the outcome.
   */
  async runRetry(
    once: (key: string, fn: (tx: Tx) => Promise<void>) => Promise<boolean>,
    input: { readonly deadLetterJobId: string; readonly opsActionId: string },
    send: (queue: string, payload: Record<string, unknown>, tx: Tx) => Promise<void>,
  ): Promise<'sent' | 'gone' | 'done_already'> {
    let outcome: 'sent' | 'gone' | 'done_already' = 'done_already';
    const ran = await once(`ops:job_retry:${input.opsActionId}`, async (tx) => {
      outcome = await this.requeue(tx, input.deadLetterJobId, (queue, payload) =>
        send(queue, payload, tx),
      );
      await this.recordRetryOutcome(tx, input.opsActionId, outcome);
    });
    if (!ran)
      await withPlatform(this.database, {}, (tx) =>
        this.recordRetryOutcome(tx, input.opsActionId, 'done_already'),
      );
    return outcome;
  }

  /** The retry's outcome, as a row beside the one that asked for it (same target and person). */
  private async recordRetryOutcome(tx: Tx, opsActionId: string, outcome: RetryOutcome) {
    const a = schema.opsAction;
    const [asked] = await tx.select().from(a).where(eq(a.id, opsActionId));
    if (!asked) return;
    await tx.insert(a).values({
      companyId: asked.companyId,
      kind: 'job_retry',
      targetId: asked.targetId,
      targetName: asked.targetName,
      reason: asked.reason,
      personId: asked.personId,
      outcome,
    });
  }

  /**
   * `ops.retry-job` (the worker), inside its once-per-retry transaction: sends the dead-lettered
   * job's payload to its queue again, through `send` (pg-boss in the same transaction). `gone`
   * when pg-boss has deleted the copy since (its retention), so there is nothing to send.
   */
  async requeue(
    tx: Tx,
    deadLetterJobId: string,
    send: (queue: string, payload: Record<string, unknown>) => Promise<void>,
  ): Promise<'sent' | 'gone'> {
    const found = await tx.execute<{ name: string | null; data: Record<string, unknown> | null }>(
      sql`select coalesce(source_name, data ->> '__job') as name, data from pgboss.job
          where name = ${DEAD_LETTER_QUEUE} and id = ${deadLetterJobId}::uuid`,
    );
    const row = found.rows[0];
    if (!row?.name || row.name === DEAD_LETTER_QUEUE) return 'gone';
    const { __job: _job, ...payload } = row.data ?? {};
    await send(row.name, payload);
    return 'sent';
  }

  /** The dead-lettered jobs an incident command retries: oldest first, ids only. */
  async select(selection: DeadLetterSelection): Promise<{ id: string; name: string | null }[]> {
    const limit = Math.min(Math.max(1, selection.limit ?? 1_000), OPS_CLI_MAX);
    let rows = await this.rows(selection, 'oldest', limit);
    if (selection.skipRetried) {
      const retried = await this.retries(rows.map((r) => r.id));
      rows = rows.filter((r) => !retried.has(r.id));
    }
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  private async rows(
    selection: DeadLetterSelection,
    order: 'newest' | 'oldest',
    limit: number,
  ): Promise<DeadRow[]> {
    const ids = selection.ids?.filter(isUuid);
    if (selection.ids && (!ids || ids.length === 0)) return [];
    return withSystem(this.database, {}, async (tx) => {
      if (!(await hasJobSchema(tx))) return [];
      const name = sql`coalesce(j.source_name, j.data ->> '__job')`;
      const where = [sql`j.name = ${DEAD_LETTER_QUEUE}`];
      if (ids)
        where.push(
          sql`j.id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        );
      if (selection.queue) where.push(sql`${name} = ${selection.queue}`);
      if (selection.from)
        where.push(sql`j.created_on >= ${selection.from.toISOString()}::timestamptz`);
      if (selection.to) where.push(sql`j.created_on < ${selection.to.toISOString()}::timestamptz`);
      const result = await tx.execute<DeadRow>(
        sql`select j.id::text as id, ${name} as name, j.data ->> 'companyId' as company_id,
              j.created_on, j.source_retry_count, j.source_output
            from pgboss.job j
            where ${sql.join(where, sql` and `)}
            order by j.created_on ${order === 'newest' ? sql`desc` : sql`asc`}, j.id
            limit ${limit}`,
      );
      return result.rows;
    });
  }

  /**
   * Each job's retry, from the platform company's ops_action rows: when it was asked for (the
   * first row) and where it stands (the latest row's outcome).
   */
  private async retries(
    ids: readonly string[],
  ): Promise<Map<string, { at: Date; outcome: RetryOutcome | null }>> {
    if (ids.length === 0) return new Map();
    return withPlatform(this.database, {}, async (tx) => {
      const a = schema.opsAction;
      const rows = await tx
        .select({ targetId: a.targetId, at: a.createdAt, outcome: a.outcome })
        .from(a)
        .where(and(eq(a.kind, 'job_retry'), inArray(a.targetId, [...ids])))
        .orderBy(a.createdAt, a.id);
      const out = new Map<string, { at: Date; outcome: RetryOutcome | null }>();
      for (const r of rows) {
        const outcome =
          r.outcome && RETRY_OUTCOMES.includes(r.outcome) ? (r.outcome as RetryOutcome) : null;
        const seen = out.get(r.targetId);
        out.set(r.targetId, {
          at: seen?.at ?? new Date(r.at),
          outcome: outcome ?? seen?.outcome ?? null,
        });
      }
      return out;
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function viewOf(
  row: DeadRow,
  retry: { readonly at: Date; readonly outcome: RetryOutcome | null } | null,
): OpsJobView {
  return {
    id: row.id,
    name: row.name ?? 'unknown',
    companyId: row.company_id && UUID.test(row.company_id) ? row.company_id : null,
    failedAt: row.created_on ? new Date(row.created_on) : null,
    attempts: (row.source_retry_count ?? 0) + 1,
    lastError: jobErrorSummary(row.source_output),
    retriedAt: retry?.at ?? null,
    retryOutcome: retry ? (retry.outcome ?? 'queued') : null,
  };
}
