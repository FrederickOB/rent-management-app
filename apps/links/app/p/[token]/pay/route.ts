import { clientFrom, isToken, startPay } from '../../../../lib/links-api';
import { errorCode, readPayForm } from '../../../../lib/pay';
import { backToPay, notFoundResponse } from '../../../../lib/redirect';

/**
 * "Pay": starts a MoMo prompt to the number given, or a card checkout (BC-04). Either way it
 * answers with 303 back to the pay page, which follows the payment from there: a reload never
 * charges twice, and the card checkout opens from a plain link on our page, since the strict
 * policy's form-action keeps a form from redirecting to another site.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => new FormData());
  const read = readPayForm(form);
  if (!read.ok)
    return backToPay(token, {
      error: read.error,
      amount: read.amountMinor,
      method: read.methodValue,
    });
  const result = await startPay(token, clientFrom(request.headers), read.request);
  if (result.ok) return backToPay(token, { intent: result.value.intentId });
  if (result.status === 404) return notFoundResponse();
  return backToPay(token, {
    error: result.status === 429 ? 'RATE_LIMITED' : errorCode(result.code),
    amount: read.request.amountMinor,
    method: read.methodValue,
  });
}
