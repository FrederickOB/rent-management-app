'use client';

import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading } from '@/components/load-state';
import { ReceiptDelivery } from '@/components/receipt-delivery';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { RECEIPT_KIND_LABELS } from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

type Receipt = Awaited<ReturnType<ApiClient['payments']['receipts']>>[number];

const LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The receipt list and its PDFs, each opened through a short-lived link. */
export function ReceiptsView() {
  const { timeZone } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<readonly Receipt[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pdfProblem, setPdfProblem] = useState<string | null>(null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const list = await api().payments.receipts({
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
  }, [gate, from, to]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  async function open(receiptId: string) {
    setPdfProblem(null);
    try {
      await openFetchedLink(async () => (await api().payments.receiptDocument({ receiptId })).url);
    } catch (failure) {
      setPdfProblem(toProblem(failure).message);
    }
  }

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
          <TextField
            label="Issued from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <TextField
            label="Issued to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {pdfProblem ? <Alert tone="error">{pdfProblem}</Alert> : null}
        {rows === null && !problem ? <Loading what="receipts" /> : null}
        {rows?.length === 0 ? <Empty>No receipt matches.</Empty> : null}
        {rows?.length ? (
          <>
            <Table caption="Receipts">
              <thead>
                <tr>
                  <Th>Receipt</Th>
                  <Th>Issued</Th>
                  <Th>Tenant and unit</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>To the tenant</Th>
                  <Th>PDF</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} data-testid="receipt-row">
                    <Td>
                      <Link
                        href={`/payments/${row.paymentId}`}
                        className="font-mono font-medium underline underline-offset-2"
                      >
                        {row.number}
                      </Link>
                      <p className="text-xs text-slate-600">{RECEIPT_KIND_LABELS[row.kind]}</p>
                    </Td>
                    <Td className="whitespace-nowrap">{formatTime(row.issuedAt, timeZone)}</Td>
                    <Td>
                      {row.tenantName ?? '—'}
                      {row.unitCode ? (
                        <p className="font-mono text-xs text-slate-600">{row.unitCode}</p>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
                    <Td>
                      {/* BC-06: whether it reached the tenant, and how fast. */}
                      <ReceiptDelivery delivery={row.delivery} compact />
                    </Td>
                    <Td>
                      <Button size="sm" variant="secondary" onClick={() => void open(row.id)}>
                        Open {row.number}
                      </Button>
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
