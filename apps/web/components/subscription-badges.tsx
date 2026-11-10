import type { SubscriptionStatus } from '@rent/domain/subscription';
import { SUBSCRIPTION_STATE_LABELS } from '@/lib/subscription';
import { Badge, type BadgeTone } from './ui/badge';

const STATUS_TONES: Record<SubscriptionStatus, BadgeTone> = {
  trialing: 'blue',
  active: 'green',
  past_due: 'amber',
  read_only: 'red',
  cancel_scheduled: 'amber',
  cancelled: 'neutral',
};

/** A subscription's status (M10 decisions 5, 11 and 12), for the subscriber and the console. */
export function SubscriptionStatusBadge({ status }: { readonly status: SubscriptionStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{SUBSCRIPTION_STATE_LABELS[status]}</Badge>;
}
