'use client';

import type { MaintenanceJob } from '@rent/contracts';
import { MAINTENANCE_JOB_STATUSES, MAINTENANCE_JOB_STATUS_LABELS } from '@rent/domain/maintenance';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import {
  CategoryBadge,
  JobStatusBadge,
  OverdueBadge,
  PriorityBadge,
} from '@/components/maintenance-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  assigneeLabel,
  assigneesSeen,
  boardQuery,
  categoryOf,
  CATEGORY_OPTIONS,
  costText,
  DEFAULT_BOARD_FILTERS,
  groupByStatus,
  isEmergency,
  jobStatusOf,
  priorityOf,
  PRIORITY_OPTIONS,
  targetText,
  type BoardFilters,
} from '@/lib/maintenance';
import { REPAIR_SOURCE_LABELS } from '@/lib/repairs';
import { useRequestGate } from '@/lib/request-gate';
import { messageExcerpt } from '@/lib/timeline';
import { useAssignees } from '@/lib/use-assignees';

const PAGE = 30;

export interface BoardPermissions {
  readonly manage: boolean;
  /** Accountants, client owners and advisers (decision 9): they see, and change nothing. */
  readonly readOnly: boolean;
  readonly listStaff: boolean;
  readonly listArtisans: boolean;
}

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open jobs (reported to work done)' },
  { value: 'all', label: 'Every job' },
  ...MAINTENANCE_JOB_STATUSES.map((s) => ({ value: s, label: MAINTENANCE_JOB_STATUS_LABELS[s] })),
];

/** The board: filters, then the jobs grouped by status, emergencies first in each group. */
export function RepairsView({ can }: { readonly can: BoardPermissions }) {
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [search, setSearch] = useState('');
  const [properties, setProperties] = useState<readonly { id: string; label: string }[]>([]);
  const [rows, setRows] = useState<readonly MaintenanceJob[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const gate = useRequestGate();
  const listed = useAssignees(can);
  const query = useMemo(() => boardQuery(filters), [filters]);

  const load = useCallback(async () => {
    const current = gate.begin();
    setProblem(null);
    try {
      const page = await api().maintenance.list({ ...query, limit: PAGE });
      if (!current()) return;
      setRows(page.items);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, query]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

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

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api().maintenance.list({ ...query, cursor, limit: PAGE });
      setRows((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function searchFor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters((f) => ({ ...f, search }));
  }

  const assignees = useMemo(() => {
    const seen = assigneesSeen(rows ?? []);
    const known = new Set(listed.map((o) => o.value));
    return [...listed, ...seen.filter((o) => !known.has(o.value))];
  }, [listed, rows]);
  const groups = useMemo(() => groupByStatus(rows ?? []), [rows]);
  const filtered =
    JSON.stringify({ ...filters, search: filters.search.trim() }) !==
    JSON.stringify(DEFAULT_BOARD_FILTERS);

  return (
    <>
      {can.readOnly ? (
        <Alert tone="info" title="Read only">
          You see the repairs on the properties you can see: each job, its photos, its cost and its
          history. The managers change them.
        </Alert>
      ) : null}
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField
              label="Status"
              value={filters.status}
              options={STATUS_OPTIONS}
              onChange={(event) => {
                const value = event.target.value;
                const status = value === 'open' || value === 'all' ? value : jobStatusOf(value);
                if (status) setFilters((f) => ({ ...f, status }));
              }}
            />
            <SelectField
              label="Priority"
              value={filters.priority}
              options={[{ value: '', label: 'Any priority' }, ...PRIORITY_OPTIONS]}
              onChange={(event) =>
                setFilters((f) => ({ ...f, priority: priorityOf(event.target.value) ?? '' }))
              }
            />
            <SelectField
              label="Category"
              value={filters.category}
              options={[{ value: '', label: 'Any category' }, ...CATEGORY_OPTIONS]}
              onChange={(event) =>
                setFilters((f) => ({ ...f, category: categoryOf(event.target.value) ?? '' }))
              }
            />
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
              label="Assigned to"
              value={filters.assignee}
              options={[{ value: '', label: 'Anyone, or nobody' }, ...assignees]}
              onChange={(event) => setFilters((f) => ({ ...f, assignee: event.target.value }))}
            />
            <div className="flex items-end pb-2">
              <CheckboxField
                label="Overdue only"
                hint="A target time missed and not yet met."
                checked={filters.overdue}
                onChange={(event) => setFilters((f) => ({ ...f, overdue: event.target.checked }))}
              />
            </div>
          </div>
          <form
            onSubmit={searchFor}
            role="search"
            aria-label="Search repairs"
            className="flex flex-wrap items-end gap-2"
          >
            <TextField
              label="Search"
              hint="A ticket number such as MT-0042, a unit code or words from the report."
              maxLength={100}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(DEFAULT_BOARD_FILTERS);
                setSearch('');
              }}
            >
              Clear the filters
            </Button>
          ) : null}
        </CardBody>
      </Card>

      {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
      {rows === null && !problem ? <Loading what="repairs" /> : null}
      {rows?.length === 0 ? (
        <Empty>
          {filtered ? 'No repair matches these filters.' : 'No repair has been reported yet.'}
        </Empty>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.status}
          aria-labelledby={`group-${group.status}`}
          className="space-y-2"
          data-testid="board-group"
          data-status={group.status}
        >
          <h2 id={`group-${group.status}`} className="text-base font-semibold text-slate-900">
            {group.label} <span className="font-normal text-slate-600">({group.jobs.length})</span>
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {group.jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </ul>
        </section>
      ))}
      {cursor ? (
        <Button variant="secondary" pending={loadingMore} onClick={() => void more()}>
          Show more repairs
        </Button>
      ) : null}
    </>
  );
}

