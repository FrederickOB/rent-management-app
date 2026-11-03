import {
  dueLabel,
  dueState,
  dueTone,
  RENT_TAX_STATUS_LABELS,
  type DueItem,
  type RentTaxStatus,
} from '@/lib/rent-tax';
import { TERMINATION_STATUS_LABELS, type TerminationStatus } from '@/lib/termination';
import {
  WITHHOLDING_STATUS_LABELS,
  WITHHOLDING_STATUS_TONES,
  type WithholdingStatus,
} from '@/lib/withholding';
import { Badge, type BadgeTone } from './ui/badge';

const RENT_TAX_TONES: Record<RentTaxStatus, BadgeTone> = {
  open: 'blue',
  part_paid: 'amber',
  paid: 'green',
  withheld: 'neutral',
  reversed: 'dark',
  correction: 'dark',
};

/** A rent tax item's status (TX-01, TX-03). */
export function RentTaxStatusBadge({ status }: { readonly status: RentTaxStatus }) {
  return (
    <span data-testid="rent-tax-status">
      <Badge tone={RENT_TAX_TONES[status]}>{RENT_TAX_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

/** Where an item stands against its due date on `today`, with the 21- and 28-day alerts (TX-02). */
export function DueBadge({ item, today }: { readonly item: DueItem; readonly today: string }) {
  return (
    <span data-testid="rent-tax-due-state">
      <Badge tone={dueTone(dueState(item, today))} className="whitespace-normal">
        {dueLabel(item, today)}
      </Badge>
    </span>
  );
}

/** A withholding record's certificate status (TX-04). */
export function WithholdingStatusBadge({ status }: { readonly status: WithholdingStatus }) {
  return (
    <span data-testid="withholding-status">
      <Badge tone={WITHHOLDING_STATUS_TONES[status]} className="whitespace-normal">
        {WITHHOLDING_STATUS_LABELS[status]}
      </Badge>
    </span>
  );
}

const TERMINATION_TONES: Record<TerminationStatus, BadgeTone> = {
  awaiting_approval: 'amber',
  settled: 'blue',
  refund_paid: 'green',
  rejected: 'red',
};

/** An early termination's progress (AR-04, P13). */
export function TerminationStatusBadge({ status }: { readonly status: TerminationStatus }) {
  return (
    <span data-testid="termination-status">
      <Badge tone={TERMINATION_TONES[status]} className="whitespace-normal">
        {TERMINATION_STATUS_LABELS[status]}
      </Badge>
    </span>
  );
}
