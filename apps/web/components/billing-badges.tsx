import type { InvoiceStatus } from '@rent/domain/billing';
import {
  CASH_RECORD_STATUS_LABELS,
  invoiceStatusLabel,
  PAYMENT_STATUS_LABELS,
  type CashRecordStatus,
  type PaymentStatus,
} from '@/lib/billing-format';
import { Badge, type BadgeTone } from './ui/badge';

const INVOICE_TONES: Record<InvoiceStatus, BadgeTone> = {
  issued: 'blue',
  part_paid: 'amber',
  paid: 'green',
  voided: 'dark',
  written_off: 'dark',
};

/** An invoice's state, derived by the API from its lines (architecture section 7). */
export function InvoiceStatusBadge({
  status,
  overdue,
}: {
  readonly status: InvoiceStatus;
  readonly overdue?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="invoice-status">
      <Badge tone={INVOICE_TONES[status]}>{invoiceStatusLabel(status)}</Badge>
      {overdue ? <Badge tone="red">Overdue</Badge> : null}
    </span>
  );
}

const PAYMENT_TONES: Record<PaymentStatus, BadgeTone> = {
  confirmed: 'green',
  unmatched: 'amber',
  reversed: 'dark',
};

export function PaymentStatusBadge({ status }: { readonly status: PaymentStatus }) {
  return (
    <span data-testid="payment-status">
      <Badge tone={PAYMENT_TONES[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

const CASH_TONES: Record<CashRecordStatus, BadgeTone> = {
  awaiting_approval: 'amber',
  approved: 'green',
  rejected: 'red',
  cancelled: 'dark',
};

/** BC-05: cash posts only once a second person approves it (decision 7 for a lone landlord). */
export function CashRecordStatusBadge({ status }: { readonly status: CashRecordStatus }) {
  return (
    <span data-testid="cash-record-status">
      <Badge tone={CASH_TONES[status]}>{CASH_RECORD_STATUS_LABELS[status]}</Badge>
    </span>
  );
}
