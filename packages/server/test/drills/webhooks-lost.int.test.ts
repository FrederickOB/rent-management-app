import { schema, withCompany } from '@rent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../../src/billing/records';
import { startServerTest, type ServerTestContext } from '../support';
import { billingServices, type BillingServices } from '../support/billing';
import { tenancyServices, type TenancyServices } from '../support/tenancy';
import {
  drillCompany,
  drillLeases,
  drillPayments,
  issueReceipts,
  moneyState,
  pastVerifyWindow,
  payToken,
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
 * NFR-AVAIL drill: the provider's webhooks are lost (M11 plan 4.7; NFR "payment callbacks retried
 * and never lost"; docs/runbooks/failed-webhooks.md). With every webhook dropped, payments made on
 * the pay page are still found by the five-minute verify-pending job, and anything it has not
 * reached, a payment that never touched our pay page included, by the daily reconciliation. Each is
 * posted once, receipted once, and the books still match their sub-ledgers.
 */
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
  company = await drillCompany(ctx, s, p, { name: 'Lost Webhooks Agency', units: 8 });
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await endpoint?.close();
  await ctx?.close();
});

describe('NFR-AVAIL lost webhooks drill', () => {
  it('recovers every dropped payment through verify-pending and the daily reconciliation, each once', async () => {
    const today = isoNow(ctx.clock, 'Africa/Accra');
    const leases = await drillLeases(ctx, s, b, company, 6, { consent: true });
    await fake.outage('drop');

    // Group A pays; every webhook is dropped. Five minutes on, verify-pending finds them.
    const groupA = [];
    for (const lease of leases.slice(0, 3)) {
      const started = await startMomo(
        p,
        await payToken(ctx, p, company.companyId, lease.invoiceId),
        150_000,
      );
      await fake.port.completeCharge(started.reference, { status: 'success' });
      groupA.push(started.reference);
    }
    expect((await moneyState(ctx, company.companyId)).payments).toHaveLength(0);
    pastVerifyWindow(ctx);
    expect(await p.providerPayments.verifyPending(company.companyId)).toBe(3);
    expect((await moneyState(ctx, company.companyId)).payments).toHaveLength(3);

    // Group B pays just before the day ends; verify-pending has not reached them yet when the
    // daily reconciliation runs, and it posts them.
    const groupB = [];
    for (const lease of leases.slice(3)) {
      const started = await startMomo(
        p,
        await payToken(ctx, p, company.companyId, lease.invoiceId),
        150_000,
      );
      await fake.port.completeCharge(started.reference, { status: 'success' });
      groupB.push(started.reference);
    }
    // Money that never touched our pay page, paid straight to the owner's subaccount.
    const [subaccount] = await withCompany(
      ctx.database,
      { companyId: company.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.providerSubaccount),
    );
    const external = await fake.port.payExternal({
      subaccountCode: subaccount!.subaccountCode,
      amountMinor: 90_000,
      channel: 'momo',
      payerPhone: '+233200000777',
      narration: 'rent',
    });
    const run = await p.reconciliation.transactions('paystack', today);
    expect(run.processed).toBe(4);

    // Not one webhook arrived, and the fake says it dropped all seven.
    expect(endpoint.received).toEqual([]);
    expect(await fake.state()).toMatchObject({ mode: 'drop', dropped: 7 });

    // Running both again changes nothing.
    pastVerifyWindow(ctx);
    await p.providerPayments.verifyPending(company.companyId);
    await p.reconciliation.transactions('paystack', today);
    const state = await moneyState(ctx, company.companyId);
    const references = state.payments.map((x) => x.reference).sort();
    expect(references).toEqual([...groupA, ...groupB, external.reference].sort());
    expect(new Set(references).size).toBe(references.length);
    // The unmatched one waits for a person in the queue; the six are receipted once, 1 to 6, and
    // each tenant gets one receipt message, however often the jobs run.
    const before = s.sms.sent.length;
    await issueReceipts(ctx, p, company.companyId);
    await issueReceipts(ctx, p, company.companyId);
    await sendQueued(ctx, s, company.companyId);
    const receipted = await moneyState(ctx, company.companyId);
    expect(receipted.receipts.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(receipted.intents.every((i) => i.status === 'confirmed')).toBe(true);
    const receiptTexts = s.sms.sent.slice(before).filter((m) => /receipt/i.test(m.body));
    expect(receiptTexts).toHaveLength(6);
    // Nothing is left for a person to explain, and the books match their sub-ledgers.
    const open = await withCompany(
      ctx.database,
      { companyId: company.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.reconciliationException),
    );
    expect(open.filter((e) => e.kind === 'missing_here' && !e.resolvedAt)).toEqual([]);
    expect((await b.subledger.check(company.companyId)).mismatches).toEqual([]);
  });
});
