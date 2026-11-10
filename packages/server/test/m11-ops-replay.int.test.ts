import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany, withSystem } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { MESSAGING_INBOUND_JOB } from '../src/core/messages';
import { WebhookReplayService } from '../src/ops/webhook-replay.service';
import { PROCESS_WEBHOOK_JOB } from '../src/payments/webhooks.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  messagingServices,
  platform,
  receive,
  SHARED_NUMBER,
  SHARED_WABA,
  whatsappFrom,
  whatsappNumber,
  work,
  type MessagingServices,
} from './support/messaging';
import {
  activeAccount,
  agreementInForce,
  CLIENT,
  claimInbox,
  deliverWebhook,
  issueReceipts,
  paymentsServices,
  type PaymentsServices,
} from './support/payments';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M11 decision 9 and plan section 6 (resilience): replaying webhooks through the platform admins'
 * replay service. ★ Idempotent replay: a day of webhooks (payments in full, a short one, a
 * chargeback, money paid outside the pay page, a tenant's WhatsApp message and a delivery status)
 * is replayed twice through the normal processing job, and money, receipts and messages are
 * exactly as before. A dead-lettered webhook is replayed into its payment once, however often it
 * is replayed. Each replay is audited in the platform's chain with its reason.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let m: MessagingServices;
let ops: WebhookReplayService;
let admin: Awaited<ReturnType<typeof platform>>;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let units: string[];
let today: string;
let phones = 0;
const phone = () => `+2332002${String(3000 + ++phones).padStart(5, '0')}`;
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const REASON = 'Provider outage 09:00 to 09:40, replaying the day (ticket 812)';
/** The platform outbox events already run, as the worker's relay would run each once. */
const ran = new Set<string>();

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  m = messagingServices(ctx, s, b);
  ops = new WebhookReplayService(ctx.database, s.policy, ctx.audit, ctx.clock);
  today = isoNow(ctx.clock, 'Africa/Accra');
  admin = await platform(ctx);
  agency = await moneyCompany(ctx, s, 'agency', 'Replay Agency');
  const second = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second Admin');
  const ownerId = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Replay Owner' })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'RPL',
    ownerId,
    units: [{ unitType: 'apartment', count: 12, bedrooms: 2 }],
  });
  units = Object.values(property.units);
  await activeAccount(ctx, s, p, agency.admin, second, { holder: 'owner', ownerId });
  await agreementInForce(ctx, s, p, agency.admin, second, ownerId, 'owner_account');
  await whatsappNumber(ctx, m, admin, {
    phoneNumberId: SHARED_NUMBER,
    wabaId: SHARED_WABA,
    kind: 'shared',
    companyId: null,
    name: 'Rent Platform',
  });
}, 120_000);

afterAll(async () => {
  await m?.stream.onModuleDestroy();
  await ctx?.close();
});

/** A tenant with a monthly lease from today (its first invoice due), SMS and WhatsApp consent. */
async function tenancy(name: string) {
  const number = phone();
  const { tenant } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: name,
    phone: number,
  });
  await s.tenants.recordConsent(agency.manager, tenant.id, { channel: 'sms', action: 'grant' });
  await m.consent.record(agency.manager, tenant.id, { channel: 'whatsapp', action: 'grant' });
  const lease = await billedLease(ctx, s, b, agency.manager, {
    unitId: units.shift()!,
    tenantId: tenant.id,
    startDate: today,
    endDate: plusDays(plusMonths(today, 12), -1),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    signedOn: today,
    billingStartDate: today,
  });
  const [invoice] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx.select().from(schema.invoice).where(eq(schema.invoice.leaseId, lease.id)),
  );
  return { leaseId: lease.id, invoiceId: invoice!.id, phone: number };
}

/** The tenant pays by MoMo on a pay link; the provider's webhook is stored and processed. */
async function pay(invoiceId: string, amountMinor: number, paidMinor = amountMinor) {
  const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
    p.links.mint(tx, await p.links.invoice(tx, invoiceId)),
  );
  const client = { ...CLIENT, ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
  const intent = await p.page.start(url.split('/p/')[1]!, client, {
    amountMinor,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId: randomUUID(),
  });
  const reference = chargeReference(intent.intentId);
  const webhook = await p.primary.completeCharge(reference, {
    status: 'success',
    ...(paidMinor === amountMinor ? {} : { amountMinor: paidMinor }),
  });
  return { reference, delivered: await deliverWebhook(ctx, p, 'paystack', webhook!) };
}

