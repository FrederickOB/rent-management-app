import type { Instant } from '../dates';
import type { ConsentChannel } from './channels';
import { REPLY_PURPOSES, STAFF_PURPOSES, type MessagePurpose } from './messaging';

/**
 * Consent (CM-09; M6 decisions 6, 7 and 8; plan 4.8). Business-initiated messages need consent on
 * the channel. A reply to a tenant who wrote in, on the channel they used and within 24 hours of
 * their message there, needs none; STOP still stops it, apart from one confirmation.
 */

/** Where a consent event came from (plan 4.2). `staff` is M3's; the rest are M6's. */
export const CONSENT_SOURCES = [
  'staff',
  'tenant_reply',
  'stop_keyword',
  'start_keyword',
  'tenant_app',
  'email_unsubscribe',
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The consent text version each source records (messaging.ts CONSENT_TEXTS). */
export function consentTextVersion(source: ConsentSource, action: 'grant' | 'withdraw'): string {
  switch (source) {
    case 'staff':
      return action === 'grant' ? 'messages.v1' : 'staff_withdraw.v1';
    case 'tenant_reply':
      return 'whatsapp_reply.v1';
    case 'stop_keyword':
      return 'stop.v1';
    case 'start_keyword':
      return 'start.v1';
    case 'tenant_app':
      return action === 'grant' ? 'app_toggle.v1' : 'app_toggle_off.v1';
    case 'email_unsubscribe':
      return 'email_unsubscribe.v1';
  }
}

/** Which sources may grant and which may withdraw. */
export function sourceAllows(source: ConsentSource, action: 'grant' | 'withdraw'): boolean {
  switch (source) {
    case 'staff':
    case 'tenant_app':
      return true;
    case 'tenant_reply':
    case 'start_keyword':
      return action === 'grant';
    case 'stop_keyword':
    case 'email_unsubscribe':
      return action === 'withdraw';
  }
}

/** The channels each source records on (decision 5: push consent is the app's toggle). */
export function sourceChannels(source: ConsentSource): readonly ConsentChannel[] {
  switch (source) {
    case 'staff':
      return ['push', 'whatsapp', 'sms', 'email'];
    case 'tenant_reply':
      return ['whatsapp'];
    // STOP ALL withdraws every channel, push included (decision 7); START comes in on a channel
    // a tenant can write on, and grants that one.
    case 'stop_keyword':
      return ['push', 'whatsapp', 'sms', 'email'];
    case 'start_keyword':
      return ['whatsapp', 'sms', 'email'];
    case 'tenant_app':
      return ['push'];
    case 'email_unsubscribe':
      return ['email'];
  }
}

/** The latest consent event on one channel for one person, if any was ever recorded. */
export interface ConsentFacts {
  readonly latest: { readonly action: 'grant' | 'withdraw'; readonly at: Instant } | null;
}

export const NO_CONSENT: ConsentFacts = { latest: null };

/** The latest of a subject's events on one channel (any order in, latest by time out). */
export function consentFactsOf(
  events: readonly { readonly action: 'grant' | 'withdraw'; readonly at: Instant }[],
): ConsentFacts {
  let latest: ConsentFacts['latest'] = null;
  for (const e of events)
    if (!latest || e.at.epochMilliseconds >= latest.at.epochMilliseconds)
      latest = { action: e.action, at: e.at };
  return { latest };
}

export const consentIsGranted = (facts: ConsentFacts): boolean => facts.latest?.action === 'grant';

/** Decision 6: a reply needs no consent within this many hours of the tenant's message. */
export const REPLY_WINDOW_HOURS = 24;
const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 60 * 60 * 1000;

/** Whether `now` is within 24 hours after the tenant's last message on the channel. */
export function withinReplyWindow(lastInboundAt: Instant | null, now: Instant): boolean {
  if (!lastInboundAt) return false;
  const age = now.epochMilliseconds - lastInboundAt.epochMilliseconds;
  return age >= 0 && age < REPLY_WINDOW_MS;
}

/** What a purpose needs before it may go on a channel. */
export type ConsentRequirement =
  /** Staff and owners about their own work or money (M3, M4b). */
  | 'none'
  /** Business-initiated: consent on the channel. */
  | 'consent'
  /** A reply: consent, or the reply window (decision 6). */
  | 'consent_or_reply'
  /** The one confirmation after STOP (decision 6). */
  | 'opt_out_confirmation'
  /** A message a tenant sent in; never sent by us. */
  | 'not_sent';

export function consentRequirement(purpose: MessagePurpose): ConsentRequirement {
  if (STAFF_PURPOSES.includes(purpose)) return 'none';
  if (REPLY_PURPOSES.includes(purpose)) return 'consent_or_reply';
  if (purpose === 'opt_out_confirmation') return 'opt_out_confirmation';
  if (purpose === 'inbound') return 'not_sent';
  return 'consent';
}

/** Why a message may go on a channel. */
export type ConsentBasis = 'exempt' | 'consent' | 'reply_window' | 'opt_out_confirmation';

export type ConsentOutcome =
  | { readonly allowed: true; readonly basis: ConsentBasis }
  | { readonly allowed: false; readonly reason: 'no_consent' | 'opted_out' };

export interface ConsentQuestion {
  readonly purpose: MessagePurpose;
  readonly consent: ConsentFacts;
  /** When the recipient last wrote to us on this channel. */
  readonly lastInboundAt: Instant | null;
  readonly now: Instant;
}

/**
 * Whether a message of this purpose may go on a channel now (CM-09; decisions 6 and 7).
 *
 * A reply within the window needs no consent, unless the person withdrew consent on the channel
 * after the message being answered: the STOP itself is such a message, so replies stop at once.
 * A tenant who writes again after a STOP can be answered within 24 hours of that new message;
 * business-initiated messages stay stopped until consent is given again.
 */
export function consentAllows(question: ConsentQuestion): ConsentOutcome {
  const { consent, lastInboundAt, now } = question;
  const refused = (): ConsentOutcome => ({
    allowed: false,
    reason: consent.latest?.action === 'withdraw' ? 'opted_out' : 'no_consent',
  });
  switch (consentRequirement(question.purpose)) {
    case 'none':
      return { allowed: true, basis: 'exempt' };
    case 'not_sent':
      return { allowed: false, reason: 'no_consent' };
    case 'consent':
      return consentIsGranted(consent) ? { allowed: true, basis: 'consent' } : refused();
    case 'opt_out_confirmation':
      return withinReplyWindow(lastInboundAt, now)
        ? { allowed: true, basis: 'opt_out_confirmation' }
        : { allowed: false, reason: 'no_consent' };
    case 'consent_or_reply': {
      if (consentIsGranted(consent)) return { allowed: true, basis: 'consent' };
      if (!withinReplyWindow(lastInboundAt, now)) return refused();
      const withdrawnAfter =
        consent.latest?.action === 'withdraw' &&
        lastInboundAt !== null &&
        consent.latest.at.epochMilliseconds >= lastInboundAt.epochMilliseconds;
      return withdrawnAfter ? refused() : { allowed: true, basis: 'reply_window' };
    }
  }
}

/**
 * Plan 4.8: a known tenant writing in on WhatsApp without consent there is asked once whether
 * they want reminders and receipts on WhatsApp. Not after they withdrew it, and not twice.
 */
export function shouldAskWhatsAppConsent(input: {
  readonly knownSender: boolean;
  readonly whatsapp: ConsentFacts;
  readonly alreadyAsked: boolean;
}): boolean {
  return input.knownSender && input.whatsapp.latest === null && !input.alreadyAsked;
}
