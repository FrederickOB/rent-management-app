import type { TenantConversation, TenantMessage } from '@rent/contracts';
import { CHANNEL_LABELS } from '@rent/domain/messaging';
import { api } from './api';

// Words, order and loaders for the Messages screens (M6 plan 4.10; CM-05).

/**
 * Each landlord's conversation (Home's marker, the list, and the thread's title). Stable, and
 * async so that any failure arrives as a rejected promise, which useLoad turns into a state.
 */
export const loadConversations = async () => api.tenantMessaging.conversations();

export type MessagePage = { readonly items: TenantMessage[]; readonly nextCursor: string | null };

/** Messages are fetched 30 at a time: a page stays well inside the 100 KB payload budget. */
export const PAGE_SIZE = 30;

/**
 * The thread oldest first, from the pages fetched (each newest first) and the messages sent from
 * this screen since, each message once.
 */
export function threadOrder(
  pages: readonly (readonly TenantMessage[])[],
  sent: readonly TenantMessage[] = [],
): TenantMessage[] {
  const byId = new Map<string, TenantMessage>();
  for (const message of [...pages.flat(), ...sent]) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** "By WhatsApp" for anything that did not come or go in the app itself. */
export function channelNote(channel: TenantMessage['channel']): string | null {
  if (!channel || channel === 'in_app') return null;
  return `By ${channel === 'sms' || channel === 'whatsapp' ? CHANNEL_LABELS[channel] : CHANNEL_LABELS[channel].toLowerCase()}`;
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/** What a message carried, in words: the app shows no attachment itself (no tenant download yet). */
export function attachmentNote(message: TenantMessage): string | null {
  if (message.attachmentCount === 0) return null;
  const stored = message.attachments.filter((a) => a.status === 'stored');
  const refused = message.attachments.filter((a) => a.status === 'rejected');
  const arriving = message.attachmentCount - message.attachments.length;
  const parts: string[] = [];
  if (stored.length > 0) {
    const photos = stored.every((a) => a.kind === 'image');
    parts.push(
      photos ? plural(stored.length, 'photo', 'photos') : plural(stored.length, 'file', 'files'),
    );
  }
  if (refused.length > 0) parts.push(`${plural(refused.length, 'file', 'files')} not accepted`);
  if (arriving > 0) parts.push(`${plural(arriving, 'file', 'files')} still arriving`);
  return parts.join(', ');
}

/** "2 new", for one landlord's conversation. */
export const unreadLabel = (count: number): string => `${count} new`;

/** A secure link, with or without its host: the cache keeps none (src/cache.ts). */
const LINKS = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\/[lpru]\/[A-Za-z0-9_-]{16,}/gi;

/** Text as the offline cache keeps it: every link replaced by `[link]`. */
export const withoutLinks = (text: string): string => text.replace(LINKS, '[link]');

const linkFree = (text: string | null): string | null =>
  text === null ? null : withoutLinks(text);

/**
 * A page of the thread for the offline cache: the same, with no link in any body, caption or file
 * name (the cache refuses the whole page otherwise).
 */
export function pageForCache(page: MessagePage): MessagePage {
  return {
    ...page,
    items: page.items.map((message) => ({
      ...message,
      body: withoutLinks(message.body),
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        caption: linkFree(attachment.caption),
        filename: linkFree(attachment.filename),
        rejectReason: linkFree(attachment.rejectReason),
      })),
    })),
  };
}

/**
 * The state of the tenant's own message (the API's `deliveryStatus`): stored, delivered, or read,
 * which the API reports once the landlord's side has replied after it.
 */
export function deliveryLabel(status: TenantMessage['deliveryStatus']): string {
  switch (status) {
    case 'read':
      return 'Read';
    case 'delivered':
      return 'Delivered';
    default:
      return 'Sent';
  }
}

/** What opening an attachment shows, in words for its button. */
export function attachmentAction(attachment: TenantMessage['attachments'][number]): string {
  return attachment.kind === 'image' ? 'View the photo' : 'Open the file';
}

/** The landlords' conversations for the offline cache, with no link in any preview. */
export function conversationsForCache(list: TenantConversation[]): TenantConversation[] {
  return list.map((conversation) => ({
    ...conversation,
    lastMessagePreview:
      conversation.lastMessagePreview === null
        ? null
        : withoutLinks(conversation.lastMessagePreview),
  }));
}
