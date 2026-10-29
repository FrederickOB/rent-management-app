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
    env: { ...env, ...process.env, NODE_ENV: 'test' } as Record<string, string>,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['./src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
