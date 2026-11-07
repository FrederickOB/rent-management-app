import { codeDetails, errorOf, textOf } from '../../../../lib/job-sheet';
import { onlyOnce } from '../../../../lib/job-sheet-store';
import { clientFrom, isToken, sendJobSheetCode } from '../../../../lib/links-api';
import { backToJobSheet, notFoundResponse } from '../../../../lib/redirect';

/**
 * "Send me a code": the API sends it to the artisan's phone on record, never one typed here. A
 * second tap on the same form gets the first one's answer, so one tap sends one code.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  const form = await request.formData().catch(() => new FormData());
  return onlyOnce(token, textOf(form, 'form'), async () => {
    const result = await sendJobSheetCode(token, clientFrom(request.headers));
    if (result.ok) return backToJobSheet(token, { sent: '1' }, '#act');
    if (result.status === 404) return notFoundResponse();
    return backToJobSheet(token, { error: errorOf(result), ...codeDetails(result) }, '#act');
  });
}
