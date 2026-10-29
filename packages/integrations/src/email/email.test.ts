import { describe, expect, it } from 'vitest';
import { emailContract } from '../testing';
import { emailAddressOf, InMemoryEmail, SmtpEmail, type SentEmail } from './email';

const DEFAULT_FROM = 'Rent Platform <no-reply@rent.local>';

const asReceived = (m: SentEmail) => ({
  from: emailAddressOf(m.from),
  to: [m.to],
  ...(m.replyTo === undefined ? {} : { replyTo: emailAddressOf(m.replyTo) }),
  subject: m.subject,
  text: m.text,
  ...(m.html === undefined ? {} : { html: m.html }),
  attachments: (m.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.content.length,
  })),
});

emailContract('in-memory', () => {
  const port = new InMemoryEmail(DEFAULT_FROM);
  return {
    port,
    defaultFrom: DEFAULT_FROM,
    received: async (id) => {
      const message = port.sent.find((m) => m.providerMessageId === id);
      return message && asReceived(message);
    },
  };
});

describe('PLATFORM email addresses', () => {
  it('reads the bare address from a named or bare address', () => {
    expect(emailAddressOf('Rent Platform <no-reply@rent.local>')).toBe('no-reply@rent.local');
    expect(emailAddressOf('  ops@rent.local ')).toBe('ops@rent.local');
    expect(emailAddressOf('"Agency, Osu" <osu@example.test>')).toBe('osu@example.test');
  });

  it('refuses an SMTP adapter whose default sender is not an address', () => {
    expect(() => new SmtpEmail('smtp://localhost:1025', 'Rent Platform')).toThrow(/default from/);
    expect(
      () => new SmtpEmail('smtp://localhost:1025', 'Ops <ops@rent.local>\r\nBcc: x@example.test'),
    ).toThrow();
  });
});
