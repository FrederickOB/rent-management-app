import { schema, sql, withCompany, withSystem } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookReplayService } from '../../src/ops/webhook-replay.service';
import { PROCESS_WEBHOOK_JOB } from '../../src/payments/webhooks.service';
import { startServerTest, type ServerTestContext } from '../support';
import { billingServices, type BillingServices } from '../support/billing';
import { platform } from '../support/messaging';
import { tenancyServices, type TenancyServices } from '../support/tenancy';
import {
  drillCompany,
  drillLeases,
  drillPayments,
  issueReceipts,
  moneyState,
  payToken,
  processInbox,
  sendQueued,
  startFakeProvider,
  startMomo,
  startWebhookEndpoint,
  type DrillCompany,
  type DrillPayments,
  type FakeProvider,
  type WebhookEndpoint,
} from './support';

/**
 * NFR-AVAIL drill: replaying every webhook of a day changes nothing (M11 plan 4.7 and section 6,
 * idempotent replay; decision 9; docs/runbooks/failed-webhooks.md). A day of payments comes in by
 * webhook: payments in full, a short one, a chargeback, and money that never touched our pay page.
 * Then the whole day is replayed twice, both ways an incident can replay it:
 * - the provider sends every event again (its own retry, or a resend from its dashboard): the
 *   intake recognises each and stores nothing new;
 * - each stored event is replayed through the replay service, as `pnpm ops:replay-webhooks` and
 *   the console do (WebhookReplayService.replayAs, with a reason): the row is marked to process
 *   again and the platform company's outbox queues the normal processing job, which runs here as
 *   the worker would run it.
 * Money, receipts, messages, allocations and the journal are exactly as before, and the books still
 * match their sub-ledgers.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: DrillPayments;
let fake: FakeProvider;
let endpoint: WebhookEndpoint;
let company: DrillCompany;
let ops: WebhookReplayService;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
const REASON = 'NFR-AVAIL drill: replaying the whole day after an incident';
/** The platform outbox events already run, as the worker's relay runs each once. */
const ran = new Set<string>();

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  endpoint = await startWebhookEndpoint();
  fake = await startFakeProvider(endpoint.url);
  p = drillPayments(ctx, s, b, fake.port);
  endpoint.handler = (body, headers) => p.webhooks.intake('paystack', body, headers, '127.0.0.1');
  company = await drillCompany(ctx, s, p, { name: 'Replay Agency', units: 8 });
  // A replay is recorded in the platform company's chain, so the deployment's platform exists.
  admin = await platform(ctx);
  ops = new WebhookReplayService(ctx.database, s.policy, ctx.audit, ctx.clock);
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await endpoint?.close();
  await ctx?.close();
});

/**
 * Replays a stored webhook through the replay service, then runs the processing job it queued in
 * the platform company's outbox, as the worker's relay and job would (each event once).
 */
async function replay(inboxId: string): Promise<string[]> {
  await ops.replayAs({ personId: admin.personId, via: 'cli' }, inboxId, REASON);
  const events = await withCompany(
    ctx.database,
    { companyId: admin.companyId, actorKind: 'system' },
    (tx) =>
      tx
        .select({ id: schema.outboxEvent.id, payload: schema.outboxEvent.payload })
        .from(schema.outboxEvent)
        .where(sql`${schema.outboxEvent.type} = ${PROCESS_WEBHOOK_JOB}`)
        .orderBy(schema.outboxEvent.createdAt, schema.outboxEvent.id),
  );
  const outcomes: string[] = [];
  for (const e of events) {
    if (ran.has(e.id)) continue;
    ran.add(e.id);
    outcomes.push(await p.webhooks.process((e.payload as { inboxId: string }).inboxId));
  }
  return outcomes;
}

