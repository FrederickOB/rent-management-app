import { clientFrom, documentLink, isToken } from '../../../../lib/links-api';
import { backToPage, notFoundResponse, seeOther } from '../../../../lib/redirect';

/**
 * The PDF: the frozen document on a signing link, the signed copy on a copy link. A fresh
 * 5-minute storage link is made for each download, so the page never holds one that expires.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const result = await documentLink(token, clientFrom(request.headers));
  if (result.ok) return seeOther(result.value.url);
  if (result.status === 404) return notFoundResponse();
  return backToPage(token, { error: result.code }, '');
}
