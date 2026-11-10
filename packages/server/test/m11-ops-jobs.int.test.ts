import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany, withSystem } from '@rent/db';
import { HEARTBEAT_STALE_SECONDS, QUEUE_AGE_THRESHOLDS } from '@rent/domain/ops';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../src/core/jobs/job';
import { JobsService } from '../src/core/jobs/jobs.service';
import { OutboxRelay } from '../src/core/jobs/outbox-relay';
import { createLogger } from '../src/core/logging/logger';
import { OPS_RETRY_JOB, QUEUE_AGE_JOB } from '../src/ops/constants';
import { DeadLetterService } from '../src/ops/dead-letters.service';
import { WorkerHeartbeat, WorkerHeartbeatService } from '../src/ops/heartbeat';
import { OpsPruningService } from '../src/ops/pruning.service';
import { QueueMonitorService } from '../src/ops/queues.service';
import { storeDeadLetter } from '../src/ops/test-controls';
import { PROCESS_WEBHOOK_JOB } from '../src/payments/webhooks.service';
import { PolicyService } from '../src/policy/policy.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';
import { platform } from './support/messaging';

/**
 * M11 decision 9 and plan 4.14 (operations): a dead-lettered job retried by a platform admin, once;
 * each queue's oldest job against its thresholds, with alerts deduplicated per window; the
 * worker's heartbeat behind `/health/worker`; and the daily pruning of rate limits and rejected
 * webhooks, which keeps signed and recent rows (review R3 F1).
 */
let ctx: ServerTestContext;
let jobs: JobsService;
let relay: OutboxRelay;
const alerts = new InMemoryAlert();
const logger = createLogger({ level: 'silent' });
const policy = new PolicyService();
let deadLetters: DeadLetterService;
let queues: QueueMonitorService;
let heartbeats: WorkerHeartbeatService;
let admin: Awaited<ReturnType<typeof platform>>;
let manager: ReturnType<typeof staff>;
let companyId: string;
let failing = true;
const runs: string[] = [];
const deadLetterErrors: (string | null | undefined)[] = [];
const REASON = 'The provider was down 02:00 to 02:30; retrying (ticket 901)';

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  ctx = await startServerTest();
  deadLetters = new DeadLetterService(ctx.database, policy, ctx.audit, ctx.clock);
  queues = new QueueMonitorService(ctx.database, policy, alerts, ctx.clock);
  heartbeats = new WorkerHeartbeatService(ctx.database, policy, ctx.clock);
  admin = await platform(ctx);
  companyId = await company(ctx, 'agency', 'Ops Jobs Agency');
  const managerId = await person(ctx, 'Ops Jobs Manager');
  manager = staff(
    companyId,
    'agency',
    managerId,
    await member(ctx, companyId, managerId, 'property_manager'),
    'property_manager',
  );
  jobs = new JobsService(ctx.database, logger, alerts, ctx.db.appUrl, {
    pollingIntervalSeconds: 0.5,
  });
  await jobs.start();
  await jobs.register(
    defineJob({
      name: 'test.ops-flaky',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid(), item: z.string() }).passthrough(),
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      async handle({ item }) {
        if (failing) throw new Error('the provider is down');
        runs.push(item);
      },
      async onDeadLetter(_payload, { error }) {
        deadLetterErrors.push(error);
      },
    }),
  );
  // The worker's `ops.retry-job` (apps/worker/src/ops.jobs.ts), as it is defined there.
  await jobs.register(
    defineJob({
      name: OPS_RETRY_JOB,
      scope: 'company',
      schema: z
        .object({
          companyId: z.string().uuid(),
          deadLetterJobId: z.string().uuid(),
          opsActionId: z.string().uuid(),
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 1, backoff: false },
      async handle({ deadLetterJobId, opsActionId }, jobCtx) {
        await jobCtx.once(`ops:job_retry:${opsActionId}`, async (tx) => {
          await deadLetters.requeue(tx, deadLetterJobId, (queue, payload) =>
            jobs.send(queue, payload, { tx }),
          );
        });
      },
    }),
  );
  // The webhook job's queue exists (its jobs are refused a retry: their webhook is replayed).
  await jobs.register(
    defineJob({
      name: PROCESS_WEBHOOK_JOB,
      scope: 'system',
      schema: z.object({}).passthrough(),
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      async handle() {},
    }),
    { workers: false },
  );
  await jobs.watchDeadLetters();
  relay = new OutboxRelay(ctx.database, jobs, logger, new Set([OPS_RETRY_JOB]));
  await relay.start();
}, 120_000);

