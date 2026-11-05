import type { Broadcast, BroadcastAudience, BroadcastPreview } from '@rent/contracts';
import { CHANNEL_LABELS, type ConsentChannel } from '@rent/domain/messaging';
import { errorCode, statusOf } from './errors';

// Broadcasts (CM-08; M6 plan 4.7): one message to the current tenants of a property, some of its
// blocks or a tenant group, sent only after a preview of who can and cannot be reached. Who is in
// the audience, on which channel and why not is decided by the API; this says it in words.

export type AudienceKind = BroadcastAudience['kind'];

export interface BroadcastDraft {
  readonly kind: AudienceKind;
  readonly propertyId: string;
  readonly blockIds: readonly string[];
  readonly groupId: string;
  readonly topic: string;
  readonly body: string;
}

export const EMPTY_BROADCAST: BroadcastDraft = {
  kind: 'property',
  propertyId: '',
  blockIds: [],
  groupId: '',
  topic: '',
  body: '',
};

export const TOPIC_MIN = 2;
export const TOPIC_MAX = 60;
export const BODY_MAX = 1_000;

export type BroadcastErrors = Partial<Record<'audience' | 'topic' | 'body', string>>;

/** Problems before a preview can be asked for; the API checks again. */
export function broadcastErrors(draft: BroadcastDraft): BroadcastErrors {
  const errors: { -readonly [K in keyof BroadcastErrors]: string } = {};
  if (draft.kind === 'group' ? !draft.groupId : !draft.propertyId)
    errors.audience = draft.kind === 'group' ? 'Choose a tenant group' : 'Choose a property';
  else if (draft.kind === 'blocks' && draft.blockIds.length === 0)
    errors.audience = 'Choose at least one block';
  const topic = draft.topic.trim().length;
  if (topic < TOPIC_MIN || topic > TOPIC_MAX)
    errors.topic = `Say what it is about in ${TOPIC_MIN} to ${TOPIC_MAX} characters, such as “water supply”`;
  const body = draft.body.trim().length;
  if (body < 1) errors.body = 'Write the message';
  else if (body > BODY_MAX)
    errors.body = `Use at most ${BODY_MAX.toLocaleString('en-GB')} characters`;
  return errors;
}

/** The audience as the API takes it, or null while it is incomplete. */
export function audienceOf(draft: BroadcastDraft): BroadcastAudience | null {
  switch (draft.kind) {
    case 'property':
      return draft.propertyId ? { kind: 'property', propertyId: draft.propertyId } : null;
    case 'blocks':
      return draft.propertyId && draft.blockIds.length
        ? { kind: 'blocks', propertyId: draft.propertyId, blockIds: [...draft.blockIds] }
        : null;
    case 'group':
      return draft.groupId ? { kind: 'group', groupId: draft.groupId } : null;
  }
}

/**
 * What a preview was made for. A preview stays good only while nothing it depends on changes; a
 * changed audience or text needs a new one before sending.
 */
export function draftKey(draft: BroadcastDraft): string {
  return JSON.stringify([audienceOf(draft), draft.topic.trim(), draft.body.trim()]);
}

export const UNREACHABLE_REASON_TEXT: Record<
  BroadcastPreview['unreachable'][number]['reason'],
  string
> = {
  no_consent: 'No consent on any channel',
  no_address: 'No phone, email or app on record',
  opted_out: 'Opted out (sent STOP)',
};

export const PREVIEW_CHANNELS: readonly ConsentChannel[] = ['push', 'whatsapp', 'sms', 'email'];

/** `12 of 14 tenants can be reached.` */
export function reachText(
  preview: Pick<BroadcastPreview, 'audienceCount' | 'reachableCount'>,
): string {
  const of = preview.audienceCount === 1 ? '1 tenant' : `${preview.audienceCount} tenants`;
  return `${preview.reachableCount} of ${of} can be reached.`;
}

/** The send button: `Send to 12 tenants`. */
export function sendLabel(reachable: number): string {
  return reachable === 1 ? 'Send to 1 tenant' : `Send to ${reachable} tenants`;
}

/** The preview is out of date: the audience changed between preview and send (409). */
export function isAudienceChanged(error: unknown): boolean {
  return statusOf(error) === 409 && errorCode(error) === 'AUDIENCE_CHANGED';
}

export type StatKey = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'notSent';

export const STAT_COLUMNS: readonly { readonly key: StatKey; readonly label: string }[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'sent', label: 'Sent' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'read', label: 'Read' },
  { key: 'failed', label: 'Failed' },
  { key: 'notSent', label: 'Not sent' },
];

export type StatRow = { readonly label: string } & Readonly<Record<StatKey, number>>;

/** Delivery stats per channel, then the total (CM-08); a channel nobody was sent on is left out. */
export function statRows(stats: Broadcast['stats']): StatRow[] {
  const rows: StatRow[] = PREVIEW_CHANNELS.map((channel) => ({
    label: CHANNEL_LABELS[channel],
    ...stats.byChannel[channel],
  })).filter((row) => STAT_COLUMNS.some(({ key }) => row[key] > 0));
  rows.push({
    label: 'Total',
    queued: stats.queued,
    sent: stats.sent,
    delivered: stats.delivered,
    read: stats.read,
    failed: stats.failed,
    notSent: stats.notSent,
  });
  return rows;
}

export const BROADCAST_STATUS_LABELS: Record<Broadcast['status'], string> = {
  sending: 'Sending',
  sent: 'Sent',
};
