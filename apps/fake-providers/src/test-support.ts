import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Test helpers; not used by the server. */
export interface ReceivedWebhook {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A local HTTP endpoint that records the webhooks posted to it. */
export async function startReceiver(): Promise<{
  url: string;
  received: ReceivedWebhook[];
  close: () => Promise<void>;
}> {
  const received: ReceivedWebhook[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const hmac = (algorithm: 'sha256' | 'sha512', key: string, body: string): string =>
  createHmac(algorithm, key).update(body).digest('hex');
