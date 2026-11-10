import { defineConfig } from '@playwright/test';

/**
 * Lighthouse collection for the M11 page budgets (run.mjs runs it, then `lhci assert`). Against a
 * running stack, as CI's e2e job starts it: links on LINKS_BASE_URL (3702), the tenant web build
 * on TENANT_WEB_ORIGIN (8081), the API, the fake providers and Mailpit. One test at a time, so
 * the measurements never compete for the CPU.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.lh\.ts$/,
  timeout: 20 * 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
});
