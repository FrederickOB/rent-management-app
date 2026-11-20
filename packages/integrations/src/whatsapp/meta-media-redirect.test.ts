import { describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import { MetaWhatsApp } from './meta';

/**
 * M11 security review, reviewer 3 (informational): the Meta media fetch must not follow a
 * redirect. Meta answers a media id with a URL on its own hosts; a redirect from there could lead
 * the authorised request, or the bytes we store, anywhere. Both requests of fetchMedia say
 * `redirect: 'error'`, and a redirect then fails the fetch, as undici does, so nothing is stored.
 */
const BASE = 'https://graph.facebook.test';
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';

function fakeMeta() {
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    if (url.startsWith(BASE))
      return Response.json({ url: MEDIA_URL, mime_type: 'image/jpeg', file_size: 3 });
    // Meta's media host answers with a redirect to somewhere else. With `redirect: 'error'` the
    // fetch fails (undici: TypeError "fetch failed", cause "unexpected redirect"); otherwise it is
    // followed and the other host's bytes come back.
    if (init?.redirect === 'error') throw new TypeError('fetch failed');
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
      headers: { 'content-type': 'image/jpeg' },
    });
  }) as typeof fetch;
  return {
    calls,
    port: new MetaWhatsApp({
      accessToken: 'fixture-token',
      graphVersion: 'v23.0',
      defaultPhoneNumberId: '106540352242922',
      baseUrl: BASE,
      fetch: fetchImpl,
    }),
  };
}

describe('NFR-SEC the Meta media fetch refuses redirects (M11 review R3, informational)', () => {
  it('asks for both the media URL and the bytes with redirect "error"', async () => {
    const { port, calls } = fakeMeta();
    await expect(port.fetchMedia('1234567890')).rejects.toBeInstanceOf(ProviderError);
    expect(calls.map((c) => c.redirect)).toEqual(['error', 'error']);
  });

  it('stores nothing when Meta’s host redirects: the fetch fails as a provider error', async () => {
    const { port } = fakeMeta();
    const failure = await port.fetchMedia('1234567890').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toContain('request failed');
  });
});
