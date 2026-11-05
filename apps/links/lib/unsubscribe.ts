import type { ApiResult, UnsubscribePage } from './links-api';
import { backToUnsubscribe } from './redirect';

// The email unsubscribe page, /u/[token] (CM-09; M6 decision 7 and plan 4.8). Opening the link
// changes nothing; one confirmation withdraws email consent for the person and the landlord the
// link was sent for. A mail client's one-click unsubscribe (RFC 8058) posts to the same confirm
// route, which a GET never reaches: link scanners open every link in an email.

type Query = Readonly<Record<string, string | undefined>>;

/** Shown when the landlord's name is missing, which the API sends only for an unknown token. */
const SOME_LANDLORD = 'your landlord';

/** What the page shows, from the API's answer to opening the link. */
export type UnsubscribeView =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'trouble'; readonly busy: boolean }
  | { readonly kind: 'expired'; readonly landlordName: string }
  /** C6: sent to an email that is no longer the one on record. Nothing changes; no address shows. */
  | { readonly kind: 'address_changed'; readonly landlordName: string }
  | {
      readonly kind: 'confirm' | 'done';
      readonly landlordName: string;
      readonly emailMasked: string | null;
    };

export function unsubscribeView(result: ApiResult<UnsubscribePage>): UnsubscribeView {
  if (!result.ok) {
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'trouble', busy: result.status === 429 };
  }
  const page = result.value;
  const landlordName = page.landlordName ?? SOME_LANDLORD;
  switch (page.screen) {
    case 'invalid':
      return { kind: 'not_found' };
    case 'expired':
      return { kind: 'expired', landlordName };
    case 'address_changed':
      return { kind: 'address_changed', landlordName };
    case 'confirm':
    case 'done':
      return { kind: page.screen, landlordName, emailMasked: page.emailMasked };
  }
}

const PROBLEMS: Readonly<Record<string, string>> = {
  RATE_LIMITED: 'Too many requests. Wait a few minutes and try again.',
  UNAVAILABLE: 'We could not stop the emails just now. Try again in a minute.',
};

/** Why the last press did not go through, from the page's query string. */
export function unsubscribeProblemText(query: Query): string | null {
  if (!query.error) return null;
  // Only the map's own entries count: never `constructor` or anything an object inherits.
  return Object.hasOwn(PROBLEMS, query.error) ? PROBLEMS[query.error]! : PROBLEMS.UNAVAILABLE!;
}

/** RFC 8058: a mail client's one-click unsubscribe posts `List-Unsubscribe=One-Click`. */
export function isOneClick(form: FormData | null): boolean {
  return form?.get('List-Unsubscribe') === 'One-Click';
}

const plain = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * The answer to a confirmation. The page's button gets a 303 back to the page (post, redirect,
 * get), which then shows what the API says; a mail client's one-click post comes from the mail
 * provider's servers, which read only the status, so it gets a short plain answer.
 */
export function confirmResponse(
  token: string,
  result: ApiResult<UnsubscribePage>,
  oneClick: boolean,
): Response {
  if (oneClick) {
    if (result.ok) {
      switch (result.value.screen) {
        case 'expired':
          return plain(410, 'This unsubscribe link has expired.');
        case 'address_changed':
          // The address it was sent to is no longer on record: nothing was changed.
          return plain(409, 'This link is for an email address that is no longer on record.');
        case 'invalid':
          return plain(404, 'Not found');
        case 'confirm':
        case 'done':
          return plain(200, 'Unsubscribed from these emails.');
      }
    }
    if (result.status === 404) return plain(404, 'Not found');
    if (result.status === 429) return plain(429, 'Too many requests.');
    return plain(503, 'Try again later.');
  }
  // A link the API does not know is not found on the page itself.
  if (result.ok || result.status === 404) return backToUnsubscribe(token, {});
  return backToUnsubscribe(token, {
    error: result.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
  });
}
