import { fakeProvidersContext } from '../testing';
import { platformChargesContract } from '../testing/platform-charges.contract';
import { FakeProvidersPayments } from './payments';

platformChargesContract('fake-providers over HTTP', () => {
  const { baseUrl, paymentsSecretKey } = fakeProvidersContext();
  return { port: new FakeProvidersPayments(baseUrl, paymentsSecretKey) };
});
