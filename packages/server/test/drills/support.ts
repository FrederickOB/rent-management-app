import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { eq, schema, sql, withCompany, withSystem } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import {
  CallbackAlert,
  FakeProvidersPayments,
  type Alert,
  type WebhookHeaders,
} from '@rent/integrations';
import { isoNow } from '../../src/billing/records';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import { createLogger } from '../../src/core/logging/logger';
import { PaymentProviders } from '../../src/core/payment-providers';
import { PayLinksService } from '../../src/payments/pay-links.service';
import { PayPageService } from '../../src/payments/pay-page.service';
import { registerPayments } from '../../src/payments/payments.module';
import { ProviderPaymentsService } from '../../src/payments/provider-payments.service';
import { QueueService } from '../../src/payments/queue.service';
import { ReceiptsService } from '../../src/payments/receipts.service';
import { ReconciliationService } from '../../src/payments/reconciliation.service';
import { RemindersService } from '../../src/payments/reminders.service';
import { SettlementAccountsService } from '../../src/payments/settlement-accounts.service';
import { WebhooksService, type IntakeResult } from '../../src/payments/webhooks.service';
import type { ServerTestContext } from '../support';
import { billedLease, moneyCompany, type BillingServices } from '../support/billing';
import { propertyWithUnits, staffIn, type TenancyServices } from '../support/tenancy';

/**
 * The NFR-AVAIL drills' harness (M11 plan 4.7; decision 9). Unlike the M4b payment tests, which use
 * an in-memory provider and hand each webhook to the intake themselves, the drills run a private
 * apps/fake-providers process, talk to it through the HTTP adapter, and let it deliver its own
 * webhooks over HTTP to an endpoint that hands them to the intake, as the API's webhook route
 * does. Its outage switch (`/payments/_test/outage`) then makes the provider go down, answer
 * slowly or not at all, or withhold or drop its webhooks.
 */
const FAKE_DIR = path.resolve(import.meta.dirname, '../../../../apps/fake-providers');
export const DRILL_SECRET_KEY = 'sk_test_drills_fake_provider';
export const CLIENT = { ip: '203.0.113.50', userAgent: 'drill-browser' };
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

/** Receives the fake's webhooks over HTTP and answers with the intake's verdict, as the API does. */
export interface WebhookEndpoint {
  readonly url: string;
  /** Every delivery: the event, the intake's answer, and the request as it came. */
  readonly received: {
    readonly event: string;
    readonly result: IntakeResult | 'no_handler';
    readonly body: Buffer;
    readonly headers: Record<string, string>;
  }[];
  handler: ((body: Buffer, headers: WebhookHeaders) => Promise<IntakeResult>) | null;
  /** Delivers a request again, as a provider retrying it would; answers the HTTP status. */
  redeliver(delivery: {
    readonly body: Buffer;
    readonly headers: Record<string, string>;
  }): Promise<number>;
  close(): Promise<void>;
}