afterAll(async () => {
  await relay?.stop();
  await jobs?.stop();
  await ctx?.close();
});

describe('NFR-AVAIL a dead-lettered job is retried by a platform admin, once (M11 decision 9)', () => {
  it('lists it with why it failed, retries it with a reason through the normal queue, and a repeated retry job sends nothing more', async () => {
    const item = `item-${randomUUID()}`;
    await jobs.send('test.ops-flaky', { companyId, item });
    let listed: Awaited<ReturnType<DeadLetterService['list']>> = [];
    await waitFor(async () => {
      listed = (await deadLetters.list(admin, { name: 'test.ops-flaky' })).filter(
        (j) => j.companyId === companyId,
      );
      return listed.length > 0 && deadLetterErrors.length > 0;
    });
    // The job's own dead-letter step was told why (M11: webhooks.failed records it on the row).
    expect(deadLetterErrors).toEqual(['Error: the provider is down']);
    const [job] = listed;
    expect(job).toMatchObject({
      name: 'test.ops-flaky',
      companyId,
      attempts: 1,
      lastError: 'Error: the provider is down',
      retriedAt: null,
    });
    expect(job!.failedAt).toBeInstanceOf(Date);
    expect(
      alerts.raised.some(
        (a) => a.code === 'job.dead_lettered' && a.context?.job === 'test.ops-flaky',
      ),
    ).toBe(true);

    await expect(deadLetters.retry(manager, job!.id, REASON)).rejects.toMatchObject({
      status: 403,
    });
    await expect(deadLetters.retry(admin, job!.id, 'no')).rejects.toMatchObject({
      code: 'bad_reason',
    });
    failing = false;
    const retried = await deadLetters.retry(admin, job!.id, REASON);
    expect(retried.retriedAt).toBeInstanceOf(Date);
    await waitFor(() => runs.includes(item));
    expect(runs.filter((r) => r === item)).toHaveLength(1);

    // The retry job delivered twice (at-least-once) sends the job once.
    const [action] = await withCompany(
      ctx.database,
      { companyId: admin.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.opsAction).where(eq(schema.opsAction.targetId, job!.id)),
    );
    expect(action).toMatchObject({
      kind: 'job_retry',
      targetName: 'test.ops-flaky',
      reason: REASON,
      personId: admin.personId,
      outcome: 'queued',
    });
    await jobs.send(OPS_RETRY_JOB, {
      companyId: admin.companyId,
      deadLetterJobId: job!.id,
      opsActionId: action!.id,
    });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(runs.filter((r) => r === item)).toHaveLength(1);

    const after = (await deadLetters.list(admin, { name: 'test.ops-flaky' })).find(
      (j) => j.id === job!.id,
    );
    expect(after!.retriedAt).toBeInstanceOf(Date);
    // NFR-AUDIT: the retry is an event in the platform's chain, with its reason.
    const events = await withCompany(
      ctx.database,
      { companyId: admin.companyId, actorKind: 'system' },
      async (tx) =>
        (
          await tx.execute<{ actor_person_id: string; data: Record<string, unknown> }>(
            sql`select actor_person_id, data from audit_event
                where action = 'ops.job_retried' and record_id = ${job!.id}`,
          )
        ).rows,
    );
    expect(events).toEqual([
      {
        actor_person_id: admin.personId,
        data: expect.objectContaining({
          queue: 'test.ops-flaky',
          jobCompanyId: companyId,
          via: 'console',
          reason: REASON,
        }),
      },
    ]);
  });

  it('refuses to retry a webhook’s processing job (its webhook is replayed instead) and an unknown job', async () => {
    const webhookJob = await storeDeadLetter(ctx.database, { queue: PROCESS_WEBHOOK_JOB });
    await expect(deadLetters.retry(admin, webhookJob, REASON)).rejects.toMatchObject({
      status: 409,
      code: 'use_webhook_replay',
    });
    await expect(deadLetters.retry(admin, randomUUID(), REASON)).rejects.toMatchObject({
      status: 404,
    });
    await expect(deadLetters.list(manager)).rejects.toMatchObject({ status: 403 });
  });
});

