// The words for a failed action on a signing page (TL-07), from the code the API gave.

type Query = Readonly<Record<string, string | undefined>>;

/** What went wrong with the last action, from the API's error code. */
const PROBLEMS: Readonly<Record<string, string>> = {
  CODE_WRONG: 'That code is not right.',
  CODE_EXPIRED: 'That code has expired. Send yourself a new one.',
  CODE_REQUIRED: 'Send yourself a code first.',
  CODE_LIMIT: 'We have sent several codes already. Wait a few minutes before asking for another.',
  CODE_FORMAT: 'Enter the 6-digit code we sent you.',
  CODE_NOT_SENT: 'We could not send your code just now. Wait a minute and try again.',
  CONSENT_REQUIRED: 'Tick the box to agree to sign electronically.',
  SIGNATURE_REQUIRED: 'Type your full name, or draw your signature, to sign.',
  DRAWING_INVALID: 'Draw your signature again.',
  REASON_REQUIRED: 'Say in a few words why you are declining.',
  SIGNING_LOCKED: 'Too many wrong codes. Signing is locked for 30 minutes.',
  RATE_LIMITED: 'Too many requests. Wait a few minutes and try again.',
  LINK_NOT_USABLE: 'This link can no longer be used to sign.',
};

/** The problem to show, with the tries left when the API said how many. */
export function problemText(query: Query): string | null {
  if (!query.error) return null;
  // The code comes from the page's query string, so only the map's own entries count: never
  // `constructor` or anything else an object inherits.
  const text = Object.hasOwn(PROBLEMS, query.error)
    ? PROBLEMS[query.error]!
    : 'Something went wrong on our side. Try again in a minute.';
  const left = query.left ? Number(query.left) : NaN;
  return Number.isFinite(left)
    ? `${text} You have ${left} ${left === 1 ? 'try' : 'tries'} left.`
    : text;
}
