import { capturedMessages, fakeProvidersContext, pushContract } from '../testing';
import { FakeProvidersPush } from './push';

pushContract('fake-providers over HTTP', () => {
  const { baseUrl } = fakeProvidersContext();
  return {
    port: new FakeProvidersPush(baseUrl),
    sent: async () =>
      (await capturedMessages(baseUrl, 'push')).map((m) => ({
        token: m.to,
        title: typeof m.meta?.title === 'string' ? m.meta.title : '',
        body: m.body,
        data: (m.meta?.data as Record<string, string> | undefined) ?? undefined,
      })),
  };
});
