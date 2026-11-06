import { clientFrom, confirmUnsubscribe, isToken } from '../../../../lib/links-api';
import { notFoundResponse, seeOther } from '../../../../lib/redirect';
import { confirmResponse, isOneClick } from '../../../../lib/unsubscribe';

/**
 * "Stop emails" (CM-09; M6 decision 7): the page's button, or a mail client's one-click
 * unsubscribe (RFC 8058, `List-Unsubscribe=One-Click`), which posts to the URL in the email's
 * List-Unsubscribe header. Withdrawing twice is harmless: the API is idempotent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => null);
  const result = await confirmUnsubscribe(token, clientFrom(request.headers));
  return confirmResponse(token, result, isOneClick(form));
}

/** A GET never unsubscribes, because link scanners open every link: it shows the page instead. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  return seeOther(`/u/${token}`);
}
