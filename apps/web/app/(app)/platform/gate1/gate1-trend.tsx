'use client';

import { useCallback, useState } from 'react';
import { ShareBar } from '@/components/bars';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { startDownload } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { gate1Targets, ratioText, type Gate1 } from '@/lib/reporting';
import { monthLabel } from '@/lib/rent-tax';
import { useLoad } from '@/lib/use-load';
import { TARGET_TONES } from '../../dashboard-view';

/** The two Gate 1 targets of a month, as badges; "No figures" when the month has none. */
function TargetBadges({ gate1 }: { readonly gate1: Gate1 | null }) {
  if (!gate1) return <span className="text-slate-600">No figures</span>;
  const targets = gate1Targets(gate1);
  if (targets.length === 0) return <span className="text-slate-600">Before targets were kept</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {targets.map((t) => (
        <Badge key={t.key} tone={TARGET_TONES[t.state]}>
          {t.key === 'collection' ? 'Collection' : 'Auto-match'}:{' '}
          {t.state === 'met' ? 'met' : t.state === 'missed' ? 'not met' : 'not measurable'}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Gate 1 month by month (M11 decision 4): the two 95% targets met or not, platform-wide and per
 * pilot company, with the Excel export. Months are the API's (from each company's cut-over).
 */
export function Gate1Trend({ months }: { readonly months: readonly string[] }) {
  const [from, setFrom] = useState(months.at(-1)!);
  const [to, setTo] = useState(months[0]!);
  const load = useCallback(
    () => api().platformMetrics.gate1Trend(from <= to ? { from, to } : { from: to, to: from }),
    [from, to],
  );
  const { state, reload } = useLoad(load);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function exportTrend() {
    setExporting(true);
    setProblem(null);
    try {
      const file = await api().platformMetrics.gate1Export(
        from <= to ? { from, to } : { from: to, to: from },
      );
      startDownload(file.url);
    } catch (failure) {
      setProblem(
        failure instanceof Error && failure.message === 'unexpected link'
          ? 'The export link could not be opened. Try again.'
          : toProblem(failure).message,
      );
    } finally {
      setExporting(false);
    }
  }

  const options = months.map((m) => ({ value: m, label: monthLabel(m) }));
  const companies =
    state.status === 'ready'
      ? [
          ...new Map(
            state.data.months.flatMap((m) => m.companies.map((c) => [c.company.id, c.company])),
          ).values(),
        ]
      : [];

  return (
    <Card data-testid="gate1-trend">
      <CardHeader
        title="Gate 1 targets, month by month"
        description="Gate 1 needs 95% of rent collected and 95% of provider payments matched automatically. Each month is met, not met, or not measurable when nothing was due or paid."
        actions={
          <Button
            size="sm"
            variant="secondary"
            pending={exporting}
            onClick={() => void exportTrend()}
          >
            Export to Excel
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <SelectField
            label="From"
            value={from}
            options={options}
            onChange={(event) => setFrom(event.target.value)}
          />
          <SelectField
            label="To"
            value={to}
            options={options}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {state.status === 'loading' ? <Loading what="the trend" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.months.length === 0 ? (
          <Empty>No months to show yet.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.months.length > 0 ? (
          <>
            <Table caption="Every company, month by month">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th>Collection rate</Th>
                  <Th>Matched automatically</Th>
                  <Th>Targets</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.data.months.map((m) => (
                  <tr key={m.month} data-testid="gate1-trend-month">
                    <Th scope="row" className="font-medium">
                      {monthLabel(m.month)}
                    </Th>
                    <Td className="min-w-32 tabular-nums">
                      {m.total ? (
                        <>
                          {ratioText(m.total.collectionRate.rate)}
                          <ShareBar bps={m.total.collectionRate.rate.bps} label="Collection rate" />
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="min-w-32 tabular-nums">
                      {m.total ? (
                        <>
                          {ratioText(m.total.autoMatch.provider.rate)}
                          <ShareBar
                            bps={m.total.autoMatch.provider.rate.bps}
                            label="Matched automatically"
                          />
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      <TargetBadges gate1={m.total} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {companies.length > 0 ? (
              <div className="overflow-x-auto">
                <Table caption="Targets by pilot company">
                  <thead>
                    <tr>
                      <Th>Company</Th>
                      {state.data.months.map((m) => (
                        <Th key={m.month}>{monthLabel(m.month)}</Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {companies.map((company) => (
                      <tr key={company.id} data-testid="gate1-trend-company">
                        <Th scope="row" className="font-medium">
                          {company.name}
                        </Th>
                        {state.data.months.map((m) => (
                          <Td key={m.month}>
                            <TargetBadges
                              gate1={
                                m.companies.find((c) => c.company.id === company.id)?.gate1 ?? null
                              }
                            />
                          </Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
