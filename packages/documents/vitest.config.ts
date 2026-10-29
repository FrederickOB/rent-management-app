import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.int.test.{ts,tsx}'],
        },
      },
      {
        // These start Chromium, so they run with the integration tests.
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.{ts,tsx}'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
