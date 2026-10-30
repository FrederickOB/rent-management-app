'use client';

import type { PropertyRowView, UnitRowView } from '@rent/contracts';
import {
  BILLING_BAND_LABELS,
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUSES,
  UNIT_TYPE_LABELS,
  UNIT_TYPES,
  type DisplayStatus,
} from '@rent/domain/portfolio';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '@/components/app-context';
import { NoAccess } from '@/components/no-access';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  EMPTY_FILTERS,
  filterOptions,
  filtersFromQuery,
  pageInfo,
  propertyListInput,
  queryFromFilters,
  unitListInput,
  withFilter,
  type PortfolioTab,
  type UnitFilters,
} from '@/lib/portfolio-filters';
import { countsSummary, locationLabel, totalOf, unitTypeLabel } from '@/lib/register-format';
import { useInterval, useOnVisible } from '@/lib/use-interval';

const REFRESH_MS = 30_000;
const SEARCH_DELAY_MS = 300;
const TABS: readonly { id: PortfolioTab; label: string }[] = [
  { id: 'units', label: 'Units' },
  { id: 'properties', label: 'Properties' },
];

type Counts = Record<DisplayStatus, number>;

type Shown =
  | {
      readonly tab: 'units';
      readonly rows: readonly UnitRowView[];
      readonly total: number;
      readonly counts: Counts;
    }
  | {
      readonly tab: 'properties';
      readonly rows: readonly PropertyRowView[];
      readonly counts: Counts;
    };

export interface PortfolioViewProps {
  readonly initialTab: PortfolioTab;
  readonly initialFilters: UnitFilters;
}

/**
 * The portfolio (PRD section 5 story): every unit across owners with status counts that follow
 * the filters and the data, and the properties with their counts. The list reloads on every
 * change of filter and every 30 seconds (M2 plan section 9, item 4).
 */
