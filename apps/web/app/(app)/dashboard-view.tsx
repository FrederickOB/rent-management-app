'use client';

import type { ApiClient } from '@rent/contracts/client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { ShareBar, StackBar } from '@/components/bars';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { startDownload } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { isReadOnlyRefusal, toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { monthLabel } from '@/lib/rent-tax';
import {
  anyFilter,
  bucketsOf,
  dashboardQuery,
  dashboardTimesText,
  expiryRows,
  EXPORT_POLL_MS,
  EXPORT_POLL_TRIES,
  exportNext,
  gate1Rows,
  gate1StatusText,
  monthsText,
  NO_FILTERS,
  ratioCounts,
  ratioText,
  refreshProblemText,
  unearnedDetailText,
  unitTypeText,
  type Dashboard,
  type DashboardFilters,
  type Gate1,
} from '@/lib/reporting';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

const BUCKET_COLOURS = ['bg-amber-300', 'bg-amber-500', 'bg-red-500', 'bg-red-700'];

/**
 * The portfolio dashboard (DA-01, DA-02, DA-06; M9 decisions 11 and 12) from the nightly
 * snapshot, with its date and time, filters, a refresh and exports. Owners and advisers see their
 * own, within scope; the API applies it.
 */
export function DashboardView({ canRefresh = false }: { readonly canRefresh?: boolean }) {
  const { timeZone } = useApp();
  const [filters, setFilters] = useState<DashboardFilters>(NO_FILTERS);
  const [data, setData] = useState<Dashboard | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const gate = useRequestGate();
  const options = useRef<Dashboard['filterOptions'] | null>(null);

  const load = useCallback(async () => {
    const current = gate.begin();
    setProblem(null);
    try {
      const next = await api().dashboard.get(dashboardQuery(filters, options.current));
      if (!current()) return;
      options.current = next.filterOptions;
      setData(next);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [filters, gate]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  async function refresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      const { queued } = await api().dashboard.refresh({});
      setNotice(
        queued
          ? 'The figures are being worked out again. Reload in a minute to see them; the time they were worked out is shown above.'
          : 'A refresh is already on its way.',
      );
    } catch (failure) {
      // M9 review: a refusal or a refresh too soon is said plainly. M10 review WEB-8: a read-only
      // company's refusal says read-only, not who may refresh.
      const problem = toProblem(failure);
      setProblem(
        isReadOnlyRefusal(failure)
          ? problem.message
          : refreshProblemText(problem.status, problem.message),
      );
    } finally {
      setRefreshing(false);
    }
  }

  if (!data)
    return problem ? (
      <LoadFailed message={problem} onRetry={() => void load()} />
    ) : (
      <Loading what="the dashboard" />
    );

  const fo = data.filterOptions;
  return (
    <section aria-labelledby="dashboard-title" className="space-y-4" data-testid="dashboard">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="dashboard-title" className="text-lg font-semibold text-slate-900">
            Portfolio
          </h2>
          {/* M9 review: which figures are live and which come from the nightly snapshot. */}
          <p className="text-sm text-slate-600" data-testid="dashboard-as-of">
            {dashboardTimesText(data, (iso) => formatTime(iso, timeZone)).snapshot}
          </p>
          <p className="text-sm text-slate-600" data-testid="dashboard-live-at">
            {dashboardTimesText(data, (iso) => formatTime(iso, timeZone)).live}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRefresh ? (
            <Button
              variant="secondary"
              size="sm"
              pending={refreshing}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          ) : null}
          <ExportButton format="xlsx" filters={dashboardQuery(filters, fo)} />
          <ExportButton format="pdf" filters={dashboardQuery(filters, fo)} />
        </div>
      </div>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fo.owners.length > 1 ? (
          <SelectField
            label="Owner"
            value={filters.ownerId}
            options={[
              { value: '', label: 'Every owner' },
              ...fo.owners.map((o) => ({ value: o.id, label: o.name })),
            ]}
            onChange={(event) => setFilters((f) => ({ ...f, ownerId: event.target.value }))}
          />
        ) : null}
        <SelectField
          label="Property"
          value={filters.propertyId}
          options={[
            { value: '', label: 'Every property' },
            ...fo.properties.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(event) => setFilters((f) => ({ ...f, propertyId: event.target.value }))}
        />
        <SelectField
          label="Region"
          value={filters.region}
          options={[
            { value: '', label: 'Every region' },
            ...fo.regions.map((r) => ({ value: r, label: r })),
          ]}
          onChange={(event) => setFilters((f) => ({ ...f, region: event.target.value }))}
        />
        <SelectField
          label="Unit type"
          value={filters.unitType}
          options={[
            { value: '', label: 'Every unit type' },
            ...fo.unitTypes.map((t) => ({ value: t, label: unitTypeText(t) })),
          ]}
          onChange={(event) => setFilters((f) => ({ ...f, unitType: event.target.value }))}
        />
      </div>
      {anyFilter(filters) ? (
        <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
          Clear the filters
        </Button>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Figure
          testId="figure-occupancy"
          title="Occupancy"
          value={ratioText(data.occupancy.rate)}
          detail={`${ratioCounts(data.occupancy.rate)} lettable units occupied; ${data.occupancy.vacant} vacant, ${data.occupancy.underRepair} under repair`}
        >
          <ShareBar bps={data.occupancy.rate.bps} label="Occupancy" />
        </Figure>
        <Figure
          testId="figure-collection"
          title={`Collection rate, ${monthLabel(data.collectionRate.month)}`}
          value={ratioText(data.collectionRate.rate)}
          detail={`${formatMinor(data.collectionRate.collectedMinor)} collected of ${formatMinor(data.collectionRate.dueMinor)} due in the month`}
        >
          <ShareBar bps={data.collectionRate.rate.bps} label="Collection rate" />
        </Figure>
        <Figure
          testId="figure-arrears"
          title="Arrears"
          value={formatMinor(data.arrears.totalMinor)}
          detail={`Earned, unpaid and past due, on ${data.arrears.leases} ${data.arrears.leases === 1 ? 'lease' : 'leases'}`}
        >
          <StackBar
            label="Arrears by age"
            parts={bucketsOf(data.arrears.byBucket).map((b, i) => ({
              key: b.bucket,
              amount: b.amountMinor,
              className: BUCKET_COLOURS[i] ?? 'bg-red-700',
            }))}
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {bucketsOf(data.arrears.byBucket).map((b, i) => (
              <div
                key={b.bucket}
                className="flex items-center justify-between gap-2"
                data-testid={`arrears-${b.bucket}`}
              >
                <dt className="flex items-center gap-2 text-slate-700">
                  <span
                    aria-hidden="true"
                    className={`inline-block size-2.5 rounded-full ${BUCKET_COLOURS[i]}`}
                  />
                  {b.label}
                </dt>
                <dd className="tabular-nums">{formatMinor(b.amountMinor)}</dd>
              </div>
            ))}
          </dl>
        </Figure>
        <Figure
          testId="figure-rent-roll"
          title="Rent roll, a month"
          value={formatMinor(data.rentRoll.totalMinor)}
          detail={`${formatMinor(data.rentRoll.rentMinor)} rent and ${formatMinor(data.rentRoll.serviceChargeMinor)} service charge on the leases in force`}
        />
        <Figure
          testId="figure-unearned"
          title="Rent paid ahead, not yet earned"
          value={formatMinor(data.unearnedRentMinor)}
          detail={unearnedDetailText(data)}
        />
        {data.arrears.dueNotStartedMinor > 0 ? (
          <Figure
            testId="figure-billed-not-started"
            title="Billed, not yet due"
            value={formatMinor(data.arrears.dueNotStartedMinor)}
            detail="Billed and past its invoice date, for months not yet started (an annual invoice’s later months). Not arrears."
          />
        ) : null}
        <Figure
          testId="figure-deposits"
          title="Deposits held"
          value={formatMinor(data.depositsHeldMinor)}
          detail="Held for tenants; never income (BC-11)."
        />
        <Figure
          testId="figure-paid-until"
          title="Paid up to date"
          value={ratioText(data.paidUntilCoverage.rate)}
          detail={`${ratioCounts(data.paidUntilCoverage.rate)} occupied units paid until today or later; median ${monthsText(data.paidUntilCoverage.medianMonthsPaidAhead)} paid ahead`}
        >
          <ShareBar bps={data.paidUntilCoverage.rate.bps} label="Paid up to date" />
        </Figure>
      </div>

      <Card data-testid="figure-expiries">
        <CardHeader
          title="Leases ending"
          description="By how soon they end, and whether a renewal is in hand (DA-02)."
        />
        <CardBody>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Leases ending within 3, 6 and 12 months</caption>
            <thead>
              <tr className="text-slate-600">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Within
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Leases
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Renewal offered
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Renewed
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Nothing yet
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {expiryRows(data.expiries).map((row) => (
                <tr key={row.withinMonths} data-testid={`expiry-${row.withinMonths}`}>
                  <td className="py-2 pr-3">{row.withinMonths} months</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.leases}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.renewalOffered}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.renewed}</td>
                  <td className="py-2 text-right tabular-nums">{row.notOffered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {data.gate1 ? <Gate1Card gate1={data.gate1} /> : null}
      <p className="text-xs text-slate-600">
        Dates are business days in the company’s time zone ({timeZone}); the figures are for{' '}
        {formatBusinessDate(data.date)}.
      </p>
    </section>
  );
}

function Figure({
  testId,
  title,
  value,
  detail,
  children,
}: {
  readonly testId: string;
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly children?: ReactNode;
}) {
  return (
    <Card data-testid={testId}>
      <CardBody className="space-y-2">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        <p
          className="text-2xl font-semibold tabular-nums text-slate-900"
          data-testid="figure-value"
        >
          {value}
        </p>
        {children}
        <p className="text-sm text-slate-600">{detail}</p>
      </CardBody>
    </Card>
  );
}

/** Gate 1 (PRD section 19) for the company this month. */
export function Gate1Card({ gate1, title }: { readonly gate1: Gate1; readonly title?: string }) {
  const { timeZone } = useApp();
  return (
    <Card data-testid="gate1">
      <CardHeader
        title={title ?? `Gate 1 measures, ${monthLabel(gate1.month)}`}
        description={gate1StatusText(gate1, (iso) => formatTime(iso, timeZone))}
        actions={
          <span data-testid="gate1-status">
            <Badge tone={gate1.status === 'final' ? 'green' : 'amber'}>
              {gate1.status === 'final' ? 'Final' : 'Provisional'}
            </Badge>
          </span>
        }
      />
      <CardBody>
        <ul className="grid gap-4 md:grid-cols-2">
          {gate1Rows(gate1).map((row) => (
            <li key={row.key} className="space-y-1" data-testid={`gate1-${row.key}`}>
              <p className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-slate-800">{row.label}</span>
                <span className="font-semibold tabular-nums">{row.value}</span>
              </p>
              <ShareBar bps={row.bps} label={row.label} />
              <p className="text-xs text-slate-600">{row.detail}</p>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

type ExportFilters = Parameters<ApiClient['dashboard']['exportCreate']>[0];

/** An export that ended without a file, in words for the person. */
class ExportFailed extends Error {}

/** An export as shown, with its filters: Excel at once, a PDF once rendered (polled). */
function ExportButton({
  format,
  filters,
}: {
  readonly format: 'pdf' | 'xlsx';
  readonly filters: Omit<ExportFilters, 'format'>;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Review WEB 8: polling stops when the dashboard closes.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    setPending(true);
    setProblem(null);
    try {
      let exported = await api().dashboard.exportCreate({ ...filters, format });
      for (
        let tries = 0;
        exportNext(exported) === 'wait' && tries < EXPORT_POLL_TRIES;
        tries += 1
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, EXPORT_POLL_MS));
        if (!mounted.current) return;
        exported = await api().dashboard.exportGet({ exportId: exported.id });
      }
      if (!mounted.current) return;
      const next = exportNext(exported);
      if (next !== 'open' || !exported.url)
        throw new ExportFailed(
          next === 'failed'
            ? 'The export failed. Try again.'
            : 'The export is taking too long. Try again in a minute.',
        );
      // The signed link is served as an attachment: it downloads, and the dashboard stays.
      startDownload(exported.url);
    } catch (failure) {
      if (!mounted.current) return;
      setProblem(
        failure instanceof ExportFailed
          ? failure.message
          : failure instanceof Error && failure.message === 'unexpected link'
            ? 'The export link could not be opened. Try again.'
            : toProblem(failure).message,
      );
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <Button variant="secondary" size="sm" pending={pending} onClick={() => void run()}>
        {format === 'xlsx' ? 'Export to Excel' : 'Export to PDF'}
      </Button>
      {problem ? (
        <span role="alert" className="text-xs font-medium text-red-700">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