export async function startWebhookEndpoint(): Promise<WebhookEndpoint> {
  const endpoint: WebhookEndpoint = {
    url: '',
    received: [],
    handler: null,
    redeliver: async () => 0,
    close: async () => undefined,
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      let event = 'unknown';
      try {
        event = (JSON.parse(body.toString('utf8')) as { event?: string }).event ?? 'unknown';
      } catch {
        // Not JSON: the intake decides.
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (
          typeof value === 'string' &&
          (name === 'x-paystack-signature' || name === 'content-type')
        )
          headers[name] = value;
      const handle = endpoint.handler;
      if (!handle) {
        endpoint.received.push({ event, result: 'no_handler', body, headers });
        response.writeHead(503).end();
        return;
      }
      handle(body, request.headers)
        .then((result) => {
          endpoint.received.push({ event, result, body, headers });
          const refused: Partial<Record<IntakeResult, number>> = {
            unknown_provider: 404,
            rejected: 401,
            too_large: 413,
            rate_limited: 429,
          };
          response.writeHead(refused[result] ?? 200).end();
        })
        .catch(() => response.writeHead(500).end());
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/paystack`;
  return Object.assign(endpoint, {
    url,
    redeliver: async (delivery: { body: Buffer; headers: Record<string, string> }) =>
      (
        await fetch(url, {
          method: 'POST',
          headers: delivery.headers,
          body: new Uint8Array(delivery.body),
        })
      ).status,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

export interface FakeProvider {
  readonly url: string;
  readonly port: FakeProvidersPayments;
  /** The outage switch: `normal` releases withheld webhooks and says how many went. */
  outage(
    mode: 'normal' | 'down' | 'slow' | 'timeout' | 'withhold' | 'drop',
    delayMs?: number,
  ): Promise<{ mode: string; withheld: number; dropped: number; released: number }>;
  state(): Promise<{ mode: string; withheld: number; dropped: number }>;
  close(): Promise<void>;
}

/** A private fake-providers process on a free port, sending payment webhooks to `webhookUrl`. */
export async function startFakeProvider(webhookUrl: string): Promise<FakeProvider> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: FAKE_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      FAKE_PAYMENTS_SECRET_KEY: DRILL_SECRET_KEY,
      FAKE_PAYMENTS_WEBHOOK_URL: webhookUrl,
      // Nothing else leaves this fake (an empty value turns a webhook off).
      FAKE_WHATSAPP_WEBHOOK_URL: '',
      FAKE_IDENTITY_WEBHOOK_URL: '',
      FAKE_SMS_INBOUND_URL: '',
      FAKE_SMS_STATUS_URL: '',
      FAKE_EMAIL_INBOUND_URL: '',
      FAKE_EMAIL_EVENTS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fake-providers did not start within 30 s:\n${output}`)),
      30_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake-providers exited with code ${code}:\n${output}`));
    });
  });
  const control = async (method: 'GET' | 'POST', body?: unknown) => {
    const response = await fetch(`${url}/payments/_test/outage`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`outage switch answered ${response.status}`);
    return (await response.json()) as {
      mode: string;
      withheld: number;
      dropped: number;
      released: number;
    };
  };
  return {
    url,
    port: new FakeProvidersPayments(url, DRILL_SECRET_KEY),
    outage: (mode, delayMs) =>
      control('POST', { mode, ...(delayMs === undefined ? {} : { delayMs }) }),
    state: () => control('GET'),
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(kill);
    },
  };
}

/**
 * The payments services wired as Nest wires them (as test/support/payments.ts does), with the
 * fake provider over HTTP as the deployment's only provider, under Paystack's name.
 */
export function drillPayments(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  port: FakeProvidersPayments,
) {
  const providers = new PaymentProviders([{ name: 'paystack', port, settlesDirect: true }]);
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
    s.rules,
  );
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
  const webhooks = new WebhooksService(
    ctx.database,
    providers,
    alertPort,
    providerPayments,
    queue,
    ctx.config,
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
  registerPayments(accounts, queue, s.messaging, links, receipts);
  return {
    port,
    providers,
    alerts,
    alertPort,
    logger,
    accounts,
    providerPayments,
    links,
    page,
    webhooks,
    queue,
    receipts,
    reminders,
    reconciliation,
  };
}

export type DrillPayments = ReturnType<typeof drillPayments>;
type Staff = Parameters<SettlementAccountsService['request']>[0];

/**
 * A company ready to take rent through the fake: an agency, a second admin to approve, an owner
 * whose approved settlement account (25 hours old on the test clock, set up with the provider) and
 * management agreement are in force, and a property with `units` units (ADR-008; as
 * test/support/payments.ts's activeAccount and agreementInForce).
 */
export async function drillCompany(
  ctx: ServerTestContext,
  s: TenancyServices,
  p: DrillPayments,
  options: { name: string; units: number; manualInstructions?: string },
) {
  const agency = await moneyCompany(ctx, s, 'agency', options.name);
  const second: Staff = await staffIn(
    ctx,
    agency.companyId,
    'agency',
    'agency_admin',
    'Drill Second Admin',
  );
  const ownerId = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: `${options.name} Owner`,
    })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'DRL',
    ownerId,
    units: [{ unitType: 'apartment', count: options.units, bedrooms: 2 }],
  });
  const back = 25 * 3_600_000;
  ctx.clock.advance(-back);
  let accountId: string;
  try {
    const requested = await p.accounts.request(agency.admin, {
      holder: 'owner',
      ownerId,
      bankCode: 'FAKEBANK1',
      accountNumber: `01${Math.floor(Math.random() * 1e9)}`.padEnd(11, '7'),
      accountName: 'Drill Account Holder',
    });
    accountId = requested.accountId;
    await s.approvals.decide(second, requested.approvalId, { decision: 'approve' });
  } finally {
    ctx.clock.advance(back);
  }
  await p.accounts.ready(agency.companyId, accountId);
  const agreementBack = 49 * 3_600_000;
  ctx.clock.advance(-agreementBack);
  try {
    const view = await p.accounts.setAgreement(agency.admin, ownerId, {
      destination: 'owner_account',
      effectiveFrom: isoNow(ctx.clock, 'Africa/Accra'),
    });
    await s.approvals.decide(second, view.openRequest!.approvalId, { decision: 'approve' });
  } finally {
    ctx.clock.advance(agreementBack);
  }
  if (options.manualInstructions)
    await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .update(schema.company)
        .set({
          settings: sql`settings || ${JSON.stringify({ manualPaymentInstructions: options.manualInstructions })}::jsonb`,
        })
        .where(eq(schema.company.id, agency.companyId)),
    );
  return { ...agency, second, ownerId, units: Object.values(property.units) };
}

export type DrillCompany = Awaited<ReturnType<typeof drillCompany>>;

/**
 * `count` monthly leases from today, each with a tenant (a phone and SMS consent when asked) and
 * its first invoice issued and due today. Created a few at a time.
 */
export async function drillLeases(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  company: DrillCompany,
  count: number,
  options: { rentMinor?: number; consent?: boolean; concurrency?: number } = {},
): Promise<{ leaseId: string; invoiceId: string; tenantId: string }[]> {
  const today = isoNow(ctx.clock, 'Africa/Accra');
  const units = company.units.splice(0, count);
  if (units.length < count) throw new Error(`only ${units.length} units left for ${count} leases`);
  const out: { leaseId: string; invoiceId: string; tenantId: string }[] = new Array(count);
  let next = 0;
  const work = async () => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      const phone = `+2332${String(41_000_000 + Math.floor(Math.random() * 8_000_000)).padStart(8, '0')}`;
      const { tenant } = await s.tenants.create(company.manager, {
        kind: 'individual',
        displayName: `Drill Tenant ${i + 1}`,
        ...(options.consent ? { phone } : {}),
      });
      if (options.consent)
        await s.tenants.recordConsent(company.manager, tenant.id, {
          channel: 'sms',
          action: 'grant',
        });
      const lease = await billedLease(ctx, s, b, company.manager, {
        unitId: units[i]!,
        tenantId: tenant.id,
        startDate: today,
        endDate: plusDays(plusMonths(today, 12), -1),
        monthlyRentMinor: options.rentMinor ?? 150_000,
        cycle: 'monthly',
        depositMinor: null,
        signedOn: plusDays(today, -1),
        billingStartDate: today,
      });
      const [invoice] = await withCompany(ctx.database, sys(company.companyId), (tx) =>
        tx
          .select({ id: schema.invoice.id })
          .from(schema.invoice)
          .where(eq(schema.invoice.leaseId, lease.id)),
      );
      out[i] = { leaseId: lease.id, invoiceId: invoice!.id, tenantId: tenant.id };
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, count) }, work));
  return out;
}

/** A pay link for an invoice, as a reminder or the tenant app makes it; returns its token. */
export async function payToken(
  ctx: ServerTestContext,
  p: DrillPayments,
  companyId: string,
  invoiceId: string,
) {
  const { url } = await withCompany(ctx.database, sys(companyId), async (tx) =>
    p.links.mint(tx, await p.links.invoice(tx, invoiceId)),
  );
  return url.split('/p/')[1]!;
}

/** The tenant starts a MoMo payment on the pay page, from a phone of their own. */
export async function startMomo(p: DrillPayments, token: string, amountMinor: number) {
  const client = { ...CLIENT, ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
  const intent = await p.page.start(token, client, {
    amountMinor,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId: randomUUID(),
  });
  return { intent, reference: chargeReference(intent.intentId) };
}

/** Processes every stored webhook not yet queued, as the inbox relay and the job would. */
export async function processInbox(ctx: ServerTestContext, p: DrillPayments): Promise<string[]> {
  const claimed = await withSystem(ctx.database, {}, (tx) =>
    tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(500)`),
  );
  const outcomes: string[] = [];
  for (const { id } of claimed.rows) outcomes.push(await p.webhooks.process(id));
  return outcomes;
}

