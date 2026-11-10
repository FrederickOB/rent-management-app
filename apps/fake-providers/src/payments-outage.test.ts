import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, createStore } from './server';
import { hmac, startReceiver } from './test-support';

/**
 * The fake provider's outage switch (M11 decision 9), which the NFR-AVAIL drills and the load
 * test drive: down, slow, timeout, webhooks withheld or dropped, and back to normal.
 */
const KEY = 'sk_test_fake_outage_tests';
const auth = { authorization: `Bearer ${KEY}` };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type App = ReturnType<typeof buildServer>;

async function setup(webhookUrl?: string) {
  const store = createStore();
  const app = buildServer(store, {
    paymentsSecretKey: KEY,
    ...(webhookUrl ? { paymentsWebhookUrl: webhookUrl } : {}),
  });
  closers.push(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/payments/subaccount',
    headers: auth,
    payload: {
      business_name: 'Outage Landlord',
      settlement_bank: 'TEST',
      account_number: '0123456789',
    },
  });
  const sub = created.json<{ data: { subaccount_code: string } }>().data.subaccount_code;
  return { app, store, sub };
}

const outage = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/payments/_test/outage', payload });

const charge = (app: App, sub: string, reference: string) =>
  app.inject({
    method: 'POST',
    url: '/payments/charge',
    headers: auth,
    payload: {
      reference,
      amount: 150_000,
      currency: 'GHS',
      email: 'tenant@example.test',
      subaccount: sub,
      mobile_money: { phone: '+233200000003', provider: 'mtn' },
    },
  });

const initialize = (app: App, sub: string, reference: string) =>
  app.inject({
    method: 'POST',
    url: '/payments/transaction/initialize',
    headers: auth,
    payload: {
      reference,
      amount: 150_000,
      currency: 'GHS',
      email: 'tenant@example.test',
      channels: ['card'],
      subaccount: sub,
    },
  });

const verify = (app: App, reference: string) =>
  app.inject({ method: 'GET', url: `/payments/transaction/verify/${reference}`, headers: auth });

const pay = (app: App, reference: string) =>
  app.inject({
    method: 'POST',
    url: `/payments/_test/charges/${reference}`,
    payload: { status: 'success' },
  });

