import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientFrom, isToken, openLink } from '../../../lib/links-api';
import { CopyScreen, Explanation, SignScreen, Trouble } from './screens';

/**
 * A secure link (CLAUDE.md section 9; M3 plan 4.8): the signing page, the signed-copy page, or
 * an explanation for a link that no longer signs, with the landlord's contact details. Rendered
 * on the server for every request; the token is never shown, logged or put in a Referer, and
 * the page sets no cookie. An unknown token is simply not found.
 */
export default async function SecureLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isToken(token)) notFound();
  const query = Object.fromEntries(
    Object.entries(await searchParams).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const result = await openLink(token, clientFrom(await headers()));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <Trouble busy={result.status === 429} />;
  }
  const page = result.value;
  switch (page.screen) {
    case 'sign':
      return <SignScreen token={token} page={page} query={query} />;
    case 'copy':
      return <CopyScreen token={token} page={page} />;
    default:
      return <Explanation token={token} page={page} done={query.done} />;
  }
}
