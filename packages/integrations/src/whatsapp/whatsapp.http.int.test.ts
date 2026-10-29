import { capturedMessages, fakeProvidersContext, whatsAppContract } from '../testing';
import { FakeProvidersWhatsApp, type SentWhatsApp } from './whatsapp';

const text = (meta: Record<string, unknown> | undefined, key: string) =>
  typeof meta?.[key] === 'string' ? meta[key] : undefined;

whatsAppContract('fake-providers over HTTP', () => {
  const { baseUrl, whatsappAppSecret } = fakeProvidersContext();
  return {
    port: new FakeProvidersWhatsApp(baseUrl),
    appSecret: whatsappAppSecret,
    sent: async () =>
      (await capturedMessages(baseUrl, 'whatsapp')).map((m): SentWhatsApp => ({
        providerMessageId: m.id,
        to: m.to,
        type: text(m.meta, 'type') as SentWhatsApp['type'],
        body: text(m.meta, 'type') === 'text' ? m.body : undefined,
        template: text(m.meta, 'template'),
        language: text(m.meta, 'language'),
        parameters: Array.isArray(m.meta?.parameters) ? (m.meta.parameters as string[]) : undefined,
        mediaUrl: text(m.meta, 'mediaUrl'),
        filename: text(m.meta, 'filename'),
        caption: text(m.meta, 'caption'),
        reference: text(m.meta, 'reference'),
      })),
  };
});
