import {
  NOTICE_OUTCOME_LABELS,
  NOTICE_STATUS_LABELS,
  type NoticeOutcome,
  type NoticeStatus,
} from '@rent/domain/notices';
import { Badge, type BadgeTone } from './ui/badge';

const STATUS_TONES: Record<NoticeStatus, BadgeTone> = {
  draft: 'neutral',
  pending_approval: 'amber',
  approved: 'blue',
  sent: 'blue',
  delivered: 'blue',
  reminded: 'amber',
  opened: 'blue',
  escalated: 'red',
  served: 'amber',
  signed: 'green',
  closed: 'dark',
  cancelled: 'dark',
  received: 'neutral',
};

/** A notice's status, in the domain's words (LN-03). */
export function NoticeStatusBadge({ status }: { readonly status: NoticeStatus }) {
  return (
    <span data-testid="notice-status">
      <Badge tone={STATUS_TONES[status]}>{NOTICE_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

export function NoticeOutcomeBadge({ outcome }: { readonly outcome: NoticeOutcome }) {
  return (
    <span data-testid="notice-outcome">
      <Badge tone="dark">{NOTICE_OUTCOME_LABELS[outcome]}</Badge>
    </span>
  );
}
