import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import { ProviderError } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isoNow } from '../src/billing/records';
import { cliIdentity } from '../src/ops/operator';
import { ReconciliationRunService } from '../src/ops/reconcile.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { platform } from './support/messaging';
import {
  activeAccount,
  agreementInForce,
  CLIENT,
  deliverWebhook,
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
 * M11 coordinator follow-ups on reconciliation: the alerts about money that belongs to no company
 * name the provider's reference and subaccount, so a person can find it at the provider (ids and
 * codes, not personal data); and `pnpm ops:reconcile` runs a day's reconciliation again, through
 * the jobs' own services, audited in the platform's chain, changing nothing the first run did.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let admin: Awaited<ReturnType<typeof platform>>;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let units: string[];
let today: string;
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
  admin = await platform(ctx);
  agency = await moneyCompany(ctx, s, 'agency', 'Reconcile Agency');
  const second = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second Admin');
  const ownerId = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Reconcile Owner' })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'RCN',
    ownerId,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  units = Object.values(property.units);
  await activeAccount(ctx, s, p, agency.admin, second, { holder: 'owner', ownerId });
  await agreementInForce(ctx, s, p, agency.admin, second, ownerId, 'owner_account');
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

/** A tenant's first invoice, due today. */
async function invoiceForNewLease(name: string): Promise<{ leaseId: string; invoiceId: string }> {
  const { tenant } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: name,
  });
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
  return { leaseId: lease.id, invoiceId: invoice!.id };
}

/** A MoMo charge on the pay page, paid at the provider; its reference and the provider's webhook. */
async function paidCharge(invoiceId: string) {
  const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
    p.links.mint(tx, await p.links.invoice(tx, invoiceId)),
  );
  const intent = await p.page.start(url.split('/p/')[1]!, CLIENT, {
    amountMinor: 150_000,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId: randomUUID(),
  });
  const reference = chargeReference(intent.intentId);
  const webhook = await p.primary.completeCharge(reference, { status: 'success' });
  return { reference, webhook: webhook! };
}

describe('BC-02 alerts about unowned provider money name its reference and subaccount (M11)', () => {
  it('payments.unknown_subaccount, payments.reconciliation_unowned and payments.settlement_unowned carry them', async () => {
    // A subaccount at the provider that is no settlement account of ours.
    const { subaccountCode } = await p.primary.createSubaccount({
      businessName: 'Not Ours Ltd',
      settlementBank: 'FAKEBANK1',
      accountNumber: '0123456789',
    });
    const external = await p.primary.payExternal({
      subaccountCode,
      amountMinor: 55_000,
      channel: 'momo',
    });
    const before = p.alerts.length;
    expect((await deliverWebhook(ctx, p, 'paystack', external.webhook)).outcome).toBe(
      'unknown_subaccount',
    );
    const raised = () => p.alerts.slice(before);
    expect(raised().find((a) => a.code === 'payments.unknown_subaccount')?.context).toMatchObject({
      provider: 'paystack',
      reference: external.reference,
      subaccountCode,
    });

    await p.reconciliation.transactions('paystack', today);
    expect(
      raised().find((a) => a.code === 'payments.reconciliation_unowned')?.context,
    ).toMatchObject({
      provider: 'paystack',
      kind: 'missing_here',
      reference: external.reference,
      subaccountCode,
    });

    const settlements = await p.primary.settle();
    const unowned = settlements.find((x) => x.subaccountCode === subaccountCode)!;
    await p.reconciliation.settlements('paystack', today);
    expect(raised().find((a) => a.code === 'payments.settlement_unowned')?.context).toMatchObject({
      provider: 'paystack',
      settlementId: unowned.settlementId,
      subaccountCode,
    });
    // Ids and codes only: nothing about the payer.
    for (const alert of raised().filter((a) => /unowned|unknown_subaccount/.test(a.code)))
      expect(JSON.stringify(alert.context)).not.toMatch(/@|\+233/);
  });
});

