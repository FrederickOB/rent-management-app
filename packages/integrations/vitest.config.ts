import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const envFile = path.resolve(import.meta.dirname, '../../.env');
const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

// Contract suites against apps/fake-providers over HTTP; their global setup starts a private instance.
const httpContracts = 'src/**/*.http.int.test.ts';

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
          exclude: [httpContracts],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contracts-http',
          include: [httpContracts],
          globalSetup: ['src/testing/fake-providers.global-setup.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
