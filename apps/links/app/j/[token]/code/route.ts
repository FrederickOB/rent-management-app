import { errorOf } from '../../../../lib/job-sheet';
import { clientFrom, isToken, sendJobSheetCode } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';

/** "Send me a code": the API sends it to the artisan's phone on record, never one typed here. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const result = await sendJobSheetCode(token, clientFrom(request.headers));
  if (result.ok) return backToJobSheet(token, { sent: '1' }, '#act');
  if (result.status === 404) return notFoundResponse();
  return backToJobSheet(token, { error: errorOf(result) }, '#act');
}
