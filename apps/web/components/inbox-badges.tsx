import type { Channel, ConversationState } from '@rent/domain/messaging';
import type { StreamStatus } from '@/lib/inbox-stream';
import { STREAM_STATUS_TEXT } from '@/lib/inbox-stream';
import {
  channelName,
  CONVERSATION_STATE_LABELS,
  MESSAGE_STATUS_LABELS,
  type MessageStatus,
} from '@/lib/inbox';
import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from './ui/badge';

const STATE_TONES: Record<ConversationState, BadgeTone> = {
  triage: 'amber',
  bot: 'blue',
  open: 'neutral',
  assigned: 'blue',
  awaiting_tenant: 'neutral',
  resolved: 'dark',
};

export function ConversationStateBadge({ state }: { readonly state: ConversationState }) {
  return (
    <span data-testid="conversation-state">
      <Badge tone={STATE_TONES[state]}>{CONVERSATION_STATE_LABELS[state]}</Badge>
    </span>
  );
}

const MESSAGE_TONES: Record<MessageStatus, BadgeTone> = {
  received: 'neutral',
  queued: 'neutral',
  sent: 'blue',
  delivered: 'green',
  read: 'green',
  failed: 'red',
  not_sent: 'amber',
};

export function MessageStatusBadge({ status }: { readonly status: MessageStatus }) {
  return (
    <span data-testid="message-status">
      <Badge tone={MESSAGE_TONES[status]}>{MESSAGE_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

export function ChannelBadge({ channel }: { readonly channel: Channel | null }) {
  return (
    <span data-testid="message-channel">
      <Badge>{channelName(channel)}</Badge>
    </span>
  );
}

/** Whether the live inbox stream is connected; shown small, and read by the end-to-end tests. */
export function StreamStatusLine({ status }: { readonly status: StreamStatus }) {
  return (
    <p
      data-testid="stream-status"
      data-status={status}
      className={cn('text-xs', status === 'live' ? 'text-emerald-800' : 'text-slate-600')}
    >
      {STREAM_STATUS_TEXT[status]}
    </p>
  );
}
