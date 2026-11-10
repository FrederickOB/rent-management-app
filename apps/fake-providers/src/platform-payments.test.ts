import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, createStore } from './server';
import { hmac, startReceiver } from './test-support';

const KEY = 'sk_test_fake_server_platform';
const auth = { authorization: `Bearer ${KEY}` };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type App = ReturnType<typeof buildServer>;

const platformCard = (reference: string, extra: Record<string, unknown> = {}) => ({
  reference,
  amount: 15_000,
  currency: 'GHS',
  email: 'admin@example.test',
  channels: ['card'],
  metadata: { purpose: 'invoices' },
  callback_url: 'https://app.example.test/settings/subscription',
  ...extra,
});

const initialize = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/payments/transaction/initialize', headers: auth, payload });

describe('PB-07 fake providers: the platform’s own charges, with no subaccount (decision 9)', () => {
  it('takes a SUB- charge with no subaccount, and refuses any other charge without one (D1)', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    const card = await initialize(app, platformCard('SUB-card-1'));
    expect(card.statusCode).toBe(200);
    expect(card.json<{ data: { authorization_url: string } }>().data.authorization_url).toMatch(
      /\/payments\/checkout\//,
    );
    const momo = await app.inject({
      method: 'POST',
      url: '/payments/charge',
      headers: auth,
      payload: {
        reference: 'SUB-momo-1',
        amount: 15_000,
        currency: 'GHS',
        email: 'admin@example.test',
        metadata: {},
        mobile_money: { phone: '+233200000123', provider: 'mtn' },
      },
    });
    expect(momo.json()).toMatchObject({ data: { status: 'pay_offline' } });
    const rentWithout = await initialize(app, platformCard('pi-0192f5a8'));
    expect(rentWithout.statusCode).toBe(400);
    expect(rentWithout.json()).toMatchObject({ message: 'Subaccount required' });
    const verified = await app.inject({
      method: 'GET',
      url: '/payments/transaction/verify/SUB-card-1',
      headers: auth,
    });
    expect(verified.json()).toMatchObject({ data: { status: 'pending', subaccount: {} } });
  });

  it('the fake checkout’s Pay button completes it and fires the signed webhook, as for rent', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const app = buildServer(createStore(), {
      paymentsSecretKey: KEY,
      paymentsWebhookUrl: receiver.url,
    });
    const card = await initialize(app, platformCard('SUB-page-1'));
    const page = new URL(
      card.json<{ data: { authorization_url: string } }>().data.authorization_url,
    ).pathname;
    const shown = await app.inject({ method: 'GET', url: page });
    expect(shown.body).toContain('Fake checkout');
    expect(shown.body).toContain('SUB-page-1');
    const paid = await app.inject({
      method: 'POST',
      url: page,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'status=success',
    });
    expect(paid.body).toContain('success');
    expect(receiver.received).toHaveLength(1);
    const body = receiver.received[0]!.body;
    expect(receiver.received[0]!.headers['x-paystack-signature']).toBe(hmac('sha512', KEY, body));
    expect(JSON.parse(body)).toMatchObject({
      event: 'charge.success',
      data: { reference: 'SUB-page-1', status: 'success', amount: 15_000, subaccount: {} },
    });
  });

  it('pays the platform out apart from any subaccount, with no subaccount named', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    await initialize(app, platformCard('SUB-settle-1', { amount: 20_000 }));
    await app.inject({
      method: 'POST',
      url: '/payments/_test/charges/SUB-settle-1',
      payload: { status: 'success', feesMinor: 300 },
    });
    const settled = await app.inject({
      method: 'POST',
      url: '/payments/_test/settle',
      payload: {},
    });
    expect(settled.json()).toMatchObject({
      settlements: [
        {
          subaccount: null,
          total_amount: 20_000,
          total_fees: 300,
          effective_amount: 19_700,
          references: ['SUB-settle-1'],
        },
      ],
    });
  });
});
