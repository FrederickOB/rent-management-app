import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the pure helpers only; e2e/*.spec.ts belong to Playwright. `@/` is the app root,
// as in tsconfig.json, so a test can reach a helper that imports through it (components/nav).
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./', import.meta.url)) }],
  },
  test: {
    include: ['lib/**/*.test.ts'],
  },
});
