import { eq, schema, sql, withCompany, withSystem } from '@rent/db';
import {
  CallbackAlert,
  InMemoryPayments,
  type Alert,
  type PaymentWebhookRequest,
} from '@rent/integrations';
import { createLogger } from '../../src/core/logging/logger';
import { PaymentProviders } from '../../src/core/payment-providers';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import { PayLinksService } from '../../src/payments/pay-links.service';
import { PayPageService } from '../../src/payments/pay-page.service';
import { registerPayments } from '../../src/payments/payments.module';
import { ProviderPaymentsService } from '../../src/payments/provider-payments.service';
import { QueueService, REFUND_JOB } from '../../src/payments/queue.service';
import { ReceiptsService } from '../../src/payments/receipts.service';
import { ReconciliationService } from '../../src/payments/reconciliation.service';
import { RemindersService } from '../../src/payments/reminders.service';
import {
  SETTLEMENT_READY_JOB,
  SettlementAccountsService,
} from '../../src/payments/settlement-accounts.service';
import { TenantMoneyService } from '../../src/payments/tenant-money.service';
import { WebhooksService } from '../../src/payments/webhooks.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

export const CLIENT = { ip: '203.0.113.9', userAgent: 'test-browser' };

/**
 * The M4b services wired as Nest wires them, on the test database, with two in-memory providers:
 * `paystack` first, and `second` for failover (BC-02; decision 1).
 */
export function paymentsServices(ctx: ServerTestContext, s: TenancyServices, b: BillingServices) {
  const primary = new InMemoryPayments('sk_test_primary', 'paystack');
  const second = new InMemoryPayments('sk_test_second', 'second');
  const providers = new PaymentProviders(
    [
      { name: 'paystack', port: primary, settlesDirect: true },
      { name: 'second', port: second, settlesDirect: true },
    ],
    ['paystack', 'second'],
  );
  const alerts: Alert[] = [];
  const alertPort = new CallbackAlert((alert) => {
    alerts.push(alert);
  });
  const logger = createLogger({ level: 'silent' });
  const accounts = new SettlementAccountsService(
    ctx.database,
    s.policy,
    s.approvals,
    s.cipher,
    providers,
    ctx.clock,
    ctx.audit,
  );
  const providerPayments = new ProviderPaymentsService(
    ctx.database,
    providers,
    b.engine,
    s.cipher,
    alertPort,
    ctx.clock,
    logger,
    s.policy,
  );
  const links = new PayLinksService(
    ctx.database,
    ctx.config,
    ctx.clock,
    s.policy,
    b.engine,
    s.tenants,
  );
  const page = new PayPageService(
    ctx.database,
    ctx.config,
    ctx.clock,
    providers,
    s.cipher,
    alertPort,
    b.engine,
    s.documents,
    links,
    providerPayments,
    s.policy,
  );
  const webhooks = new WebhooksService(ctx.database, providers, alertPort, providerPayments);
  const queue = new QueueService(
    ctx.database,
    s.policy,
    s.approvals,
    s.documents,
    b.engine,
    b.posting,
    providers,
    s.cipher,
    alertPort,
    ctx.clock,
  );
  const receipts = new ReceiptsService(
    ctx.database,
    ctx.config,
    ctx.clock,
    alertPort,
    s.messaging,
    s.documents,
    b.engine,
    links,
    providerPayments,
    s.policy,
  );
  const reminders = new RemindersService(ctx.database, b.engine, logger);
  const reconciliation = new ReconciliationService(
    ctx.database,
    providers,
    b.posting,
    providerPayments,
    alertPort,
    logger,
  );
  const tenantMoney = new TenantMoneyService(
    ctx.database,
    s.policy,
    ctx.clock,
    b.engine,
    links,
    receipts,
  );
  registerPayments(accounts, queue, s.messaging, links, receipts);
  return {
    primary,
    second,
    providers,
    alerts,
    accounts,
    providerPayments,
    links,
    page,
    webhooks,
    queue,
    receipts,
    reminders,
    reconciliation,
    tenantMoney,
  };
}

export type PaymentsServices = ReturnType<typeof paymentsServices>;

type Staff = Parameters<SettlementAccountsService['request']>[0];

/**
 * An approved settlement account that is usable now (ADR-008): requested by one person,
 * approved by another 25 hours ago on the test clock, then set up with the providers and
 * activated by the ready job.
 */
export async function activeAccount(
  ctx: ServerTestContext,
  s: TenancyServices,
  p: PaymentsServices,
  requester: Staff,
  approver: Staff,
  input: { holder: 'owner' | 'agency'; ownerId?: string | null; accountNumber?: string },
): Promise<string> {
  const back = 25 * 3_600_000;
  ctx.clock.advance(-back);
  let accountId: string;
  try {
    const requested = await p.accounts.request(requester, {
      holder: input.holder,
      ownerId: input.ownerId ?? null,
      bankCode: 'FAKEBANK1',
      accountNumber: input.accountNumber ?? `01${Math.floor(Math.random() * 1e9)}`.padEnd(11, '7'),
      accountName: 'Test Account Holder',
    });
    accountId = requested.accountId;
    await s.approvals.decide(approver, requested.approvalId, { decision: 'approve' });
  } finally {
    ctx.clock.advance(back);
  }
  const companyId = (requester as { companyId: string }).companyId;
  await p.accounts.ready(companyId, accountId);
  return accountId;
}

/** Runs the outbox's queued messages, as the worker's send job would. */
export async function sendQueued(ctx: ServerTestContext, s: TenancyServices, companyId: string) {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(
        sql`${schema.outboxEvent.type} = ${MESSAGE_SEND_JOB} and ${schema.outboxEvent.publishedAt} is null`,
      )
      .orderBy(schema.outboxEvent.createdAt),
  );
  for (const e of events)
    await s.messaging.deliver(companyId, messageRequestSchema.parse(e.payload));
  return events.length;
}

/** Receipts for payments posted (`payment.posted`), issued as the worker would. */
export async function issueReceipts(
  ctx: ServerTestContext,
  p: PaymentsServices,
  companyId: string,
) {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(eq(schema.outboxEvent.type, 'payment.posted'))
      .orderBy(schema.outboxEvent.createdAt),
  );
  const out: string[] = [];
  for (const e of events)
    out.push(await p.receipts.issue(companyId, (e.payload as { receiptId: string }).receiptId));
  return out;
}

/** Approved provider refunds of unmatched money, made as the worker's refund job would. */
export async function runRefunds(ctx: ServerTestContext, p: PaymentsServices, companyId: string) {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(eq(schema.outboxEvent.type, REFUND_JOB)),
  );
  for (const e of events)
    await p.queue.refundWithProvider(companyId, (e.payload as { refundId: string }).refundId);
}

/** A webhook delivered to the API's intake, then processed as the inbox relay and job would. */
export async function deliverWebhook(
  ctx: ServerTestContext,
  p: PaymentsServices,
  provider: string,
  webhook: PaymentWebhookRequest,
): Promise<{ intake: string; outcome: string | null }> {
  const intake = await p.webhooks.intake(provider, Buffer.from(webhook.rawBody), webhook.headers);
  let outcome: string | null = null;
  for (const id of await claimInbox(ctx)) outcome = await p.webhooks.process(id);
  return { intake, outcome };
}

/** Claims the stored webhooks not yet published, as the relay does (ids only). */
export async function claimInbox(ctx: ServerTestContext): Promise<string[]> {
  const claimed = await withSystem(ctx.database, {}, (tx) =>
    tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(100)`),
  );
  return claimed.rows.map((r) => r.id);
}

export { SETTLEMENT_READY_JOB };
