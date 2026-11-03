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

export const notFoundResponse = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