/** Receipts for every payment posted (`payment.posted` events), issued as the worker would. */
export async function issueReceipts(ctx: ServerTestContext, p: DrillPayments, companyId: string) {
  const events = await withCompany(ctx.database, sys(companyId), (tx) =>
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

/** Sends every queued message, as the worker's `messaging.send` job would. */
export async function sendQueued(ctx: ServerTestContext, s: TenancyServices, companyId: string) {
  const events = await withCompany(ctx.database, sys(companyId), (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(eq(schema.outboxEvent.type, MESSAGE_SEND_JOB))
      .orderBy(schema.outboxEvent.createdAt),
  );
  for (const e of events)
    await s.messaging.deliver(companyId, messageRequestSchema.parse(e.payload));
  return events.length;
}

/** What the money looks like now: one row per payment, receipt and intent state. */
export async function moneyState(ctx: ServerTestContext, companyId: string) {
  return withCompany(ctx.database, sys(companyId), async (tx) => {
    const payments = await tx
      .select({
        id: schema.payment.id,
        reference: schema.payment.providerReference,
        amount: schema.payment.amountMinor,
      })
      .from(schema.payment);
    const receipts = await tx
      .select({ number: schema.receipt.number, paymentId: schema.receipt.paymentId })
      .from(schema.receipt)
      .orderBy(schema.receipt.number);
    const intents = await tx
      .select({
        id: schema.paymentIntent.id,
        status: schema.paymentIntent.status,
        failureReason: schema.paymentIntent.failureReason,
      })
      .from(schema.paymentIntent);
    const journal = await tx.execute<{ entries: number; lines: number; debits: number }>(
      sql`select count(distinct entry_id)::int as entries, count(*)::int as lines,
            coalesce(sum(greatest(amount_minor, 0)), 0)::bigint as debits from journal_line`,
    );
    const allocations = await tx.execute<{ n: number; total: number }>(
      sql`select count(*)::int as n, coalesce(sum(amount_minor), 0)::bigint as total from allocation`,
    );
    return {
      payments,
      receipts,
      intents,
      journal: {
        entries: Number(journal.rows[0]!.entries),
        lines: Number(journal.rows[0]!.lines),
        debits: Number(journal.rows[0]!.debits),
      },
      allocations: { n: Number(allocations.rows[0]!.n), total: Number(allocations.rows[0]!.total) },
    };
  });
}

/**
 * Five minutes and a second past the latest of the test clock and the wall clock, so verify-pending
 * takes every intent made before: intents are stamped by the database's own clock, which runs on
 * while the test clock stands still.
 */
export const pastVerifyWindow = (ctx: ServerTestContext) =>
  ctx.clock.set(new Date(Math.max(ctx.clock.now().getTime(), Date.now()) + 5 * 60_000 + 1_000));