function JobCard({ job }: { readonly job: MaintenanceJob }) {
  const { timeZone } = useApp();
  const emergency = isEmergency(job);
  return (
    <li
      data-testid="repair-row"
      data-ticket={job.ticket}
      className={cn(
        'space-y-2 rounded-lg border bg-white p-4 text-sm shadow-sm',
        emergency ? 'border-l-8 border-red-600' : 'border-slate-200',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/repairs/${job.id}`}
          className="font-mono text-base font-semibold underline underline-offset-2"
        >
          {job.ticket}
        </Link>
        <PriorityBadge job={job} />
        <JobStatusBadge status={job.status} />
        <CategoryBadge job={job} />
        <OverdueBadge job={job} />
      </div>
      <p className="break-words text-slate-900">{messageExcerpt(job.description, 160)}</p>
      <p className="text-slate-700">
        <span className="font-mono">{job.unit?.code ?? 'Common area'}</span> · {job.property.name}
        {job.tenant ? ` · ${job.tenant.name}` : ''}
      </p>
      <dl className="grid gap-x-4 gap-y-1 text-slate-700 sm:grid-cols-2">
        <div>
          <dt className="sr-only">Reported</dt>
          <dd>
            {REPAIR_SOURCE_LABELS[job.source]},{' '}
            <time dateTime={job.createdAt}>{formatTime(job.createdAt, timeZone)}</time>
          </dd>
        </div>
        <div>
          <dt className="sr-only">Assigned to</dt>
          <dd>{assigneeLabel(job.assignee)}</dd>
        </div>
        {job.targets && job.status !== 'closed' && job.status !== 'cancelled' ? (
          <div className="sm:col-span-2">
            <dt className="sr-only">Target</dt>
            <dd>
              {targetText(
                job.targets,
                job.targets.respondedAt === null ? 'respond' : 'complete',
                timeZone,
              )}
            </dd>
          </div>
        ) : null}
        {job.visitAt ? (
          <div className="sm:col-span-2">
            <dt className="sr-only">Visit</dt>
            <dd>Visit {formatTime(job.visitAt, timeZone)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline text-slate-600">Cost </dt>
          <dd className="inline tabular-nums" data-testid="job-cost">
            {costText(job)}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-600">Files </dt>
          <dd className="inline tabular-nums">{job.attachmentCount}</dd>
        </div>
      </dl>
    </li>
  );
}
