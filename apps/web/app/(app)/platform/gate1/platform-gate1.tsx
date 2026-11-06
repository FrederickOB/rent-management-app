'use client';

import { useCallback, useState } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import { gate1Rows } from '@/lib/reporting';
import { monthLabel } from '@/lib/rent-tax';
import { draftableMonths } from '@/lib/statements';
import { useLoad } from '@/lib/use-load';
import { Gate1Card } from '../../dashboard-view';

/** Months to choose from: this one, then the twelve before it (platform admins work in UTC dates). */
function months(): string[] {
  const today = todayIn('UTC');
  return [today.slice(0, 7), ...draftableMonths(today)];
}

export function PlatformGate1() {
  const choices = months();
  const [month, setMonth] = useState(choices[0]!);
  const load = useCallback(() => api().platformMetrics.gate1({ month }), [month]);
  const { state, reload } = useLoad(load);

  return (
    <>
      <SelectField
        label="Month"
        value={month}
        options={choices.map((m) => ({ value: m, label: monthLabel(m) }))}
        onChange={(event) => setMonth(event.target.value)}
        className="max-w-xs"
      />
      {state.status === 'loading' ? <Loading what="the metrics" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' ? (
        <>
          {state.data.total ? (
            <Gate1Card
              gate1={state.data.total}
              title={`Every company, ${monthLabel(state.data.month)}`}
            />
          ) : (
            <Empty>
              No figures for {monthLabel(state.data.month)} yet; they are worked out each night.
            </Empty>
          )}
          <Card>
            <CardHeader title="By company" />
            <CardBody>
              {state.data.companies.length === 0 ? <Empty>No companies yet.</Empty> : null}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <caption className="sr-only">Gate 1 measures by company</caption>
                  <thead>
                    <tr className="text-slate-600">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Company
                      </th>
                      {state.data.total
                        ? gate1Rows(state.data.total).map((r) => (
                            <th
                              key={r.key}
                              scope="col"
                              className="py-1 pr-3 text-right font-medium"
                            >
                              {r.label}
                            </th>
                          ))
                        : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {state.data.companies.map((c) => (
                      <tr key={c.company.id} data-testid="gate1-company">
                        <th scope="row" className="py-2 pr-3 font-medium">
                          {c.company.name}
                        </th>
                        {c.gate1 ? (
                          gate1Rows(c.gate1).map((r) => (
                            <td
                              key={r.key}
                              className="py-2 pr-3 text-right tabular-nums"
                              title={r.detail}
                            >
                              {r.value}
                            </td>
                          ))
                        ) : (
                          <td className="py-2 text-slate-600" colSpan={7}>
                            No figures yet
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </>
      ) : null}
    </>
  );
}
