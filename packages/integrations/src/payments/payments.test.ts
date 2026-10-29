import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paymentsContract } from '../testing';
import {
  InMemoryPayments,
  isWholePesewas,
  parsePaystackWebhook,
  verifyPaystackSignature,
} from './payments';

paymentsContract('in-memory', () => ({ port: new InMemoryPayments('sk_test_unit') }));

describe('PLATFORM payments webhook signature (x-paystack-signature)', () => {
  const body =
    '{"event":"charge.success","data":{"id":302961,"reference":"pay-1","amount":150000}}';
  const signature = createHmac('sha512', 'sk_test_unit').update(body).digest('hex');

  it('accepts the HMAC-SHA512 of the raw body under the secret key, header name in any case', () => {
    expect(
      verifyPaystackSignature('sk_test_unit', body, { 'x-paystack-signature': signature }),
    ).toBe(true);
    expect(
      verifyPaystackSignature('sk_test_unit', Buffer.from(body), {
        'X-Paystack-Signature': signature,
      }),
    ).toBe(true);
  });

  it('refuses a changed body, another key, a repeated or listed header, and a short signature', () => {
    expect(
      verifyPaystackSignature('sk_test_unit', body.replace('150000', '15000'), {
        'x-paystack-signature': signature,
      }),
    ).toBe(false);
    expect(
      verifyPaystackSignature('sk_test_other', body, { 'x-paystack-signature': signature }),
    ).toBe(false);
    expect(
      verifyPaystackSignature('sk_test_unit', body, {
        'x-paystack-signature': signature,
        'X-Paystack-Signature': signature,
      }),
    ).toBe(false);
    expect(
      verifyPaystackSignature('sk_test_unit', body, { 'x-paystack-signature': [signature] }),
    ).toBe(false);
    expect(
      verifyPaystackSignature('sk_test_unit', body, {
        'x-paystack-signature': signature.slice(0, 64),
      }),
    ).toBe(false);
  });

  it('refuses to verify without a secret key, rather than accept anything', () => {
    expect(() => verifyPaystackSignature('', body, { 'x-paystack-signature': signature })).toThrow(
      /not configured/,
    );
  });
});

describe('PLATFORM payments webhook parsing', () => {
  it('takes only the event, its id and the reference: money is never read from a webhook', () => {
    expect(
      parsePaystackWebhook(
        '{"event":"charge.success","data":{"id":302961,"reference":"pay-1","amount":150000}}',
      ),
    ).toEqual({
      eventId: 'charge.success:302961',
      type: 'charge.success',
      reference: 'pay-1',
    });
  });
});

describe('PLATFORM payments amounts', () => {
  it('accepts only positive whole pesewas within the safe integer range', () => {
    expect(isWholePesewas(1)).toBe(true);
    expect(isWholePesewas(Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const value of [
      0,
      -1,
      0.5,
      150_000.01,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(isWholePesewas(value)).toBe(false);
    }
  });
});
