import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import { PaystackPayments } from './paystack';

/**
 * PB-07 the platform's own charges through the Paystack adapter (M10 decision 9), on the recorded
 * responses in fixtures/paystack: the same endpoints as rent, with no subaccount and no bearer, so
 * the money settles to the platform's own balance. No request leaves this machine.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'paystack');
const KEY = 'sk_test_fixture_only_not_a_real_key';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function replay(routes: Record<string, string>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const file = routes[`${method} ${url.pathname}`];
    if (!file) return new Response('{"status":false,"message":"Not found"}', { status: 404 });
    return new Response(readFileSync(path.join(FIXTURES, file), 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const port = new PaystackPayments({
    secretKey: KEY,
    liveCollection: 'disabled',
    baseUrl: 'https://api.paystack.test',
    fetch: fetchImpl,
  });
  return { port, calls };
}

const base = {
  reference: 'SUB-0192f5a8111172228333444455556666',
  amountMinor: 15_000,
  currency: 'GHS' as const,
  email: 'admin@example.test',
  metadata: { purpose: 'invoices', paymentId: '0192f5a8-1111-7222-8333-444455556666' },
};

describe('PB-07 the Paystack adapter charges the platform with no subaccount (decision 9)', () => {
  it('starts a card charge on checkout without a subaccount or bearer', async () => {
    const { port, calls } = replay({ 'POST /transaction/initialize': 'initialize.json' });
    const result = await port.initializePlatform({
      ...base,
      callbackUrl: 'https://app.example.test/settings/subscription',
    });
    expect(result).toEqual({
      provider: 'paystack',
      providerReference: 'pi-0192f5a8111172228333444455556666',
      authorizationUrl: 'https://checkout.paystack.com/7pq2c5x0m3fake',
      status: 'pending',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/transaction/initialize',
      body: {
        email: 'admin@example.test',
        amount: 15_000,
        currency: 'GHS',
        reference: base.reference,
        channels: ['card'],
        callback_url: 'https://app.example.test/settings/subscription',
        metadata: base.metadata,
      },
    });
    expect(calls[0]!.body).not.toHaveProperty('subaccount');
    expect(calls[0]!.body).not.toHaveProperty('bearer');
  });

  it('charges MoMo straight to the phone with the network’s code, without a subaccount', async () => {
    const { port, calls } = replay({ 'POST /charge': 'charge-momo.json' });
    const result = await port.chargePlatformMomo({
      ...base,
      phone: '+233200000003',
      network: 'at',
    });
    expect(result).toMatchObject({
      provider: 'paystack',
      status: 'pending',
      displayText: 'Please complete authorization process on your mobile phone',
    });
    expect(result.unsupportedStep).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({
      mobile_money: { phone: '+233200000003', provider: 'atl' },
      amount: 15_000,
      reference: base.reference,
    });
    expect(calls[0]!.body).not.toHaveProperty('subaccount');
    expect(calls[0]!.body).not.toHaveProperty('bearer');
  });

  it('refuses a reference without the platform prefix before calling Paystack', async () => {
    const { port, calls } = replay({ 'POST /transaction/initialize': 'initialize.json' });
    const error = await port
      .initializePlatform({ ...base, reference: 'pi-0192f5a8111172228333444455556666' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
