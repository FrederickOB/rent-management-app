/**
 * Form posts answer with 303 See Other back to the link's page (post, redirect, get), so a
 * reload never repeats an action. The Location is relative to this host. Nothing is cached.
 */
export function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

/** Back to the link's page, with what happened in the query and the sign section in view. */
export function backToPage(
  token: string,
  query: Readonly<Record<string, string | null | undefined>>,
  hash = '#sign',
): Response {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.size > 0 ? `?${params.toString()}` : '';
  return seeOther(`/l/${token}${search}${hash}`);
}

type PlainQuery = Readonly<Record<string, string | number | null | undefined>>;

function withQuery(path: string, query: PlainQuery): Response {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  const search = params.size > 0 ? `?${params.toString()}` : '';
  return seeOther(`${path}${search}`);
}

/** Back to a pay link's page (BC-04), with what happened in the query. */
export const backToPay = (token: string, query: PlainQuery): Response =>
  withQuery(`/p/${token}`, query);

/** Back to a receipt link's page (BC-06), with what happened in the query. */
export const backToReceipt = (token: string, query: PlainQuery): Response =>
  withQuery(`/r/${token}`, query);

export const notFoundResponse = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
