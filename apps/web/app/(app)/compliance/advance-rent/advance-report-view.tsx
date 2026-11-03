'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { AdvanceReportTable } from '@/components/advance-report-table';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { RulesWarning } from '@/components/rules-warning';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ADVANCE_POLICY_LABELS, policyNote } from '@/lib/advance-compliance';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/use-load';

/** The advance rent report's body (AR-05): the company's policy, then the flagged leases. */
export function AdvanceReportView({ seeSettings }: { readonly seeSettings: boolean }) {
  const load = useCallback(() => api().advanceRent.compliance(), []);
  const { state, reload } = useLoad(load);
  const rules =
    state.status === 'ready' ? state.data.rows.flatMap((r) => (r.rule ? [r.rule] : [])) : [];
  return (
    <Card data-testid="advance-report">
      <CardHeader
        title="Paid ahead beyond the limit"
        description={
          state.status === 'ready' ? (
            <span data-testid="advance-policy">{ADVANCE_POLICY_LABELS[state.data.policy]}.</span>
          ) : null
        }
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the report" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? (
          <>
            <Alert tone="info" live={false}>
              {policyNote(state.data.policy)}{' '}
              {seeSettings ? (
                <Link href="/settings/company" className="font-medium underline underline-offset-2">
                  Company settings
                </Link>
              ) : null}
            </Alert>
            <RulesWarning rules={rules} />
            {state.data.rows.length === 0 ? (
              <Empty>
                {state.data.policy === 'off'
                  ? 'Nothing is flagged while the check is off.'
                  : 'No lease is paid further ahead than its limit.'}
              </Empty>
            ) : (
              <AdvanceReportTable rows={state.data.rows} linkPayments />
            )}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
