import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, createStore, DEFAULT_PAYMENTS_SECRET_KEY } from './server';
import { hmac, startReceiver } from './test-support';

const KEY = 'sk_test_fake_server_tests';
const auth = { authorization: `Bearer ${KEY}` };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type App = ReturnType<typeof buildServer>;

async function subaccount(app: App): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/payments/subaccount',
    headers: auth,
    payload: {
      business_name: 'Test Landlord Ltd',
      settlement_bank: 'TEST',
      account_number: '0123456789',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { subaccount_code: string } }>().data.subaccount_code;
}

const initialize = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/payments/transaction/initialize', headers: auth, payload });

const chargeBody = (sub: string, reference: string, extra: Record<string, unknown> = {}) => ({
  reference,
  amount: 150_000,
  currency: 'GHS',
  email: 'tenant@example.test',
  channels: ['card'],
  subaccount: sub,
  metadata: { leaseId: 'lease-1' },
  ...extra,
});

describe('PLATFORM fake providers: payments', () => {
  it('requires the secret key on the provider API, as Paystack does', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    expect(
      (await app.inject({ method: 'GET', url: '/payments/transaction/verify/x' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/payments/transaction/verify/x',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    const byDefault = buildServer();
    const response = await byDefault.inject({
      method: 'GET',
      url: '/payments/transaction/verify/x',
      headers: { authorization: `Bearer ${DEFAULT_PAYMENTS_SECRET_KEY}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('initialises a card charge with a checkout page, and a MoMo charge with a phone prompt', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    const sub = await subaccount(app);
    const card = await initialize(app, chargeBody(sub, 'pay-card-1'));
    expect(card.statusCode).toBe(200);
    const url = card.json<{ data: { authorization_url: string } }>().data.authorization_url;
    expect(new URL(url).pathname).toMatch(/^\/payments\/checkout\//);
    const momo = await initialize(
      app,
      chargeBody(sub, 'pay-momo-1', {
        channels: ['mobile_money'],
        mobile_money: { phone: '+233200000003' },
      }),
    );
    expect(momo.json()).toMatchObject({
      status: true,
      data: { reference: 'pay-momo-1', status: 'pay_offline' },
    });
  });

  it('refuses unknown subaccounts, duplicate references and amounts that are not whole pesewas', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    const sub = await subaccount(app);
    expect((await initialize(app, chargeBody('ACCT_nobody', 'pay-1'))).statusCode).toBe(400);
    expect((await initialize(app, chargeBody(sub, 'pay-2'))).statusCode).toBe(200);
    expect((await initialize(app, chargeBody(sub, 'pay-2'))).statusCode).toBe(409);
    for (const amount of [1500.5, 0, -1, 2 ** 53, '150000']) {
      expect(
        (
          await initialize(
            app,
            chargeBody(sub, `pay-amount-${String(amount)}`.replace(/[^A-Za-z0-9-]/g, ''), {
              amount,
            }),
          )
        ).statusCode,
      ).toBe(400);
    }
    expect((await initialize(app, chargeBody(sub, 'pay-3', { currency: 'NGN' }))).statusCode).toBe(
      400,
    );
  });

  it('completes a charge: a signed charge.success webhook goes to the configured URL; verify reports the amount paid', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const app = buildServer(createStore(), {
      paymentsSecretKey: KEY,
      paymentsWebhookUrl: receiver.url,
    });
    const sub = await subaccount(app);
    await initialize(app, chargeBody(sub, 'pay-ok'));
    const completed = await app.inject({
      method: 'POST',
      url: '/payments/_test/charges/pay-ok',
      payload: { status: 'success', amountMinor: 149_000, feesMinor: 2_900 },
    });
    expect(completed.statusCode).toBe(200);
    const { webhook, delivery } = completed.json<{
      webhook: { rawBody: string; signature: string };
      delivery: { status: number };
    }>();
    expect(webhook.signature).toBe(hmac('sha512', KEY, webhook.rawBody));
    expect(delivery.status).toBe(200);
    expect(receiver.received[0]?.body).toBe(webhook.rawBody);
    expect(receiver.received[0]?.headers['x-paystack-signature']).toBe(webhook.signature);
    expect(JSON.parse(webhook.rawBody)).toMatchObject({
      event: 'charge.success',
      data: { reference: 'pay-ok', amount: 149_000, requested_amount: 150_000 },
    });

    const verified = await app.inject({
      method: 'GET',
      url: '/payments/transaction/verify/pay-ok',
      headers: auth,
    });
    expect(verified.json()).toMatchObject({
      status: true,
      data: {
        status: 'success',
        amount: 149_000,
        currency: 'GHS',
        fees: 2_900,
        subaccount: { subaccount_code: sub },
      },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/payments/_test/charges/pay-ok',
          payload: { status: 'failed' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('sends no webhook for a failed charge, and refuses fees larger than the amount', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const app = buildServer(createStore(), {
      paymentsSecretKey: KEY,
      paymentsWebhookUrl: receiver.url,
    });
    const sub = await subaccount(app);
    await initialize(app, chargeBody(sub, 'pay-fail'));
    const failed = await app.inject({
      method: 'POST',
      url: '/payments/_test/charges/pay-fail',
      payload: { status: 'failed' },
    });
    expect(failed.json()).toMatchObject({ status: 'failed', webhook: null });
    expect(receiver.received).toHaveLength(0);
    await initialize(app, chargeBody(sub, 'pay-fees'));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/payments/_test/charges/pay-fees',
          payload: { status: 'success', feesMinor: 150_001 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/payments/_test/charges/nothing',
          payload: { status: 'success' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('settles successful charges per subaccount and lists them with their transactions', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    const sub = await subaccount(app);
    for (const reference of ['pay-s1', 'pay-s2', 'pay-s3']) {
      await initialize(app, chargeBody(sub, reference));
    }
    await app.inject({
      method: 'POST',
      url: '/payments/_test/charges/pay-s1',
      payload: { status: 'success', feesMinor: 2_925 },
    });
    await app.inject({
      method: 'POST',
      url: '/payments/_test/charges/pay-s2',
      payload: { status: 'success', amountMinor: 80_050, feesMinor: 1_561 },
    });
    const settled = await app.inject({
      method: 'POST',
      url: '/payments/_test/settle',
      payload: {},
    });
    const [settlement] = settled.json<{
      settlements: {
        id: number;
        total_amount: number;
        total_fees: number;
        effective_amount: number;
        references: string[];
      }[];
    }>().settlements;
    expect(settlement).toMatchObject({
      total_amount: 230_050,
      total_fees: 4_486,
      effective_amount: 225_564,
      references: ['pay-s1', 'pay-s2'],
    });
    expect(
      (await app.inject({ method: 'POST', url: '/payments/_test/settle', payload: {} })).json(),
    ).toEqual({ settlements: [] });

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const listed = await app.inject({
      method: 'GET',
      url: `/payments/settlement?from=${from}&to=${to}`,
      headers: auth,
    });
    expect(listed.json<{ data: { id: number }[] }>().data.map((s) => s.id)).toEqual([
      settlement?.id,
    ]);
    const transactions = await app.inject({
      method: 'GET',
      url: `/payments/settlement/${settlement?.id}/transactions`,
      headers: auth,
    });
    expect(
      transactions.json<{ data: { reference: string }[] }>().data.map((t) => t.reference),
    ).toEqual(['pay-s1', 'pay-s2']);
    const all = await app.inject({
      method: 'GET',
      url: `/payments/transaction?from=${from}&to=${to}`,
      headers: auth,
    });
    expect(all.json<{ data: unknown[] }>().data).toHaveLength(3);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/payments/transaction?from=yesterday&to=today',
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('serves a fake checkout page whose form completes the charge', async () => {
    const app = buildServer(createStore(), { paymentsSecretKey: KEY });
    const sub = await subaccount(app);
    const card = await initialize(app, chargeBody(sub, 'pay-page'));
    const path = new URL(
      card.json<{ data: { authorization_url: string } }>().data.authorization_url,
    ).pathname;
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.body).toContain('No money moves');
    const posted = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'status=success',
    });
    expect(posted.body).toContain('success');
    const verified = await app.inject({
      method: 'GET',
      url: '/payments/transaction/verify/pay-page',
      headers: auth,
    });
    expect(verified.json()).toMatchObject({ data: { status: 'success' } });
  });
});
