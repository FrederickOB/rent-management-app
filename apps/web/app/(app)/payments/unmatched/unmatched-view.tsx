'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { api } from '@/lib/api';
import { RECEIVED_INTO_LABELS } from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatTime } from '@/lib/format';
import { useKeepers } from '@/lib/idempotency';
import { formatMinor } from '@/lib/tenancy-format';
import { openRefundText, providerFacts, queueOwnerOf } from '@/lib/unmatched-queue';
import { useLoad } from '@/lib/use-load';
import { RefundForm } from './refund-form';
import { SuggestionsPanel } from './suggestions-panel';

export interface QueuePermissions {
  /** payments.match: confirm a match (P23). */
  readonly match: boolean;
  /** payment.refund_unmatched: ask to refund money that belongs to no lease (P31). */
  readonly refund: boolean;
  readonly seeApprovals: boolean;
}

type Open = { readonly paymentId: string; readonly what: 'match' | 'refund' } | null;

interface Notice {
  readonly text: string;
  readonly paymentId: string;
  /** A refund waits in Approvals; a match has taken effect. */
  readonly approvals: boolean;
}

/** The unmatched queue (BC-12; plan 4.5), with ranked suggestions and refunds. */
export function UnmatchedView({ can }: { readonly can: QueuePermissions }) {
  const { timeZone } = useApp();
  const load = useCallback(() => api().payments.unmatched(), []);
  const { state, reload } = useLoad(load);
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // One key per receipt and action while the page is open: reopening a form after a dropped
  // answer reuses it, so the money is never matched or refunded twice.
  const keepers = useKeepers();

  return (
    <Card>
      <CardBody>
        {notice ? (
          <Alert tone="success">
            {notice.text}{' '}
            <Link
              href={`/payments/${notice.paymentId}`}
              className="font-medium underline underline-offset-2"
            >
              Open the payment
            </Link>
            {notice.approvals && can.seeApprovals ? (
              <>
                {' · '}
                <Link href="/approvals" className="font-medium underline underline-offset-2">
                  Open Approvals
                </Link>
              </>
            ) : null}
          </Alert>
        ) : null}
        {state.status === 'loading' ? <Loading what="unmatched receipts" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>Nothing is waiting to be matched.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length ? (
          <ul className="divide-y divide-slate-100">
            {state.data.map((row) => {
              const isOpen = open?.paymentId === row.paymentId;
              const amount = formatMinor(row.amountMinor);
              // Money with a refund asked for is not matched meanwhile (P31).
              const refunding = row.openRefund ?? null;
              return (
                <li key={row.paymentId} data-testid="unmatched-receipt" className="space-y-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1 text-sm">
                      <p className="text-base font-semibold tabular-nums">
                        {amount}{' '}
                        <span className="text-sm font-normal text-slate-700">
                          received {formatBusinessDate(row.receivedOn)}
                        </span>
                      </p>
                      <p className="text-slate-700">
                        Into {RECEIVED_INTO_LABELS[row.receivedInto].toLowerCase()}
                        {row.settlesInto
                          ? `, settling into ${RECEIVED_INTO_LABELS[row.settlesInto].toLowerCase()}`
                          : ''}
                        {row.ownerName ? ` (${row.ownerName})` : ''}
                      </p>
                      {providerFacts(row).map((fact) => (
                        <p key={fact} data-testid="unmatched-provider-fact">
                          {fact}
                        </p>
                      ))}
                      {row.senderReference ? (
                        <p>
                          Sender’s reference:{' '}
                          <span className="font-mono">{row.senderReference}</span>
                        </p>
                      ) : null}
                      {row.note ? <p className="text-slate-700">{row.note}</p> : null}
                      <p className="text-xs text-slate-600">
                        Recorded {formatTime(row.createdAt, timeZone)}
                      </p>
                      {refunding ? (
                        <p className="font-medium text-amber-900" data-testid="unmatched-refund">
                          {openRefundText(refunding)}{' '}
                          {can.seeApprovals ? (
                            <Link href="/approvals" className="underline underline-offset-2">
                              Open Approvals
                            </Link>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/payments/${row.paymentId}`}
                        className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
                      >
                        Details
                      </Link>
                      {can.match && !refunding && !(isOpen && open.what === 'match') ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setOpen({ paymentId: row.paymentId, what: 'match' })}
                        >
                          Find the lease<span className="sr-only"> for {amount}</span>
                        </Button>
                      ) : null}
                      {can.refund && !refunding && !(isOpen && open.what === 'refund') ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setOpen({ paymentId: row.paymentId, what: 'refund' })}
                        >
                          Refund to the payer<span className="sr-only"> ({amount})</span>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {can.match && !refunding && isOpen && open.what === 'match' ? (
                    <SuggestionsPanel
                      paymentId={row.paymentId}
                      amountMinor={row.amountMinor}
                      owner={queueOwnerOf(row)}
                      keeper={keepers(`match:${row.paymentId}`)}
                      onMatched={(unitCode) => {
                        setOpen(null);
                        setNotice({
                          text: `Matched ${amount} to ${unitCode}. It paid the lease’s oldest debt first.`,
                          paymentId: row.paymentId,
                          approvals: false,
                        });
                        reload();
                      }}
                      onCancel={() => setOpen(null)}
                    />
                  ) : null}
                  {can.refund && !refunding && isOpen && open.what === 'refund' ? (
                    <RefundForm
                      row={row}
                      keeper={keepers(`refund:${row.paymentId}`)}
                      onAsked={(text) => {
                        setOpen(null);
                        setNotice({ text, paymentId: row.paymentId, approvals: true });
                        reload();
                      }}
                      onCancel={() => setOpen(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {!can.match && state.status === 'ready' && state.data.length ? (
          <p className="text-sm text-slate-600">
            You can see these receipts. Matching them needs more access; ask an administrator if you
            need it.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
