import { keyFor, ME_KEY } from './cache';

/**
 * How many tenancies each landlord had in the copy last cached in this browser (src/cache.ts),
 * read at once: on the web the cache is the browser's local storage, which AsyncStorage reads
 * and writes under the same keys. Null when there is no copy, or it cannot be read.
 */
export function cachedTenancyCounts(personId: string | null): readonly number[] | null {
  try {
    const person =
      personId ??
      (JSON.parse(window.localStorage.getItem(ME_KEY) ?? 'null') as { personId?: unknown } | null)
        ?.personId;
    if (typeof person !== 'string') return null;
    const kept = JSON.parse(window.localStorage.getItem(keyFor(person, 'tenancies')) ?? 'null') as {
      data?: unknown;
    } | null;
    if (!Array.isArray(kept?.data)) return null;
    return kept.data.map((group: { tenancies?: unknown }) =>
      Array.isArray(group?.tenancies) ? group.tenancies.length : 0,
    );
  } catch {
    return null;
  }
}
