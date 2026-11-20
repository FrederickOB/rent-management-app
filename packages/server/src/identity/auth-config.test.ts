import { InMemoryEmail, InMemorySms } from '@rent/integrations';
import type { Database } from '@rent/db';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../core/clock';
import { DEV_BETTER_AUTH_SECRET, loadConfig } from '../core/config';
import { createLogger } from '../core/logging/logger';
import { createAuth } from './auth';
import { MembershipDirectory } from './memberships';

const env = {
  DATABASE_URL: 'postgres://rent_app@localhost:5432/rent',
  API_BASE_URL: 'https://api.example.invalid',
  WEB_ORIGIN: 'https://app.example.invalid',
  LINKS_ORIGIN: 'https://links.example.invalid',
  TENANT_WEB_ORIGIN: 'https://tenant.example.invalid',
  BETTER_AUTH_SECRET: 'a-real-secret-for-this-test-only-0123456789',
  LINKS_API_KEY: 'k'.repeat(40),
};

/** No query runs while the configuration is built, so a stand-in database is enough. */
const database = { db: {} } as unknown as Database;

function authFor(nodeEnv: 'production' | 'development', secret = env.BETTER_AUTH_SECRET) {
  const config = loadConfig({ ...env, NODE_ENV: 'development', BETTER_AUTH_SECRET: secret });
  return createAuth({
    database,
    config: { ...config, NODE_ENV: nodeEnv },
    sms: new InMemorySms(),
    email: new InMemoryEmail(),
    clock: systemClock,
    logger: createLogger({ level: 'silent' }),
    memberships: new MembershipDirectory(database),
  });
}

describe('NFR-SEC M11 review R1 F10: host-only cookies in production', () => {
  it('names them __Host-, Secure, Path=/ and without a Domain in production; plain over http in development', async () => {
    const production = (await authFor('production').$context).authCookies.sessionToken;
    expect(production.name).toBe('__Host-rent.session_token');
    expect(production.attributes).toMatchObject({
      secure: true,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(production.attributes).not.toHaveProperty('domain');
    const development = (await authFor('development').$context).authCookies.sessionToken;
    expect(development.name).toBe('rent.session_token');
    expect(development.attributes.secure).toBe(false);
  });
});

describe('NFR-SEC M11 review R1 F11: the published development secret never runs production', () => {
  it('is refused by the configuration and by the auth set-up', () => {
    expect(() =>
      loadConfig({ ...env, NODE_ENV: 'production', BETTER_AUTH_SECRET: DEV_BETTER_AUTH_SECRET }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => authFor('production', DEV_BETTER_AUTH_SECRET)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => authFor('development', DEV_BETTER_AUTH_SECRET)).not.toThrow();
  });
});