describe('NFR-AVAIL queue age: thresholds per queue and alerts once a window (M11 decision 9)', () => {
  /** A queue with no worker, holding one job that has waited `minutes`. */
  async function waiting(name: string, minutes: number) {
    await jobs.register(
      defineJob({
        name,
        scope: 'system',
        schema: z.object({}).passthrough(),
        retry: { limit: 0, delaySeconds: 1, backoff: false },
        async handle() {},
      }),
      { workers: false },
    );
    await jobs.send(name, {});
    await withSystem(ctx.database, {}, (tx) =>
      tx.execute(
        sql`update pgboss.job set start_after = now() - make_interval(mins => ${minutes}::int),
              created_on = now() - make_interval(mins => ${minutes}::int)
            where name = ${name}`,
      ),
    );
  }

  it('grades payments queues at 5 and 15 minutes and the rest at 30 and 120, and alerts each level at most once a window', async () => {
    await waiting('payments.test-warning', 6);
    await waiting('payments.test-critical', 16);
    await waiting('test.other-warning', 31);
    await waiting('test.other-ok', 29);
    const byName = new Map((await queues.queues(admin)).map((q) => [q.name, q]));
    expect(byName.get('payments.test-warning')).toMatchObject({
      queued: 1,
      active: 0,
      level: 'warning',
      warnAfterSeconds: QUEUE_AGE_THRESHOLDS.payments.warnAfterSeconds,
      criticalAfterSeconds: QUEUE_AGE_THRESHOLDS.payments.criticalAfterSeconds,
    });
    expect(byName.get('payments.test-warning')!.oldestAgeSeconds).toBeGreaterThanOrEqual(360);
    expect(byName.get('payments.test-critical')!.level).toBe('critical');
    expect(byName.get('test.other-warning')).toMatchObject({
      level: 'warning',
      warnAfterSeconds: QUEUE_AGE_THRESHOLDS.other.warnAfterSeconds,
    });
    expect(byName.get('test.other-ok')!.level).toBe('ok');
    // A job scheduled for later is not waiting yet.
    await jobs.send('test.other-ok', {}, { startAfter: new Date(Date.now() + 3_600_000) });
    expect((await queues.stats()).find((q) => q.name === 'test.other-ok')).toMatchObject({
      queued: 2,
      level: 'ok',
    });
    await expect(queues.queues(manager)).rejects.toMatchObject({ status: 403 });

    const ours = (r: { alerted: { queue: string; level: string }[] }) =>
      r.alerted.filter((a) => a.queue.includes('.test-') || a.queue.startsWith('test.other'));
    const first = await queues.alertAges();
    expect(ours(first).sort((x, y) => x.queue.localeCompare(y.queue))).toEqual([
      { queue: 'payments.test-critical', level: 'critical' },
      { queue: 'payments.test-warning', level: 'warning' },
      { queue: 'test.other-warning', level: 'warning' },
    ]);
    const raised = alerts.raised.filter((a) => a.code.startsWith('ops.queue_age_'));
    expect(raised.find((a) => a.context?.queue === 'payments.test-critical')).toMatchObject({
      severity: 'critical',
      code: 'ops.queue_age_critical',
    });
    // The next minute's check alerts nothing new: once a window per queue and level.
    expect(ours(await queues.alertAges())).toEqual([]);
    expect(ours(await queues.alertAges())).toEqual([]);
    // After the critical window (30 minutes) it alerts again and says how many it held back.
    ctx.clock.advance(31 * 60_000);
    try {
      const later = ours(await queues.alertAges());
      expect(later).toEqual([{ queue: 'payments.test-critical', level: 'critical' }]);
      const again = alerts.raised
        .filter(
          (a) =>
            a.code === 'ops.queue_age_critical' && a.context?.queue === 'payments.test-critical',
        )
        .at(-1)!;
      expect(again.context?.suppressedBefore).toBe(2);
    } finally {
      ctx.clock.advance(-31 * 60_000);
    }
  });
});

describe('NFR-AVAIL the worker heartbeat (M11 decision 9)', () => {
  it('is missing before the worker beats, healthy while it beats, and stale after two minutes without', async () => {
    expect(await heartbeats.status()).toEqual({
      lastBeatAt: null,
      ageSeconds: null,
      healthy: false,
    });
    const beat = new WorkerHeartbeat(ctx.database, ctx.clock, logger, {
      instance: 'test-worker:1',
      intervalMs: 60_000,
    });
    await beat.start();
    try {
      expect(await heartbeats.heartbeat(admin)).toMatchObject({ ageSeconds: 0, healthy: true });
      ctx.clock.advance((HEARTBEAT_STALE_SECONDS - 1) * 1000);
      expect((await heartbeats.status()).healthy).toBe(true);
      ctx.clock.advance(2_000);
      expect(await heartbeats.status()).toMatchObject({
        ageSeconds: HEARTBEAT_STALE_SECONDS + 1,
        healthy: false,
      });
      await beat.beat();
      expect(await heartbeats.status()).toMatchObject({ ageSeconds: 0, healthy: true });
      const [row] = await withSystem(ctx.database, {}, (tx) =>
        tx.select().from(schema.workerHeartbeat),
      );
      expect(row).toMatchObject({ instance: 'test-worker:1', beats: 2 });
    } finally {
      ctx.clock.advance(-(HEARTBEAT_STALE_SECONDS + 1) * 1000);
      await beat.stop();
    }
    await expect(heartbeats.heartbeat(manager)).rejects.toMatchObject({ status: 403 });
  });
});

