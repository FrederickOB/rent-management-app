/**
 * Outbound messaging rules (M3 decisions 1 and 2; CLAUDE.md section 8; CM-09). WhatsApp and push
 * join the channel order in M6, with replies and STOP.
 */
export const MESSAGE_CHANNELS = ['sms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  sms: 'SMS',
  email: 'email',
};

/** The order a business-initiated message tries the channels in. */
export const CHANNEL_ORDER: readonly MessageChannel[] = ['sms', 'email'];

export const MESSAGE_PURPOSES = [
  'signing_link',
  'signing_reminder',
  'signed_copy',
  'id_check_link',
  'staff_notice',
  // M4b: pay links, the rent reminder ladder, receipts, and settlement-account alerts to owners.
  'pay_link',
  'rent_reminder',
  'receipt',
  'settlement_alert',
] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

/**
 * Messages the business starts need consent on the channel (CM-09). Staff notices go to staff by
 * email and need none; one-time codes never pass through messaging at all. A settlement-account
 * alert (ADR-008) goes to the owner whose rent is being redirected, on the phone and email in the
 * register: it is a security notice about their own money, not a message about a tenancy, so it
 * needs no tenancy consent (M4b; listed for the founder in the M4b report).
 */
export function needsConsent(purpose: MessagePurpose): boolean {
  return purpose !== 'staff_notice' && purpose !== 'settlement_alert';
}

/**
 * The consent staff record when they add a person's details, by version (M3 decision 2). The
 * version and the text's hash are kept with every consent event. It records what the person
 * agreed to, nothing more.
 */
export const CONSENT_TEXTS: Readonly<Record<string, string>> = {
  'messages.v1':
    'This person agreed to receive messages about their tenancy, including links to sign ' +
    'documents, by {channel}.',
};
export const CURRENT_CONSENT_TEXT = 'messages.v1';

/** The consent text for a channel, as shown to staff and stored with the event. */
export function consentText(version: string, channel: MessageChannel): string {
  const text = CONSENT_TEXTS[version];
  if (!text) throw new Error(`Unknown consent text ${version}`);
  return text.replace('{channel}', MESSAGE_CHANNEL_LABELS[channel]);
}

export interface Reachability {
  /** Channels the recipient has an address for (a phone for SMS, an email for email). */
  readonly addresses: ReadonlySet<MessageChannel>;
  /** Channels with consent currently granted (the latest consent event is a grant). */
  readonly consented: ReadonlySet<MessageChannel>;
}

/**
 * The first channel in the order that can carry the message: it needs an address, and consent
 * unless the purpose is exempt. Null means "not sent: no consent" (staff hand over a link).
 */
export function chooseChannel(
  purpose: MessagePurpose,
  reach: Reachability,
  skip: ReadonlySet<MessageChannel> = new Set(),
): MessageChannel | null {
  for (const channel of CHANNEL_ORDER) {
    if (skip.has(channel) || !reach.addresses.has(channel)) continue;
    if (needsConsent(purpose) && !reach.consented.has(channel)) continue;
    return channel;
  }
  return null;
}

/** Whether consent is granted now, from a subject's events on one channel, oldest first. */
export function consentGranted(
  events: readonly { readonly action: 'grant' | 'withdraw' }[],
): boolean {
  return events.at(-1)?.action === 'grant';
}

/**
 * A message body as it is stored: the token in any secure link is replaced, so the record never
 * holds a live link (CLAUDE.md section 9). Matches `/l/<token>` (signing), `/p/<token>` (pay) and
 * `/r/<token>` (receipt) paths.
 */
export function redactLinkTokens(body: string): string {
  return body.replace(/\/([lpr])\/[A-Za-z0-9_-]{16,}/g, '/$1/[link]');
}
