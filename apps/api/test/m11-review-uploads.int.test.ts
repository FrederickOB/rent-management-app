import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './support';

/**
 * M11 review B13 over HTTP: the job sheet's check, for apps/links before it reads a photo body,
 * is a links-API route like the rest of the sheet's (the links key, no session).
 */
let api: TestApi;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api?.close();
});

const check = (headers: Record<string, string>) =>
  fetch(`${api.baseUrl}/job-sheets/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      token: 'Q'.repeat(43),
      client: { ip: '203.0.113.90', userAgent: 'links-server' },
    }),
  });

describe('MI-04 NFR-SEC M11 review B13: the job sheet check is for the links app only', () => {
  it('refuses a caller without the links key, and answers 404 for an unknown token', async () => {
    expect((await check({})).status).toBe(401);
    const unknown = await check({ [LINKS_API_KEY_HEADER]: DEV_LINKS_API_KEY });
    expect(unknown.status).toBe(404);
  });
});
