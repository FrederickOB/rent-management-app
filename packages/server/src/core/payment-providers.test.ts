import { InMemoryPayments } from '@rent/integrations';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { PaymentProviders, paymentProvidersFor } from './payment-providers';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  API_BASE_URL: 'http://localhost:3700',
  WEB_ORIGIN: 'http://localhost:3701',
  LINKS_ORIGIN: 'http://localhost:3702',
  TENANT_WEB_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  NODE_ENV: 'test',
};

describe('BC-02 failover', () => {
  it('tries the company’s order, only providers that settle directly and hold a subaccount (D1)', () => {
    const providers = new PaymentProviders(
      [
        { name: 'paystack', port: new InMemoryPayments('k1', 'paystack'), settlesDirect: true },
        { name: 'second', port: new InMemoryPayments('k2', 'second'), settlesDirect: true },
        { name: 'hubtel', port: new InMemoryPayments('k3', 'hubtel'), settlesDirect: false },
      ],
      ['paystack', 'hubtel', 'second'],
    );
    expect(providers.order(null, new Set(['paystack', 'second', 'hubtel']))).toEqual([
      'paystack',
      'second',
    ]);
    expect(providers.order(['second'], new Set(['paystack', 'second']))).toEqual(['second']);
    expect(providers.order(null, new Set(['paystack']))).toEqual(['paystack']);
    expect(providers.settlingProviders()).toEqual(['paystack', 'second']);
  });
});

describe('BC-02 live rent collection waits for counsel (decision 3; OQ-03)', () => {
  it('refuses to start with a live Paystack key unless LIVE_RENT_COLLECTION is enabled, naming who', () => {
    expect(() => loadConfig({ ...base, PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow(/OQ-03/);
    expect(() =>
      loadConfig({ ...base, PAYSTACK_SECRET_KEY: 'sk_live_abc', LIVE_RENT_COLLECTION: 'enabled' }),
    ).toThrow(/ENABLED_BY/);
    expect(
      loadConfig({
        ...base,
        PAYSTACK_SECRET_KEY: 'sk_live_abc',
        LIVE_RENT_COLLECTION: 'enabled',
        LIVE_RENT_COLLECTION_ENABLED_BY: 'Founder, after counsel’s opinion of 2027-01-10',
      }).LIVE_RENT_COLLECTION,
    ).toBe('enabled');
    const test = paymentProvidersFor(loadConfig({ ...base, PAYSTACK_SECRET_KEY: 'sk_test_abc' }));
    expect(test.names()).toEqual(['paystack']);
    expect(paymentProvidersFor(loadConfig(base)).names()).toEqual(['paystack']);
  });
});