/** Runs the processing jobs replays queued, as the worker's relay and jobs would, each once. */
async function runReplays(): Promise<string[]> {
  const events = await withCompany(ctx.database, sys(admin.companyId), (tx) =>
    tx
      .select({
        id: schema.outboxEvent.id,
        type: schema.outboxEvent.type,
        payload: schema.outboxEvent.payload,
      })
      .from(schema.outboxEvent)
      .where(sql`${schema.outboxEvent.type} in (${PROCESS_WEBHOOK_JOB}, ${MESSAGING_INBOUND_JOB})`)
      .orderBy(schema.outboxEvent.createdAt, schema.outboxEvent.id),
  );
  const outcomes: string[] = [];
  for (const e of events) {
    if (ran.has(e.id)) continue;
    ran.add(e.id);
    const { inboxId } = e.payload as { inboxId: string };
    outcomes.push(
      e.type === PROCESS_WEBHOOK_JOB
        ? await p.webhooks.process(inboxId)
        : await m.inbound.process(inboxId),
    );
  }
  return outcomes;
}

/** Everything a replay could disturb in the company, and what the providers were sent. */
async function snapshot() {
  const state = await withCompany(ctx.database, sys(agency.companyId), async (tx) => {
    const count = async (table: string) =>
      Number(
        (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))
          .rows[0]!.n,
      );
    const payments = await tx
      .select({ id: schema.payment.id, amount: schema.payment.amountMinor })
      .from(schema.payment)
      .orderBy(schema.payment.id);
    const receipts = await tx
      .select({ number: schema.receipt.number, paymentId: schema.receipt.paymentId })
      .from(schema.receipt)
      .orderBy(schema.receipt.number);
    const journal = await tx.execute<{ account: string; total: string; lines: number }>(
      sql`select account_code as account, sum(amount_minor)::text as total, count(*)::int as lines
          from journal_line group by account_code order by account_code`,
    );
    return {
      payments,
      receipts,
      journal: journal.rows,
      allocations: await count('allocation'),
      reversals: await count('payment_reversal'),
      exceptions: await count('reconciliation_exception'),
      receiptDeliveries: await count('receipt_delivery'),
      messages: await count('message'),
      messageEvents: await count('message_event'),
      conversations: await count('conversation'),
      outbox: await count('outbox_event'),
      auditEvents: await count('audit_event'),
    };
  });
  return { ...state, sms: s.sms.sent.length, whatsapp: m.whatsapp.sent.length };
}

/** The day's stored webhooks that can be replayed (signed, with a body), oldest first. */
async function daysWebhooks(): Promise<string[]> {
  return (
    await ops.select({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
      include: 'all',
    })
  ).map((r) => r.id);
}