describe('NFR-SEC pruning keeps signed and recent rows (M11 review R3 F1)', () => {
  it('deletes rate-limit rows over 24 hours old and rejected webhooks over 30 days old, and nothing else', async () => {
    const now = ctx.clock.now().getTime();
    const hours = (n: number) => now - n * 3_600_000;
    await withSystem(ctx.database, {}, (tx) =>
      tx.insert(schema.rateLimit).values([
        { key: 'prune-test:old', count: 3, lastRequest: hours(25) },
        { key: 'prune-test:recent', count: 3, lastRequest: hours(23) },
      ]),
    );
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const inbox = (eventId: string, signed: boolean, receivedAt: Date) => ({
      provider: 'paystack',
      eventId,
      rawBody: signed ? '{}' : null,
      bodySha256: 'ab'.repeat(32),
      bodyBytes: 2,
      headers: {},
      signatureValid: signed,
      status: signed ? 'processed' : 'rejected',
      outcome: signed ? 'posted' : 'bad_signature',
      receivedAt,
    });
    await withSystem(ctx.database, {}, (tx) =>
      tx
        .insert(schema.webhookInbox)
        .values([
          inbox('prune:rejected-old', false, days(31)),
          inbox('prune:rejected-recent', false, days(29)),
          inbox('prune:signed-old', true, days(400)),
        ]),
    );
    const pruned = await new OpsPruningService(ctx.database, ctx.clock).prune();
    expect(pruned.rateLimits).toBeGreaterThanOrEqual(1);
    expect(pruned.rejectedWebhooks).toBe(1);
    const keys = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ key: string }>(sql`select key from rate_limit where key like 'prune-test:%'`),
    );
    expect(keys.rows.map((r) => r.key)).toEqual(['prune-test:recent']);
    const left = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ event_id: string }>(
        sql`select event_id from webhook_inbox where event_id like 'prune:%' order by event_id`,
      ),
    );
    expect(left.rows.map((r) => r.event_id)).toEqual(['prune:rejected-recent', 'prune:signed-old']);
    // Pruning again changes nothing; the function itself refuses a cut-off under 30 days.
    expect((await new OpsPruningService(ctx.database, ctx.clock).prune()).rejectedWebhooks).toBe(0);
    await expect(
      withSystem(ctx.database, {}, (tx) =>
        tx.execute(sql`select app.prune_rejected_webhooks(now() - interval '29 days')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '22023' } });
  });
});

describe('NFR-AVAIL the dead-lettered job test control looks like a real dead letter (M11 decision 9)', () => {
  it('is listed with its queue, attempts and last error, and its retry runs the minute’s queue check', async () => {
    let checks = 0;
    await jobs.register(
      defineJob({
        name: QUEUE_AGE_JOB,
        scope: 'system',
        schema: z.object({}).passthrough(),
        retry: { limit: 0, delaySeconds: 1, backoff: false },
        async handle() {
          await queues.alertAges();
          checks += 1;
        },
      }),
    );
    const id = await storeDeadLetter(ctx.database, { queue: QUEUE_AGE_JOB });
    await waitFor(async () =>
      (await deadLetters.list(admin, { name: QUEUE_AGE_JOB })).some((j) => j.id === id),
    );
    expect(
      (await deadLetters.list(admin, { name: QUEUE_AGE_JOB })).find((j) => j.id === id),
    ).toMatchObject({
      name: QUEUE_AGE_JOB,
      companyId: null,
      attempts: 3,
      lastError: 'Error: e2e test control: the job gave up',
      retriedAt: null,
    });
    await deadLetters.retry(admin, id, 'The queue check is safe to run again');
    await waitFor(() => checks > 0);
    expect(checks).toBe(1);
  });
});
