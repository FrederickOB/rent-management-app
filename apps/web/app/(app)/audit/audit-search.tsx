'use client';

import type { AuditEventRow } from '@rent/contracts';
import { addDays, compareDates, parseBusinessDate, startOfDay } from '@rent/domain/dates';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { NoAccess } from '@/components/no-access';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { controlClass, Field, SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { summarise } from '@/lib/audit-summary';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime, humanise } from '@/lib/format';

export interface AuditFilters {
  readonly actorPersonId: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly action: string;
  /** Business dates (YYYY-MM-DD) in the company's time zone. */
  readonly from: string;
  readonly to: string;
}

const EMPTY: AuditFilters = {
  actorPersonId: '',
  recordType: '',
  recordId: '',
  action: '',
  from: '',
  to: '',
};
const PAGE_SIZE = 25;
const RECORD_TYPES = [
  'company',
  'membership',
  'session',
  'approval_request',
  'approval_decision',
  'rule',
];
const ACTIONS = [
  'company.update',
  'membership.insert',
  'membership.update',
  'membership.invited',
  'auth.signed_in',
];

type Query = NonNullable<Parameters<ReturnType<typeof api>['audit']['search']>[0]>;

/** Date filters cover whole days in the company's time zone; `to` runs to the end of its day. */
function toQuery(filters: AuditFilters, timeZone: string): Query | string {
  const query: Query = { limit: PAGE_SIZE };
  if (filters.actorPersonId.trim()) query.actorPersonId = filters.actorPersonId.trim();
  if (filters.recordType.trim()) query.recordType = filters.recordType.trim();
  if (filters.recordId.trim()) query.recordId = filters.recordId.trim();
  if (filters.action.trim()) query.action = filters.action.trim();
  try {
    const from = filters.from ? parseBusinessDate(filters.from) : null;
    const to = filters.to ? parseBusinessDate(filters.to) : null;
    if (from && to && compareDates(from, to) > 0) return 'The start date is after the end date.';
    if (from) query.from = startOfDay(from, timeZone).toString();
    if (to) query.to = startOfDay(addDays(to, 1), timeZone).toString();
  } catch {
    return 'Enter dates as day, month and year.';
  }
  return query;
}

type Results =
  | { readonly status: 'idle' | 'loading' }
  | {
      readonly status: 'ready';
      readonly events: readonly AuditEventRow[];
      readonly nextBefore: number | null;
      readonly loadingMore: boolean;
    }
  | { readonly status: 'error'; readonly problem: Problem };

export interface AuditSearchProps {
  readonly initial: AuditFilters;
  /** Names for the person filter, or null when this session may not list people. */
  readonly people: readonly { readonly personId: string; readonly name: string }[] | null;
}

