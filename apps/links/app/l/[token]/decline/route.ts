import { clientFrom, declineLink, isToken } from '../../../../lib/links-api';
import { backToPage, notFoundResponse } from '../../../../lib/redirect';

/** Declines to sign, with a reason; the lease goes back to the landlord as a draft. */
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
  return backToPage(token, { error: result.code, step: 'decline' });
}
