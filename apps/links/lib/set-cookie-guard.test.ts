import { createServer, ServerResponse, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { installSetCookieGuard } from './set-cookie-guard';

// A subclass, so the test never patches the process-wide ServerResponse.
class GuardedResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends ServerResponse<Request> {}

let drops = 0;
installSetCookieGuard(GuardedResponse.prototype, () => {
  drops += 1;
});

async function respond(write: (response: ServerResponse) => void): Promise<Headers> {
  const server = createServer({ ServerResponse: GuardedResponse }, (_request, response) => {
    write(response);
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`);
    await response.text();
    return response.headers;
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const WAYS_TO_SET_A_COOKIE: [string, (response: ServerResponse) => void][] = [
  ['setHeader', (r) => r.setHeader('Set-Cookie', 'a=1').setHeader('X-Kept', 'yes')],
  [
    'setHeader with a list',
    (r) => r.setHeader('set-cookie', ['a=1', 'b=2']).setHeader('X-Kept', 'yes'),
  ],
  ['appendHeader', (r) => r.appendHeader('Set-Cookie', 'a=1').appendHeader('X-Kept', 'yes')],
  ['setHeaders', (r) => r.setHeaders(new Headers({ 'set-cookie': 'a=1', 'x-kept': 'yes' }))],
  ['writeHead with an object', (r) => r.writeHead(200, { 'Set-Cookie': 'a=1', 'X-Kept': 'yes' })],
  [
    'writeHead with a flat list',
    (r) => r.writeHead(200, 'OK', ['Set-Cookie', 'a=1', 'X-Kept', 'yes']),
  ],
  [
    'writeHead with pairs',
    (r) =>
      r.writeHead(200, [
        ['set-cookie', 'a=1'],
        ['x-kept', 'yes'],
      ]),
  ],
  [
    'writeHead after setHeader',
    (r) => r.setHeader('X-Kept', 'yes').writeHead(200, { 'Set-Cookie': 'a=1' }),
  ],
];

describe('NFR-SEC secure headers: links Set-Cookie guard', () => {
  it.each(WAYS_TO_SET_A_COOKIE)(
    'drops Set-Cookie added through %s and keeps the rest',
    async (_way, write) => {
      const before = drops;
      const headers = await respond(write);
      expect(headers.getSetCookie()).toEqual([]);
      expect(headers.get('x-kept')).toBe('yes');
      expect(drops).toBeGreaterThan(before);
    },
  );

  it('leaves responses without cookies untouched', async () => {
    const before = drops;
    const headers = await respond((r) => r.writeHead(201, { 'X-Kept': 'yes' }));
    expect(headers.get('x-kept')).toBe('yes');
    expect(drops).toBe(before);
  });

  it('installs once and never touches the prototype it was not given', () => {
    const { setHeader } = GuardedResponse.prototype;
    installSetCookieGuard(GuardedResponse.prototype);
    expect(GuardedResponse.prototype.setHeader).toBe(setHeader);
    expect(Object.hasOwn(ServerResponse.prototype, 'setHeader')).toBe(false);
  });
});
