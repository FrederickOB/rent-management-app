'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { RETENTION_CATEGORY_LABELS } from '@/lib/data-protection';
import { formatTime } from '@/lib/format';
import { retentionStatusText } from '@/lib/ops';
import { useLoad } from '@/lib/use-load';

export function RetentionView() {
  const load = useCallback(() => api().platformRetention.review(), []);
  const { state, reload } = useLoad(load);

  return (
    <>
      <p className="text-sm">
        <Link href="/platform/health" className="underline underline-offset-2">
          System health
        </Link>
      </p>
      {state.status === 'loading' ? <Loading what="the retention review" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' ? (
        <Card data-testid="retention-review">
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-700">
              {state.data.checkedAt
                ? `Reviewed ${formatTime(state.data.checkedAt, 'UTC')}.`
                : 'Not reviewed yet: the review runs each night.'}
            </p>
            {state.data.categories.length === 0 ? (
              <Empty>No categories reviewed.</Empty>
            ) : (
              <Table caption="Records past their retention period">
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th>Rule</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Past retention</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data.categories.map((row) => (
                    <tr key={row.category} data-testid="retention-category">
                      <Td className="font-medium">{RETENTION_CATEGORY_LABELS[row.category]}</Td>
                      <Td className="font-mono text-xs break-all">{row.ruleKey}</Td>
                      <Td>
                        <Badge tone={row.verified ? 'green' : 'amber'}>
                          {row.verified ? 'Verified' : 'Unverified'}
                        </Badge>
                        <span className="block text-xs text-slate-600">
                          {retentionStatusText(row)}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums">
                        {row.verified ? row.pastRetention : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
