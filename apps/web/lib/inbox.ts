import {
  inboxStreamEventSchema,
  type ConversationDetail,
  type ConversationSummary,
  type InboxStreamEvent,
  type MESSAGE_STATUSES,
  type ReplyChannel,
  type ThreadMessage,
} from '@rent/contracts';
import { instantFrom, minutesBetween } from '@rent/domain/dates';
import {
  CHANNEL_LABELS,
  type Channel,
  type ConversationState,
  type HandoverReason,
  type InboundChannel,
  type InboxView,
} from '@rent/domain/messaging';
import { formatTime } from './format';

// The unified inbox (CM-05, CM-06; M6 plan 4.6 and 4.11). What the API sends is shown as it is:
// the screens never decide who may reply, on which channel or with which template. They read the
// conversation's `channels` and `can`, and say in words what the API answered.

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** The inbox tabs, in the order they are shown. */
export const INBOX_VIEW_ORDER: readonly InboxView[] = [
  'all',
  'mine',
  'unassigned',
  'overdue',
  'triage',
  'bot',
  'resolved',
];

export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  all: 'All open',
  mine: 'Mine',
  unassigned: 'Unassigned',
  overdue: 'Overdue',
  triage: 'Unknown senders',
  bot: 'With the assistant',
  resolved: 'Resolved',
};

export function isInboxView(value: string | undefined): value is InboxView {
  return value !== undefined && (INBOX_VIEW_ORDER as readonly string[]).includes(value);
}

export const CONVERSATION_STATE_LABELS: Record<ConversationState, string> = {
  triage: 'Unknown sender',
  bot: 'With the assistant',
  open: 'Open',
  assigned: 'Assigned',
  awaiting_tenant: 'Waiting for the tenant',
  resolved: 'Resolved',
};

export const HANDOVER_REASON_LABELS: Record<HandoverReason, string> = {
  asked_for_person: 'Asked for a person',
  bot_cannot_help: 'The assistant could not help',
  media_received: 'Sent a photo or file',
  contact_without_account: 'A contact who cannot see the account',
  no_lease: 'No current lease',
};

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  received: 'Received',
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  not_sent: 'Not sent',
};

const STATUS_REASONS: Readonly<Record<string, string>> = {
  no_consent: 'no consent on this channel',
  no_address: 'no phone, email or app on record for this channel',
  opted_out: 'the tenant opted out',
  window_closed: 'the WhatsApp 24-hour window had closed',
  no_approved_template: 'no approved WhatsApp template',
  not_on_whatsapp: 'the number is not on WhatsApp',
  template_rejected: 'Meta refused the template',
};

/** Why a message failed or was not sent, in words; unknown reasons are shown as they came. */
export function statusReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return STATUS_REASONS[reason] ?? reason.replace(/[_.]+/g, ' ');
}

/** Why the composer cannot use a channel now (the API's `reason`). */
export const REPLY_UNAVAILABLE_TEXT: Record<NonNullable<ReplyChannel['reason']>, string> = {
  no_address: 'There is no address on record for this channel.',
  no_consent:
    'The tenant has not agreed to messages on this channel, and has not written on it in the last 24 hours.',
  opted_out: 'The tenant opted out of this channel (STOP).',
  window_closed: 'The WhatsApp 24-hour window has closed.',
};

export const channelName = (channel: Channel | null): string =>
  channel ? CHANNEL_LABELS[channel] : 'Not sent yet';

/** The conversation's name in lists and headings: the tenant, or the unknown sender's address. */
export function conversationTitle(conversation: ConversationSummary): string {
  if (conversation.tenant) return conversation.tenant.name;
  if (conversation.triage)
    return `Unknown sender on ${CHANNEL_LABELS[conversation.triage.channel]} (${conversation.triage.addressMasked})`;
  return 'Unknown sender';
}

/** Who wrote a message, for its header line. */
export function authorLabel(message: ThreadMessage): string {
  switch (message.authorType) {
    case 'bot':
      return message.authorName ?? 'Assistant';
    case 'system':
      return message.authorName ?? 'Automatic message';
    case 'unknown':
      return message.authorName ?? 'Unknown sender';
    default:
      return message.authorName ?? (message.direction === 'inbound' ? 'Tenant' : 'Staff');
  }
}

