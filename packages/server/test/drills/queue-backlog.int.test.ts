import { schema, sql, withCompany, withSystem } from '@rent/db';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isoNow } from '../../src/billing/records';
import { defineJob, type JobDefinition } from '../../src/core/jobs/job';
import { JobsService } from '../../src/core/jobs/jobs.service';
import { OutboxRelay } from '../../src/core/jobs/outbox-relay';
import { createLogger } from '../../src/core/logging/logger';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import { PROCESS_WEBHOOK_JOB, WebhookInboxRelay } from '../../src/payments/webhooks.service';
import { startServerTest, type ServerTestContext } from '../support';
import { billingServices, type BillingServices } from '../support/billing';
import { tenancyServices, type TenancyServices } from '../support/tenancy';
import {
  drillCompany,
  drillLeases,
  drillPayments,
  payToken,
  startFakeProvider,
  startMomo,
  startWebhookEndpoint,
  type DrillCompany,
  type DrillPayments,
  type FakeProvider,
  type WebhookEndpoint,
} from './support';

/**
 * NFR-AVAIL drill: a queue backlog at month end (M11 plan 4.7; docs/runbooks/queue-backlog.md).
 * With no worker running, a month end's work piles up: the lease events of every new tenancy, a
 * reminder for every invoice due today, and a webhook for every payment, some delivered twice by
 * the provider. Then a worker starts on the real pg-boss queues, with the relays the worker runs
 * and the job definitions it registers for these queues (mirrored from apps/worker/src, which this
 * package cannot import: tenancy.jobs.ts, billing.jobs.ts and payments.jobs.ts, same names, retry
 * policies and drain flags). The drill measures how long the backlog takes to clear and checks
 * that nothing ran twice: one invoice per lease, one payment and one receipt per charge with
 * numbers 1 to N, one message per reminder and per receipt.
 *
 * Sizes: DRILL_BACKLOG_LEASES (default 200) leases, of which DRILL_BACKLOG_PAYMENTS (default 120)
 * pay. The month-end scale (5,000 invoices, 1,000 webhooks) is the load test's (load/README.md).
 */
const LEASES = Number(process.env.DRILL_BACKLOG_LEASES ?? 200);
const PAYMENTS = Math.min(LEASES, Number(process.env.DRILL_BACKLOG_PAYMENTS ?? 120));
const DUPLICATES = Math.floor(PAYMENTS / 4);
/** Decision 7's bound for the load test's queues; the drill must clear well inside it. */
const DRAIN_LIMIT_MS = 15 * 60_000;
const ENVELOPE = ['companyId', 'eventId', '__job'] as const;

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: DrillPayments;
let fake: FakeProvider;
let endpoint: WebhookEndpoint;
let company: DrillCompany;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  endpoint = await startWebhookEndpoint();
  fake = await startFakeProvider(endpoint.url);
  p = drillPayments(ctx, s, b, fake.port);
  endpoint.handler = (body, headers) => p.webhooks.intake('paystack', body, headers, '127.0.0.1');
  company = await drillCompany(ctx, s, p, { name: 'Backlog Agency', units: LEASES });
}, 600_000);

afterAll(async () => {
  await fake?.close();
  await endpoint?.close();
  await ctx?.close();
});

const companyCtx = () => ({ companyId: company.companyId, actorKind: 'system' as const });

/** The worker's definitions for the queues this backlog fills (see the file comment). */
function workerDefinitions(): JobDefinition<never>[] {
  const uuid = z.string().uuid();
  return [
    defineJob({
      name: PROCESS_WEBHOOK_JOB,
      // As the worker since M11 (apps/worker/src/payments.jobs.ts): a burst drains without the
      // 1 s pause after every job.
      drain: true,
      scope: 'system',
      schema: z.object({ inboxId: uuid }).passthrough(),
      retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
      async handle({ inboxId }) {
        await p.webhooks.process(inboxId);
      },
      async onDeadLetter({ inboxId }) {
        await p.webhooks.failed(inboxId);
      },
    }),
    defineJob({
      name: 'payment.posted',
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, receiptId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 5, backoff: true },
      async handle({ companyId, receiptId }) {
        await p.receipts.issue(companyId, receiptId);
      },
    }),
    defineJob({
      name: MESSAGE_SEND_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid }).passthrough(),
      retry: { limit: 12, delaySeconds: 30, backoff: true, maxDelaySeconds: 1_800 },
      drain: true,
      async handle(payload) {
        const body = { ...(payload as Record<string, unknown>) };
        for (const key of ENVELOPE) delete body[key];
        await s.messaging.deliver(payload.companyId, messageRequestSchema.parse(body));
      },
    }),
    defineJob({
      name: 'lease.signed',
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, leaseId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, leaseId }, jobCtx) {
        await b.invoicing.onLeaseSigned(companyId, leaseId, `job:${jobCtx.jobId}`);
      },
    }),
  ] as JobDefinition<never>[];
}

