'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { daysLeftLabel } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

/**
 * Leases whose paid-until is near (AR-06; M5 decision 5): within the company's prompt window
 * (90 days unless set), the renewal conversation for tenants who pay ahead. The daily job emails
 * each lease's manager and messages the tenant where consent is recorded; this list shows when.
 */
export function PaidUntilEnding({ windowDays }: { readonly windowDays: number }) {
  const load = useCallback(() => api().advanceRent.paidUntilEnding({}), []);
  const { state, reload } = useLoad(load);
  return (
    <Card data-testid="paid-until-ending">
      <CardHeader
        title="Paid until soon"
        description={`Leases whose rent is paid until a date within ${windowDays} days: time to talk about renewing, or the next advance.`}
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="leases paid until soon" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>No lease is paid until a date that close.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length ? (
          <Table caption="Leases paid until a date within the prompt window">
            <thead>
              <tr>
                <Th>Lease</Th>
                <Th>Paid until</Th>
                <Th>Lease ends</Th>
                <Th>Prompted</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.data.map((row) => (
                <tr key={row.leaseId} data-testid="paid-until-row">
                  <Td>
                    <Link
                      href={`/leases/${row.leaseId}`}
                      className="font-mono font-medium underline underline-offset-2"
                    >
                      {row.unitCode}
                    </Link>
                    <p className="text-xs text-slate-600">
                      {row.tenantName} · {row.propertyName}
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatBusinessDate(row.paidUntil)}
                    <p className="text-xs text-slate-600">{daysLeftLabel(row.daysLeft)}</p>
                  </Td>
                  <Td className="whitespace-nowrap">{formatBusinessDate(row.endDate)}</Td>
                  <Td className="whitespace-nowrap">
                    {row.promptedOn ? formatBusinessDate(row.promptedOn) : 'Not yet'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardBody>
    </Card>
  );
}
