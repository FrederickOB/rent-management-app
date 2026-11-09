'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DocumentDownload } from '@/components/document-download';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { monthLabel } from '@/lib/rent-tax';
import { invoiceStateText } from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

const RECEIPT_PDF_POLL_MS = 3_000;
const RECEIPT_PDF_POLLS = 20;

/** The subscription's invoices and receipts, newest first, with their PDFs (PB-07). */
export function BillingHistory({ version }: { readonly version: number }) {
  // `version` changes after a payment, so both lists load again.
  const load = useCallback(
    () =>
      version >= 0
        ? Promise.all([api().subscription.invoices(), api().subscription.receipts()])
        : Promise.resolve(null),
    [version],
  );
  const { state, reload } = useLoad(load);

  // A receipt's PDF is made by the worker just after the payment. Until it is ready the receipt
  // has no document, so the lists load again every few seconds, for about a minute, and its
  // Download appears once the PDF is there.
  const [polls, setPolls] = useState(0);
  useEffect(() => setPolls(0), [version]);
  const receiptPdfWaiting =
    state.status === 'ready' &&
    state.data !== null &&
    state.data[1].some((receipt) => !receipt.hasDocument);
  const stillPolling = receiptPdfWaiting && polls < RECEIPT_PDF_POLLS;
  useEffect(() => {
    if (!stillPolling) return;
    const timer = window.setTimeout(() => {
      setPolls((n) => n + 1);
      reload();
    }, RECEIPT_PDF_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [stillPolling, polls, reload]);

  return (
    <Card data-testid="subscription-history">
      <CardHeader
        title="Invoices and receipts"
        description="Each invoice is made on the 1st for the month before, from that month’s snapshot of units with a lease."
      />
      <CardBody className="space-y-4">
        {state.status === 'loading' ? <Loading what="invoices and receipts" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data ? (
          <>
            {state.data[0].length === 0 ? (
              <Empty>No invoice yet: the first comes on the 1st after the trial ends.</Empty>
            ) : (
              <Table caption="Subscription invoices">
                <thead>
                  <tr>
                    <Th>Invoice</Th>
                    <Th>Month</Th>
                    <Th>Due</Th>
                    <Th className="text-right">Total</Th>
                    <Th>State</Th>
                    <Th>PDF</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data[0].map((invoice) => (
                    <tr key={invoice.id} data-testid="subscription-invoice-row">
                      <Td className="font-medium">
                        <Link
                          href={`/settings/subscription/invoices/${invoice.id}`}
                          className="underline underline-offset-2"
                        >
                          {invoice.number}
                        </Link>
                      </Td>
                      <Td>{monthLabel(invoice.month)}</Td>
                      <Td>{formatBusinessDate(invoice.dueOn)}</Td>
                      <Td className="text-right tabular-nums">{formatMinor(invoice.totalMinor)}</Td>
                      <Td
                        className={invoice.pastDue ? 'font-medium text-amber-900' : undefined}
                        data-testid="subscription-invoice-state"
                      >
                        {invoiceStateText(invoice)}
                      </Td>
                      <Td>
                        {invoice.hasDocument ? (
                          <DocumentDownload
                            label="Download"
                            name={`Download invoice ${invoice.number}`}
                            load={() =>
                              api().subscription.invoiceDocument({ invoiceId: invoice.id })
                            }
                          />
                        ) : (
                          '—'
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {state.data[1].length === 0 ? (
              <Empty>No receipt yet.</Empty>
            ) : (
              <Table caption="Subscription receipts">
                <thead>
                  <tr>
                    <Th>Receipt</Th>
                    <Th>Paid on</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Paid by</Th>
                    <Th>For</Th>
                    <Th>PDF</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data[1].map((receipt) => (
                    <tr key={receipt.id} data-testid="subscription-receipt-row">
                      <Td className="font-medium">{receipt.number}</Td>
                      <Td>{formatBusinessDate(receipt.paidOn)}</Td>
                      <Td className="text-right tabular-nums">
                        {formatMinor(receipt.amountMinor)}
                      </Td>
                      <Td>{receipt.channel === 'card' ? 'Card' : 'Mobile money'}</Td>
                      <Td>
                        {receipt.purpose === 'annual'
                          ? 'Twelve months up front'
                          : receipt.invoiceNumbers.join(', ') || '—'}
                      </Td>
                      <Td>
                        {receipt.hasDocument ? (
                          <DocumentDownload
                            label="Download"
                            name={`Download receipt ${receipt.number}`}
                            load={() =>
                              api().subscription.receiptDocument({ receiptId: receipt.id })
                            }
                          />
                        ) : stillPolling ? (
                          <span className="text-slate-600">The PDF is being made…</span>
                        ) : (
                          '—'
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
