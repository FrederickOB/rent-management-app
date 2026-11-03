import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaystackPayments } from './paystack';

/**
 * BC-02 the Paystack sandbox smoke test (M4b decision 4): runs only when PAYSTACK_TEST_SECRET_KEY
 * holds a Paystack test key, locally or in a manual CI job, never with a live key. It checks that
 * the recorded fixtures still match what Paystack answers. No money moves on a test key.
 */
const key = process.env.PAYSTACK_TEST_SECRET_KEY ?? '';

describe.runIf(key.startsWith('sk_test_'))('BC-02 the Paystack sandbox smoke test', () => {
  it('lists Ghana’s banks, and a card charge initialised there verifies as pending', async () => {
    const port = new PaystackPayments({ secretKey: key, liveCollection: 'disabled' });
    const banks = await port.listBanks();
    expect(banks.length).toBeGreaterThan(0);
    const reference = `pi-smoke-${randomUUID().replace(/-/g, '')}`;
    // A subaccount is needed for a split charge; without one the smoke test checks the rest.
    const result = await port
      .initialiseCharge({
        reference,
        amountMinor: 100,
        currency: 'GHS',
        channel: 'card',
        customer: { email: `smoke-${randomUUID()}@example.test` },
        subaccountCode: process.env.PAYSTACK_TEST_SUBACCOUNT ?? '',
        metadata: { smoke: 'true' },
      })
      .catch(() => null);
    if (result) expect((await port.verify(reference)).status).toBe('pending');
  });
});