describe('NFR-AVAIL ★ replaying a day of webhooks changes nothing (M11 decision 9)', () => {
  it('replays every webhook of the day twice through the normal processing job; money, receipts and messages are exactly as before', async () => {
    const leases = [
      await tenancy('Replay Tenant One'),
      await tenancy('Replay Tenant Two'),
      await tenancy('Replay Tenant Three'),
      await tenancy('Replay Tenant Four'),
    ];
    // A day of payments: three in full, one short (flagged for a person), then a chargeback.
    const outcomes: (string | null)[] = [];
    const references: string[] = [];
    for (const [i, lease] of leases.entries()) {
      const paid = await pay(lease.invoiceId, 150_000, i === 3 ? 100_000 : 150_000);
      references.push(paid.reference);
      outcomes.push(paid.delivered.outcome);
    }
    expect(outcomes).toEqual(['posted', 'posted', 'posted', 'posted_flagged']);
    const chargeback = await p.primary.chargeback(references[0]!);
    expect((await deliverWebhook(ctx, p, 'paystack', chargeback)).intake).toBe('stored');
    // Money paid straight to the owner's subaccount: unmatched, waiting for a person.
    const [subaccount] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.providerSubaccount),
    );
    const external = await p.primary.payExternal({
      subaccountCode: subaccount!.subaccountCode,
      amountMinor: 70_000,
      channel: 'momo',
      payerPhone: '+233200000779',
    });
    expect((await deliverWebhook(ctx, p, 'paystack', external.webhook)).intake).toBe('stored');
    await issueReceipts(ctx, p, agency.companyId);
    // A tenant writes on WhatsApp, the bot answers, and the answer is reported delivered.
    await whatsappFrom(ctx, m, leases[1]!.phone, 'BALANCE');
    await work(ctx, m, agency.companyId);
    const answer = m.whatsapp.sent.filter((x) => x.to === leases[1]!.phone).at(-1)!;
    const status = await m.whatsapp.simulateStatus({
      providerMessageId: answer.providerMessageId,
      status: 'delivered',
    });
    expect((await receive(ctx, m, 'whatsapp', status.rawBody, status.signature)).outcomes).toEqual([
      'delivered',
    ]);
    await work(ctx, m, agency.companyId);

    // The messaging helper processes rows without the relay's claim; claim them as it would have.
    await claimInbox(ctx);
    const stored = await daysWebhooks();
    expect(stored.length).toBeGreaterThanOrEqual(8);
    const before = await snapshot();
    expect(before.payments).toHaveLength(5);
    expect(before.reversals).toBe(1);

    for (let round = 1; round <= 2; round += 1) {
      for (const id of stored) {
        const replayed = await ops.replayAs(
          { personId: admin.personId, via: 'cli' },
          id,
          `${REASON}, round ${round}`,
        );
        expect(replayed).toMatchObject({ status: 'pending', replayCount: round });
      }
      // Nothing is processed until the queued jobs run: the rows wait, published, for their job.
      expect(await claimInbox(ctx)).toEqual([]);
      const reprocessed = await runReplays();
      expect(reprocessed).toHaveLength(stored.length);
      expect(reprocessed.filter((o) => /^posted/.test(o))).toEqual([]);
      // The jobs that follow a posting run again too, and find their work done.
      await issueReceipts(ctx, p, agency.companyId);
      await work(ctx, m, agency.companyId);
    }

    expect(await snapshot()).toEqual(before);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
    // Every row is processed again (or ignored, as before), counted twice and by whom.
    const rows = await withSystem(ctx.database, {}, (tx) =>
      tx
        .select()
        .from(schema.webhookInbox)
        .where(sql`${schema.webhookInbox.id} in ${stored}`),
    );
    for (const row of rows) {
      expect(row.status, row.eventType ?? '').toMatch(/^(processed|ignored)$/);
      expect(row.replayCount).toBe(2);
      expect(row.lastReplayedBy).toBe(admin.personId);
    }
  });
});

