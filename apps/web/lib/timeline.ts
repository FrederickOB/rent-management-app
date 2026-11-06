import { AUTHOR_TYPES, MESSAGE_STATUSES, type ThreadMessage } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { instantFrom } from '@rent/domain/dates';
import { CHANNEL_LABELS, isChannel } from '@rent/domain/messaging';
import type { MessageStatus } from './inbox';

// The tenant's timeline (TL-01; M6 plan 4.11): what the audit log recorded about the tenant, and
// since M6 the messages to and from them, newest first.

export type TimelineEvent = Awaited<ReturnType<ApiClient['tenants']['timeline']>>[number];

export type TimelineEntry =
  | {
      readonly kind: 'event';
      readonly at: string;
      readonly key: string;
      readonly event: TimelineEvent;
    }
  | {
      readonly kind: 'message';
      readonly at: string;
      readonly key: string;
      readonly message: ThreadMessage;
    };

const epoch = (iso: string): number => {
  try {
    return instantFrom(iso).epochMilliseconds;
  } catch {
    return 0;
  }
};

/**
 * Audit events and messages together, newest first; ties keep each list's own order. No screen
 * uses it since review W2: the API's timeline carries the messages itself (`message.inbound`,
 * `message.outbound`), on every plan. Kept with its unit test, which has passed (review rule 1).
 */
export function mergeTimeline(
  events: readonly TimelineEvent[],
  messages: readonly ThreadMessage[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...events.map((event, index) => ({
      kind: 'event' as const,
      at: event.at,
      key: `event-${event.at}-${event.action}-${index}`,
      event,
    })),
    ...messages.map((message) => ({
      kind: 'message' as const,
      at: message.createdAt,
      key: `message-${message.id}`,
      message,
    })),
  ];
  return entries
    .map((entry, index) => ({ entry, index, time: epoch(entry.at) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map(({ entry }) => entry);
}

/** `WhatsApp message from the tenant`, `SMS to the tenant from Kofi Manager`. */
export function messageHeadline(
  message: Pick<ThreadMessage, 'direction' | 'channel' | 'authorType' | 'authorName'>,
): string {
  const channel = message.channel ? CHANNEL_LABELS[message.channel] : 'A';
  if (message.direction === 'inbound') {
    const from =
      message.authorType === 'contact' && message.authorName ? message.authorName : 'the tenant';
    return `${channel} message from ${from}`;
  }
  switch (message.authorType) {
    case 'bot':
      return `${channel} reply from the assistant`;
    case 'staff':
      return `${channel} message to the tenant${message.authorName ? ` from ${message.authorName}` : ''}`;
    default:
      return `${channel} message to the tenant`;
  }
}

/** The first lines of a message for the timeline; the thread shows it whole. */
export function messageExcerpt(body: string, max = 280): string {
  const text = body.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A message as the tenant's timeline carries it (review W2): the API's event and its data. */
export interface TimelineMessage {
  readonly direction: 'inbound' | 'outbound';
  readonly channel: ThreadMessage['channel'];
  readonly authorType: ThreadMessage['authorType'];
  readonly authorName: string | null;
  readonly subject: string | null;
  /** The start of the text; null when this person may not read message words. */
  readonly preview: string | null;
  readonly status: MessageStatus | null;
  readonly conversationId: string | null;
}

const MESSAGE_ACTIONS: Readonly<Record<string, TimelineMessage['direction']>> = {
  'message.inbound': 'inbound',
  'message.outbound': 'outbound',
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The message a timeline event stands for, or null for any other event. Without `data` (no
 * permission to read the words) it still says which way it went and who sent it.
 */
export function messageOfEvent(event: TimelineEvent): TimelineMessage | null {
  const direction = MESSAGE_ACTIONS[event.action];
  if (!direction) return null;
  const data = event.data ?? {};
  const channel = text(data.channel);
  const author = text(data.authorType);
  const status = text(data.status);
  const fallbackAuthor: TimelineMessage['authorType'] =
    direction === 'inbound'
      ? 'tenant'
      : event.actorName === 'Assistant'
        ? 'bot'
        : event.actorName
          ? 'staff'
          : 'system';
  return {
    direction,
    channel: channel && isChannel(channel) ? channel : null,
    authorType:
      author && (AUTHOR_TYPES as readonly string[]).includes(author)
        ? (author as TimelineMessage['authorType'])
        : fallbackAuthor,
    authorName: direction === 'outbound' ? event.actorName : null,
    subject: text(data.subject),
    preview: text(data.preview),
    status:
      status && (MESSAGE_STATUSES as readonly string[]).includes(status)
        ? (status as MessageStatus)
        : null,
    conversationId: text(data.conversationId),
  };
}
