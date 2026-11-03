import { MOMO_NETWORKS, type INTENT_STATUSES } from '@rent/contracts';
import { formatBusinessDate, formatInstant, instantFrom } from '@rent/domain/dates';
import { format, money, parseAmount } from '@rent/domain/money';

/**
 * The pay page's words and form (BC-04; M4b plan 4.3). Amounts arrive from the API as integer
 * pesewas and are formatted here only, through packages/domain/money (CLAUDE.md section 4). Server
 * code only: nothing here ships to the browser.
 */

export type MomoNetwork = (typeof MOMO_NETWORKS)[number];
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** `GH₵1,500.00`, from integer pesewas. */
export const cedis = (amountMinor: number): string => format(money(amountMinor));

/** The amount box's starting value, `1,500.00`, which the form reads back exactly. */
export function amountFieldValue(amountMinor: number): string {
  return amountMinor > 0 ? cedis(amountMinor).replace('GH₵', '') : '';
}

/** A business date in words: `1 November 2026`. */
export function day(iso: string): string {
  try {
    return formatBusinessDate(iso);
  } catch {
    return iso;
  }
}

/** An instant for people, always naming the zone (DO-04). */
export function when(iso: string, timeZone: string): string {
  try {
    return formatInstant(instantFrom(iso), timeZone);
  } catch {
    return iso;
  }
}

/** A payment the provider has not finished with: the page waits and checks again. */
export const isWaiting = (status: IntentStatus | null | undefined): boolean =>
  status === 'initiated' || status === 'pending';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isIntentId = (value: string | undefined): value is string =>
  typeof value === 'string' && UUID.test(value);

/** A form's one-time id (the contract's 16 to 64 base64url characters): 192 random bits. */
export function newSubmissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const SUBMISSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The method radio's values: one per MoMo network, and card. */
export const METHOD_VALUES = [...MOMO_NETWORKS.map((n) => `momo-${n}` as const), 'card'] as const;
export type MethodValue = (typeof METHOD_VALUES)[number];
export const isMethodValue = (value: string | undefined): value is MethodValue =>
  (METHOD_VALUES as readonly string[]).includes(value ?? '');

export interface PayRequest {
  readonly amountMinor: number;
  readonly method: 'momo' | 'card';
  readonly momo: { readonly phone: string; readonly network: MomoNetwork } | null;
  readonly submissionId: string;
}

export type PayForm =
  | { readonly ok: true; readonly request: PayRequest; readonly methodValue: MethodValue }
  | {
      readonly ok: false;
      /** One of this app's own codes, shown through payProblemText. */
      readonly error: string;
      /** What the tenant chose, to put back on the form; never the phone number. */
      readonly amountMinor: number | null;
      readonly methodValue: MethodValue | null;
    };

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Digits, spaces, brackets, dashes and a leading +: the API makes it E.164 or refuses it. */
const PHONE_SHAPE = /^\+?[\d\s()-]{9,24}$/;

/**
 * Reads the pay form. The amount is parsed exactly, in packages/domain/money; limits are the
 * API's to enforce, since only it knows the rent left to the end of the term (decision 7).
 */
export function readPayForm(form: FormData): PayForm {
  const choice = text(form, 'method');
  const methodValue = isMethodValue(choice) ? choice : null;
  let amountMinor: number | null = null;
  try {
    amountMinor = parseAmount(text(form, 'amount')).amountMinor;
  } catch {
    amountMinor = null;
  }
  const fail = (error: string): PayForm => ({
    ok: false,
    error,
    amountMinor: amountMinor !== null && amountMinor > 0 ? amountMinor : null,
    methodValue,
  });
  if (amountMinor === null) return fail('AMOUNT_FORMAT');
  if (amountMinor <= 0) return fail('AMOUNT_TOO_SMALL');
  if (!methodValue) return fail('METHOD_REQUIRED');
  let momo: PayRequest['momo'] = null;
  if (methodValue !== 'card') {
    const phone = text(form, 'momoPhone');
    if (!phone) return fail('PHONE_REQUIRED');
    if (!PHONE_SHAPE.test(phone)) return fail('PHONE_INVALID');
    momo = { phone, network: methodValue.slice('momo-'.length) as MomoNetwork };
  }
  const submitted = text(form, 'submissionId');
  return {
    ok: true,
    methodValue,
    request: {
      amountMinor,
      method: momo ? 'momo' : 'card',
      momo,
      // A hand-made post without one still gets a charge of its own, once.
      submissionId: SUBMISSION_ID.test(submitted) ? submitted : newSubmissionId(),
    },
  };
}

