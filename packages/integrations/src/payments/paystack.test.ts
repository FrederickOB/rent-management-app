import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import {
  isLivePaystackKey,
  LiveKeyRefused,
  PAYSTACK_MOMO_CODES,
  PaystackPayments,
} from './paystack';

/**
 * BC-02 the Paystack adapter, on recorded responses (M4b decision 4). The fixtures follow the
 * shapes in Paystack's documentation (fixtures/paystack); no request leaves this machine.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'paystack');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const KEY = 'sk_test_fixture_only_not_a_real_key';

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly authorization: string | null;
}

/** Replays a fixture per method and path; anything else is a 404, as Paystack answers. */
function replay(routes: Record<string, { status?: number; file: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get('authorization'),
    });
    const paged =
      url.pathname === '/transaction' ||
      url.pathname === '/settlement' ||
      url.pathname.endsWith('/transactions');
    const key = `${method} ${url.pathname}${paged ? `#${url.searchParams.get('page')}` : ''}`;
    const route = routes[key];
    if (!route) return new Response('{"status":false,"message":"Not found"}', { status: 404 });
    return new Response(fixture(route.file), {
      status: route.status ?? 200,
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

const charge = {
  reference: 'pi-0192f5a8111172228333444455557777',
  amountMinor: 150_000,
  currency: 'GHS' as const,
  customer: { email: 'tenant@example.test' },
  subaccountCode: 'ACCT_fake0001',
  metadata: { intentId: '0192f5a8-1111-7222-8333-444455557777' },
  customerName: 'Kwame Monthly',
};

describe('BC-02 the Paystack adapter (recorded responses)', () => {
  it('initialises a card charge on checkout, naming the subaccount, which bears the fee', async () => {
    const { port, calls } = replay({ 'POST /transaction/initialize': { file: 'initialize.json' } });
    const result = await port.initialiseCharge({ ...charge, channel: 'card' });
    expect(result).toEqual({
      provider: 'paystack',
      providerReference: 'pi-0192f5a8111172228333444455556666',
      authorizationUrl: 'https://checkout.paystack.com/7pq2c5x0m3fake',
      status: 'pending',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      authorization: `Bearer ${KEY}`,
      body: {
        email: 'tenant@example.test',
        amount: 150_000,
        currency: 'GHS',
        reference: charge.reference,
        subaccount: 'ACCT_fake0001',
        bearer: 'subaccount',
        channels: ['card'],
      },
    });
    // Checkout shows the tenant's name (decision 5), never a phone number.
    expect(JSON.stringify(calls[0]!.body)).toContain('Kwame Monthly');
  });

  it('charges MoMo straight to the phone with the network’s provider code (fixture assumption)', async () => {
    const { port, calls } = replay({ 'POST /charge': { file: 'charge-momo.json' } });
    const result = await port.initialiseCharge({
      ...charge,
      channel: 'momo',
      customer: { email: 'tenant@example.test', phone: '+233200000003' },
      momoNetwork: 'telecel',
    });
    expect(result).toMatchObject({
      status: 'pending',
      displayText: 'Please complete authorization process on your mobile phone',
    });
    expect(calls[0]!.body).toMatchObject({
      mobile_money: { phone: '+233200000003', provider: 'vod' },
      subaccount: 'ACCT_fake0001',
      bearer: 'subaccount',
    });
    expect(PAYSTACK_MOMO_CODES).toEqual({ mtn: 'mtn', telecel: 'vod', at: 'atl' });
    await expect(
      port.initialiseCharge({
        ...charge,
        channel: 'momo',
        customer: { email: 'tenant@example.test', phone: '+233200000003' },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('verifies a charge: status, amount, currency, reference, and the subaccount, fee and phone', async () => {
    const { port } = replay({
      'GET /transaction/verify/pi-0192f5a8111172228333444455557777': {
        file: 'verify-success.json',
      },
      'GET /transaction/verify/pi-0192f5a8111172228333444455558888': {
        file: 'verify-pending.json',
      },
    });
    expect(await port.verify(charge.reference)).toEqual({
      status: 'success',
      amountMinor: 150_000,
      currency: 'GHS',
      reference: charge.reference,
      paidAt: '2026-11-03T09:12:44.000Z',
      channel: 'momo',
      metadata: {
        companyId: '0192f5a8-0000-7000-8000-000000000001',
        leaseId: '0192f5a8-0000-7000-8000-000000000002',
        invoiceId: '0192f5a8-0000-7000-8000-000000000003',
        intentId: '0192f5a8-1111-7222-8333-444455557777',
      },
    });
    expect(await port.verifyTransaction(charge.reference)).toMatchObject({
      subaccountCode: 'ACCT_fake0001',
      feesMinor: 2925,
      payerPhone: '+233200000003',
    });
    // "ongoing" is still pending; an empty metadata string is no metadata.
    expect(await port.verify('pi-0192f5a8111172228333444455558888')).toMatchObject({
      status: 'pending',
      channel: 'card',
      metadata: {},
    });
  });

  it('treats an unknown reference as a non-retryable 404', async () => {
    const { port } = replay({});
    const error: unknown = await port.verify('pi-unknown').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(404);
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('lists every page of a day’s transactions', async () => {
    const { port, calls } = replay({
      'GET /transaction#1': { file: 'transactions-page-1.json' },
      'GET /transaction#2': { file: 'transactions-page-2.json' },
    });
    const listed = await port.listTransactions({
      from: '2026-11-03T00:00:00.000Z',
      to: '2026-11-04T00:00:00.000Z',
    });
    expect(listed.map((t) => [t.reference, t.status, t.amountMinor])).toEqual([
      ['pi-0192f5a8111172228333444455557777', 'success', 150_000],
      ['pi-0192f5a8111172228333444455558888', 'abandoned', 80_050],
    ]);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(calls[0]!.url.searchParams.get('from')).toBe('2026-11-03T00:00:00.000Z');
  });

  it('lists settlements with their charges, and reads deductions out of the payout', async () => {
    const { port } = replay({
      'GET /settlement#1': { file: 'settlements.json' },
      'GET /settlement/3090001/transactions#1': { file: 'settlement-transactions.json' },
      'GET /settlement/3090001/transactions#2': { file: 'settlement-transactions-page-2.json' },
      // The refunds the payout deducted, by the settlement they name (fixture assumption).
      'GET /refund': { file: 'refunds.json' },
    });
    const [settlement] = await port.listSettlements({
      from: '2026-11-04T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
    });
    expect(settlement).toEqual({
      settlementId: '3090001',
      subaccountCode: 'ACCT_fake0001',
      status: 'success',
      currency: 'GHS',
      grossMinor: 230_050,
      feesMinor: 4_486,
      deductionsMinor: 20_000,
      netMinor: 205_564,
      settledAt: '2026-11-04T00:00:00.000Z',
      // The second charge is on the second page.
      references: ['pi-0192f5a8111172228333444455557777', 'pi-0192f5a8111172228333444455559999'],
      deductedReferences: [
        { reference: 'pi-0192f5a8111172228333444455550000', amountMinor: 20_000 },
      ],
    });
    expect(settlement!.grossMinor - settlement!.feesMinor - settlement!.deductionsMinor).toBe(
      settlement!.netMinor,
    );
  });

  it('creates a subaccount that takes the whole charge (D1), refunds, and checks account names', async () => {
    const { port, calls } = replay({
      'POST /subaccount': { file: 'subaccount.json' },
      'POST /refund': { file: 'refund.json' },
      'GET /bank/resolve': { file: 'bank-resolve.json' },
      'GET /bank': { file: 'banks.json' },
    });
    expect(
      await port.createSubaccount({
        businessName: 'Test Landlord Ltd',
        settlementBank: 'FAKEBANK1',
        accountNumber: '0123456789',
      }),
    ).toEqual({ subaccountCode: 'ACCT_fake0002' });
    expect(calls[0]!.body).toMatchObject({ percentage_charge: 0 });
    expect(await port.refund({ reference: charge.reference, amountMinor: 150_000 })).toEqual({
      refundReference: '6001001',
      status: 'pending',
    });
    expect(calls[1]!.body).toEqual({ transaction: charge.reference, amount: 150_000 });
    expect(
      await port.resolveAccount({ bankCode: 'FAKEBANK1', accountNumber: '0123456789' }),
    ).toEqual({ accountName: 'TEST LANDLORD LIMITED' });
    expect(await port.listBanks()).toEqual([
      { code: 'FAKEBANK1', name: 'Test Bank One' },
      { code: 'FAKEBANK2', name: 'Test Bank Two' },
    ]);
  });

  it('reads an account Paystack cannot check as unconfirmed, not refused', async () => {
    const { port } = replay({
      'GET /bank/resolve': { status: 422, file: 'bank-resolve-unavailable.json' },
    });
    expect(
      await port.resolveAccount({ bankCode: 'FAKEBANK1', accountNumber: '0123456789' }),
    ).toBeNull();
  });

  it('verifies the signature of a recorded webhook, and reads only its event, id and reference', () => {
    const { port } = replay({});
    for (const [file, type, reference] of [
      ['webhook-charge-success.json', 'charge.success', 'pi-0192f5a8111172228333444455557777'],
      [
        'webhook-dispute-resolve.json',
        'charge.dispute.resolve',
        'pi-0192f5a8111172228333444455557777',
      ],
      ['webhook-refund-processed.json', 'refund.processed', 'pi-0192f5a8111172228333444455557777'],
    ] as const) {
      const raw = fixture(file);
      const signature = createHmac('sha512', KEY).update(raw).digest('hex');
      expect(port.verifyWebhookSignature(raw, { 'x-paystack-signature': signature })).toBe(true);
      expect(
        port.verifyWebhookSignature(raw.replace('150000', '15000'), {
          'x-paystack-signature': signature,
        }),
      ).toBe(false);
      const event = port.parseWebhook(raw);
      expect(event).toMatchObject({ type, reference });
      expect(Object.keys(event!).sort()).toEqual(['eventId', 'reference', 'type']);
    }
  });

  it('refuses a live key unless live rent collection is enabled (decision 3; OQ-03)', () => {
    expect(isLivePaystackKey('sk_live_x')).toBe(true);
    expect(isLivePaystackKey('sk_test_x')).toBe(false);
    expect(
      () => new PaystackPayments({ secretKey: 'sk_live_x', liveCollection: 'disabled' }),
    ).toThrow(LiveKeyRefused);
    expect(new PaystackPayments({ secretKey: 'sk_live_x', liveCollection: 'enabled' }).live).toBe(
      true,
    );
    expect(new PaystackPayments({ secretKey: KEY, liveCollection: 'disabled' }).live).toBe(false);
  });
});

/** As `replay`, keyed on method, path and `page` (when asked) and the `transaction` filter. */
function replayPages(routes: Record<string, { status?: number; file: string }>) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    const base = `${init?.method ?? 'GET'} ${url.pathname}`;
    const page = url.searchParams.get('page');
    const transaction = url.searchParams.get('transaction');
    const route =
      routes[`${base}#${page}`] ?? routes[`${base}?transaction=${transaction}`] ?? routes[base];
    if (!route) return new Response('{"status":false,"message":"Not found"}', { status: 404 });
    return new Response(fixture(route.file), {
      status: route.status ?? 200,
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

describe('BC-02 the Paystack adapter reads refunds, disputes and deductions (M4b review)', () => {
  it('reads every page of a settlement’s charges and the refunds it deducted (review item 6)', async () => {
    const { port, calls } = replayPages({
      'GET /settlement#1': { file: 'settlements-deducted.json' },
      'GET /settlement/3090002/transactions#1': {
        file: 'settlement-3090002-transactions-page-1.json',
      },
      'GET /settlement/3090002/transactions#2': {
        file: 'settlement-3090002-transactions-page-2.json',
      },
      'GET /refund#1': { file: 'refunds-deducted.json' },
      'GET /transaction/4099260520': { file: 'transaction-by-id.json' },
    });
    const [settlement] = await port.listSettlements({
      from: '2026-11-05T00:00:00.000Z',
      to: '2026-11-06T00:00:00.000Z',
    });
    expect(settlement).toMatchObject({
      settlementId: '3090002',
      grossMinor: 180_000,
      feesMinor: 3_490,
      deductionsMinor: 63_000,
      netMinor: 113_510,
      references: ['pi-0192f5a8111172228333444455551111', 'pi-0192f5a8111172228333444455552222'],
      // A refund that carries its charge, and a lost dispute deducted as a refund that names
      // its charge by id only (fixture assumption, OQ-01). The pending refund deducted nothing.
      deductedReferences: [
        { reference: 'pi-0192f5a8111172228333444455557777', amountMinor: 33_000 },
        { reference: 'pi-0192f5a8111172228333444455559999', amountMinor: 30_000 },
      ],
    });
    const deducted = settlement!.deductedReferences.reduce((sum, d) => sum + d.amountMinor, 0);
    expect(deducted).toBe(settlement!.deductionsMinor);
    // Refunds are read from 90 days before the settlement's day.
    const refunds = calls.find((u) => u.pathname === '/refund')!;
    expect(refunds.searchParams.get('from')).toBe('2026-08-07T00:00:00.000Z');
  });

  it('lists a charge’s refunds and the disputes that took money (review items 2 and 17)', async () => {
    const reference = 'pi-0192f5a8111172228333444455557777';
    const { port, calls } = replayPages({
      [`GET /transaction/verify/${reference}`]: { file: 'verify-success.json' },
      'GET /refund?transaction=4099260516': { file: 'refunds-for-transaction.json' },
      'GET /dispute?transaction=4099260516': { file: 'disputes-for-transaction.json' },
    });
    expect(await port.reversals(reference)).toEqual([
      { kind: 'refund', id: '6001010', status: 'failed', amountMinor: 20_000 },
      { kind: 'refund', id: '6001011', status: 'pending', amountMinor: 20_000 },
      { kind: 'chargeback', id: '880010', status: 'processed', amountMinor: 50_000 },
      { kind: 'chargeback', id: '880012', status: 'pending', amountMinor: 10_000 },
    ]);
    expect(calls.filter((u) => u.pathname === '/refund')[0]!.searchParams.get('transaction')).toBe(
      '4099260516',
    );
  });

  it('lists the day’s refunds and disputes with their charges (review item 16)', async () => {
    const { port } = replayPages({
      'GET /refund#1': { file: 'refunds-deducted.json' },
      'GET /dispute#1': { file: 'disputes-for-transaction.json' },
      'GET /transaction/4099260520': { file: 'transaction-by-id.json' },
    });
    const listed = await port.listReversals({
      from: '2026-11-04T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
    });
    expect(listed.map((r) => [r.kind, r.reference, r.status, r.amountMinor])).toEqual([
      ['refund', 'pi-0192f5a8111172228333444455557777', 'processed', 33_000],
      ['refund', 'pi-0192f5a8111172228333444455559999', 'processed', 30_000],
      ['refund', 'pi-0192f5a8111172228333444455553333', 'pending', 5_000],
      ['chargeback', 'pi-0192f5a8111172228333444455557777', 'processed', 50_000],
      ['chargeback', 'pi-0192f5a8111172228333444455557777', 'pending', 10_000],
    ]);
  });

  it('reports a MoMo step it cannot take, such as an OTP, instead of waiting (review item 19)', async () => {
    const { port } = replay({ 'POST /charge': { file: 'charge-send-otp.json' } });
    expect(
      await port.initialiseCharge({
        ...charge,
        channel: 'momo',
        customer: { email: 'tenant@example.test', phone: '+233200000003' },
        momoNetwork: 'telecel',
      }),
    ).toMatchObject({ status: 'pending', unsupportedStep: 'send_otp' });
  });
});
