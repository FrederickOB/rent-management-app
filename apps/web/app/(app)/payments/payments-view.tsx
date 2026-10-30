'use client';

import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentRow } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { PaymentStatusBadge } from '@/components/billing-badges';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

const LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The payment list (plan 4.19), by status, method and date received. */
export function PaymentsView({ leaseId: initialLease }: { readonly leaseId: string | null }) {
  const [leaseId, setLeaseId] = useState(initialLease);
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<readonly PaymentRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const chosenStatus = PAYMENT_STATUSES.find((s) => s === status);
      const chosenMethod = PAYMENT_METHODS.find((m) => m === method);
      const list = await api().payments.list({
        ...(leaseId ? { leaseId } : {}),
        ...(chosenStatus ? { status: chosenStatus } : {}),
        ...(chosenMethod ? { method: chosenMethod } : {}),
        ...(ISO_DATE.test(from) ? { from } : {}),
        ...(ISO_DATE.test(to) ? { to } : {}),
        limit: LIMIT,
      });
      if (!current()) return;
      setRows(list);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, leaseId, status, method, from, to]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            label="Status"
            value={status}
            options={[
              { value: '', label: 'Any' },
              ...PAYMENT_STATUSES.map((s) => ({ value: s, label: PAYMENT_STATUS_LABELS[s] })),
            ]}
            onChange={(event) => setStatus(event.target.value)}
          />
          <SelectField
            label="How it was paid"
            value={method}
            options={[
              { value: '', label: 'Any way' },
              ...PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] })),
            ]}
            onChange={(event) => setMethod(event.target.value)}
          />
          <TextField
            label="Received from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <TextField
            label="Received to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {leaseId ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">Showing one lease</Badge>
            <Button size="sm" variant="ghost" onClick={() => setLeaseId(null)}>
              Show every payment
            </Button>
          </div>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null && !problem ? <Loading what="payments" /> : null}
        {rows?.length === 0 ? <Empty>No payment matches.</Empty> : null}
        {rows?.length ? (
          <>
            <Table caption="Payments">
              <thead>
                <tr>
                  <Th>Received</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>How</Th>
                  <Th>Tenant and unit</Th>
                  <Th>Receipt</Th>
                  <Th className="text-right">Credit left</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} data-testid="payment-row">
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/payments/${row.id}`}
                        className="font-medium underline underline-offset-2"
                      >
                        {formatBusinessDate(row.receivedOn)}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
                    <Td>
                      {PAYMENT_METHOD_LABELS[row.method]}
                      {row.collectorName ? (
                        <p className="text-xs text-slate-600">Collected by {row.collectorName}</p>
                      ) : null}
                    </Td>
                    <Td>
                      {row.tenantName ?? <span className="text-slate-600">No lease yet</span>}
                      {row.unitCode ? (
                        <p className="text-xs text-slate-600">
                          <span className="font-mono">{row.unitCode}</span>
                          {row.propertyName ? ` · ${row.propertyName}` : ''}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="font-mono">{row.receiptNumber ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.creditMinor)}</Td>
                    <Td>
                      <PaymentStatusBadge status={row.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {rows.length >= LIMIT ? (
              <p className="text-sm text-slate-600">
                Showing the first {LIMIT}. Narrow the dates to find others.
              </p>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
