import { describe, expect, it } from 'vitest';
import { buildServer } from './server';

describe('PLATFORM fake providers: GhanaPost GPS lookup', () => {
  it('resolves the fixed fake codes, in any case and with spaces', async () => {
    const app = buildServer();
    for (const code of ['GA-000-0001', 'ga-000-0001', 'GA 000 0001']) {
      const response = await app.inject({
        method: 'GET',
        url: `/address-lookup/${encodeURIComponent(code)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        code: 'GA-000-0001',
        region: expect.stringContaining('fake'),
      });
    }
  });

  it('answers 404 for an unknown code and 400 for something that is not a digital address', async () => {
    const app = buildServer();
    expect(
      (await app.inject({ method: 'GET', url: '/address-lookup/GA-183-8164' })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/address-lookup/Accra' })).statusCode).toBe(
      400,
    );
  });
});