export function PortfolioView({ initialTab, initialFilters }: PortfolioViewProps) {
  const { timeZone } = useApp();
  const [tab, setTab] = useState<PortfolioTab>(initialTab);
  const [filters, setFilters] = useState<UnitFilters>(initialFilters);
  const [searchText, setSearchText] = useState(initialFilters.search);
  const [shown, setShown] = useState<Shown | null>(null);
  const [everything, setEverything] = useState<readonly PropertyRowView[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const latest = useRef(0);
  const tabRefs = useRef<Record<PortfolioTab, HTMLButtonElement | null>>({
    units: null,
    properties: null,
  });

  const load = useCallback(
    async (quiet: boolean) => {
      const request = ++latest.current;
      if (!quiet) setLoading(true);
      try {
        const [list, all] = await Promise.all([
          tab === 'units'
            ? api()
                .register.listUnits(unitListInput(filters))
                .then((r): Shown => ({ tab: 'units', ...r }))
            : api()
                .register.listProperties(propertyListInput(filters))
                .then((r): Shown => ({ tab: 'properties', ...r })),
          api().register.listProperties({}),
        ]);
        if (request !== latest.current) return; // a newer request is on its way
        setShown(list);
        setEverything(all.rows);
        setProblem(null);
        setUpdatedAt(new Date());
      } catch (failure) {
        if (request === latest.current) setProblem(toProblem(failure));
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [tab, filters],
  );

  useEffect(() => {
    void load(false);
  }, [load]);
  useInterval(() => void load(true), REFRESH_MS);
  useOnVisible(() => void load(true));

  // A navigation to this page with other filters (the nav, a link from home) starts from them.
  // The address changes this screen makes itself already match its state, so they are ignored.
  const params = useSearchParams();
  const shownQuery = useRef('');
  useEffect(() => {
    shownQuery.current = queryFromFilters(tab, filters);
  });
  useEffect(() => {
    const next = filtersFromQuery(params);
    if (queryFromFilters(next.tab, next.filters) === shownQuery.current) return;
    setTab(next.tab);
    setFilters(next.filters);
    setSearchText(next.filters.search);
  }, [params]);

  // The address bar carries the filters, so a filtered list can be bookmarked or shared.
  useEffect(() => {
    const query = queryFromFilters(tab, filters);
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(null, '', url);
  }, [tab, filters]);

  // Typing waits for a pause before it searches.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) =>
        current.search === searchText ? current : withFilter(current, 'search', searchText),
      );
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const set = <K extends keyof Omit<UnitFilters, 'page'>>(key: K, value: UnitFilters[K]) =>
    setFilters((current) => withFilter(current, key, value));

  function clear() {
    setSearchText('');
    setFilters(EMPTY_FILTERS);
  }

  function chooseTab(next: PortfolioTab) {
    setTab(next);
    setShown(null);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: PortfolioTab = tab === 'units' ? 'properties' : 'units';
    chooseTab(next);
    tabRefs.current[next]?.focus();
  }

  if (problem?.status === 403) return <NoAccess what="the property register" />;

  const options = filterOptions(everything, filters);
  const filtered =
    filters.ownerId ||
    filters.region ||
    filters.district ||
    filters.search ||
    (tab === 'units' && (filters.propertyId || filters.unitType || filters.status));
  const current = shown && shown.tab === tab ? shown : null;

  return (
    <>
      <div
        role="tablist"
        aria-label="Portfolio views"
        className="flex gap-1 border-b border-slate-200"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(element) => {
              tabRefs.current[t.id] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => chooseTab(t.id)}
            onKeyDown={onTabKey}
            className={cn(
              '-mb-px min-h-11 border-b-2 px-4 py-2 text-sm font-medium',
              tab === t.id
                ? 'border-brand text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-4">
        <Card>
          <CardBody>
            <form
              role="search"
              aria-label="Filter the portfolio"
              onSubmit={(event) => event.preventDefault()}
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              <TextField
                label="Search"
                type="search"
                placeholder={
                  tab === 'units' ? 'Unit code, property name or code' : 'Name, code or town'
                }
                maxLength={80}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
              <SelectField
                label="Owner"
                value={filters.ownerId}
                options={[{ value: '', label: 'All owners' }, ...options.owners]}
                onChange={(event) => set('ownerId', event.target.value)}
              />
              <SelectField
                label="Region"
                value={filters.region}
                options={[{ value: '', label: 'All regions' }, ...options.regions]}
                onChange={(event) => set('region', event.target.value)}
              />
              <SelectField
                label="District"
                value={filters.district}
                disabled={options.districts.length === 0 && !filters.district}
                options={[
                  { value: '', label: 'All districts' },
                  ...options.districts,
                  ...(filters.district &&
                  !options.districts.some((d) => d.value === filters.district)
                    ? [{ value: filters.district, label: filters.district }]
                    : []),
                ]}
                onChange={(event) => set('district', event.target.value)}
              />
              {tab === 'units' ? (
                <>
                  <SelectField
                    label="Property"
                    value={filters.propertyId}
                    options={[{ value: '', label: 'All properties' }, ...options.properties]}
                    onChange={(event) => set('propertyId', event.target.value)}
                  />
                  <SelectField
                    label="Unit type"
                    value={filters.unitType}
                    options={[
                      { value: '', label: 'All types' },
                      ...UNIT_TYPES.map((t) => ({ value: t, label: UNIT_TYPE_LABELS[t] })),
                    ]}
                    onChange={(event) =>
                      set('unitType', UNIT_TYPES.find((t) => t === event.target.value) ?? '')
                    }
                  />
                </>
              ) : null}
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-600" aria-live="polite">
                {loading
                  ? 'Loading…'
                  : updatedAt
                    ? `Updated ${formatTime(updatedAt, timeZone)}`
                    : null}
              </p>
              <div className="flex gap-2">
                {filtered ? (
                  <Button variant="ghost" size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={() => void load(false)}>
                  Refresh
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>

        {problem ? <Alert tone="error">{problem.message}</Alert> : null}

        {current ? (
          <StatusChips
            counts={current.counts}
            status={tab === 'units' ? filters.status : ''}
            onChoose={tab === 'units' ? (status) => set('status', status) : null}
          />
        ) : null}

        {current?.tab === 'units' ? (
          <UnitsTable
            rows={current.rows}
            total={current.total}
            page={filters.page}
            onPage={(page) => setFilters((f) => ({ ...f, page }))}
            onClear={filtered ? clear : null}
          />
        ) : null}
        {current?.tab === 'properties' ? (
          <PropertiesTable rows={current.rows} onClear={filtered ? clear : null} />
        ) : null}
      </div>
    </>
  );
}

/**
 * Counts by status (PRD section 5). They follow every filter except status itself, so each chip
 * says how many units choosing it would show; choosing one filters the list.
 */
function StatusChips({
  counts,
  status,
  onChoose,
}: {
  readonly counts: Counts;
  readonly status: DisplayStatus | '';
  readonly onChoose: ((status: DisplayStatus | '') => void) | null;
}) {
  const chips: { id: DisplayStatus | ''; label: string; count: number }[] = [
    { id: '', label: 'All', count: totalOf(counts) },
    ...DISPLAY_STATUSES.map((s) => ({ id: s, label: DISPLAY_STATUS_LABELS[s], count: counts[s] })),
  ];
  return (
    <div role="group" aria-label="Units by status" className="flex flex-wrap gap-2">
      {chips.map((chip) => {
        const active = status === chip.id;
        const body = (
          <>
            <span>{chip.label}</span>
            <span className="font-semibold tabular-nums" data-testid="chip-count">
              {chip.count}
            </span>
          </>
        );
        const style = cn(
          'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm',
          active
            ? 'border-brand bg-brand text-brand-contrast'
            : 'border-slate-300 bg-white text-slate-800',
        );
        return onChoose ? (
          <button
            key={chip.id || 'all'}
            type="button"
            aria-pressed={active}
            data-testid={`status-chip-${chip.id || 'all'}`}
            onClick={() => onChoose(active && chip.id ? '' : chip.id)}
            className={cn(style, !active && 'hover:bg-slate-100')}
          >
            {body}
          </button>
        ) : (
          <span
            key={chip.id || 'all'}
            data-testid={`status-chip-${chip.id || 'all'}`}
            className={style}
          >
            {body}
          </span>
        );
      })}
    </div>
  );
}

function UnitsTable({
  rows,
  total,
  page,
  onPage,
  onClear,
}: {
  readonly rows: readonly UnitRowView[];
  readonly total: number;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onClear: (() => void) | null;
}) {
  const info = pageInfo(total, page);
  if (rows.length === 0)
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-slate-700" role="status">
            {onClear ? 'No units match these filters.' : 'There are no units yet.'}
          </p>
          {onClear ? (
            <Button variant="secondary" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </CardBody>
      </Card>
    );
  return (
    <Card>
      <CardBody>
        <Table caption="Units">
          <thead>
            <tr>
              <Th>Unit</Th>
              <Th>Property</Th>
              <Th>Owner</Th>
              <Th>Type</Th>
              <Th>Billing band</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((unit) => (
              <tr key={unit.id} data-testid="unit-row">
                <Td className="whitespace-nowrap">
                  <Link
                    href={`/portfolio/units/${unit.id}`}
                    className="font-mono font-medium underline underline-offset-2"
                  >
                    {unit.code}
                  </Link>
                </Td>
                <Td>
                  <Link
                    href={`/portfolio/properties/${unit.propertyId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {unit.propertyName}
                  </Link>
                </Td>
                <Td>{unit.owner?.displayName ?? 'No owner'}</Td>
                <Td>{unitTypeLabel(unit.unitType, unit.bedrooms)}</Td>
                <Td>
                  {BILLING_BAND_LABELS[unit.billingBand]}
                  {unit.bandOverridden ? <span className="text-slate-600"> (changed)</span> : null}
                </Td>
                <Td>
                  <StatusBadge status={unit.status} underRepair={unit.underRepair} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <nav
          aria-label="Pages of units"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <p className="text-sm text-slate-600" data-testid="units-range">
            Showing {info.label}
          </p>
          {info.pages > 1 ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => onPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= info.pages}
                onClick={() => onPage(page + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </nav>
      </CardBody>
    </Card>
  );
}

function PropertiesTable({
  rows,
  onClear,
}: {
  readonly rows: readonly PropertyRowView[];
  readonly onClear: (() => void) | null;
}) {
  if (rows.length === 0)
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-slate-700" role="status">
            {onClear ? 'No properties match these filters.' : 'There are no properties yet.'}
          </p>
          {onClear ? (
            <Button variant="secondary" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </CardBody>
      </Card>
    );
  return (
    <Card>
      <CardBody>
        <Table caption="Properties">
          <thead>
            <tr>
              <Th>Property</Th>
              <Th>Owner</Th>
              <Th>Location</Th>
              <Th className="text-right">Units</Th>
              <Th>By status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((property) => (
              <tr key={property.id} data-testid="property-row">
                <Td>
                  <Link
                    href={`/portfolio/properties/${property.id}`}
                    className="font-medium underline underline-offset-2"
                  >
                    {property.name}
                  </Link>
                  <p className="font-mono text-slate-600">{property.code}</p>
                </Td>
                <Td>{property.owner?.displayName ?? 'No owner'}</Td>
                <Td>{locationLabel(property)}</Td>
                <Td className="text-right tabular-nums">{property.unitCount}</Td>
                <Td>{countsSummary(property.counts)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-sm text-slate-600">
          {rows.length} {rows.length === 1 ? 'property' : 'properties'}
        </p>
      </CardBody>
    </Card>
  );
}
