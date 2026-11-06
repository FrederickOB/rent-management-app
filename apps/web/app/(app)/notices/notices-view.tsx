'use client';

import {
  NOTICE_OUTCOME_LABELS,
  NOTICE_OUTCOMES,
  NOTICE_STATUS_LABELS,
  NOTICE_STATUSES,
  NOTICE_TYPE_LABELS,
  NOTICE_TYPES,
  type NoticeOutcome,
  type NoticeStatus,
  type NoticeType,
} from '@rent/domain/notices';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { NoticeOutcomeBadge, NoticeStatusBadge } from '@/components/notice-badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { AGE_BUCKET_LABELS, noticeTitle, type NoticeRow } from '@/lib/notices';
import { isNotOnPlan } from '@/lib/plan';
import { useRequestGate } from '@/lib/request-gate';

type Summary = Awaited<ReturnType<ReturnType<typeof api>['notices']['summary']>>;

interface Filters {
  /** `open`, `all`, or one status. */
  readonly status: 'open' | 'all' | NoticeStatus;
  readonly type: '' | NoticeType;
  readonly propertyId: string;
  readonly outcome: '' | NoticeOutcome;
  readonly servedTooLate: boolean;
  readonly search: string;
}

const START: Filters = {
  status: 'open',
  type: '',
  propertyId: '',
  outcome: '',
  servedTooLate: false,
  search: '',
};

