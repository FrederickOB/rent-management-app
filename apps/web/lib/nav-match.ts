/**
 * The navigation item for a path: the most specific one that contains it, so /portfolio/import
 * marks Import rather than Portfolio, and /portfolio/units/… still marks Portfolio.
 */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches =
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
