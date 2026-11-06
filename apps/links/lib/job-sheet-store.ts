import { createHash } from 'node:crypto';

/**
 * What the job sheet remembers between posts, in this server's memory only (M8 review LT 6):
 *
 * - **Photos already in storage** after a refused completion (a wrong or expired code), so the
 *   artisan retries with the code alone and nothing is uploaded twice. Kept for 30 minutes.
 * - **Forms already being handled,** by the form's own id, so a second tap on the same form waits
 *   for the first and gets the same answer, instead of uploading and sending again.
 *
 * Keys hold a hash of the token, never the token. Kept on `globalThis`, so the page and the routes
 * share it whichever bundle loads them. With several servers, a retry that reaches another one
 * simply asks for the photos again.
 */
const KEPT_MS = 30 * 60_000;
const FORM_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Snapshot {
  readonly status: number;
  readonly headers: readonly [string, string][];
  readonly body: string | null;
}
interface Store {
  readonly kept: Map<string, { readonly uploadIds: readonly string[]; readonly at: number }>;
  readonly forms: Map<string, { readonly at: number; readonly answer: Promise<Snapshot> }>;
}

const holder = globalThis as typeof globalThis & { __rentJobSheetStore?: Store };
const store: Store = (holder.__rentJobSheetStore ??= { kept: new Map(), forms: new Map() });

const keyOf = (token: string) => createHash('sha256').update(token).digest('base64url');

function prune(now = Date.now()): void {
  for (const [key, entry] of store.kept) if (now - entry.at > KEPT_MS) store.kept.delete(key);
  for (const [key, entry] of store.forms) if (now - entry.at > FORM_MS) store.forms.delete(key);
}

/** Photos uploaded for a completion the API refused: the next try may use them. */
export function keepUploads(token: string, uploadIds: readonly string[]): void {
  if (uploadIds.length === 0) return;
  store.kept.set(keyOf(token), { uploadIds: [...uploadIds], at: Date.now() });
}

export function keptUploads(token: string): readonly string[] {
  prune();
  return store.kept.get(keyOf(token))?.uploadIds ?? [];
}

export function forgetUploads(token: string): void {
  store.kept.delete(keyOf(token));
}

/** A fresh id for one rendering of a form, sent back with it. */
export const newFormId = (): string => crypto.randomUUID();

async function snapshot(response: Response): Promise<Snapshot> {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: response.body ? await response.text() : null,
  };
}

/**
 * Runs a form's action once per form id: a second post of the same form, while the first runs or
 * after it answered, gets the first one's answer. A post without a well-formed id simply runs.
 */
export async function onlyOnce(
  token: string,
  formId: string,
  run: () => Promise<Response>,
): Promise<Response> {
  if (!UUID.test(formId)) return run();
  prune();
  const key = `${keyOf(token)}:${formId.toLowerCase()}`;
  const earlier = store.forms.get(key);
  if (earlier) {
    const answer = await earlier.answer;
    return new Response(answer.body, { status: answer.status, headers: [...answer.headers] });
  }
  const first = (async () => {
    const response = await run();
    return { response, copy: await snapshot(response.clone()) };
  })();
  const answer = first.then((done) => done.copy);
  store.forms.set(key, { at: Date.now(), answer });
  answer.catch(() => store.forms.delete(key));
  return (await first).response;
}
