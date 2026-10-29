import { clientFrom, isToken, signLink } from '../../../../lib/links-api';
import { backToPage, notFoundResponse } from '../../../../lib/redirect';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** Signs with the code, a typed name or a drawing, and the consent tick. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isToken(token)) return notFoundResponse();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToPage(token, { error: 'SIGNATURE_REQUIRED' });
  }
  const method = text(form, 'method') === 'drawn' ? 'drawn' : 'typed';
  const result = await signLink(token, clientFrom(request.headers), {
    code: text(form, 'code').replace(/\s+/g, ''),
    method,
    typedName: method === 'typed' ? text(form, 'typedName') : null,
    drawing: method === 'drawn' ? text(form, 'drawing') || null : null,
    consentVersion: text(form, 'consentVersion'),
    consentAccepted: text(form, 'consent') === 'yes',
  });
  if (result.ok) return backToPage(token, { done: 'signed' }, '');
  return backToPage(token, {
    error: result.code,
    left: result.data?.attemptsLeft,
    draw: method === 'drawn' ? '1' : null,
  });
}
