import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a running stack (pnpm dev, or CI's services): the API on 3700 with the demo
 * seed loaded, and this app on 3701. One worker, because the tests share seeded accounts and
 * the agency's branding, and sign-ins share one per-IP rate limit through the web proxy.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.WEB_ORIGIN ?? 'http://localhost:3701',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
