import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Property-based tests are CPU-bound. CI's integration job runs every suite at once, where a
    // schedule property test that takes 0.2 s alone took 6 s (M3), past the 5 s default.
    testTimeout: 30_000,
  },
});