/** Audit log search (AD-07) by person, record, action and date, with keyset paging. */
export function AuditSearch({ initial, people }: AuditSearchProps) {
  const { timeZone } = useApp();
  const [filters, setFilters] = useState<AuditFilters>(initial);
  const [applied, setApplied] = useState<Query | null>(null);
  const [results, setResults] = useState<Results>({ status: 'idle' });
  const [formError, setFormError] = useState<string | null>(null);

  const run = useCallback(async (query: Query, append: AuditEventRow[] | null) => {
    setResults((current) =>
      append && current.status === 'ready'
        ? { ...current, loadingMore: true }
        : { status: 'loading' },
    );
    try {
      const page = await api().audit.search(query);
      setResults({
        status: 'ready',
        events: [...(append ?? []), ...page.events],
        nextBefore: page.nextBefore,
        loadingMore: false,
      });
    } catch (failure) {
      setResults({ status: 'error', problem: toProblem(failure) });
    }
  }, []);

  // Search once on arrival, with any filters from the link that brought the person here.
  useEffect(() => {
    const query = toQuery(initial, timeZone);
    if (typeof query === 'string') return;
    setApplied(query);
    void run(query, null);
  }, [initial, timeZone, run]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = toQuery(filters, timeZone);
    if (typeof query === 'string') {
      setFormError(query);
      return;
    }
    setFormError(null);
    setApplied(query);
    void run(query, null);
  }

  function clear() {
    setFilters(EMPTY);
    setFormError(null);
    const query = toQuery(EMPTY, timeZone);
    if (typeof query === 'string') return;
    setApplied(query);
    void run(query, null);
  }

  const set = (key: keyof AuditFilters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  if (results.status === 'error' && results.problem.status === 403)
    return <NoAccess what="the audit log" />;

  return (
    <>
      <Card>
        <CardHeader title="Search" description={`Dates are whole days in ${timeZone}.`} />
        <CardBody>
          <form onSubmit={submit} className="space-y-4" aria-label="Search the audit log">
            {formError ? <Alert tone="error">{formError}</Alert> : null}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {people ? (
                <SelectField
                  label="Person"
                  value={filters.actorPersonId}
                  options={[
                    { value: '', label: 'Anyone' },
                    ...people.map((p) => ({ value: p.personId, label: p.name })),
                  ]}
                  onChange={(event) => set('actorPersonId')(event.target.value)}
                />
              ) : (
                <TextField
                  label="Person ID"
                  value={filters.actorPersonId}
                  onChange={(event) => set('actorPersonId')(event.target.value)}
                />
              )}
              <Field label="Action">
                {(control) => (
                  <>
                    <input
                      {...control}
                      list="audit-actions"
                      maxLength={80}
                      spellCheck={false}
                      placeholder="For example company.update"
                      value={filters.action}
                      onChange={(event) => set('action')(event.target.value)}
                      className={controlClass}
                    />
                    <datalist id="audit-actions">
                      {ACTIONS.map((action) => (
                        <option key={action} value={action} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <Field label="Record type">
                {(control) => (
                  <>
                    <input
                      {...control}
                      list="audit-record-types"
                      maxLength={60}
                      spellCheck={false}
                      placeholder="For example membership"
                      value={filters.recordType}
                      onChange={(event) => set('recordType')(event.target.value)}
                      className={controlClass}
                    />
                    <datalist id="audit-record-types">
                      {RECORD_TYPES.map((type) => (
                        <option key={type} value={type} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <TextField
                label="Record ID"
                maxLength={80}
                spellCheck={false}
                value={filters.recordId}
                onChange={(event) => set('recordId')(event.target.value)}
              />
              <TextField
                label="From"
                type="date"
                value={filters.from}
                onChange={(event) => set('from')(event.target.value)}
              />
              <TextField
                label="To"
                type="date"
                value={filters.to}
                onChange={(event) => set('to')(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={results.status === 'loading'}>
                Search
              </Button>
              <Button variant="ghost" onClick={clear}>
                Clear
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <section aria-labelledby="audit-results" className="space-y-3">
        <h2 id="audit-results" className="text-base font-semibold">
          Events
        </h2>
        {results.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            Searching…
          </p>
        ) : null}
        {results.status === 'error' ? <Alert tone="error">{results.problem.message}</Alert> : null}
        {results.status === 'ready' && results.events.length === 0 ? (
          <p role="status" className="text-sm text-slate-600">
            No events match this search.
          </p>
        ) : null}
        {results.status === 'ready' ? (
          <ol className="space-y-3">
            {results.events.map((event) => (
              <AuditEventItem key={event.seq} event={event} timeZone={timeZone} />
            ))}
          </ol>
        ) : null}
        {results.status === 'ready' && results.nextBefore !== null && applied ? (
          <Button
            variant="secondary"
            pending={results.loadingMore}
            onClick={() =>
              void run({ ...applied, before: results.nextBefore ?? undefined }, [...results.events])
            }
          >
            Show older events
          </Button>
        ) : null}
      </section>
    </>
  );
}

function AuditEventItem({
  event,
  timeZone,
}: {
  readonly event: AuditEventRow;
  readonly timeZone: string;
}) {
  const summary = summarise(event.data);
  const actor =
    event.actorName ??
    (event.actorPersonId ? `Person ${event.actorPersonId}` : humanise(event.actorKind));
  return (
    <li
      data-testid="audit-event"
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-sm font-semibold text-slate-900">{event.action}</p>
        <p className="text-sm text-slate-600">
          <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, timeZone)}</time>
        </p>
      </div>
      <p className="mt-1 text-sm text-slate-700">
        By {actor}
        {event.recordType ? (
          <>
            {' '}
            on {humanise(event.recordType).toLowerCase()}{' '}
            <span className="font-mono text-xs break-all">{event.recordId}</span>
          </>
        ) : null}
        <span className="text-slate-500"> (event {event.seq})</span>
      </p>
      {summary.changes.length > 0 ? (
        <div className="relative mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">
              {summary.kind === 'changed'
                ? 'Values before and after the change'
                : 'Recorded values'}
            </caption>
            <thead>
              <tr className="text-slate-600">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Field
                </th>
                {summary.kind === 'changed' || summary.kind === 'removed' ? (
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Before
                  </th>
                ) : null}
                {summary.kind !== 'removed' ? (
                  <th scope="col" className="py-1 font-medium">
                    {summary.kind === 'details' ? 'Value' : 'After'}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.changes.map((change) => (
                <tr key={change.field}>
                  <th scope="row" className="py-1 pr-4 align-top font-normal text-slate-700">
                    {change.field}
                  </th>
                  {summary.kind === 'changed' || summary.kind === 'removed' ? (
                    <td className="py-1 pr-4 align-top break-all">{change.before}</td>
                  ) : null}
                  {summary.kind !== 'removed' ? (
                    <td className="py-1 align-top break-all">{change.after}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-600">No further details.</p>
      )}
    </li>
  );
}
