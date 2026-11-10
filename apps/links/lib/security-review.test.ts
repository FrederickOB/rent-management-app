import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as complete } from '../app/j/[token]/complete/route';
import { POST as start } from '../app/j/[token]/start/route';
import { register } from '../instrumentation';
import { proxy } from '../proxy';
import { JOB_SHEET_FORM_LIMITS } from './body-limit';
import { forgetUploads } from './job-sheet-store';
import { clientFrom } from './links-api';
import { readMultipart } from './multipart';
import { installPeerAddress, missingClientIpHeader, PEER_ADDRESS_HEADER } from './peer-address';
import { HSTS_VALUE, secured, securityHeaders } from './security-headers';
import { admitUpload, resetUploadGate } from './upload-gate';

// The M11 security review (ASVS L2) for apps/links: F2, the job sheet's photo forms are guarded
// before they are read and then read part by part, never whole into memory; F8, the client's
// address comes only from a header the edge overwrites, or from the socket; and HSTS in
// production (decision 6).

const TOKEN = 's'.repeat(43);
const STORAGE = 'https://storage.example.test/rent-uploads';
const params = { params: Promise.resolve({ token: TOKEN }) };

/** A request whose body fails the test if any of it is read. */
function unread(headers: Record<string, string>) {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('the body must not be read');
    },
  });
  return new Request(`http://links.test/j/${TOKEN}/complete`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'multipart/form-data; boundary=x', ...headers },
    duplex: 'half',
  } as RequestInit);
}

/** A multipart body, streamed in 64 KB chunks, counting how much of it was pulled. */
function streamed(parts: { name: string; filename?: string; type?: string; bytes: Uint8Array }[]) {
  const boundary = '----rent-test-boundary';
  const chunks: Uint8Array[] = [];
  const text = (value: string) => new TextEncoder().encode(value);
  for (const part of parts) {
    const disposition =
      part.filename !== undefined
        ? `form-data; name="${part.name}"; filename="${part.filename}"`
        : `form-data; name="${part.name}"`;
    chunks.push(text(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n`));
    if (part.type) chunks.push(text(`Content-Type: ${part.type}\r\n`));
    chunks.push(text('\r\n'), part.bytes, text('\r\n'));
  }
  chunks.push(text(`--${boundary}--\r\n`));
  const whole = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    whole.set(c, at);
    at += c.length;
  }
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= whole.length) return controller.close();
      const next = whole.subarray(pulled, pulled + 64 * 1024);
      pulled += next.length;
      controller.enqueue(next);
    },
  });
  const request = new Request(`http://links.test/j/${TOKEN}/complete`, {
    method: 'POST',
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-forwarded-for': '198.51.100.20',
    },
    duplex: 'half',
  } as RequestInit);
  return { request, pulled: () => pulled, size: whole.length };
}

const jpegBytes = (size: number) => new Uint8Array(size).fill(0xff);
/** Where this file's posts keep their photos (LINKS_UPLOAD_DIR), so no other test's folders count. */
let uploads = '';
const ourFolders = () => readdirSync(uploads).filter((name) => name.startsWith('rent-links-'));

beforeEach(() => {
  resetUploadGate();
  forgetUploads(TOKEN);
  uploads = mkdtempSync(`${tmpdir()}/rent-links-test-`);
  vi.stubEnv('LINKS_UPLOAD_DIR', uploads);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(uploads, { recursive: true, force: true });
});

