import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const envFile = path.resolve(import.meta.dirname, '../../.env');
const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
// Global setup runs in this process, not in a test worker, so it needs the variables too.
for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

export default defineConfig({
  test: {
    env: { ...env, ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn' } as Record<string, string>,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
          globalSetup: ['./test/support/global-setup.ts'],
          // 60 s, founder-approved 2026-11-06 (M9 §9): TL-07's reminder and recall tests and BC-06
          // are slow under the full run's load (the reminder test: 1.8 s alone, up to 30 s there).
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