const QUEUES = [PROCESS_WEBHOOK_JOB, 'payment.posted', MESSAGE_SEND_JOB, 'lease.signed'];

/** What is still waiting: unprocessed webhooks, unpublished events and unfinished jobs. */
async function backlog() {
  return withSystem(ctx.database, {}, async (tx) => {
    const inbox = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from webhook_inbox where status = 'received'`,
    );
    const jobs = await tx.execute<{ name: string; n: number }>(
      sql`select name, count(*)::int as n from pgboss.job
          where name = any(${`{${QUEUES.join(',')}}`}::text[]) and state in ('created', 'retry', 'active')
          group by name`,
    );
    const outbox = await withCompany(ctx.database, companyCtx(), (ctx2) =>
      ctx2.execute<{ n: number }>(
        sql`select count(*)::int as n from outbox_event where published_at is null
            and type = any(${`{${QUEUES.join(',')}}`}::text[])`,
      ),
    );
    return {
      inbox: Number(inbox.rows[0]!.n),
      outbox: Number(outbox.rows[0]!.n),
      jobs: Object.fromEntries(jobs.rows.map((r) => [r.name, Number(r.n)])),
    };
  });
}

const isEmpty = (b: Awaited<ReturnType<typeof backlog>>) =>
  b.inbox === 0 && b.outbox === 0 && Object.values(b.jobs).every((n) => n === 0);

describe('NFR-AVAIL queue backlog drill', () => {
  it(
    `clears a month-end backlog (${LEASES} leases and reminders, ${PAYMENTS} payments) with nothing run twice`,
    async () => {
      const today = isoNow(ctx.clock, 'Africa/Accra');
      const built = Date.now();
      const leases = await drillLeases(ctx, s, b, company, LEASES, {
        consent: true,
        concurrency: 6,
      });

      // The backlog, with no worker: a reminder for every invoice due today…
      const reminders = await p.reminders.run(company.companyId, today);
      expect(reminders).toBe(LEASES);
      // …and payments, whose webhooks the provider delivers (to the intake only: nothing processes).
      const references: string[] = [];
      for (const lease of leases.slice(0, PAYMENTS)) {
        const started = await startMomo(
          p,
          await payToken(ctx, p, company.companyId, lease.invoiceId),
          150_000,
        );
        references.push(started.reference);
      }
      // The provider withholds while the payers approve, then sends everything at once when it
      // catches up, and sends a quarter of them a second time, as a provider retrying would.
      await fake.outage('withhold');
      for (const reference of references)
        await fake.port.completeCharge(reference, { status: 'success' });
      expect((await fake.outage('normal')).released).toBe(PAYMENTS);
      const delivered = endpoint.received.filter((r) => r.result === 'stored');
      expect(delivered).toHaveLength(PAYMENTS);
      for (const delivery of delivered.slice(0, DUPLICATES))
        expect(await endpoint.redeliver(delivery)).toBe(200);
      expect(endpoint.received.filter((r) => r.result === 'duplicate')).toHaveLength(DUPLICATES);
      const queued = await backlog();
      expect(queued.inbox).toBe(PAYMENTS);
      expect(queued.outbox).toBeGreaterThanOrEqual(LEASES * 2);
      const buildMs = Date.now() - built;

      // The worker starts.
      const alerts = new InMemoryAlert();
      const logger = createLogger({ level: 'silent' });
      const jobs = new JobsService(ctx.database, logger, alerts, ctx.db.appUrl);
      await jobs.start();
      for (const definition of workerDefinitions()) await jobs.register(definition);
      await jobs.watchDeadLetters();
      const relay = new OutboxRelay(ctx.database, jobs, logger, new Set(QUEUES));
      const inbox = new WebhookInboxRelay(ctx.database, jobs, logger);
      const started = Date.now();
      const cleared: Record<string, number> = {};
      await relay.start();
      await inbox.start();
      let last: Awaited<ReturnType<typeof backlog>>;
      try {
        for (;;) {
          last = await backlog();
          const at = Date.now() - started;
          if (last.inbox === 0) cleared.webhooks ??= at;
          for (const queue of QUEUES)
            if (!last.jobs[queue] && last.outbox === 0) cleared[queue] ??= at;
          if (isEmpty(last)) break;
          if (at > DRAIN_LIMIT_MS) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        await relay.stop();
        await inbox.stop();
        await jobs.stop();
      }
      const drainMs = Date.now() - started;
      console.info(
        `queue backlog drill: ${LEASES} leases, ${LEASES} reminders, ${PAYMENTS} webhooks (+${DUPLICATES} resent); built in ${buildMs} ms; drained in ${drainMs} ms; cleared at ${JSON.stringify(cleared)}`,
      );
      expect(last).toEqual({ inbox: 0, outbox: 0, jobs: {} });
      expect(drainMs).toBeLessThan(DRAIN_LIMIT_MS);
      expect(alerts.raised.filter((a) => a.severity === 'critical')).toEqual([]);

      // Nothing ran twice.
      const counts = await withCompany(ctx.database, companyCtx(), async (tx) => {
        const one = async (q: ReturnType<typeof sql>) =>
          Number((await tx.execute<{ n: number }>(q)).rows[0]!.n);
        return {
          invoices: await one(sql`select count(*)::int as n from invoice`),
          payments: await one(sql`select count(*)::int as n from payment`),
          paymentRefs: await one(
            sql`select count(distinct provider_reference)::int as n from payment`,
          ),
          receipts: await tx
            .select({ number: schema.receipt.number })
            .from(schema.receipt)
            .orderBy(schema.receipt.number),
          deliveries: await one(sql`select count(*)::int as n from receipt_delivery`),
          reminderMessages: await one(
            sql`select count(*)::int as n from message where purpose = 'rent_reminder'`,
          ),
        };
      });
      expect(counts.invoices).toBe(LEASES);
      expect(counts.payments).toBe(PAYMENTS);
      expect(counts.paymentRefs).toBe(PAYMENTS);
      expect(counts.receipts.map((r) => r.number)).toEqual(
        Array.from({ length: PAYMENTS }, (_, i) => i + 1),
      );
      expect(counts.deliveries).toBe(PAYMENTS);
      expect(counts.reminderMessages).toBe(LEASES);
      // Each message went once: no SMS was sent twice (each carries its own receipt number or pay
      // link), and every reminder and every receipt reached its tenant.
      const sent = s.sms.sent.map((m) => `${m.to}|${m.body}`);
      expect(new Set(sent).size).toBe(sent.length);
      expect(s.sms.sent.filter((m) => /receipt/i.test(m.body))).toHaveLength(PAYMENTS);
      // A reminder whose invoice was paid before it went is rightly not sent (BC-09); every
      // tenant still owing got theirs, once.
      const reminded = await withCompany(ctx.database, companyCtx(), (tx) =>
        tx.execute<{ tenant_id: string; sent: number }>(
          sql`select m.tenant_id, count(e.id) filter (where e.status = 'sent')::int as sent
              from message m left join message_event e
                on e.company_id = m.company_id and e.message_id = m.id
              where m.purpose = 'rent_reminder' group by m.tenant_id`,
        ),
      );
      const sentTo = new Map(reminded.rows.map((r) => [r.tenant_id, Number(r.sent)]));
      expect([...sentTo.values()].every((n) => n <= 1)).toBe(true);
      expect(leases.slice(PAYMENTS).map((l) => sentTo.get(l.tenantId))).toEqual(
        leases.slice(PAYMENTS).map(() => 1),
      );
      expect((await b.subledger.check(company.companyId)).mismatches).toEqual([]);
    },
    30 * 60_000,
  );
});
