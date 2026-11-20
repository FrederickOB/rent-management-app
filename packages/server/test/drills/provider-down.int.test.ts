import { eq, schema, withCompany } from '@rent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from '../support';
import { billingServices, type BillingServices } from '../support/billing';
import { tenancyServices, type TenancyServices } from '../support/tenancy';
import {
  CLIENT,
  drillCompany,
  drillLeases,
  drillPayments,
  issueReceipts,
  moneyState,
  pastVerifyWindow,
  payToken,
  processInbox,
  startFakeProvider,
  startMomo,
  startWebhookEndpoint,
  type DrillCompany,
  type DrillPayments,
  type FakeProvider,
  type WebhookEndpoint,
} from './support';

/**
 * NFR-AVAIL drill: the payment provider goes down (M11 plan 4.7; docs/runbooks/provider-outage.md).
 * While it is down a tenant on the pay page is shown the landlord's own instructions, one incident
 * alert is raised, and no intent is left half-made. Payments approved just before the outage are
 * not lost: when the provider is back, verify-pending confirms them and the webhooks it held back
 * arrive and change nothing. A provider that stops answering (timeout) is asked before anything
 * else is tried, and the charge it made is followed to the end, once.
 */
const INSTRUCTIONS = 'Pay into GCB 0000 at any branch, quoting your unit code.';

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
  company = await drillCompany(ctx, s, p, {
    name: 'Outage Agency',
    units: 8,
    manualInstructions: INSTRUCTIONS,
  });
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await endpoint?.close();
  await ctx?.close();
});

const codes = () => p.alerts.map((a) => a.code);

describe('NFR-AVAIL provider down drill', () => {
  it('shows the manual instructions with one alert while down; afterwards verify-pending and the held webhooks post each payment once', async () => {
    const [early1, early2, during] = await drillLeases(ctx, s, b, company, 3);
    // Before the outage: two tenants start paying and approve on their phones, but the provider's
    // webhooks are held back (the outage has begun at its end).
    const first = await startMomo(
      p,
      await payToken(ctx, p, company.companyId, early1!.invoiceId),
      150_000,
    );
    const second = await startMomo(
      p,
      await payToken(ctx, p, company.companyId, early2!.invoiceId),
      150_000,
    );
    expect([first.intent.status, second.intent.status]).toEqual(['pending', 'pending']);
    await fake.outage('withhold');
    await fake.port.completeCharge(first.reference, { status: 'success' });
    await fake.port.completeCharge(second.reference, { status: 'success' });
    expect(await fake.state()).toMatchObject({ withheld: 2 });

    // The provider goes down.
    await fake.outage('down');
    const token = await payToken(ctx, p, company.companyId, during!.invoiceId);
    const page = await p.page.open(token, CLIENT);
    expect(page.screen).toBe('pay');
    expect(page.landlord.manualInstructions).toBe(INSTRUCTIONS);
    const before = p.alerts.length;
    const refused = await startMomo(p, token, 150_000);
    // The tenant is told plainly, with the landlord's own instructions; one incident alert.
    expect(refused.intent.status).toBe('failed');
    expect(refused.intent.message).toContain(INSTRUCTIONS);
    expect(codes().slice(before)).toEqual(['payments.provider_unavailable']);
    expect(p.alerts.at(-1)!.severity).toBe('critical');

    // verify-pending runs during the outage: it cannot check, so nothing changes and nothing posts.
    pastVerifyWindow(ctx);
    await p.providerPayments.verifyPending(company.companyId);
    let state = await moneyState(ctx, company.companyId);
    expect(state.payments).toHaveLength(0);
    // No intent is stuck: the refused one is final, the two approved ones wait for a check.
    const byId = new Map(state.intents.map((i) => [i.id, i]));
    expect(byId.get(refused.intent.intentId)).toMatchObject({
      status: 'failed',
      failureReason: 'providers_unavailable',
    });
    expect(byId.get(first.intent.intentId)!.status).toBe('pending');
    expect(byId.get(second.intent.intentId)!.status).toBe('pending');

    // The provider is back: the held webhooks are sent, and verify-pending runs first.
    const back = await fake.outage('normal');
    expect(back.released).toBe(2);
    expect(endpoint.received.slice(-2).map((r) => r.result)).toEqual(['stored', 'stored']);
    pastVerifyWindow(ctx);
    expect(await p.providerPayments.verifyPending(company.companyId)).toBe(2);
    state = await moneyState(ctx, company.companyId);
    expect(state.payments).toHaveLength(2);
    // The late webhooks find their payments already posted, and post nothing more.
    const outcomes = await processInbox(ctx, p);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o !== 'posted' && o !== 'posted_flagged')).toBe(true);
    state = await moneyState(ctx, company.companyId);
    expect(state.payments.map((x) => x.reference).sort()).toEqual(
      [first.reference, second.reference].sort(),
    );
    // Each paid once, with one receipt, numbered without a gap.
    await issueReceipts(ctx, p, company.companyId);
    state = await moneyState(ctx, company.companyId);
    expect(state.receipts.map((r) => r.number)).toEqual([1, 2]);
    expect(state.intents.filter((i) => i.status === 'pending' || i.status === 'initiated')).toEqual(
      [],
    );
    // The tenant shown the instructions can pay through the platform again.
    const retried = await startMomo(p, token, 150_000);
    expect(retried.intent.status).toBe('pending');
    expect((await b.subledger.check(company.companyId)).mismatches).toEqual([]);
  });

  it('a provider that stops answering is asked about the charge before anything else; the charge it made posts once', async () => {
    const [lease] = await drillLeases(ctx, s, b, company, 1);
    const token = await payToken(ctx, p, company.companyId, lease!.invoiceId);
    // Past the adapter's 10 s: the charge request and the check that follows both go unanswered.
    await fake.outage('timeout', 10_500);
    const before = p.alerts.length;
    const lost = await startMomo(p, token, 150_000);
    await fake.outage('normal');
    // The intent stays with this provider, waiting for a check (never failed over, never failed);
    // a warning says why.
    expect(['initiated', 'pending']).toContain(lost.intent.status);
    expect(codes().slice(before)).toContain('payments.charge_unknown');
    const [row] = await withCompany(
      ctx.database,
      { companyId: company.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.paymentIntent)
          .where(eq(schema.paymentIntent.id, lost.intent.intentId)),
    );
    expect(row!.provider).toBe('paystack');
    // The provider did make the charge; the payer approves it and its webhook arrives.
    await fake.port.completeCharge(lost.reference, { status: 'success' });
    expect(await processInbox(ctx, p)).toEqual(['posted']);
    pastVerifyWindow(ctx);
    await p.providerPayments.verifyPending(company.companyId);
    const state = await moneyState(ctx, company.companyId);
    expect(state.payments.filter((x) => x.reference === lost.reference)).toHaveLength(1);
    expect((await b.subledger.check(company.companyId)).mismatches).toEqual([]);
  }, 60_000);
});
