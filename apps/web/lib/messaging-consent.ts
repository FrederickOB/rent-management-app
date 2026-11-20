import type { MessagingConsent } from '@rent/contracts';
import {
  BUSINESS_CHANNEL_ORDER,
  CHANNEL_LABELS,
  type ConsentChannel,
  type ConsentSource,
} from '@rent/domain/messaging';
import type { ConsentDraft } from './tenant-form';

// Consent on every channel (CM-09; M6 plan 4.8): push, WhatsApp, SMS and email, from
// GET /tenants/{id}/messaging-consent. Each grant and withdrawal is its own record; the card shows
// the latest per channel, with where it came from.

export type ChannelConsent = MessagingConsent['subjects'][number]['channels'][number];

/**
 * How the latest consent event came, for people. M11 adds a data protection request (it only ever
 * withdraws consent) and the onboarding workbook's import.
 */
export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  staff: 'recorded by staff',
  tenant_reply: 'replied YES on WhatsApp',
  stop_keyword: 'sent STOP',
  start_keyword: 'sent START',
  tenant_app: 'set in the tenant app',
  email_unsubscribe: 'used the unsubscribe link',
  data_protection: 'stopped for a data protection request',
  import: 'brought in from the onboarding workbook',
};

/** What is missing when a channel has nowhere to send to. */
export const NO_ADDRESS_TEXT: Record<ConsentChannel, string> = {
  push: 'Not using the tenant app on a phone',
  whatsapp: 'No WhatsApp number on file',
  sms: 'No phone on file',
  email: 'No email on file',
};

/** The channel's name in labels: `WhatsApp`, `SMS`, `Email`, `App notification`. */
export const consentChannelName = (channel: ConsentChannel): string => CHANNEL_LABELS[channel];

/** The channels in the order a business-initiated message tries them (decision 5). */
export function orderedChannels(channels: readonly ChannelConsent[]): ChannelConsent[] {
  return [...channels].sort(
    (a, b) => BUSINESS_CHANNEL_ORDER.indexOf(a.channel) - BUSINESS_CHANNEL_ORDER.indexOf(b.channel),
  );
}

/** One person's channels: the tenant (contactId null) or a contact. */
export function channelsFor(
  consent: MessagingConsent | null,
  contactId: string | null,
): ChannelConsent[] | null {
  const subject = consent?.subjects.find((s) => s.contactId === contactId);
  return subject ? orderedChannels(subject.channels) : null;
}

/**
 * SMS and email as the M3 record holds them. No screen uses it since review W8: the consent card
 * shows a load error and a retry instead of falling back to these rows. Kept with its unit test,
 * which has passed (M6 review rule 1); the M3 record knows no reset reason.
 */
export function m3Channels(
  consent: ConsentDraft,
  addresses: { readonly phone: string | null; readonly email: string | null },
): Omit<ChannelConsent, 'reason'>[] {
  return (['sms', 'email'] as const).map((channel) => ({
    channel,
    granted: consent[channel],
    source: null,
    recordedAt: null,
    reachable: Boolean(channel === 'sms' ? addresses.phone : addresses.email),
  }));
}

/**
 * How the latest consent event on a channel came about, for the card (C3; review W7): a reset
 * because the phone or email changed reads as that, never as a withdrawal by staff (decision 8).
 */
export function consentHistoryText(entry: {
  readonly channel: ConsentChannel;
  readonly granted: boolean;
  readonly source: ConsentSource | null;
  readonly reason: 'address_changed' | null;
}): string {
  if (!entry.granted && entry.reason === 'address_changed')
    return entry.channel === 'email'
      ? 'Reset: the email address changed'
      : 'Reset: the phone number changed';
  const how = entry.source ? CONSENT_SOURCE_LABELS[entry.source] : 'recorded';
  return `${entry.granted ? 'Agreed' : 'Withdrawn'}: ${how}`;
}