/** `3 h 12 min`, `45 min`, `less than a minute`. */
export function durationText(minutes: number): string {
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface WindowStatus {
  readonly open: boolean;
  readonly text: string;
}

/**
 * The WhatsApp 24-hour window (CM-07) as the API reported it: when it closes, and how long is
 * left now. The client clock only counts down to the API's instant; it decides nothing.
 */
export function windowStatus(closesAt: string | null, now: Date, timeZone: string): WindowStatus {
  if (!closesAt) return { open: false, text: 'The WhatsApp window is closed.' };
  const left = minutesBetween(instantFrom(now), instantFrom(closesAt));
  if (left <= 0) return { open: false, text: 'The WhatsApp window is closed.' };
  return {
    open: true,
    text: `The WhatsApp window is open for ${durationText(left)} more (until ${formatTime(closesAt, timeZone)}).`,
  };
}

/** The response target line (CM-06; decision 10). */
export function responseDueText(
  conversation: Pick<ConversationSummary, 'firstResponseDueAt' | 'overdue'>,
  now: Date,
  timeZone: string,
): string | null {
  if (!conversation.firstResponseDueAt) return null;
  const at = formatTime(conversation.firstResponseDueAt, timeZone);
  if (conversation.overdue) return `Reply overdue since ${at}`;
  const left = minutesBetween(instantFrom(now), instantFrom(conversation.firstResponseDueAt));
  return left > 0 ? `Reply due in ${durationText(left)} (by ${at})` : `Reply due by ${at}`;
}

const byTimeThenId = (a: ThreadMessage, b: ThreadMessage): number => {
  const at =
    instantFrom(a.createdAt).epochMilliseconds - instantFrom(b.createdAt).epochMilliseconds;
  if (at !== 0) return at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * The thread as shown: oldest first, each message once. A message fetched again (a new delivery
 * status, an attachment that arrived) replaces the copy on screen; nothing is ever removed.
 */
export function mergeMessages(
  current: readonly ThreadMessage[],
  incoming: readonly ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(byTimeThenId);
}

/**
 * The channel the composer starts on (plan 4.6): the one the tenant last wrote on, as the API
 * says, kept if the person already chose another that is still offered.
 */
export function startingChannel(
  detail: Pick<ConversationDetail, 'channels' | 'defaultChannel'>,
  chosen: InboundChannel | null,
): InboundChannel | null {
  const offered = (channel: InboundChannel | null) =>
    channel !== null && detail.channels.some((c) => c.channel === channel);
  if (offered(chosen)) return chosen;
  if (offered(detail.defaultChannel)) return detail.defaultChannel;
  return (
    detail.channels.find((c) => c.mode === 'free_text')?.channel ??
    detail.channels[0]?.channel ??
    null
  );
}

/** For the composer on WhatsApp outside the window: the SMS channel, when it takes free text. */
export function smsAlternative(detail: Pick<ConversationDetail, 'channels'>): ReplyChannel | null {
  return detail.channels.find((c) => c.channel === 'sms' && c.mode === 'free_text') ?? null;
}

/** Live stream reconnects: 1 s, 2 s, 4 s … up to 30 s, with a little jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.floor(base * (0.8 + random() * 0.4));
}

/** One event from `/inbox/stream` (ids only), or null for anything else (a comment, a ping). */
export function parseStreamEvent(data: unknown): InboxStreamEvent | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > 2_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = inboxStreamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether an event is about this thread, or a triage conversation merged into it. */
export function eventTouches(
  event: InboxStreamEvent,
  conversationId: string,
  mergedFrom: readonly string[] = [],
): boolean {
  return event.conversationId === conversationId || mergedFrom.includes(event.conversationId);
}

/** `Showing messages since 1 Jan 2026, when the lease began.` */
export function sinceText(since: string, formatDate: (iso: string) => string): string {
  return `Showing messages since ${formatDate(since)}, when the lease began.`;
}

/** The size of an attachment, for people. */
export function sizeText(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1_000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.floor(bytes / 1_000)} KB`;
  return `${Math.floor(bytes / 100_000) / 10} MB`;
}

/** The rows a list shows, and the cursor for the page after them. */
export interface Shown<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

/**
 * A list after a live refresh. The refresh fetches as many rows as are shown, up to the API's
 * page limit. Past the limit, the rows loaded with "Show more" stay below the fresh ones with
 * their own cursor, instead of the list being cut back to the limit; so does a row a new arrival
 * pushed out of the first page, which the old cursor would never bring back. A row that left the
 * view meanwhile may stay until the view is opened again.
 */
export function refreshedRows<T extends { readonly id: string }>(
  shown: Shown<T> | null,
  page: { readonly items: readonly T[]; readonly nextCursor: string | null },
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (!shown || shown.items.length <= limit)
    return { items: [...page.items], nextCursor: page.nextCursor };
  const fresh = new Set(page.items.map((item) => item.id));
  const rest = shown.items.filter((item) => !fresh.has(item.id));
  return { items: [...page.items, ...rest], nextCursor: shown.cursor };
}

/** A plain left click, which a link may handle itself; any other opens a tab as links do. */
export function plainClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Milliseconds from now until an instant the API sent, plus a second so the API agrees it has
 * passed; null when there is none, it has passed, or it is more than a day away (a timer that
 * long is set again on the next refresh anyway).
 */
export function msUntil(at: string | null, now: Date): number | null {
  if (!at) return null;
  const wait = instantFrom(at).epochMilliseconds - instantFrom(now).epochMilliseconds;
  if (wait <= 0 || wait > 24 * 60 * 60 * 1000) return null;
  return wait + 1_000;
}

/**
 * The tag panel's choices: the company's list; the conversation's tags still on it (ticked); and
 * those since taken off it, which the API no longer takes and a save removes.
 */
export function tagChoices(
  list: readonly string[],
  tags: readonly string[],
): { offered: string[]; kept: string[]; retired: string[] } {
  const listed = new Set(list);
  return {
    offered: [...new Set(list)],
    kept: tags.filter((tag) => listed.has(tag)),
    retired: tags.filter((tag) => !listed.has(tag)),
  };
}
