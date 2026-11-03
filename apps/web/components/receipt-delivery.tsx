'use client';

import { deliveryLine, deliverySpeed, type DeliveryFacts } from '@/lib/receipt-delivery';
import { useApp } from './app-context';
import { Badge } from './ui/badge';

/**
 * Whether a receipt reached the tenant, on which channel and how long after the payment was
 * confirmed (BC-06; M4b plan 4.6). A receipt sent later than the one-minute target says so.
 */
export function ReceiptDelivery({
  delivery,
  compact = false,
}: {
  /** Left out by an API from before M4b; null when the receipt was never queued for the tenant. */
  readonly delivery: DeliveryFacts | null | undefined;
  /** For a table row: the badge and how fast, without the full sentence. */
  readonly compact?: boolean;
}) {
  const { timeZone } = useApp();
  if (delivery === undefined) return null;
  const line = deliveryLine(delivery, timeZone);
  const detail = compact ? deliverySpeed(delivery) : line.detail;
  return (
    <span className="inline-flex flex-col gap-0.5" data-testid="receipt-delivery">
      <span data-testid="receipt-delivery-label">
        <Badge tone={line.tone}>{line.label}</Badge>
      </span>
      {detail ? (
        <span className="text-xs text-slate-600" data-testid="receipt-delivery-detail">
          {detail}
        </span>
      ) : null}
    </span>
  );
}
