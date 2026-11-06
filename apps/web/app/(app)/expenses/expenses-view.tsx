'use client';

import { RECEIVING_ACCOUNTS, type ExpenseRow } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS } from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import {
  CATEGORY_OPTIONS,
  DEFAULT_EXPENSE_FILTERS,
  EXPENSE_STATUS_LABELS,
  expenseCategoryOf,
  NO_RECEIPT,
  needsReceiptFlag,
  expenseQuery,
  expenseStatusOf,
  expensesTotal,
  PAID_BY_LABELS,
  payInput,
  type ExpenseFilters,
} from '@/lib/expenses';
import { formatTime } from '@/lib/format';
import { isKeyReused, moneyProblem, sendOnce, useKeepers } from '@/lib/idempotency';
import { reasonProblem } from '@/lib/maintenance';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

export interface ExpensePermissions {
  readonly record: boolean;
  readonly seeJobs: boolean;
  readonly agency: boolean;
}

export function ExpensesView({
  initialJobId,
  saved = false,
  can,
}: {
  readonly initialJobId: string;
  /** Back from recording one. */
  readonly saved?: boolean;
  readonly can: ExpensePermissions;
}) {
  const [filters, setFilters] = useState<ExpenseFilters>({
    ...DEFAULT_EXPENSE_FILTERS,
    jobId: initialJobId,
  });
  const [properties, setProperties] = useState<readonly { id: string; label: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(saved ? 'Recorded the expense.' : null);
  const [open, setOpen] = useState<{ id: string; what: 'pay' | 'reverse' } | null>(null);
  const keepers = useKeepers();
  const query = useMemo(() => expenseQuery(filters), [filters]);
  const load = useCallback(() => api().expenses.list(query), [query]);
  const { state, reload } = useLoad(load);

  useEffect(() => {
    let current = true;
    api()
      .register.listProperties({})
      .then(
        (result) => {
          if (current)
            setProperties(result.rows.map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` })));
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);

  const done = (text: string) => {
    setNotice(text);
    setOpen(null);
    reload();
  };

  return (
    <>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField
              label="Property"
              value={filters.propertyId}
              options={[
                { value: '', label: 'Every property' },
                ...properties.map((p) => ({ value: p.id, label: p.label })),
              ]}
              onChange={(event) => setFilters((f) => ({ ...f, propertyId: event.target.value }))}
            />
            <SelectField
              label="Status"
              value={filters.status}
              options={[
                { value: '', label: 'Any status' },
                ...(['unpaid', 'paid', 'reversed'] as const).map((s) => ({
                  value: s,
                  label: EXPENSE_STATUS_LABELS[s],
                })),
              ]}
              onChange={(event) =>
                setFilters((f) => ({ ...f, status: expenseStatusOf(event.target.value) ?? '' }))
              }
            />
            <SelectField
              label="Category"
              value={filters.category}
              options={[{ value: '', label: 'Any category' }, ...CATEGORY_OPTIONS]}
              onChange={(event) =>
                setFilters((f) => ({ ...f, category: expenseCategoryOf(event.target.value) ?? '' }))
              }
            />
            <TextField
              label="From"
              type="date"
              value={filters.from}
              onChange={(event) => setFilters((f) => ({ ...f, from: event.target.value }))}
            />
            <TextField
              label="To"
              type="date"
              value={filters.to}
              onChange={(event) => setFilters((f) => ({ ...f, to: event.target.value }))}
            />
          </div>
          {filters.jobId ? (
            <p className="text-sm">
              Showing the expenses of one repair.{' '}
              <button
                type="button"
                className="min-h-9 font-medium underline underline-offset-2"
                onClick={() => setFilters((f) => ({ ...f, jobId: '' }))}
              >
                Show every expense
              </button>
            </p>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Expenses"
          description={
            state.status === 'ready'
              ? `${state.data.length} shown, ${formatMinor(expensesTotal(state.data))} not counting reversed ones.`
              : undefined
          }
        />
        <CardBody>
          {state.status === 'loading' ? <Loading what="the expenses" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <Empty>No expense matches.</Empty>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {state.data.map((row) => (
                <ExpenseItem
                  key={row.id}
                  row={row}
                  can={can}
                  open={open?.id === row.id ? open.what : null}
                  onOpen={(what) => {
                    setOpen(what ? { id: row.id, what } : null);
                    setNotice(null);
                  }}
                  keeper={keepers}
                  onDone={done}
                />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function ExpenseItem({
  row,
  can,
  open,
  onOpen,
  keeper,
  onDone,
}: {
  readonly row: ExpenseRow;
  readonly can: ExpensePermissions;
  readonly open: 'pay' | 'reverse' | null;
  readonly onOpen: (what: 'pay' | 'reverse' | null) => void;
  readonly keeper: ReturnType<typeof useKeepers>;
  readonly onDone: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [problem, setProblem] = useState<string | null>(null);
  const reversed = row.status === 'reversed';
  return (
    <li className="space-y-2 py-3 text-sm" data-testid="expense-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className={reversed ? 'text-slate-500 line-through' : 'font-medium text-slate-900'}>
            {row.supplierName} · {row.categoryLabel}
          </p>
          <p className="text-slate-700">
            {formatBusinessDate(row.expenseDate)} · {row.property.name}
            {row.unit ? (
              <span className="ml-1 font-mono text-xs">{row.unit.code}</span>
            ) : null} · {row.owner.name}
          </p>
          <p className="text-slate-600">
            {PAID_BY_LABELS[row.paidBy]}
            {row.paidOn ? `; paid ${formatBusinessDate(row.paidOn)}` : ''}
            {row.job ? (
              <>
                {' · '}
                {can.seeJobs ? (
                  <Link
                    href={`/repairs/${row.job.id}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {row.job.ticket}
                  </Link>
                ) : (
                  <span className="font-mono">{row.job.ticket}</span>
                )}
              </>
            ) : null}
          </p>
          {row.note ? <p className="whitespace-pre-wrap text-slate-800">{row.note}</p> : null}
          {row.reversal ? (
            <p className="text-slate-700">
              Reversed {formatTime(row.reversal.at, timeZone)}
              {row.reversal.byName ? ` by ${row.reversal.byName}` : ''}: {row.reversal.reason}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={
              reversed
                ? 'tabular-nums text-slate-500 line-through'
                : 'text-base font-semibold tabular-nums'
            }
          >
            {formatMinor(row.amountMinor)}
          </span>
          <Badge
            tone={row.status === 'paid' ? 'green' : row.status === 'unpaid' ? 'amber' : 'dark'}
          >
            {EXPENSE_STATUS_LABELS[row.status]}
          </Badge>
          {needsReceiptFlag(row) ? (
            <span data-testid="no-receipt">
              <Badge tone="red">{NO_RECEIPT}</Badge>
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.hasReceipt ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void openFetchedLink(
                async () => (await api().expenses.receiptDownload({ expenseId: row.id })).url,
              ).catch((failure: unknown) => setProblem(toProblem(failure).message))
            }
          >
            Open the receipt
          </Button>
        ) : null}
        {can.record && row.status === 'unpaid' && open === null ? (
          <Button size="sm" variant="secondary" onClick={() => onOpen('pay')}>
            Record as paid
          </Button>
        ) : null}
        {can.record && !reversed && open === null ? (
          <Button size="sm" variant="ghost" onClick={() => onOpen('reverse')}>
            Reverse
          </Button>
        ) : null}
      </div>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {open === 'pay' ? (
        <PayForm
          row={row}
          agency={can.agency}
          keeper={keeper(`pay:${row.id}`)}
          onDone={onDone}
          onCancel={() => onOpen(null)}
        />
      ) : null}
      {open === 'reverse' ? (
        <ReverseForm
          row={row}
          keeper={keeper(`reverse:${row.id}`)}
          onDone={onDone}
          onCancel={() => onOpen(null)}
        />
      ) : null}
    </li>
  );
}

function PayForm({
  row,
  agency,
  keeper,
  onDone,
  onCancel,
}: {
  readonly row: ExpenseRow;
  readonly agency: boolean;
  readonly keeper: ReturnType<ReturnType<typeof useKeepers>>;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [draft, setDraft] = useState({
    paidOn: today,
    paidFrom: agency ? '' : 'owner_account',
    reference: '',
  });
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = payInput(draft, row, today);
  const errors = tried ? parsed.errors : {};
  // What the key was used for: changed details are a new submission, with a new key.
  const keyedFor = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const input = parsed.input;
    if (!input) return;
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) => keyedApi(key).expenses.pay({ expenseId: row.id, ...input }));
      onDone(`Recorded ${formatMinor(row.amountMinor)} to ${row.supplierName} as paid.`);
    } catch (failure) {
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) keeper.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Record ${row.supplierName} as paid`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Paid on"
          type="date"
          min={row.expenseDate}
          max={today}
          value={draft.paidOn}
          error={errors.paidOn}
          onChange={(event) => setDraft((d) => ({ ...d, paidOn: event.target.value }))}
        />
        {agency ? (
          <SelectField
            label="Paid from"
            value={draft.paidFrom}
            error={errors.paidFrom}
            options={[
              { value: '', label: 'Choose the account' },
              ...RECEIVING_ACCOUNTS.map((a) => ({ value: a, label: RECEIVING_ACCOUNT_LABELS[a] })),
            ]}
            onChange={(event) => setDraft((d) => ({ ...d, paidFrom: event.target.value }))}
          />
        ) : null}
        <TextField
          label="Reference (optional)"
          autoComplete="off"
          maxLength={120}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record as paid
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReverseForm({
  row,
  keeper,
  onDone,
  onCancel,
}: {
  readonly row: ExpenseRow;
  readonly keeper: ReturnType<ReturnType<typeof useKeepers>>;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = reasonProblem(reason);
  const keyedFor = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (problem) return;
    if (keyedFor.current !== reason.trim()) {
      keeper.reset();
      keyedFor.current = reason.trim();
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).expenses.reverse({ expenseId: row.id, reason: reason.trim() }),
      );
      onDone(
        `Reversed the expense of ${formatMinor(row.amountMinor)}. Record the right one as a new expense.`,
      );
    } catch (failure) {
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) keeper.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Reverse the expense to ${row.supplierName}`}
      className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-red-900">
        A reversal cancels the expense in the books with a new entry; the original is kept. Record
        the right amount as a new expense.
      </p>
      <TextAreaField
        label="Reason"
        rows={2}
        maxLength={500}
        value={reason}
        error={tried ? problem : undefined}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Reverse the expense
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
