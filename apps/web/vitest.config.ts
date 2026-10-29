import { defineConfig } from 'vitest/config';

// Unit tests for the pure helpers only; e2e/*.spec.ts belong to Playwright.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
  },
});
