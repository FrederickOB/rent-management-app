import { keyFor, ME_KEY } from '../src/cache';
import { cachedTenancyCounts } from '../src/cache-peek.web';

// M11 review (founder decision 8's layout budget): Home holds its tenancies' place while they load,
// sized on the web from the copy last cached in the browser, read during the first render.

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
      },
    },
  });
});

const PERSON = '0193a7c0-0000-7000-8000-0000000000aa';
const cache = (groups: unknown) =>
  stored.set(
    keyFor(PERSON, 'tenancies'),
    JSON.stringify({ data: groups, savedAt: '2026-11-10T09:00:00.000Z' }),
  );

describe('NFR-PERF TL-01 the tenancies last cached, read at once on the web', () => {
  it('counts each landlord’s tenancies in the cached copy', () => {
    cache([{ tenancies: [{}, {}] }, { tenancies: [{}] }]);
    expect(cachedTenancyCounts(PERSON)).toEqual([2, 1]);
  });

  it('finds the person last signed in on this device before the session is known', () => {
    cache([{ tenancies: [{}] }]);
    stored.set(ME_KEY, JSON.stringify({ personId: PERSON }));
    expect(cachedTenancyCounts(null)).toEqual([1]);
  });

  it('says nothing without a copy, or with one it cannot read', () => {
    expect(cachedTenancyCounts(PERSON)).toBeNull();
    stored.set(keyFor(PERSON, 'tenancies'), '{not json');
    expect(cachedTenancyCounts(PERSON)).toBeNull();
    expect(cachedTenancyCounts(null)).toBeNull();
  });
});