/** Everything a replay could disturb, for the company and the global inbox. */
async function snapshot() {
  const money = await moneyState(ctx, company.companyId);
  const rest = await withCompany(
    ctx.database,
    { companyId: company.companyId, actorKind: 'system' },
    async (tx) => {
      const count = async (table: string) =>
        Number(
          (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))
            .rows[0]!.n,
        );
      return {
        reversals: await count('payment_reversal'),
        receiptDeliveries: await count('receipt_delivery'),
        messages: await count('message'),
        outbox: await count('outbox_event'),
        exceptions: await count('reconciliation_exception'),
        auditEvents: await count('audit_event'),
      };
    },
  );
  const inbox = await withSystem(ctx.database, {}, (tx) =>
    tx.execute<{ n: number; valid: number }>(
      sql`select count(*)::int as n, count(*) filter (where signature_valid)::int as valid from webhook_inbox`,
    ),
  );
  return {
    ...money,
    payments: [...money.payments].sort((x, y) => x.id.localeCompare(y.id)),
    intents: [...money.intents].sort((x, y) => x.id.localeCompare(y.id)),
    ...rest,
    inboxRows: Number(inbox.rows[0]!.n),
    smsSent: s.sms.sent.length,
  };
}

describe('NFR-AVAIL webhook replay drill', () => {
  it('replaying every stored webhook of a day, twice, changes nothing', async () => {
    const leases = await drillLeases(ctx, s, b, company, 6, { consent: true });
    // A day of webhooks: four paid in full, one short, then one charged back.
    const references: string[] = [];
    for (const [i, lease] of leases.slice(0, 5).entries()) {
      const started = await startMomo(
        p,
        await payToken(ctx, p, company.companyId, lease.invoiceId),
        150_000,
      );
      await fake.port.completeCharge(started.reference, {
        status: 'success',
        ...(i === 4 ? { amountMinor: 100_000 } : {}),
      });
      references.push(started.reference);
    }
    // The inbox is claimed in no particular order.
    expect((await processInbox(ctx, p)).sort()).toEqual([
      'posted',
      'posted',
      'posted',
      'posted',
      'posted_flagged',
    ]);
    await issueReceipts(ctx, p, company.companyId);
    await fake.port.chargeback(references[0]!);
    // Money paid straight to the owner's subaccount, which waits for a person.
    const [subaccount] = await withCompany(
      ctx.database,
      { companyId: company.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.providerSubaccount),
    );
    await fake.port.payExternal({
      subaccountCode: subaccount!.subaccountCode,
      amountMinor: 70_000,
      channel: 'momo',
      payerPhone: '+233200000778',
    });
    const outcomes = await processInbox(ctx, p);
    expect(outcomes).toHaveLength(2);
    await issueReceipts(ctx, p, company.companyId);
    await sendQueued(ctx, s, company.companyId);
    const stored = endpoint.received.filter((r) => r.result === 'stored');
    expect(stored).toHaveLength(7);

    const before = await snapshot();
    expect(before.payments).toHaveLength(6);
    expect(before.reversals).toBe(1);

    for (let round = 0; round < 2; round += 1) {
      // The provider sends the whole day again: each event is known, nothing is stored.
      for (const delivery of stored) expect(await endpoint.redeliver(delivery)).toBe(200);
      // Every stored event of the day is processed again through the normal path.
      const rows = await withSystem(ctx.database, {}, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from webhook_inbox where signature_valid
              and received_at >= now() - interval '1 day' order by received_at`,
        ),
      );
      expect(rows.rows).toHaveLength(7);
      const replayed = [];
      for (const { id } of rows.rows) replayed.push(...(await replay(id)));
      expect(replayed).toHaveLength(7);
      expect(replayed.filter((o) => o === 'posted' || o === 'posted_flagged')).toEqual([]);
      // The jobs that follow a posting run again too; they find their work done.
      await issueReceipts(ctx, p, company.companyId);
      await sendQueued(ctx, s, company.companyId);
    }
    expect(endpoint.received.filter((r) => r.result === 'duplicate')).toHaveLength(14);

    const after = await snapshot();
    // Each replay is recorded and queued in the platform company (its ops action, audit event and
    // job); the company's money, messages and records are exactly as before.
    expect({ ...after, auditEvents: 0, outbox: 0 }).toEqual({
      ...before,
      auditEvents: 0,
      outbox: 0,
    });
    expect((await b.subledger.check(company.companyId)).mismatches).toEqual([]);
  });
});
