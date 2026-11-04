'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading } from '@/components/load-state';
import { ReasonForm } from '@/components/reason-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  exceptionWords,
  RESOLVE_NOTE,
  sortExceptions,
  type ReconciliationException,
} from '@/lib/reconciliation';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

/** Reconciliation exceptions for a person to look into and resolve (plan 4.8). */
export function ReconciliationView({ canResolve }: { readonly canResolve: boolean }) {
  const [showResolved, setShowResolved] = useState(false);
  const [rows, setRows] = useState<readonly ReconciliationException[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const list = await api().paymentsQueue.exceptions(showResolved ? {} : { open: 'true' });
      if (!current()) return;
      setRows(sortExceptions(list));
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, showResolved]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  return (
    <Card data-testid="reconciliation">
      <CardBody>
        <CheckboxField
          label="Show resolved ones too"
          checked={showResolved}
          onChange={(event) => {
            setRows(null);
            setShowResolved(event.target.checked);
          }}
        />
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null && !problem ? <Loading what="reconciliation exceptions" /> : null}
        {rows?.length === 0 ? (
          <Empty>
            {showResolved
              ? 'Reconciliation has found nothing to look into.'
              : 'Nothing to look into: the provider’s records and settlements match ours.'}
          </Empty>
        ) : null}
        {rows?.length ? (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <ExceptionItem
                key={row.id}
                row={row}
                canResolve={canResolve}
                onResolved={(text) => {
                  setNotice(text);
                  void load();
                }}
              />
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ExceptionItem({
  row,
  canResolve,
  onResolved,
}: {
  readonly row: ReconciliationException;
  readonly canResolve: boolean;
  readonly onResolved: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [resolving, setResolving] = useState(false);
  const words = exceptionWords(row.kind);
  const open = row.resolvedAt === null;
  return (
    <li data-testid="reconciliation-exception" className="space-y-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="text-base font-semibold">{words.title}</p>
          <p className="text-slate-800">{row.detail}</p>
          <p className="text-slate-700">{words.check}</p>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-slate-700">
            {row.amountMinor !== null ? (
              <div>
                <dt className="inline">Amount: </dt>
                <dd className="inline tabular-nums">{formatMinor(row.amountMinor)}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline">Provider: </dt>
              <dd className="inline">{row.provider}</dd>
            </div>
            {row.reference ? (
              <div>
                <dt className="inline">Reference: </dt>
                <dd className="inline font-mono">{row.reference}</dd>
              </div>
            ) : null}
            {row.settlementId ? (
              <div>
                <dt className="inline">Settlement: </dt>
                <dd className="inline font-mono">{row.settlementId}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-xs text-slate-600">Found {formatTime(row.createdAt, timeZone)}</p>
          {row.kind === 'missing_here' ? (
            <p>
              <Link href="/payments/unmatched" className="font-medium underline underline-offset-2">
                Unmatched receipts
              </Link>
            </p>
          ) : null}
        </div>
        <Badge tone={open ? 'amber' : 'green'}>{open ? 'To look into' : 'Resolved'}</Badge>
      </div>
      {!open ? (
        <p className="text-sm text-slate-700" data-testid="exception-resolution">
          Resolved {formatTime(row.resolvedAt as string, timeZone)}
          {row.resolutionNote ? `: ${row.resolutionNote}` : ''}
        </p>
      ) : null}
      {open && canResolve && !resolving ? (
        <Button size="sm" variant="secondary" onClick={() => setResolving(true)}>
          Resolve<span className="sr-only"> {words.title}</span>
        </Button>
      ) : null}
      {resolving ? (
        <ReasonForm
          label={`Resolve: ${words.title}`}
          intro="Say what you found and what was done. Resolving records your note; it changes no money. If money needs to move, use a reversal, a match or a refund, which a second person approves."
          reasonLabel="What you found"
          minLength={RESOLVE_NOTE.min}
          maxLength={RESOLVE_NOTE.max}
          submitText="Mark it resolved"
          onSubmit={async (note) => {
            await api().paymentsQueue.resolveException({ exceptionId: row.id, note });
            setResolving(false);
            onResolved(`Resolved: ${words.title.toLowerCase()}.`);
          }}
          onCancel={() => setResolving(false)}
        />
      ) : null}
    </li>
  );
}
