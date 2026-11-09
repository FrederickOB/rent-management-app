'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useApp } from '@/components/app-context';
import { DocumentDownload } from '@/components/document-download';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatTime } from '@/lib/format';
import { monthLabel } from '@/lib/rent-tax';
import {
  bandLabel,
  bandRows,
  invoiceLineText,
  invoiceStateText,
  totalUnits,
  vatStatusText,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

export function InvoiceView({ invoiceId }: { readonly invoiceId: string }) {
  const { timeZone } = useApp();
  const load = useCallback(async () => {
    const invoice = await api().subscription.invoice({ invoiceId });
    const snapshot = await api().subscription.snapshot({ snapshotId: invoice.snapshotId });
    return { invoice, snapshot };
  }, [invoiceId]);
  const { state, reload } = useLoad(load);

  const back = (
    <p className="text-sm">
      <Link href="/settings/subscription" className="underline underline-offset-2">
        Subscription
      </Link>
    </p>
  );
  if (state.status === 'loading')
    return (
      <>
        {back}
        <Loading what="the invoice" />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {back}
        <LoadFailed message={state.problem.message} onRetry={reload} />
      </>
    );
  const { invoice, snapshot } = state.data;
  const hasVat = invoice.lines.some((line) => ['vat', 'nhil', 'getfund'].includes(line.kind));

  return (
    <>
      {back}
      <PageHeader
        title={`Invoice ${invoice.number}`}
        description={`${monthLabel(invoice.month)}. Issued ${formatBusinessDate(invoice.issuedOn)}, due ${formatBusinessDate(invoice.dueOn)}.`}
      />
      <Card data-testid="subscription-invoice">
        <CardHeader
          title={invoiceStateText(invoice)}
          actions={
            invoice.hasDocument ? (
              <DocumentDownload
                label="Download the PDF"
                load={() => api().subscription.invoiceDocument({ invoiceId: invoice.id })}
              />
            ) : null
          }
        />
        <CardBody className="space-y-3">
          {hasVat && invoice.vatUnverified ? (
            <Alert tone="warning">{vatStatusText({ charged: true, verified: false })}</Alert>
          ) : null}
          <Table caption="Invoice lines">
            <thead>
              <tr>
                <Th>Line</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.lines.map((line, index) => (
                <tr key={`${line.kind}-${index}`} data-testid="subscription-invoice-line">
                  <Td>{invoiceLineText(line)}</Td>
                  <Td className="text-right tabular-nums">{formatMinor(line.amountMinor)}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-semibold">Total</Td>
                <Td className="text-right font-semibold tabular-nums">
                  {formatMinor(invoice.totalMinor)}
                </Td>
              </tr>
            </tbody>
          </Table>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-600">From prepaid credit</dt>
              <dd className="tabular-nums">{formatMinor(invoice.prepaidMinor)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">Paid</dt>
              <dd className="tabular-nums">{formatMinor(invoice.paidMinor)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">Left to pay</dt>
              <dd className="font-semibold tabular-nums">
                {formatMinor(invoice.outstandingMinor)}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      <Card data-testid="subscription-snapshot">
        <CardHeader
          title={`The units billed: ${monthLabel(snapshot.month)}`}
          description={`Recorded ${formatTime(snapshot.takenAt, timeZone)} and never changed: every unit with a lease on any day of the month. Vacant units are not billed.`}
        />
        <CardBody className="space-y-3">
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {bandRows(snapshot.countsByBand).map((row) => (
              <li key={row.band}>
                {row.label}: <span className="font-medium tabular-nums">{row.value}</span>
              </li>
            ))}
            <li>
              Every band:{' '}
              <span className="font-medium tabular-nums">{totalUnits(snapshot.countsByBand)}</span>
            </li>
          </ul>
          <Table caption="Units billed, one by one">
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Band</Th>
                <Th className="text-right">Days with a lease</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {snapshot.units.map((unit) => (
                <tr key={`${unit.unitId}-${unit.leaseId}`} data-testid="snapshot-unit">
                  <Td className="font-medium">{unit.unitCode}</Td>
                  <Td>{bandLabel(unit.band)}</Td>
                  <Td className="text-right tabular-nums">{unit.daysLeased}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