/** Everything a reconciliation run can change in the company. */
async function snapshot() {
  return withCompany(ctx.database, sys(agency.companyId), async (tx) => {
    const count = async (table: string) =>
      Number(
        (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))
          .rows[0]!.n,
      );
    const journal = await tx.execute<{ account: string; total: string; lines: number }>(
      sql`select account_code as account, sum(amount_minor)::text as total, count(*)::int as lines
          from journal_line group by account_code order by account_code`,
    );
    return {
      payments: await count('payment'),
      receipts: await count('receipt'),
      settlements: await count('provider_settlement'),
      exceptions: await count('reconciliation_exception'),
      reversals: await count('payment_reversal'),
      outbox: await count('outbox_event'),
      journal: journal.rows,
    };
  });
}

describe('BC-02 ops:reconcile runs a day again through the jobs’ services, idempotently (M11)', () => {
  it('posts a payment whose webhook never came and the day’s settlement once; a second run changes nothing', async () => {
    const run = new ReconciliationRunService(
      ctx.database,
      p.providers,
      p.reconciliation,
      ctx.audit,
      ctx.clock,
    );
    const operator = { personId: admin.personId, via: 'cli' as const };
    const missed = await invoiceForNewLease('Missed Webhook Tenant');
    await paidCharge(missed.invoiceId);
    // Another payment whose webhook came: posted already, and settled by the provider today.
    const settled = await invoiceForNewLease('Settled Tenant');
    const delivered = await paidCharge(settled.invoiceId);
    expect((await deliverWebhook(ctx, p, 'paystack', delivered.webhook)).outcome).toBe('posted');
    const paymentsOf = (leaseId: string) =>
      withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.select().from(schema.payment).where(eq(schema.payment.leaseId, leaseId)),
      );
    expect(await paymentsOf(missed.leaseId)).toHaveLength(0);
    await p.primary.settle();
    const before = await snapshot();

    const first = await run.runAs(operator, { day: today }, 'Webhooks were lost 09:00 to 09:40');
    expect(first.providers.map((r) => r.provider)).toEqual(['paystack', 'second']);
    const paystack = first.providers.find((r) => r.provider === 'paystack')!;
    // The missed payment (the unowned one of the test before is not ours, so not counted).
    expect(paystack.transactions.processed).toBe(1);
    expect(paystack.settlementsPosted).toBeGreaterThanOrEqual(1);
    expect(await paymentsOf(missed.leaseId)).toHaveLength(1);
    const afterFirst = await snapshot();
    expect(afterFirst.payments).toBeGreaterThan(before.payments);
    expect(afterFirst.settlements).toBeGreaterThan(before.settlements);

    const second = await run.runAs(
      operator,
      { day: today, provider: 'paystack' },
      'Checking the run is idempotent',
    );
    expect(second.providers).toHaveLength(1);
    expect(second.providers[0]!.settlementsPosted).toBe(0);
    expect(await snapshot()).toEqual(afterFirst);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);

    // NFR-AUDIT: each run is started and finished in the platform's chain, with its reason.
    const events = await withCompany(
      ctx.database,
      sys(admin.companyId),
      async (tx) =>
        (
          await tx.execute<{
            action: string;
            record_id: string;
            actor_person_id: string;
            data: Record<string, unknown>;
          }>(
            sql`select action, record_id, actor_person_id, data from audit_event
              where record_type = 'reconciliation_run' order by seq`,
          )
        ).rows,
    );
    expect(events.map((e) => [e.action, e.record_id])).toEqual([
      ['ops.reconciliation_started', first.runId],
      ['ops.reconciliation_finished', first.runId],
      ['ops.reconciliation_started', second.runId],
      ['ops.reconciliation_finished', second.runId],
    ]);
    expect(events[0]).toMatchObject({
      actor_person_id: admin.personId,
      data: {
        day: today,
        providers: ['paystack', 'second'],
        via: 'cli',
        reason: 'Webhooks were lost 09:00 to 09:40',
      },
    });
    expect(events[3]!.data).toMatchObject({
      day: today,
      providers: [{ provider: 'paystack', settlementsPosted: 0 }],
    });
    // Each run is two ops_action rows (append-only): started, then finished, with its reason.
    const actions = await withCompany(ctx.database, sys(admin.companyId), (tx) =>
      tx
        .select()
        .from(schema.opsAction)
        .where(eq(schema.opsAction.kind, 'reconcile_run'))
        .orderBy(schema.opsAction.createdAt, schema.opsAction.id),
    );
    expect(actions.map((a) => [a.targetId, a.targetName, a.outcome, a.reason, a.personId])).toEqual(
      [
        [first.runId, today, 'started', 'Webhooks were lost 09:00 to 09:40', admin.personId],
        [first.runId, today, 'finished', 'Webhooks were lost 09:00 to 09:40', admin.personId],
        [second.runId, today, 'started', 'Checking the run is idempotent', admin.personId],
        [second.runId, today, 'finished', 'Checking the run is idempotent', admin.personId],
      ],
    );
    expect((await ctx.audit.verifyChain(admin.companyId)).ok).toBe(true);
  });

  it('refuses a short reason, a day not yet come or not a date, and an unknown provider, before anything runs', async () => {
    const run = new ReconciliationRunService(
      ctx.database,
      p.providers,
      p.reconciliation,
      ctx.audit,
      ctx.clock,
    );
    const operator = { personId: admin.personId, via: 'cli' as const };
    const reason = 'Reconciling again after an outage';
    await expect(run.runAs(operator, { day: today }, 'no')).rejects.toMatchObject({
      code: 'bad_reason',
    });
    await expect(run.runAs(operator, { day: plusDays(today, 1) }, reason)).rejects.toMatchObject({
      code: 'bad_day',
    });
    await expect(run.runAs(operator, { day: '2026-02-30' }, reason)).rejects.toMatchObject({
      code: 'bad_day',
    });
    await expect(
      run.runAs(operator, { day: today, provider: 'nope' }, reason),
    ).rejects.toMatchObject({
      code: 'bad_provider',
    });
  });

  it('records a run that fails: started, then failed with the error’s code, and the error goes on', async () => {
    const run = new ReconciliationRunService(
      ctx.database,
      p.providers,
      p.reconciliation,
      ctx.audit,
      ctx.clock,
    );
    const operator = { personId: admin.personId, via: 'cli' as const };
    const down = vi
      .spyOn(p.second, 'listTransactions')
      .mockRejectedValueOnce(new ProviderError('second', 'HTTP 503', true, 503));
    try {
      await expect(
        run.runAs(operator, { day: today, provider: 'second' }, 'Second provider back up'),
      ).rejects.toBeInstanceOf(ProviderError);
    } finally {
      down.mockRestore();
    }
    const rows = await withCompany(ctx.database, sys(admin.companyId), async (tx) => ({
      actions: await tx
        .select()
        .from(schema.opsAction)
        .where(eq(schema.opsAction.reason, 'Second provider back up'))
        .orderBy(schema.opsAction.createdAt, schema.opsAction.id),
      events: (
        await tx.execute<{ action: string; data: Record<string, unknown> }>(
          sql`select action, data from audit_event
              where record_type = 'reconciliation_run' and action = 'ops.reconciliation_failed'`,
        )
      ).rows,
    }));
    expect(rows.actions.map((a) => [a.kind, a.targetName, a.outcome])).toEqual([
      ['reconcile_run', today, 'started'],
      ['reconcile_run', today, 'failed'],
    ]);
    expect(rows.actions[0]!.targetId).toBe(rows.actions[1]!.targetId);
    expect(rows.events).toEqual([
      {
        action: 'ops.reconciliation_failed',
        data: { day: today, provider: 'second', error: 'ProviderError: second: HTTP 503' },
      },
    ]);
  });
});

describe('NFR-AUDIT a reconciliation run from the incident command records its OS user and host (M11 review B4)', () => {
  it('puts them in each of the run’s audit events', async () => {
    const run = new ReconciliationRunService(
      ctx.database,
      p.providers,
      p.reconciliation,
      ctx.audit,
      ctx.clock,
    );
    const cli = cliIdentity();
    const result = await run.runAs(
      { personId: admin.personId, via: 'cli', cli },
      { day: today, provider: 'second' },
      'Checking the operator is recorded',
    );
    const events = await withCompany(
      ctx.database,
      sys(admin.companyId),
      async (tx) =>
        (
          await tx.execute<{ action: string; data: Record<string, unknown> }>(
            sql`select action, data from audit_event where record_id = ${result.runId} order by seq`,
          )
        ).rows,
    );
    expect(events.map((e) => e.action)).toEqual([
      'ops.reconciliation_started',
      'ops.reconciliation_finished',
    ]);
    for (const e of events) expect(e.data).toMatchObject({ osUser: cli.osUser, host: cli.host });
  });
});
