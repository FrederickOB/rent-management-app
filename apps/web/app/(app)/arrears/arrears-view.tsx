'use client';

import type { Arrears } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  ARREARS_BY,
  ARREARS_BY_LABELS,
  ARREARS_KEY_LABELS,
  BUCKET_COLUMNS,
  OPENS_TENANT,
  bucketMinor,
  overdueInvoicesHref,
  recordHref,
  type ArrearsBy,
} from '@/lib/arrears-view';
import { ageBucketLabel } from '@/lib/billing-format';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

/** The ageing table (BC-08). The API ages the lines as of the date; nothing here adds up money. */
export function ArrearsView({
  initialBy,
  initialAsOf,
  seeTenants,
}: {
  readonly initialBy: ArrearsBy;
  readonly initialAsOf: string;
  readonly seeTenants: boolean;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [by, setBy] = useState<ArrearsBy>(initialBy);
  const [asOf, setAsOf] = useState(initialAsOf || today);
  const [data, setData] = useState<Arrears | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    setData(null);
    try {
      const result = await api().arrears.get({
        by,
        ...(/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? { asOf } : {}),
      });
      if (!current()) return;
      setData(result);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, by, asOf]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  // A tenant's page opens only for people who may see tenants.
  const linkRecord = (shown: ArrearsBy) => !OPENS_TENANT[shown] || seeTenants;

  return (
    <Card data-testid="arrears">
      <CardHeader
        title="Overdue invoices by age"
        description={
          data
            ? `As of ${formatBusinessDate(data.asOf)}. Days are counted from each line’s due date.`
            : 'Days are counted from each line’s due date.'
        }
      />
      <CardBody>
        <div className="flex flex-wrap items-end gap-4">
          <div role="group" aria-label="Group the arrears" className="flex flex-wrap gap-2">
            {ARREARS_BY.map((option) => (
              <Button
                key={option}
                variant={by === option ? 'primary' : 'secondary'}
                aria-pressed={by === option}
                onClick={() => setBy(option)}
              >
                {ARREARS_BY_LABELS[option]}
              </Button>
            ))}
          </div>
          <TextField
            label="As of"
            type="date"
            max={today}
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
            className="w-48"
          />
        </div>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {data === null && !problem ? <Loading what="arrears" /> : null}
        {data && data.rows.length === 0 ? (
          <Empty>Nothing is overdue as of {formatBusinessDate(data.asOf)}.</Empty>
        ) : null}
        {data && data.rows.length ? (
          <Table caption={`Arrears ${ARREARS_BY_LABELS[data.by].toLowerCase()}`}>
            <thead>
              <tr>
                <Th>{ARREARS_KEY_LABELS[data.by]}</Th>
                {BUCKET_COLUMNS.map((bucket) => (
                  <Th key={bucket} className="text-right">
                    {ageBucketLabel(bucket)}
                  </Th>
                ))}
                <Th className="text-right">Total</Th>
                <Th>Oldest due</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((row) => (
                <tr key={row.key} data-testid="arrears-row">
                  {/* The row's name heads it, so each amount is read with whose it is. */}
                  <th
                    scope="row"
                    className="px-3 py-3 text-left align-top font-normal text-slate-800"
                  >
                    {linkRecord(data.by) ? (
                      <Link
                        href={recordHref(data.by, row.key)}
                        className="font-medium underline underline-offset-2"
                      >
                        {row.label}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.label}</span>
                    )}
                    <p className="text-xs">
                      <Link
                        href={overdueInvoicesHref(data.by, row.key)}
                        className="underline underline-offset-2"
                      >
                        Overdue invoices
                      </Link>
                      {row.leaseIds.length > 1 ? ` · ${row.leaseIds.length} leases` : ''}
                    </p>
                  </th>
                  {BUCKET_COLUMNS.map((bucket) => (
                    <Td
                      key={bucket}
                      data-testid={`bucket-${bucket}`}
                      className="text-right tabular-nums"
                    >
                      {bucketMinor(row.buckets, bucket)
                        ? formatMinor(bucketMinor(row.buckets, bucket))
                        : '—'}
                    </Td>
                  ))}
                  <Td className="text-right font-semibold tabular-nums" data-testid="arrears-total">
                    {formatMinor(row.totalMinor)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatBusinessDate(row.oldestDueDate)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300" data-testid="arrears-totals">
                <Th scope="row">Total</Th>
                {BUCKET_COLUMNS.map((bucket) => (
                  <Td
                    key={bucket}
                    data-testid={`bucket-${bucket}`}
                    className="text-right font-semibold tabular-nums"
                  >
                    {formatMinor(bucketMinor(data.totals, bucket))}
                  </Td>
                ))}
                <Td className="text-right font-semibold tabular-nums" data-testid="arrears-total">
                  {formatMinor(data.totalMinor)}
                </Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        ) : null}
      </CardBody>
    </Card>
  );
}
