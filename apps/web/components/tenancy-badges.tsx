import type { LeaseStatus } from '@rent/domain/tenancy';
import { ID_STATUS_LABELS, leaseStatusLabel, type IdStatus } from '@/lib/tenancy-format';
import { Badge, type BadgeTone } from './ui/badge';

const LEASE_TONES: Record<LeaseStatus, BadgeTone> = {
  draft: 'neutral',
  pending_signatures: 'blue',
  signed: 'blue',
  active: 'green',
  ending: 'amber',
  holding_over: 'amber',
  ended: 'dark',
  terminated: 'dark',
  cancelled: 'dark',
};

/** A lease's state (plan 4.7), with a border so it reads the same without colour. */
export function LeaseStatusBadge({ status }: { readonly status: LeaseStatus }) {
  return (
    <span data-testid="lease-status">
      <Badge tone={LEASE_TONES[status]}>{leaseStatusLabel(status)}</Badge>
    </span>
  );
}

const ID_TONES: Record<IdStatus, BadgeTone> = {
  none: 'neutral',
  not_started: 'neutral',
  pending: 'blue',
  verified: 'green',
  not_matched: 'red',
  recorded: 'dark',
};

/** TL-02: whether the ID number has been checked against NIA records. */
export function IdStatusBadge({ status }: { readonly status: IdStatus }) {
  return (
    <span data-testid="id-status">
      <Badge tone={ID_TONES[status]}>{ID_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

/** "Signed on paper" claims no e-signature evidence (decision 7). */
export function PaperBadge() {
  return <Badge tone="dark">Signed on paper</Badge>;
}
