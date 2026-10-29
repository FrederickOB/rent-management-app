import { capturedMessages, fakeProvidersContext, smsContract } from '../testing';
import { FakeProvidersSms } from './sms';

smsContract('fake-providers over HTTP', () => {
  const { baseUrl } = fakeProvidersContext();
  return {
    port: new FakeProvidersSms(baseUrl),
    sent: async () =>
      (await capturedMessages(baseUrl, 'sms')).map((m) => ({
        providerMessageId: m.id,
        to: m.to,
        body: m.body,
      })),
  };
});