describe('NFR-AVAIL a dead-lettered webhook is replayed into its payment once (M11 decision 9)', () => {
  it('lists it as dead-lettered with why, posts it on replay, and a second replay changes nothing', async () => {
    const lease = await tenancy('Dead Letter Tenant');
    const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
      p.links.mint(tx, await p.links.invoice(tx, lease.invoiceId)),
    );
    const intent = await p.page.start(url.split('/p/')[1]!, CLIENT, {
      amountMinor: 150_000,
      method: 'momo',
      momo: { phone: '024 000 0003', network: 'mtn' },
      submissionId: randomUUID(),
    });
    const webhook = await p.primary.completeCharge(chargeReference(intent.intentId), {
      status: 'success',
    });
    expect(
      await p.webhooks.intake('paystack', Buffer.from(webhook!.rawBody), webhook!.headers),
    ).toBe('stored');
    // Its job gave up (the provider was down for every retry): the dead letter records why.
    const [inboxId] = await claimInbox(ctx);
    await p.webhooks.failed(inboxId!, 'ProviderError: provider unavailable (HTTP 503)');
    const paymentsOf = () =>
      withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.select().from(schema.payment).where(eq(schema.payment.leaseId, lease.leaseId)),
      );
    expect(await paymentsOf()).toHaveLength(0);

    const listed = await ops.list(admin, { status: 'dead_lettered' });
    expect(listed.find((w) => w.id === inboxId)).toMatchObject({
      provider: 'paystack',
      eventType: 'charge.success',
      status: 'dead_lettered',
      lastError: 'ProviderError: provider unavailable (HTTP 503)',
      replayCount: 0,
      lastReplayedAt: null,
      lastReplayedByName: null,
    });
    expect((await ops.list(admin, { status: 'failed' })).map((w) => w.id)).not.toContain(inboxId);

    const first = await ops.replay(admin, inboxId!, `  ${REASON}  `);
    expect(first).toMatchObject({
      id: inboxId,
      status: 'pending',
      replayCount: 1,
      lastReplayedByName: 'Platform admin',
    });
    expect(await runReplays()).toEqual(['posted']);
    expect(await paymentsOf()).toHaveLength(1);
    // Replayed again: the payment is final, nothing more is posted.
    const second = await ops.replay(admin, inboxId!, 'Checking the replay is idempotent');
    expect(second).toMatchObject({ status: 'pending', replayCount: 2 });
    expect(await runReplays()).toEqual(['already_posted']);
    expect(await paymentsOf()).toHaveLength(1);
    expect((await ops.list(admin)).map((w) => w.id)).not.toContain(inboxId);

    // NFR-AUDIT: each replay is an ops_action with its reason, and an event in the platform chain.
    const audit = await withCompany(ctx.database, sys(admin.companyId), async (tx) => ({
      actions: await tx
        .select()
        .from(schema.opsAction)
        .where(eq(schema.opsAction.targetId, inboxId!))
        .orderBy(schema.opsAction.createdAt),
      events: (
        await tx.execute<{
          action: string;
          actor_person_id: string;
          data: Record<string, unknown>;
        }>(
          sql`select action, actor_person_id, data from audit_event
              where action = 'ops.webhook_replayed' and record_id = ${inboxId!} order by seq`,
        )
      ).rows,
    }));
    expect(audit.actions.map((a) => [a.kind, a.reason, a.personId, a.outcome])).toEqual([
      ['webhook_replay', REASON, admin.personId, 'queued'],
      ['webhook_replay', 'Checking the replay is idempotent', admin.personId, 'queued'],
    ]);
    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]).toMatchObject({
      actor_person_id: admin.personId,
      data: {
        provider: 'paystack',
        previousStatus: 'dead_lettered',
        replayCount: 1,
        via: 'console',
        reason: REASON,
      },
    });
    expect((await ctx.audit.verifyChain(admin.companyId)).ok).toBe(true);
  });
});

describe('NFR-SEC replay is for platform admins, with a reason, of what can be replayed (M11 decision 9)', () => {
  it('refuses staff, a short reason, a rejected webhook and an unknown id', async () => {
    const forged = await p.webhooks.intake('paystack', Buffer.from('{"event":"charge.success"}'), {
      'x-paystack-signature': 'ab'.repeat(64),
    });
    expect(forged).toBe('rejected');
    const [rejected] = await withSystem(ctx.database, {}, (tx) =>
      tx
        .select({ id: schema.webhookInbox.id })
        .from(schema.webhookInbox)
        .where(eq(schema.webhookInbox.status, 'rejected')),
    );
    await expect(ops.list(agency.admin)).rejects.toMatchObject({ status: 403 });
    await expect(ops.replay(agency.admin, rejected!.id, REASON)).rejects.toMatchObject({
      status: 403,
    });
    await expect(ops.replay(null, rejected!.id, REASON)).rejects.toMatchObject({ status: 403 });
    await expect(ops.replay(admin, rejected!.id, 'oops')).rejects.toMatchObject({
      status: 400,
      code: 'bad_reason',
    });
    await expect(ops.replay(admin, rejected!.id, 'x'.repeat(501))).rejects.toMatchObject({
      code: 'bad_reason',
    });
    await expect(ops.replay(admin, rejected!.id, REASON)).rejects.toMatchObject({
      status: 409,
      code: 'webhook_not_replayable',
    });
    await expect(ops.replay(admin, randomUUID(), REASON)).rejects.toMatchObject({ status: 404 });
    await expect(ops.replay(admin, 'not-an-id', REASON)).rejects.toMatchObject({ status: 404 });
    // Nothing was recorded for any of them.
    const recorded = await withCompany(ctx.database, sys(admin.companyId), (tx) =>
      tx.select().from(schema.opsAction).where(eq(schema.opsAction.targetId, rejected!.id)),
    );
    expect(recorded).toEqual([]);
  });
});