describe('NFR-SEC F2: a photo form is guarded before it is read (MI-06)', () => {
  it('an address with two photo forms under way gets no third, and its body is never read', async () => {
    const first = admitUpload('203.0.113.50');
    const second = admitUpload('203.0.113.50');
    expect([first.ok, second.ok]).toEqual([true, true]);
    for (const route of [complete, start]) {
      const refused = await route(unread({ 'x-forwarded-for': '203.0.113.50' }), params);
      expect(refused.headers.get('location')).toBe(`/j/${TOKEN}?error=RATE_LIMITED#act`);
      expect(refused.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
    // Another address is not held up by it.
    expect(admitUpload('203.0.113.51').ok).toBe(true);
  });

  it('a token the API does not know is refused before its body is read, and frees its place', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(new URL(url).pathname);
        return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
      }),
    );
    for (const route of [complete, start]) {
      const refused = await route(unread({ 'x-forwarded-for': '203.0.113.60' }), params);
      expect(refused.status).toBe(404);
      expect(refused.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
    // The token check is the only call made: no upload is asked for, nothing reaches storage.
    expect(asked).toEqual(['/job-sheets/open', '/job-sheets/open']);
    // Both refusals gave their places back (two at once per address).
    const a = admitUpload('203.0.113.60');
    const b = admitUpload('203.0.113.60');
    expect([a.ok, b.ok]).toEqual([true, true]);
  });

  it('the server takes only so many photo forms at once, and frees a place once one is handled', () => {
    vi.stubEnv('JOB_SHEET_UPLOADS_PER_SERVER', '2');
    const a = admitUpload('198.51.100.1');
    const b = admitUpload('198.51.100.2');
    expect(admitUpload('198.51.100.3').ok).toBe(false);
    if (a.ok) a.release();
    expect(admitUpload('198.51.100.3').ok).toBe(true);
    if (b.ok) b.release();
  });

  it('an address gets 30 photo forms in 10 minutes, then waits', () => {
    const now = Date.parse('2026-11-10T09:00:00Z');
    for (let i = 0; i < 30; i += 1) {
      const admitted = admitUpload('192.0.2.7', now + i);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }
    expect(admitUpload('192.0.2.7', now + 31).ok).toBe(false);
    expect(admitUpload('192.0.2.7', now + 10 * 60_000 + 1).ok).toBe(true);
  });

  it('a photo over 10 MB is refused once it passes 10 MB, without reading the rest', async () => {
    const big = streamed([
      { name: 'photos', filename: 'big.jpg', type: 'image/jpeg', bytes: jpegBytes(30_000_000) },
    ]);
    const read = await readMultipart(big.request, JOB_SHEET_FORM_LIMITS);
    expect(read).toEqual({ ok: false, error: 'PHOTO_TOO_LARGE' });
    expect(big.pulled()).toBeLessThan(10_200_000);
    expect(ourFolders()).toEqual([]);
  });

  it('an eleventh photo is refused as it starts, without reading the rest', async () => {
    const many = streamed(
      Array.from({ length: 12 }, (_, i) => ({
        name: 'photos',
        filename: `p${i}.jpg`,
        type: 'image/jpeg',
        bytes: jpegBytes(500_000),
      })),
    );
    const read = await readMultipart(many.request, JOB_SHEET_FORM_LIMITS);
    expect(read).toEqual({ ok: false, error: 'PHOTO_TOO_MANY' });
    expect(many.pulled()).toBeLessThan(many.size);
  });

  it('photos are kept on disk while the form is handled, and the folder goes afterwards', async () => {
    const before = ourFolders();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === STORAGE) return new Response(null, { status: 204 });
        const path = new URL(url).pathname;
        if (path === '/job-sheets/uploads') {
          // While the post is handled, its photos are in a folder of their own.
          expect(ourFolders().length).toBe(before.length + 1);
          return Response.json({
            uploadId: '0193a7c0-0000-7000-8000-0000000c0001',
            url: STORAGE,
            fields: {},
            expiresAt: 'x',
          });
        }
        return Response.json({ screen: 'done' });
      }),
    );
    const form = streamed([
      { name: 'photos', filename: 'after.jpg', type: 'image/jpeg', bytes: jpegBytes(3_000_000) },
      { name: 'completionNote', bytes: new TextEncoder().encode('Replaced the trap.') },
      { name: 'code', bytes: new TextEncoder().encode('123456') },
    ]);
    const answer = await complete(form.request, params);
    expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?done=completed`);
    expect(ourFolders()).toEqual(before);
  });

  it('text fields, an empty file input and a photo read as a browser would send them', async () => {
    const form = streamed([
      { name: 'form', bytes: new TextEncoder().encode('0193a7c0-0000-4000-8000-0000000f0009') },
      { name: 'photos', filename: '', type: 'application/octet-stream', bytes: new Uint8Array() },
      { name: 'photos', filename: 'a.jpg', type: 'image/jpeg', bytes: jpegBytes(1_234) },
      { name: 'completionNote', bytes: new TextEncoder().encode('Fixed, with a “new” tap ✓') },
    ]);
    const read = await readMultipart(form.request, JOB_SHEET_FORM_LIMITS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(ourFolders()).toHaveLength(1);
    expect(read.form.get('form')).toBe('0193a7c0-0000-4000-8000-0000000f0009');
    expect(read.form.get('completionNote')).toBe('Fixed, with a “new” tap ✓');
    const photos = read.form.getAll('photos') as File[];
    expect(photos.map((p) => [p.name, p.size, p.type])).toEqual([
      ['', 0, 'application/octet-stream'],
      ['a.jpg', 1_234, 'image/jpeg'],
    ]);
    expect(new Uint8Array(await photos[1]!.arrayBuffer()).every((b) => b === 0xff)).toBe(true);
    await read.cleanup();
    expect(ourFolders()).toEqual([]);
  });
});

describe('NFR-SEC F8: the client’s address is never the client’s own word (TL-07 evidence)', () => {
  it('behind the edge, only the header the edge overwrites counts', () => {
    const headers = new Headers({
      'x-real-ip': '198.51.100.99',
      'x-forwarded-for': '6.6.6.6',
      [PEER_ADDRESS_HEADER]: '10.0.0.5',
      'user-agent': 'Mozilla/5.0',
    });
    expect(clientFrom(headers, { CLIENT_IP_HEADER: 'X-Real-IP' }).ip).toBe('198.51.100.99');
    expect(
      clientFrom(new Headers({ 'x-forwarded-for': '6.6.6.6' }), { CLIENT_IP_HEADER: 'x-real-ip' })
        .ip,
    ).toBe('unknown');
  });

  it('with no edge, the connection’s own address, never X-Forwarded-For', () => {
    const headers = new Headers({
      'x-forwarded-for': '6.6.6.6',
      [PEER_ADDRESS_HEADER]: '127.0.0.1',
    });
    expect(clientFrom(headers, {}).ip).toBe('127.0.0.1');
  });

  it('the server stamps every request with its socket’s address, over anything the client sent', async () => {
    installPeerAddress(Server.prototype);
    const seen: (string | string[] | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers[PEER_ADDRESS_HEADER]);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/', headers: { [PEER_ADDRESS_HEADER]: '6.6.6.6' } },
        (res) => res.resume().on('end', resolve),
      );
      req.on('error', reject);
      req.end();
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(seen).toEqual(['127.0.0.1']);
  });

  it('a deployment without the edge’s header refuses to start; CI and local stacks run', async () => {
    expect(missingClientIpHeader({ NODE_ENV: 'production', LINKS_API_KEY: 'k' })).toBe(true);
    expect(
      missingClientIpHeader({ NODE_ENV: 'production', LINKS_API_KEY: 'k', CLIENT_IP_HEADER: 'x' }),
    ).toBe(false);
    expect(missingClientIpHeader({ NODE_ENV: 'production' })).toBe(false);
    expect(missingClientIpHeader({ NODE_ENV: 'development', LINKS_API_KEY: 'k' })).toBe(false);

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LINKS_API_KEY', 'a-real-deployment-key');
    vi.stubEnv('CLIENT_IP_HEADER', '');
    try {
      await expect(register()).rejects.toThrow('exit 1');
      expect(String(error.mock.calls[0]?.[0])).toContain('CLIENT_IP_HEADER');
      expect(String(error.mock.calls[0]?.[0])).not.toContain('a-real-deployment-key');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('NFR-SEC HSTS on links, in production only (decision 6)', () => {
  it('production sends a year of HSTS, without includeSubDomains or preload; nothing else does', () => {
    const header = (list: ReturnType<typeof securityHeaders>) =>
      list.find(([name]) => name === 'Strict-Transport-Security')?.[1];
    expect(header(securityHeaders('production'))).toBe('max-age=31536000');
    expect(HSTS_VALUE).not.toMatch(/includeSubDomains|preload/);
    expect(header(securityHeaders('development'))).toBeUndefined();
    expect(header(securityHeaders('test'))).toBeUndefined();
  });

  it('on pages through the proxy, and on the photo posts that bypass it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const page = proxy(new NextRequest(`http://links.test/p/${'p'.repeat(43)}`));
    expect(page.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(secured(new Response(null)).headers.get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      proxy(new NextRequest('http://links.test/health')).headers.get('strict-transport-security'),
    ).toBeNull();
  });
});
