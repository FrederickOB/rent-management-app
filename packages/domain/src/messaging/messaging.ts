/**
 * Outbound messaging rules (M3 decisions 1 and 2; CLAUDE.md section 8; CM-09). M6 adds WhatsApp,
 * push and in-app messages, replies and STOP in the files beside this one (channels.ts,
 * consent.ts, whatsapp.ts, keywords.ts, routing.ts, bot.ts and inbox.ts).
 *
 * The names in this file keep their M3 meaning for their callers: `MESSAGE_CHANNELS`,
 * `MessageChannel`, `CHANNEL_ORDER` and `chooseChannel` are the SMS-and-email channels of the M3
 * send job and the M3 staff consent form. M6 code uses `CHANNELS`, `CONSENT_CHANNELS`,
 * `BUSINESS_CHANNEL_ORDER` and `planOutbound` (channels.ts).
 */
export const MESSAGE_CHANNELS = ['sms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  sms: 'SMS',
  email: 'email',
};

/** The order the M3 send job tries its channels in. M6: `BUSINESS_CHANNEL_ORDER`. */
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
  // M6 (plan 4.2 and 4.9): replies in a conversation, by staff or the bot; broadcasts; the one
  // confirmation after STOP; the question asking a tenant who wrote in on WhatsApp whether they
  // want reminders and receipts there (plan 4.8); overdue-conversation alerts to staff; renewal
  // reminders and paid-until prompts with their own templates; and messages tenants send in.
  'conversation_reply',
  'bot_reply',
  'broadcast',
  'opt_out_confirmation',
  'consent_request',
  'overdue_alert',
  'renewal_reminder',
  'paid_until_prompt',
  'inbound',
  // M7 (plan 4.6 and 4.7): a notice's link, the first ladder reminder, and later reminders that
  // say the notice remains in force whether or not it is signed.
  'notice_link',
  'notice_reminder',
  'notice_in_force',
  // M8 (plan 4.4, 4.5 and 4.8): the emergency alert to the property's staff, the artisan's job
  // sheet link, the tenant's repair updates, and the final statement at move-out.
  'maintenance_alert',
  'job_sheet_link',
  'repair_update',
  'final_statement',
] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

/** Purposes that reach staff or owners about their own work or money, never a tenancy (CM-09). */
export const STAFF_PURPOSES: readonly MessagePurpose[] = [
  'staff_notice',
  'settlement_alert',
  'overdue_alert',
  // M8 decision 5: an emergency repair alert to the property's managers and caretakers. SMS goes
  // to their phone on record; WhatsApp only to those who opted in (contact_consent_event).
  'maintenance_alert',
];

/**
 * Automatic prompts the system sends on its own in a conversation: the WhatsApp consent question
 * (plan 4.8) and the confirmation after STOP or START. They never become a conversation's preview
 * or last message in the inbox (M8 review), so the tenant's own message stays the one shown and
 * unanswered. Staff replies and the bot's answers still do.
 */
export const SYSTEM_PROMPT_PURPOSES: readonly MessagePurpose[] = [
  'consent_request',
  'opt_out_confirmation',
];

/** Purposes that answer a tenant who wrote in (M6 decision 6). */
export const REPLY_PURPOSES: readonly MessagePurpose[] = [
  'conversation_reply',
  'bot_reply',
  'consent_request',
];

/**
 * Messages the business starts need consent on the channel (CM-09). Staff notices go to staff by
 * email and need none; one-time codes never pass through messaging at all. A settlement-account
 * alert (ADR-008) goes to the owner whose rent is being redirected, on the phone and email in the
 * register: it is a security notice about their own money, not a message about a tenancy, so it
 * needs no tenancy consent (M4b; listed for the founder in the M4b report).
 *
 * This is the M3 rule, without the reply window: a reply, the opt-out confirmation and an inbound
 * message count as needing consent here. M6 code asks `consentAllows` (consent.ts), which knows
 * the window (decision 6).
 */
export function needsConsent(purpose: MessagePurpose): boolean {
  return !STAFF_PURPOSES.includes(purpose);
}

/**
 * The consent texts, by version (M3 decision 2; M6 plan 4.8). The version and the text's hash are
 * kept with every consent event. Each records what the person agreed to or asked for, nothing more.
 */
export const CONSENT_TEXTS: Readonly<Record<string, string>> = {
  'messages.v1':
    'This person agreed to receive messages about their tenancy, including links to sign ' +
    'documents, by {channel}.',
  // M6: consent the tenant gives or withdraws themselves.
  'whatsapp_reply.v1':
    'This person replied YES on WhatsApp to receive reminders, receipts and other messages ' +
    'about their tenancy by {channel}.',
  'app_toggle.v1':
    'This person turned on notifications in the tenant app to receive messages about their ' +
    'tenancy by {channel}.',
  'app_toggle_off.v1':
    'This person turned off notifications in the tenant app, and no longer wants messages by ' +
    '{channel}.',
  'stop.v1': 'This person sent STOP and no longer wants messages by {channel}.',
  'start.v1': 'This person sent START to receive messages about their tenancy by {channel} again.',
  'email_unsubscribe.v1':
    'This person used the unsubscribe link in an email and no longer wants messages by {channel}.',
  'staff_withdraw.v1':
    'Staff recorded that this person no longer wants messages about their tenancy by {channel}.',
  // M6 decision 8 (OQ-54): consent belongs to the address it was given for.
  // M8 decisions 5 and 6: staff and artisans, recorded in contact_consent_event.
  'staff_alerts.v1':
    'This staff member agreed to receive emergency repair alerts for their properties by {channel}.',
  'staff_alerts_off.v1': 'This staff member no longer wants emergency repair alerts by {channel}.',
  'artisan_contact.v1':
    'This artisan agreed to receive repair job sheets and one-time codes from the company by {channel}.',
  'artisan_contact_off.v1': 'This artisan no longer wants repair job sheets by {channel}.',
  'address_changed.v1':
    'The {channel} address on record changed, so the consent given for the old one no longer applies. Record the person’s agreement for the new one.',
};
export const CURRENT_CONSENT_TEXT = 'messages.v1';

/** Channel names in consent texts. M6 channels are named here as well as SMS and email. */
const CONSENT_CHANNEL_WORDS: Readonly<Record<string, string>> = {
  sms: 'SMS',
  email: 'email',
  whatsapp: 'WhatsApp',
  push: 'app notification',
};

/** The consent text for a channel, as shown to staff and stored with the event. */
export function consentText(version: string, channel: string): string {
  const text = CONSENT_TEXTS[version];
  if (!text) throw new Error(`Unknown consent text ${version}`);
  const word = CONSENT_CHANNEL_WORDS[channel];
  if (!word) throw new Error(`No consent is recorded for the ${channel} channel`);
  return text.replace('{channel}', word);
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
 * holds a live link (CLAUDE.md section 9). Matches `/l/<token>` (signing), `/p/<token>` (pay),
 * `/r/<token>` (receipt), from M6 `/u/<token>` (email unsubscribe) and from M8 `/j/<token>` (an
 * artisan's job sheet) paths.
 */
export function redactLinkTokens(body: string): string {
  return body.replace(/\/([lpruj])\/[A-Za-z0-9_-]{16,}/g, '/$1/[link]');
}
