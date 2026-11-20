import { describe, expect, it } from 'vitest';
import { loadConfig, loadProcessConfig } from './config';

/** The settings every configuration needs; nothing here is a secret. */
const base = {
  DATABASE_URL: 'postgres://rent_app@localhost:5432/rent_x',
  API_BASE_URL: 'https://api.example.invalid',
  WEB_ORIGIN: 'https://app.example.invalid',
  LINKS_ORIGIN: 'https://links.example.invalid',
  TENANT_WEB_ORIGIN: 'https://tenant.example.invalid',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
};

describe('NFR-SEC production guards fail closed (M11 review B5)', () => {
  it('refuses to start an API or worker whose NODE_ENV is unset or unknown', () => {
    expect(() => loadProcessConfig({ ...base })).toThrow('NODE_ENV must be set');
    expect(() => loadProcessConfig({ ...base, NODE_ENV: 'prod' })).toThrow('NODE_ENV must be set');
    expect(loadProcessConfig({ ...base, NODE_ENV: 'development' }).NODE_ENV).toBe('development');
    // Hand-built configurations (unit tests) keep the development default.
    expect(loadConfig({ ...base }).NODE_ENV).toBe('development');
  });

  it('refuses the e2e owner connection in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        LINKS_API_KEY: 'k'.repeat(40),
        E2E_DATABASE_OWNER_URL: 'postgres://rent_owner@localhost:5432/rent_x',
      }),
    ).toThrow('E2E_DATABASE_OWNER_URL must not be set in production');
  });
});
