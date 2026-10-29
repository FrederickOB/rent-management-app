import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import { emailContract, fakeEmail, type ReceivedEmail } from '../testing';
import { SmtpEmail, type EmailPort } from './email';

const SMTP_URL = process.env.SMTP_URL ?? 'smtp://localhost:1025';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const DEFAULT_FROM = 'Rent Platform <no-reply@rent.local>';

interface MailpitAddress {
  Address: string;
}
interface MailpitMessage {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  ReplyTo: MailpitAddress[] | null;
  Subject: string;
  Text: string;
  HTML: string;
  Attachments: { FileName: string; ContentType: string; Size: number }[];
}

async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}/api/v1${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Mailpit's id for a message, by its Message-ID header; Mailpit may take a moment to store it. */
async function findInMailpit(messageId: string): Promise<string | undefined> {
  const query = encodeURIComponent(`message-id:"${messageId.replace(/^<|>$/g, '')}"`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await mailpit<{ messages: { ID: string }[] }>(`/search?query=${query}`);
    if (result.messages[0]) return result.messages[0].ID;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

emailContract('SMTP to Mailpit', () => {
  const smtp = new SmtpEmail(SMTP_URL, DEFAULT_FROM);
  const sentIds: string[] = [];
  // Records what this test sent, so cleanup deletes only those messages from the shared Mailpit.
  const port: EmailPort = {
    provider: smtp.provider,
    send: async (message) => {
      const result = await smtp.send(message);
      sentIds.push(result.providerMessageId);
      return result;
    },
    parseInbound: (body) => smtp.parseInbound(body),
  };
  return {
    port,
    defaultFrom: DEFAULT_FROM,
    received: async (providerMessageId): Promise<ReceivedEmail | undefined> => {
      const id = await findInMailpit(providerMessageId);
      if (!id) return undefined;
      const m = await mailpit<MailpitMessage>(`/message/${id}`);
      const replyTo = m.ReplyTo?.[0]?.Address;
      return {
        from: m.From.Address,
        to: m.To.map((a) => a.Address),
        ...(replyTo === undefined ? {} : { replyTo }),
        subject: m.Subject,
        text: m.Text.replace(/\r\n/g, '\n').trimEnd(),
        ...(m.HTML ? { html: m.HTML } : {}),
        attachments: m.Attachments.map((a) => ({
          filename: a.FileName,
          contentType: a.ContentType,
          size: a.Size,
        })),
      };
    },
    cleanup: async () => {
      const ids = (await Promise.all(sentIds.map(findInMailpit))).filter((id) => id !== undefined);
      if (ids.length > 0) {
        await fetch(`${MAILPIT_URL}/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ IDs: ids }),
        });
      }
      smtp.close();
    },
  };
});

/** An SMTP server that refuses every recipient with a permanent 550, quoting the address. */
async function rejectingSmtpServer(): Promise<{ url: string; close: () => void }> {
  const server = net.createServer((socket) => {
    socket.write('220 test ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const command = buffer.slice(0, 4).toUpperCase();
        buffer = buffer.slice(end + 2);
        if (command === 'EHLO' || command === 'HELO') socket.write('250 test\r\n');
        else if (command === 'MAIL' || command === 'RSET') socket.write('250 OK\r\n');
        else if (command === 'RCPT')
          socket.write('550 5.1.1 <someone@example.test> mailbox unavailable\r\n');
        else if (command === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

async function closedPort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

describe('PLATFORM SMTP errors', () => {
  it('marks an unreachable server as retryable', async () => {
    const smtp = new SmtpEmail(`smtp://127.0.0.1:${await closedPort()}`, DEFAULT_FROM);
    const error: unknown = await smtp
      .send({ to: fakeEmail(), subject: 'x', text: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    smtp.close();
  });

  it('marks a permanent refusal as not retryable, without the address in the error', async () => {
    const server = await rejectingSmtpServer();
    const smtp = new SmtpEmail(server.url, DEFAULT_FROM);
    const to = fakeEmail();
    try {
      const error: unknown = await smtp
        .send({ to, subject: 'x', text: 'x' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect((error as ProviderError).message).toMatch(/550/);
      expect((error as ProviderError).message).not.toContain('@');
    } finally {
      smtp.close();
      server.close();
    }
  });
});
