import {
  CHANNEL_LABELS,
  CONSENT_CHANNELS,
  isConsentChannel,
  type Channel,
  type ConsentChannel,
} from './channels';

/**
 * STOP, STOP ALL, UNSUBSCRIBE and START (CM-09; M6 decision 7). They are recognised before
 * anything else, whatever state the conversation is in (plan 4.4). Only the keyword on its own
 * counts: "please stop the noise" is a message, not an opt-out.
 */
export type Keyword =
  { readonly kind: 'stop'; readonly scope: 'channel' | 'all' } | { readonly kind: 'start' };

/** Upper case, single spaces, and no punctuation or emoji around the words. */
export function normaliseKeywordText(text: string): string {
  return text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE']);
const STOP_ALL = new Set(['STOP ALL', 'UNSUBSCRIBE ALL']);

export function parseKeyword(text: string | null | undefined): Keyword | null {
  if (!text) return null;
  const words = normaliseKeywordText(text);
  if (STOP_ALL.has(words)) return { kind: 'stop', scope: 'all' };
  if (STOP_WORDS.has(words)) return { kind: 'stop', scope: 'channel' };
  if (words === 'START') return { kind: 'start' };
  return null;
}

/** A YES to the WhatsApp consent question (plan 4.8). */
export function isAffirmative(text: string | null | undefined): boolean {
  if (!text) return false;
  return ['YES', 'Y', 'YES PLEASE'].includes(normaliseKeywordText(text));
}

/**
 * What a keyword does (decision 7): STOP or UNSUBSCRIBE withdraws consent on the channel it came
 * in on; STOP ALL on every channel; START grants the channel it came in on again. A keyword typed
 * in the app changes nothing by itself: push is the app's own toggle.
 */
export function keywordEffect(
  keyword: Keyword,
  arrivedOn: Channel,
): { readonly action: 'grant' | 'withdraw'; readonly channels: readonly ConsentChannel[] } {
  if (keyword.kind === 'start')
    return {
      action: 'grant',
      channels: isConsentChannel(arrivedOn) && arrivedOn !== 'push' ? [arrivedOn] : [],
    };
  if (keyword.scope === 'all') return { action: 'withdraw', channels: [...CONSENT_CHANNELS] };
  return { action: 'withdraw', channels: isConsentChannel(arrivedOn) ? [arrivedOn] : [] };
}

/**
 * The one confirmation after STOP (decision 6): what stopped, how to stop the rest, and how to
 * start again. Plain text, no amounts or addresses.
 */
export function optOutConfirmationText(input: {
  readonly companyName: string;
  readonly keyword: Keyword;
  readonly arrivedOn: Channel;
}): string {
  const { companyName, keyword, arrivedOn } = input;
  if (keyword.kind === 'start')
    return `You will get messages from ${companyName} on ${CHANNEL_LABELS[arrivedOn]} again. Reply STOP at any time to stop them.`;
  if (keyword.scope === 'all')
    return `You will no longer get messages from ${companyName} on any channel. Reply START on a channel to get messages there again.`;
  return `You will no longer get messages from ${companyName} on ${CHANNEL_LABELS[arrivedOn]}. To stop SMS, email and app notifications too, reply STOP ALL. Reply START to get messages here again.`;
}

/**
 * STOP, STOP ALL and START typed in the tenant app (M6 review M2; decision 1). Until there is an
 * SMS short code, the app is how a tenant stops SMS: STOP stops SMS, STOP ALL every channel, and
 * START gives SMS back. Push stays the app's own toggle.
 */
export function appKeywordEffect(keyword: Keyword): {
  readonly action: 'grant' | 'withdraw';
  readonly channels: readonly ConsentChannel[];
} {
  if (keyword.kind === 'start') return { action: 'grant', channels: ['sms'] };
  if (keyword.scope === 'all') return { action: 'withdraw', channels: [...CONSENT_CHANNELS] };
  return { action: 'withdraw', channels: ['sms'] };
}

/** The app's confirmation in the thread, naming the landlord the conversation is with. */
export function appOptOutConfirmationText(input: {
  readonly companyName: string;
  readonly keyword: Keyword;
}): string {
  const { companyName, keyword } = input;
  if (keyword.kind === 'start')
    return `You will get SMS from ${companyName} again. Write STOP here at any time to stop them.`;
  if (keyword.scope === 'all')
    return `You will no longer get messages from ${companyName} on any channel. Write START here to get SMS again, or turn notifications on in Profile.`;
  return `You will no longer get SMS from ${companyName}. To stop WhatsApp, email and app notifications too, write STOP ALL. Write START to get SMS again.`;
}

/**
 * The confirmation for a keyword sent to the shared number or SMS code (M6 review MF-1; the
 * founder's reversible default). It applies to every landlord that knows the phone, so it names
 * none of them (TL-12).
 */
export function sharedOptOutConfirmationText(input: {
  readonly keyword: Keyword;
  readonly arrivedOn: Channel;
}): string {
  const { keyword, arrivedOn } = input;
  if (keyword.kind === 'start')
    return `You will get messages here on ${CHANNEL_LABELS[arrivedOn]} again. Reply STOP at any time to stop them.`;
  if (keyword.scope === 'all')
    return 'You will no longer get messages from your landlords through this service, on any channel. Reply START on a channel to get messages there again.';
  return `You will no longer get messages from your landlords here on ${CHANNEL_LABELS[arrivedOn]}. To stop SMS, email and app notifications too, reply STOP ALL. Reply START to get messages here again.`;
}
