import { clientFrom, isToken, payInvoiceDocument } from '../../../../lib/links-api';
import { backToPay, notFoundResponse, seeOther } from '../../../../lib/redirect';

/**
 * The invoice PDF the pay link is for (BC-09: the first reminder is how an invoice reaches the
 * tenant). A fresh 5-minute storage link is made for each download, so the page never holds one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const result = await payInvoiceDocument(token, clientFrom(request.headers));
  if (result.ok) return seeOther(result.value.url);
  // The API says 404 both for a PDF still being rendered and for a link it does not know. Back
  // to the page either way: it explains the first, and is itself not found for the second.
  return backToPay(token, { invoice: 'unavailable' });
}
