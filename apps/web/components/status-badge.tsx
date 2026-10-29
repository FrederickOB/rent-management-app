import { DISPLAY_STATUS_LABELS, type DisplayStatus } from '@rent/domain/portfolio';
import { Badge, type BadgeTone } from './ui/badge';

export const STATUS_TONES: Record<DisplayStatus, BadgeTone> = {
  occupied: 'green',
  reserved: 'blue',
  under_repair: 'amber',
  not_lettable: 'dark',
  vacant: 'neutral',
};

/**
 * The one status shown for a unit (PR-06; prd-issues 21). An occupied unit that is under repair
 * keeps "Occupied" and gets an "Under repair" badge beside it.
 */
export function StatusBadge({
  status,
  underRepair = false,
}: {
  readonly status: DisplayStatus;
  readonly underRepair?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="unit-status">
      <Badge tone={STATUS_TONES[status]}>{DISPLAY_STATUS_LABELS[status]}</Badge>
      {underRepair && status !== 'under_repair' ? (
        <Badge tone="amber">{DISPLAY_STATUS_LABELS.under_repair}</Badge>
      ) : null}
    </span>
  );
}
