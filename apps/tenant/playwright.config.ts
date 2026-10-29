import { defineConfig, devices } from '@playwright/test';

/** Runs against a running stack (pnpm dev, or CI's services and the static web export). */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.TENANT_WEB_ORIGIN ?? 'http://localhost:8081',
    // A 5-inch phone (CLAUDE.md section 9 and PRD Devices).
    ...devices['Pixel 5'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-mobile', use: { browserName: 'chromium' } }],
});
