import { clientFrom, declineLink, isToken } from '../../../../lib/links-api';
import { declineProblem, NOTICE_NOT_DECLINABLE } from '../../../../lib/notice';
import { backToPage, notFoundResponse } from '../../../../lib/redirect';

/**
 * Declines to sign, with a reason; the lease goes back to the landlord as a draft. A notice
 * cannot be declined (M7 plan 4.5): its page offers no decline, and the API refuses one with 409.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => null);
  const reason = form?.get('reason');
  const result = await declineLink(
    token,
    clientFrom(request.headers),
    typeof reason === 'string' ? reason : '',
  );
  if (result.ok) return backToPage(token, { done: 'declined' }, '');
  const error = declineProblem(result);
  // A notice's page has no decline step to go back to.
  return backToPage(
    token,
    error === NOTICE_NOT_DECLINABLE ? { error } : { error, step: 'decline' },
  );
}
