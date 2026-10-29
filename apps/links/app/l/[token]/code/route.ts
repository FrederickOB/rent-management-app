import { clientFrom, isToken, sendCode } from '../../../../lib/links-api';
import { backToPage, notFoundResponse } from '../../../../lib/redirect';

/** "Send me a code": the API sends it to the phone or email on record, never one typed here. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const result = await sendCode(token, clientFrom(request.headers));
  if (result.ok) return backToPage(token, { sent: '1' });
  return backToPage(token, { error: result.code });
}
