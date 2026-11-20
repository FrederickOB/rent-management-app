import { defineConfig, devices } from '@playwright/test';

// A port of its own, clear of pnpm dev (3700 to 3702), the fake providers (4010) and Expo (8081).
const PORT = 3792;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // A 5-inch phone (CLAUDE.md section 9): 360 by 640 CSS pixels.
    ...devices['Galaxy S5'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-5-inch' }],
  webServer: {
    // A production build, written to .next/e2e so a running `next start` or `next dev` keeps
    // its own files.
    command: `./node_modules/.bin/next build && ./node_modules/.bin/next start --hostname 127.0.0.1 --port ${PORT}`,
    // Production, whatever the shell exports: the stack's script exports NODE_ENV=development for
    // the API, and `next build` fails under it.
    env: { LINKS_DIST_DIR: '.next/e2e', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    url: `${baseURL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
