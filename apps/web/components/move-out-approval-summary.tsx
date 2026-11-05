'use client';

import type { MoveOutDetail } from '@rent/contracts';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import type { InspectionDetail } from '@/lib/inspections';
import { deductionEvidence, liveDeductions } from '@/lib/move-out';
import { useLoad } from '@/lib/use-load';
import { DeductionList } from './deduction-list';
import { FinalStatement } from './final-statement';
import { Alert } from './ui/alert';

/**
 * What the second person sees before approving a move-out's settlement (M8 plan 4.8): the final
 * statement, laid out to show it balances, and every deduction with its inspection items and
 * photos. A deduction without a photo is pointed out.
 */
export function MoveOutApprovalSummary({ moveOutId }: { readonly moveOutId: string }) {
  const load = useCallback(async (): Promise<{
    detail: MoveOutDetail;
    inspection: InspectionDetail | null;
  }> => {
    const detail = await api().moveOuts.get({ moveOutId });
    const inspection = detail.inspectionId
      ? await api()
          .inspections.get({ inspectionId: detail.inspectionId })
          .catch(() => null)
      : null;
    return { detail, inspection };
  }, [moveOutId]);
  const { state } = useLoad(load);

  if (state.status === 'loading')
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading the final statement…
      </p>
    );
  if (state.status === 'error')
    return (
      <Alert tone="warning" live={false}>
        The move-out could not be loaded: {state.problem.message} Open it before deciding.
      </Alert>
    );
  const { detail, inspection } = state.data;
  const deductions = liveDeductions(detail.deductions);
  const withoutPhoto = deductions.filter((d) => deductionEvidence(d) !== 'photos').length;
  return (
    <div className="space-y-4" data-testid="move-out-approval">
      {detail.statement ? (
        <FinalStatement statement={detail.statement} />
      ) : (
        <Alert tone="warning" live={false}>
          {detail.statementUnavailable?.message ?? 'The statement cannot be shown now.'}
        </Alert>
      )}
      <section className="space-y-2" aria-label="Deductions">
        <h3 className="text-sm font-semibold text-slate-900">Deductions ({deductions.length})</h3>
        {detail.inspectionId === null ? (
          <Alert tone="warning" live={false}>
            There was no move-out inspection, so no photo stands behind any deduction.
          </Alert>
        ) : withoutPhoto > 0 ? (
          <Alert tone="warning" live={false}>
            {withoutPhoto === 1 ? 'One deduction has' : `${withoutPhoto} deductions have`} no photo
            behind {withoutPhoto === 1 ? 'it' : 'them'}.
          </Alert>
        ) : null}
        <DeductionList
          deductions={deductions}
          items={inspection?.items ?? []}
          inspectionId={detail.inspectionId}
        />
      </section>
    </div>
  );
}
