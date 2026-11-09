import { loadConfig, testControlsEnabled } from '@rent/server/core';
import { describe, expect, it } from 'vitest';

/** The settings every configuration needs; nothing here is a secret. */
const base = {
  DATABASE_URL: 'postgres://rent_app@localhost:5432/rent',
  API_BASE_URL: 'https://api.example.invalid',
  WEB_ORIGIN: 'https://app.example.invalid',
  LINKS_ORIGIN: 'https://links.example.invalid',
  TENANT_WEB_ORIGIN: 'https://tenant.example.invalid',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
};
const production = { ...base, NODE_ENV: 'production', LINKS_API_KEY: 'k'.repeat(40) };

describe('M10 e2e test controls: configuration', () => {
  it('are off unless switched on, and on only outside production', () => {
    expect(testControlsEnabled(loadConfig({ ...base, NODE_ENV: 'development' }))).toBe(false);
    expect(
      testControlsEnabled(loadConfig({ ...base, NODE_ENV: 'test', E2E_TEST_CONTROLS: 'on' })),
    ).toBe(true);
    expect(testControlsEnabled(loadConfig(production))).toBe(false);
  });

  it('refuses to start production with them on', () => {
    expect(() => loadConfig({ ...production, E2E_TEST_CONTROLS: 'on' })).toThrow(
      'E2E_TEST_CONTROLS cannot be turned on in production',
    );
    // Whatever built the configuration, production never mounts them.
    const forced = { ...loadConfig(production), E2E_TEST_CONTROLS: 'on' as const };
    expect(testControlsEnabled(forced)).toBe(false);
  });
});
