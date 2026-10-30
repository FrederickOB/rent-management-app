import { describe, expect, it } from 'vitest';
import { activeNavHref } from './nav-match';

const HREFS = ['/', '/portfolio', '/owners', '/portfolio/import', '/settings/users'];

describe('AD-03 navigation', () => {
  it('marks the most specific section that contains the page', () => {
    expect(activeNavHref('/', HREFS)).toBe('/');
    expect(activeNavHref('/portfolio', HREFS)).toBe('/portfolio');
    expect(activeNavHref('/portfolio/units/019a3000', HREFS)).toBe('/portfolio');
    expect(activeNavHref('/portfolio/import', HREFS)).toBe('/portfolio/import');
    expect(activeNavHref('/settings/users', HREFS)).toBe('/settings/users');
  });

  it('does not match on a shared prefix alone', () => {
    expect(activeNavHref('/portfolios', HREFS)).toBeNull();
    expect(activeNavHref('/audit', HREFS)).toBeNull();
  });
});