export function NoticesView() {
  const { timeZone } = useApp();
  const [filters, setFilters] = useState<Filters>(START);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<readonly NoticeRow[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [properties, setProperties] = useState<readonly { id: string; label: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const gate = useRequestGate();
  const set = (next: Partial<Filters>) => setFilters((current) => ({ ...current, ...next }));

  useEffect(() => {
    const id = window.setTimeout(() => setFilters((f) => ({ ...f, search })), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const [list, counts] = await Promise.all([
        api().notices.list({
          ...(filters.status === 'open'
            ? { open: 'true' }
            : filters.status === 'all'
              ? {}
              : { status: filters.status }),
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
          ...(filters.outcome ? { outcome: filters.outcome } : {}),
          ...(filters.servedTooLate ? { servedTooLate: 'true' } : {}),
          ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
        }),
        api()
          .notices.summary()
          .catch(() => null),
      ]);
      if (!current()) return;
      setRows(list);
      if (counts) setSummary(counts);
      setProblem(null);
    } catch (failure) {
      if (!current()) return;
      setProblem(
        isNotOnPlan(failure)
          ? 'Legal notices are not on your company’s plan.'
          : toProblem(failure).message,
      );
    }
  }, [gate, filters]);

  useEffect(() => {
    setRows(null);
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

  return (
    <>
      {summary ? (
        <SummaryCards
          summary={summary}
          onLate={() => set({ servedTooLate: true, status: 'all' })}
        />
      ) : null}
      <Card>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Status"
              value={filters.status}
              options={[
                { value: 'open', label: 'Open (issued, not closed)' },
                { value: 'all', label: 'Every status' },
                ...NOTICE_STATUSES.map((s) => ({ value: s, label: NOTICE_STATUS_LABELS[s] })),
              ]}
              onChange={(event) => set({ status: event.target.value as Filters['status'] })}
            />
            <SelectField
              label="Type"
              value={filters.type}
              options={[
                { value: '', label: 'Every type' },
                ...NOTICE_TYPES.map((t) => ({ value: t, label: NOTICE_TYPE_LABELS[t] })),
              ]}
              onChange={(event) => set({ type: event.target.value as Filters['type'] })}
            />
            <SelectField
              label="Property"
              value={filters.propertyId}
              options={[
                { value: '', label: 'Every property' },
                ...properties.map((p) => ({ value: p.id, label: p.label })),
              ]}
              onChange={(event) => set({ propertyId: event.target.value })}
            />
            <SelectField
              label="Outcome"
              value={filters.outcome}
              options={[
                { value: '', label: 'Any outcome' },
                ...NOTICE_OUTCOMES.map((o) => ({ value: o, label: NOTICE_OUTCOME_LABELS[o] })),
              ]}
              onChange={(event) => set({ outcome: event.target.value as Filters['outcome'] })}
            />
            <TextField
              label="Search"
              hint="A notice number, a tenant or a unit code."
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex items-end pb-2">
              <CheckboxField
                label="Served too late for their date"
                checked={filters.servedTooLate}
                onChange={(event) => set({ servedTooLate: event.target.checked })}
              />
            </div>
          </div>
          {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
          {rows === null && !problem ? <Loading what="notices" /> : null}
          {rows?.length === 0 ? <Empty>No notice matches.</Empty> : null}
          {rows?.length ? (
            <Table caption="Notices">
              <thead>
                <tr>
                  <Th>Notice</Th>
                  <Th>Tenant and unit</Th>
                  <Th>Status</Th>
                  <Th>Effective</Th>
                  <Th className="text-right">Days outstanding</Th>
                  <Th className="text-right">Acknowledged</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} data-testid="notice-row">
                    <Td>
                      <Link
                        href={`/notices/${row.id}`}
                        className="font-medium underline underline-offset-2"
                      >
                        {noticeTitle(row)}
                      </Link>
                      {row.subtypeLabel ? (
                        <p className="text-xs text-slate-600">{row.subtypeLabel}</p>
                      ) : null}
                      {row.correctsNumber ? (
                        <p className="text-xs text-slate-600">Corrects {row.correctsNumber}</p>
                      ) : null}
                      {row.correctedByNumber ? (
                        <p className="text-xs text-slate-600">
                          Corrected by {row.correctedByNumber}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      {row.tenant?.name ?? 'Every tenant'}
                      <p className="font-mono text-xs text-slate-600">
                        {row.unitCode ?? row.property.name}
                      </p>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <NoticeStatusBadge status={row.status} />
                        {row.outcome ? <NoticeOutcomeBadge outcome={row.outcome} /> : null}
                        {row.ladderPaused ? <Badge tone="amber">Reminders paused</Badge> : null}
                        {row.ladderCancelled ? (
                          <Badge tone="dark">Reminders cancelled</Badge>
                        ) : null}
                        {row.servedTooLate ? <Badge tone="red">Served too late</Badge> : null}
                      </div>
                      {row.issuedAt ? (
                        <p className="text-xs text-slate-600">
                          Issued {formatTime(row.issuedAt, timeZone)}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row.effectiveDate ? formatBusinessDate(row.effectiveDate) : '—'}
                    </Td>
                    <Td className="text-right tabular-nums">{row.daysOutstanding ?? '—'}</Td>
                    <Td className="text-right tabular-nums">
                      {row.signedRecipients} of {row.recipientCount}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function SummaryCards({
  summary,
  onLate,
}: {
  readonly summary: Summary;
  readonly onLate: () => void;
}) {
  const open = summary.byStatus.filter((s) => s.count > 0);
  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="notices-summary">
      <Card>
        <CardHeader title="Open, by status" level={2} />
        <CardBody>
          {open.length === 0 ? (
            <p className="text-sm text-slate-600">No open notice.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {open.map((s) => (
                <li key={s.status} className="flex justify-between gap-2">
                  <span>{NOTICE_STATUS_LABELS[s.status]}</span>
                  <span className="tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-slate-600">
            {summary.drafts} {summary.drafts === 1 ? 'draft' : 'drafts'} ·{' '}
            {summary.awaitingApproval} waiting for approval
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Open, by days since issue" level={2} />
        <CardBody>
          <ul className="space-y-1 text-sm">
            {summary.byAge.map((b) => (
              <li key={b.bucket} className="flex justify-between gap-2">
                <span>{AGE_BUCKET_LABELS[b.bucket]}</span>
                <span className="tabular-nums">{b.count}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Served too late for their date" level={2} />
        <CardBody>
          <p className="text-2xl font-semibold tabular-nums">{summary.servedTooLate}</p>
          {summary.servedTooLate > 0 ? (
            <>
              <Alert tone="warning">
                Physical service came too late for the date these notices state. Correct them with a
                new notice.
              </Alert>
              <button
                type="button"
                className="text-sm font-medium underline underline-offset-2"
                onClick={onLate}
              >
                Show them
              </button>
            </>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
