import { describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import { fakeProvidersContext, paymentsContract } from '../testing';
import { FakeProvidersPayments } from './payments';

paymentsContract('fake-providers over HTTP', () => {
  const { baseUrl, paymentsSecretKey } = fakeProvidersContext();
  return { port: new FakeProvidersPayments(baseUrl, paymentsSecretKey) };
});

describe('PLATFORM integration contracts: payments (fake-providers over HTTP, authentication)', () => {
  it('refuses API calls made with the wrong secret key', async () => {
    const { baseUrl } = fakeProvidersContext();
    const port = new FakeProvidersPayments(baseUrl, 'sk_test_wrong');
    const error: unknown = await port.verify('any-reference').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
    expect((error as ProviderError).retryable).toBe(false);
  });
});
