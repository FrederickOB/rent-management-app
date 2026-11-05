import { errorOf, textOf } from '../../../../lib/job-sheet';
import { clientFrom, isToken, respondJobSheet } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';

/** Accept or decline the job (decision 6); a decline may say why. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => new FormData());
  const response = textOf(form, 'response') === 'declined' ? 'declined' : 'accepted';
  const reason = textOf(form, 'reason') || null;
  const result = await respondJobSheet(token, clientFrom(request.headers), response, reason);
  if (result.ok) return backToJobSheet(token, { done: response });
  if (result.status === 404) return notFoundResponse();
  return backToJobSheet(
    token,
    { error: errorOf(result), step: response === 'declined' ? 'decline' : null },
    '#act',
  );
}
