import { clientFrom, isToken, receiptDocument } from '../../../../lib/links-api';
import { backToReceipt, notFoundResponse, seeOther } from '../../../../lib/redirect';

/** The receipt PDF: a fresh 5-minute storage link for each download, behind the 30-day link. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const result = await receiptDocument(token, clientFrom(request.headers));
  if (result.ok) return seeOther(result.value.url);
  if (result.status === 404) return notFoundResponse();
  return backToReceipt(token, { download: 'unavailable' });
}