describe('NFR-AVAIL fake provider outage switch', () => {
  it('down: initialize, charge and verify answer 503 before anything is done; normal restores them', async () => {
    const { app, sub } = await setup();
    expect((await charge(app, sub, 'out-before')).statusCode).toBe(200);
    const set = await outage(app, { mode: 'down' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ mode: 'down', withheld: 0, released: 0 });
    const refused = await initialize(app, sub, 'out-down-1');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ status: false });
    expect((await charge(app, sub, 'out-down-2')).statusCode).toBe(503);
    expect((await verify(app, 'out-before')).statusCode).toBe(503);
    // Even without the key: an outage answers whoever calls.
    expect(
      (await app.inject({ method: 'GET', url: '/payments/transaction/verify/out-before' }))
        .statusCode,
    ).toBe(503);
    // The payer's side (test controls) still works: the charge made before the outage is paid.
    expect((await pay(app, 'out-before')).statusCode).toBe(200);
    await outage(app, { mode: 'normal' });
    // Nothing refused during the outage was created.
    expect((await verify(app, 'out-down-1')).statusCode).toBe(404);
    expect((await verify(app, 'out-before')).json()).toMatchObject({
      data: { status: 'success' },
    });
  });

  it('slow: answers after the delay, and the call succeeds', async () => {
    const { app, sub } = await setup();
    await outage(app, { mode: 'slow', delayMs: 250 });
    const started = Date.now();
    const response = await initialize(app, sub, 'out-slow');
    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect((await app.inject({ method: 'GET', url: '/payments/_test/outage' })).json()).toEqual({
      mode: 'slow',
      delayMs: 250,
      withheld: 0,
      dropped: 0,
    });
  });

  it('timeout: the caller gives up first, yet the charge may exist afterwards', async () => {
    const { app, sub } = await setup();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await outage(app, { mode: 'timeout', delayMs: 400 });
    // The client's own limit (10 s in the adapters) is shortened here to keep the test quick.
    const call = fetch(`${base}/payments/charge`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: 'out-timeout',
        amount: 150_000,
        currency: 'GHS',
        email: 'tenant@example.test',
        subaccount: sub,
        mobile_money: { phone: '+233200000003', provider: 'mtn' },
      }),
      signal: AbortSignal.timeout(100),
    });
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await outage(app, { mode: 'normal' });
    const found = await verify(app, 'out-timeout');
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ data: { reference: 'out-timeout', status: 'pending' } });
  });

  it('withhold: webhooks wait in order and are sent, signed, when the mode returns to normal', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const { app, sub } = await setup(receiver.url);
    await charge(app, sub, 'out-held-1');
    await charge(app, sub, 'out-held-2');
    await outage(app, { mode: 'withhold' });
    const paid = await pay(app, 'out-held-1');
    expect(paid.json()).toMatchObject({ delivery: { error: 'withheld' } });
    await pay(app, 'out-held-2');
    expect(receiver.received).toHaveLength(0);
    // Verify answers meanwhile: the charge is paid, only its webhook is late.
    expect((await verify(app, 'out-held-1')).json()).toMatchObject({ data: { status: 'success' } });
    // Another mode keeps them held.
    await outage(app, { mode: 'down' });
    expect(receiver.received).toHaveLength(0);
    const back = await outage(app, { mode: 'normal' });
    expect(back.json()).toMatchObject({ mode: 'normal', withheld: 0, released: 2 });
    expect(receiver.received.map((r) => JSON.parse(r.body).data.reference)).toEqual([
      'out-held-1',
      'out-held-2',
    ]);
    for (const r of receiver.received)
      expect(r.headers['x-paystack-signature']).toBe(hmac('sha512', KEY, r.body));
    // Released once: setting normal again sends nothing more.
    expect((await outage(app, { mode: 'normal' })).json()).toMatchObject({ released: 0 });
    expect(receiver.received).toHaveLength(2);
  });

  it('drop: webhooks are discarded for good, while verify still reports the payment', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const { app, sub } = await setup(receiver.url);
    await charge(app, sub, 'out-drop');
    await outage(app, { mode: 'drop' });
    expect((await pay(app, 'out-drop')).json()).toMatchObject({ delivery: { error: 'dropped' } });
    expect(
      (await app.inject({ method: 'GET', url: '/payments/_test/outage' })).json(),
    ).toMatchObject({ mode: 'drop', dropped: 1, withheld: 0 });
    expect((await outage(app, { mode: 'normal' })).json()).toMatchObject({ released: 0 });
    expect(receiver.received).toHaveLength(0);
    expect((await verify(app, 'out-drop')).json()).toMatchObject({ data: { status: 'success' } });
  });

  it('resets: DELETE discards what is withheld without sending it; /_reset also restores normal', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const { app, sub } = await setup(receiver.url);
    await charge(app, sub, 'out-reset');
    await outage(app, { mode: 'withhold' });
    await pay(app, 'out-reset');
    expect((await app.inject({ method: 'DELETE', url: '/payments/_test/outage' })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: 'GET', url: '/payments/_test/outage' })).json()).toEqual({
      mode: 'normal',
      delayMs: 0,
      withheld: 0,
      dropped: 0,
    });
    expect((await outage(app, { mode: 'normal' })).json()).toMatchObject({ released: 0 });
    expect(receiver.received).toHaveLength(0);

    await outage(app, { mode: 'down' });
    expect((await app.inject({ method: 'DELETE', url: '/_reset' })).statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/payments/_test/outage' })).json(),
    ).toMatchObject({ mode: 'normal' });
  });

  it('refuses an unknown mode or a delay out of range', async () => {
    const { app } = await setup();
    expect((await outage(app, { mode: 'flaky' })).statusCode).toBe(400);
    expect((await outage(app, { mode: 'slow', delayMs: -1 })).statusCode).toBe(400);
    expect((await outage(app, { mode: 'slow', delayMs: 120_001 })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/payments/_test/outage' })).json(),
    ).toMatchObject({ mode: 'normal' });
  });
});
