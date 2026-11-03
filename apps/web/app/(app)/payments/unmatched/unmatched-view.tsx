'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { api } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS } from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatTime } from '@/lib/format';
import { useKeepers } from '@/lib/idempotency';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';
import { MatchForm } from '../match-form';
import { ownerAccountOf } from '@/lib/lease-pick';

/** The minimal unmatched list (P23; plan 4.9), with "Match to a lease". */
export function UnmatchedView({ canMatch }: { readonly canMatch: boolean }) {
  const { timeZone } = useApp();
  const load = useCallback(() => api().payments.unmatched(), []);
  const { state, reload } = useLoad(load);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; paymentId: string } | null>(null);
  // One key per receipt while the page is open: reopening its form after a dropped answer reuses it.
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
            {state.data.map((row) => (
              <li key={row.paymentId} data-testid="unmatched-receipt" className="space-y-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="text-base font-semibold tabular-nums">
                      {formatMinor(row.amountMinor)}{' '}
                      <span className="text-sm font-normal text-slate-700">
                        received {formatBusinessDate(row.receivedOn)}
                      </span>
                    </p>
                    <p className="text-slate-700">
                      Into {RECEIVING_ACCOUNT_LABELS[row.receivedInto].toLowerCase()}
                      {row.ownerName ? ` (${row.ownerName})` : ''}
                    </p>
                    {row.senderReference ? (
                      <p>
                        Sender’s reference: <span className="font-mono">{row.senderReference}</span>
                      </p>
                    ) : null}
                    {row.note ? <p className="text-slate-700">{row.note}</p> : null}
                    <p className="text-xs text-slate-600">
                      Recorded {formatTime(row.createdAt, timeZone)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/payments/${row.paymentId}`}
                      className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
                    >
                      Details
                    </Link>
                    {canMatch && open !== row.paymentId ? (
                      <Button size="sm" variant="secondary" onClick={() => setOpen(row.paymentId)}>
                        Match to a lease
                      </Button>
                    ) : null}
                  </div>
                </div>
                {canMatch && open === row.paymentId ? (
                  <MatchForm
                    paymentId={row.paymentId}
                    owner={ownerAccountOf(row)}
                    keeper={keepers(row.paymentId)}
                    onMatched={(_payment, lease) => {
                      setOpen(null);
                      setNotice({
                        text: `Matched ${formatMinor(row.amountMinor)} to ${lease.unitCode}. It paid the lease’s oldest debt first.`,
                        paymentId: row.paymentId,
                      });
                      reload();
                    }}
                    onCancel={() => setOpen(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!canMatch && state.status === 'ready' && state.data.length ? (
          <p className="text-sm text-slate-600">
            You can see these receipts. Matching them needs more access; ask an administrator if you
            need it.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
