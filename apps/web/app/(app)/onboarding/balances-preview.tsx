'use client';

import type { OnboardingPreview } from '@rent/contracts';
import { useCallback } from 'react';
import { LoadFailed, Loading } from '@/components/load-state';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem, type Problem } from '@/lib/errors';
import { balanceWord, changedFigures, onboardingMessage } from '@/lib/onboarding';
import { bucketsOf } from '@/lib/reporting';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

type Figures = OnboardingPreview['leases'][number]['after'];

const toError = (failure: unknown): Problem => {
  const problem = toProblem(failure);
  return { ...problem, message: onboardingMessage(failure) ?? problem.message };
};

/**
 * Each lease as the landlord will see it after commit (decision 3), to check against their own
 * records, with totals per owner. For an adjustment, each changed figure shows before and after.
 */
export function BalancesPreview({
  batchId,
  adjustment,
}: {
  readonly batchId: string;
  readonly adjustment: boolean;
}) {
  const load = useCallback(() => api().onboarding.preview({ batchId }), [batchId]);
  const { state, reload } = useLoad(load, toError);

  if (state.status === 'loading') return <Loading what="the preview" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const preview = state.data;

  return (
    <section className="space-y-4" data-testid="balances-preview">
      <h3 className="text-sm font-semibold text-slate-900">
        {adjustment ? 'Each lease before and after the adjustment' : 'Each lease after commit'}, on
        the cut-over of {formatBusinessDate(preview.cutOverDate)}
      </h3>
      <p className="text-sm text-slate-700">
        Check these against the landlord’s own records before asking for approval.
      </p>
      <Table caption="Leases after commit">
        <thead>
          <tr>
            <Th>Unit</Th>
            <Th>Tenant</Th>
            <Th>Owner</Th>
            <Th className="text-right">Balance</Th>
            <Th className="text-right">Arrears, by age</Th>
            <Th className="text-right">Paid ahead</Th>
            <Th>Paid until</Th>
            <Th className="text-right">Deposit held</Th>
            <Th className="text-right">Withholding to certify</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {preview.leases.map((lease) => {
            const changed = new Set(changedFigures(lease.before, lease.after));
            const money = (key: keyof Figures & `${string}Minor`) => (
              <Figure
                after={formatMinor(lease.after[key] as number)}
                before={
                  lease.before && changed.has(key) ? formatMinor(lease.before[key] as number) : null
                }
              />
            );
            return (
              <tr key={lease.leaseId} data-testid="preview-lease">
                <Td className="font-medium">{lease.unitCode}</Td>
                <Td>{lease.tenantName}</Td>
                <Td>{lease.owner.name}</Td>
                <Td className="text-right tabular-nums" data-testid="preview-balance">
                  {money('balanceMinor')}
                  <span className="block text-xs text-slate-600">
                    {balanceWord(lease.after.balanceMinor)}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  {money('arrearsMinor')}
                  {lease.after.arrearsMinor > 0 ? (
                    <span className="block text-xs text-slate-600">
                      {bucketsOf(lease.after.arrearsByAge)
                        .filter((b) => b.amountMinor > 0)
                        .map((b) => `${b.label}: ${formatMinor(b.amountMinor)}`)
                        .join('; ')}
                    </span>
                  ) : null}
                </Td>
                <Td className="text-right tabular-nums">{money('advanceMinor')}</Td>
                <Td>
                  <Figure
                    after={lease.after.paidUntil ? formatBusinessDate(lease.after.paidUntil) : '—'}
                    before={
                      lease.before && changed.has('paidUntil')
                        ? lease.before.paidUntil
                          ? formatBusinessDate(lease.before.paidUntil)
                          : '—'
                        : null
                    }
                  />
                </Td>
                <Td className="text-right tabular-nums">{money('depositHeldMinor')}</Td>
                <Td className="text-right tabular-nums">{money('withholdingOutstandingMinor')}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <Table caption="Totals per owner">
        <thead>
          <tr>
            <Th>Owner</Th>
            <Th className="text-right">Leases</Th>
            <Th className="text-right">Arrears</Th>
            <Th className="text-right">Paid ahead</Th>
            <Th className="text-right">Deposits held</Th>
            <Th className="text-right">Withholding to certify</Th>
            <Th className="text-right">Agent-held cash</Th>
            <Th className="text-right">Rent tax outstanding</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {preview.owners.map((row) => (
            <tr key={row.owner.id} data-testid="preview-owner">
              <Td className="font-medium">{row.owner.name}</Td>
              <Td className="text-right tabular-nums">{row.leases}</Td>
              <Td className="text-right tabular-nums">{formatMinor(row.arrearsMinor)}</Td>
              <Td className="text-right tabular-nums">{formatMinor(row.advancesMinor)}</Td>
              <Td className="text-right tabular-nums">{formatMinor(row.depositsHeldMinor)}</Td>
              <Td className="text-right tabular-nums">
                {formatMinor(row.withholdingOutstandingMinor)}
              </Td>
              <Td className="text-right tabular-nums">{formatMinor(row.agentCashMinor)}</Td>
              <Td className="text-right tabular-nums">
                {formatMinor(row.rentTaxOutstandingMinor)}
                {row.rentTaxDueOn ? (
                  <span className="block text-xs text-slate-600">
                    due {formatBusinessDate(row.rentTaxDueOn)}
                  </span>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

/** A figure, with its value before an adjustment when it changes. */
function Figure({ after, before }: { readonly after: string; readonly before: string | null }) {
  if (before === null) return <>{after}</>;
  return (
    <>
      <span className="block text-xs text-slate-500 line-through">{before}</span>
      <span className="font-medium">{after}</span>
    </>
  );
}
