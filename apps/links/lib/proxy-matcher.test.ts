import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { config as proxyConfig } from '../proxy';

// M8 review LT 1: Next.js copies a post's body for the proxy and cuts it at 10 MB, warning with
// the URL and its token. The job sheet's two photo posts, which carry up to ten 10 MB photos, are
// therefore left out of the proxy; every other path still goes through it.

const TOKEN = 'm'.repeat(43);

describe('MI-06 the proxy and the job sheet’s photo posts (review LT 1)', () => {
  it('the proxy never sees the two photo posts, and still runs everywhere else', () => {
    // Next.js's own compiler for the matcher, as `next build` runs it. Loading it patches how
    // errors print, which is why this test has a file of its own.
    const { getMiddlewareMatchers } = createRequire(import.meta.url)(
      'next/dist/build/analysis/get-page-static-info',
    ) as {
      getMiddlewareMatchers: (matcher: unknown, config: object) => { regexp: string }[];
    };
    const matchers = getMiddlewareMatchers(proxyConfig.matcher, {}).map(
      (m) => new RegExp(m.regexp),
    );
    const runs = (path: string) => matchers.some((re) => re.test(path));
    for (const path of [
      '/',
      '/health',
      `/l/${TOKEN}`,
      `/p/${TOKEN}`,
      `/j/${TOKEN}`,
      `/j/${TOKEN}/respond`,
      `/j/${TOKEN}/code`,
      `/j/${TOKEN}/attachment/0193a7c0-0000-7000-8000-0000000c0001`,
      '/_next/static/chunks/main.js',
    ])
      expect(runs(path), path).toBe(true);
    expect(runs(`/j/${TOKEN}/start`)).toBe(false);
    expect(runs(`/j/${TOKEN}/complete`)).toBe(false);
  });
});