/** An API error code fit for the page's address: upper-case letters, digits, `_` and `.`. */
export function errorCode(code: string): string {
  return /^[A-Z0-9_.]{1,64}$/.test(code) ? code : 'ERROR';
}

export interface AmountLimits {
  readonly minMinor: number;
  readonly maxMinor: number;
}

/**
 * The words for a failed attempt, from the code in the page's address. Only codes are carried
 * there, never the API's own message, so nobody can make this page say something of their own.
 * The API's codes are matched by what they contain, since a module prefixes its own.
 */
export function payProblemText(code: string | undefined, limits: AmountLimits): string | null {
  if (!code) return null;
  const has = (part: string) => code.includes(part);
  if (code === 'AMOUNT_FORMAT') return 'Enter the amount in cedis, such as 1500 or 1,500.50.';
  if (has('AMOUNT_TOO_SMALL') || has('AMOUNT_TOO_LOW'))
    return `Pay at least ${cedis(limits.minMinor)}.`;
  if (has('AMOUNT_TOO_LARGE') || has('AMOUNT_TOO_HIGH'))
    return `You can pay at most ${cedis(limits.maxMinor)}: the rent left to the end of your lease.`;
  if (code === 'METHOD_REQUIRED') return 'Choose how you want to pay.';
  if (code === 'PHONE_REQUIRED') return 'Enter the MoMo number to charge.';
  if (has('PHONE'))
    return 'Check the MoMo number: a Ghana mobile number of 10 digits, starting with 0.';
  if (has('RATE_LIMITED') || has('TOO_MANY'))
    return 'Too many attempts. Wait a few minutes and try again.';
  if (has('NOT_USABLE') || has('EXPIRED') || has('SETTLED') || has('REVOKED'))
    return 'This link can no longer take payments.';
  if (has('UNAVAILABLE') || has('PROVIDER'))
    return 'We could not reach the payment service. Try again in a few minutes.';
  return 'We could not start the payment. Check the amount and the number, then try again.';
}

export type PayView = 'closed' | 'settled' | 'paid' | 'unavailable' | 'waiting' | 'pay';

/**
 * Which screen the pay page shows: an expired or replaced link explains itself; a settled
 * invoice takes no more payments; a landlord who cannot take payments now gives their own
 * instructions; a payment the provider has not finished with waits, unless the tenant chose to
 * start again; otherwise the form.
 */
export function chooseView(input: {
  readonly screen: 'pay' | 'paid' | 'settled' | 'expired' | 'revoked' | 'unavailable';
  readonly methods: readonly string[];
  readonly intentStatus: IntentStatus | null;
  readonly startAgain: boolean;
}): PayView {
  switch (input.screen) {
    case 'expired':
    case 'revoked':
      return 'closed';
    case 'settled':
    case 'paid':
    case 'unavailable':
      return input.screen;
    default:
      if (input.methods.length === 0) return 'unavailable';
      return isWaiting(input.intentStatus) && !input.startAgain ? 'waiting' : 'pay';
  }
}

/**
 * The tenant has just made the payment the page follows: it is in the address, put there by the
 * form's redirect, or the provider's checkout has just sent them back (Paystack adds `trxref`
 * and `reference` to the return address).
 */
export function justPaid(query: Readonly<Record<string, string | undefined>>): boolean {
  return isIntentId(query.intent) || returnedFromCheckout(query);
}

export function returnedFromCheckout(query: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(query.returned || query.trxref || query.reference);
}

/** Only a web page may be the card checkout: the URL comes from the API, but is checked anyway. */
export function checkoutHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * How long the waiting page waits before it checks again: every 5 seconds for the first
 * half-minute, every 15 seconds to about 3 minutes, then once a minute. About 30 checks in 15
 * minutes, so a tenant who leaves the page open stays within the link's rate limit.
 */
export function recheckSeconds(checksSoFar: number): number {
  if (checksSoFar < 6) return 5;
  if (checksSoFar < 16) return 15;
  return 60;
}

/** The count of checks so far, from the page's address. */
export function checksFrom(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n < 10_000 ? n : 0;
}
