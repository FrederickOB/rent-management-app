'use client';

import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { conditionLabel, type InspectionItem } from '@/lib/inspections';
import { deductionEvidence, EVIDENCE_TEXT, type Deduction } from '@/lib/move-out';
import { formatMinor } from '@/lib/tenancy-format';
import { useApp } from './app-context';
import { MediaView } from './media';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/**
 * Deductions from the deposit (MI-11), each with the inspection items and photos behind it, so
 * the approver sees the evidence. A deduction with no photo says so. Withdrawn ones are shown
 * struck through: deductions are never edited or deleted.
 */
export function DeductionList({
  deductions,
  items,
  inspectionId,
  onWithdraw,
  withdrawing,
}: {
  readonly deductions: readonly Deduction[];
  /** The move-out inspection's items, to name what each deduction points at. */
  readonly items: readonly InspectionItem[];
  readonly inspectionId: string | null;
  readonly onWithdraw?: (deduction: Deduction) => void;
  readonly withdrawing?: string | null;
}) {
  const { timeZone } = useApp();
  if (deductions.length === 0) return <p className="text-sm text-slate-600">No deductions.</p>;
  const byId = new Map(items.map((i) => [i.id, i]));
  return (
    <ul className="space-y-3" aria-label="Deductions">
      {deductions.map((d) => {
        const withdrawn = d.withdrawnAt !== null;
        const evidence = deductionEvidence(d);
        const linked = d.inspectionItemIds
          .map((id) => byId.get(id))
          .filter((i): i is InspectionItem => !!i);
        return (
          <li
            key={d.id}
            className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
            data-testid="deduction"
            data-withdrawn={withdrawn ? 'true' : undefined}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p
                className={withdrawn ? 'text-slate-500 line-through' : 'font-medium text-slate-900'}
              >
                {d.kindLabel}: {d.reason}
              </p>
              <span className="flex items-center gap-2">
                <span
                  className={
                    withdrawn
                      ? 'tabular-nums text-slate-500 line-through'
                      : 'font-semibold tabular-nums'
                  }
                >
                  {formatMinor(d.amountMinor)}
                </span>
                {withdrawn ? <Badge tone="dark">Withdrawn</Badge> : null}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Added {formatTime(d.createdAt, timeZone)}
              {d.createdByName ? ` by ${d.createdByName}` : ''}
              {withdrawn && d.withdrawnAt
                ? ` · withdrawn ${formatTime(d.withdrawnAt, timeZone)}`
                : ''}
            </p>
            {!withdrawn && evidence !== 'photos' ? (
              <Alert tone="warning" live={false}>
                <span data-testid="deduction-no-photo">{EVIDENCE_TEXT[evidence]}</span>
              </Alert>
            ) : null}
            {linked.length > 0 ? (
              <ul className="space-y-1" aria-label="Inspection items">
                {linked.map((item) => (
                  <li key={item.id}>
                    {item.roomLabel}, {item.itemLabel}: {conditionLabel(item.condition)}
                    {item.moveIn ? ` (at move-in: ${conditionLabel(item.moveIn.condition)})` : ''}
                    {item.worsened ? ' · worse than at move-in' : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {d.photoIds.length > 0 && inspectionId ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Photos">
                {d.photoIds.map((photoId, index) => (
                  <li key={photoId}>
                    <MediaView
                      kind="image"
                      name={`Photo ${index + 1} for ${d.kindLabel.toLowerCase()}`}
                      load={async () =>
                        (await api().inspections.photoDownload({ inspectionId, photoId })).url
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {!withdrawn && onWithdraw ? (
              <Button
                size="sm"
                variant="ghost"
                pending={withdrawing === d.id}
                onClick={() => onWithdraw(d)}
              >
                Withdraw <span className="sr-only">{d.kindLabel}</span>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
