'use client';

import type { OwnerStatementView } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { monthLabel } from '@/lib/rent-tax';
import { draftableMonths, ISSUE_LOCKS_NOTE, statementMessage } from '@/lib/statements';
import { useLoad } from '@/lib/use-load';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function StatementsView({
  initialOwnerId,
  canDraft,
}: {
  readonly initialOwnerId: string;
  readonly canDraft: boolean;
}) {
  const [ownerId, setOwnerId] = useState(UUID.test(initialOwnerId) ? initialOwnerId : '');
  const [status, setStatus] = useState<'' | 'draft' | 'issued'>('');
  const [owners, setOwners] = useState<readonly { id: string; name: string }[]>([]);
  const load = useCallback(
    () =>
      api().ownerStatements.list({
        ...(ownerId ? { ownerId } : {}),
        ...(status ? { status } : {}),
      }),
    [ownerId, status],
  );
  const { state, reload } = useLoad(load);

  useEffect(() => {
    let current = true;
    api()
      .owners.list({})
      .then(
        (rows) => {
          if (current)
            setOwners(
              rows.filter((o) => !o.archived).map((o) => ({ id: o.id, name: o.displayName })),
            );
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      {canDraft && owners.length > 0 ? <DraftForm owners={owners} /> : null}
      <Card>
        <CardHeader title="Statements" description="Newest month first." />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            {owners.length > 1 ? (
              <SelectField
                label="Owner"
                value={ownerId}
                options={[
                  { value: '', label: 'Every owner' },
                  ...owners.map((o) => ({ value: o.id, label: o.name })),
                ]}
                onChange={(event) => setOwnerId(event.target.value)}
              />
            ) : null}
            <SelectField
              label="Status"
              value={status}
              options={[
                { value: '', label: 'Drafts and issued' },
                { value: 'draft', label: 'Drafts' },
                { value: 'issued', label: 'Issued' },
              ]}
              onChange={(event) => {
                const v = event.target.value;
                setStatus(v === 'draft' || v === 'issued' ? v : '');
              }}
            />
          </div>
          {state.status === 'loading' ? <Loading what="the statements" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <Empty>No statement yet. Last month’s are drafted on the 1st.</Empty>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {state.data.map((row) => (
                <StatementRow key={row.id} row={row} />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function StatementRow({ row }: { readonly row: OwnerStatementView }) {
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-2 py-3"
      data-testid="statement-row"
    >
      <span className="space-y-1">
        <Link href={`/statements/${row.id}`} className="font-medium underline underline-offset-2">
          {row.owner.name}, {monthLabel(row.month)}
        </Link>
        <span className="block text-slate-600">
          {row.issuedAt
            ? `Issued ${formatTime(row.issuedAt, row.ownerTimeZone)}${row.issuedBy ? ` by ${row.issuedBy.name}` : ''}`
            : `Worked out ${formatTime(row.generatedAt, row.ownerTimeZone)}`}
        </span>
      </span>
      <span data-testid="statement-status">
        <Badge tone={row.status === 'issued' ? 'green' : 'amber'}>
          {row.status === 'issued' ? 'Issued' : 'Draft'}
        </Badge>
      </span>
    </li>
  );
}

/** Draft a statement for a past month, or work a draft out again; then open it. */
function DraftForm({ owners }: { readonly owners: readonly { id: string; name: string }[] }) {
  const router = useRouter();
  const { timeZone } = useApp();
  const months = draftableMonths(todayIn(timeZone));
  const [ownerId, setOwnerId] = useState(owners.length === 1 ? owners[0]!.id : '');
  const [month, setMonth] = useState(months[0] ?? '');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!ownerId || !month) return;
    setPending(true);
    try {
      const drafted = await api().ownerStatements.draft({ ownerId, month });
      router.push(`/statements/${drafted.id}`);
    } catch (failure) {
      setError(statementMessage(failure) ?? toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Draft a statement"
        description="For a month that is over. A draft is worked out from the ledger each time it is opened; an issued one never changes."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Draft a statement" className="space-y-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <p className="text-sm text-slate-700" data-testid="issue-locks-note">
            {ISSUE_LOCKS_NOTE}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Owner"
              value={ownerId}
              error={tried && !ownerId ? 'Choose the owner' : undefined}
              options={[
                { value: '', label: 'Choose the owner' },
                ...owners.map((o) => ({ value: o.id, label: o.name })),
              ]}
              onChange={(event) => setOwnerId(event.target.value)}
            />
            <SelectField
              label="Month"
              value={month}
              options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
              onChange={(event) => setMonth(event.target.value)}
            />
          </div>
          <Button type="submit" pending={pending}>
            Draft the statement
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
