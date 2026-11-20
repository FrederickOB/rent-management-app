/**
 * How many tenancies each landlord had in the copy last cached on this device, read during the
 * first render (Home sizes its loading place from it, M11 review). On iOS and Android the cache is
 * read only asynchronously, after the first frame, so there is nothing to read here; Home holds
 * about one card's place instead (src/cache-peek.web.ts reads it on the web).
 */
export function cachedTenancyCounts(_personId: string | null): readonly number[] | null {
  return null;
}
