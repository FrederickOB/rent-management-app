'use client';

import { useCallback, useState } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import { monthLabel } from '@/lib/rent-tax';
import { draftableMonths } from '@/lib/statements';
import { ESTIMATED } from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';
import { UsageTable } from '../companies/[companyId]/company-detail';

/** Last month first (the API's default), then the eleven before it, then this month so far. */
function months(): string[] {
  const today = todayIn('UTC');
  return [...draftableMonths(today), today.slice(0, 7)];
}

export function MessagingCostsView() {
  const choices = months();
  const [month, setMonth] = useState(choices[0]!);
  const load = useCallback(() => api().platformAdmin.usage({ month }), [month]);
  const { state, reload } = useLoad(load);

  const totals =
    state.status === 'ready'
      ? state.data.reduce(
          (sum, row) => ({
            sms: sum.sms + row.smsCostMinor,
            whatsapp: sum.whatsapp + row.whatsappCostEstimatedMinor,
          }),
          { sms: 0, whatsapp: 0 },
        )
      : null;

  return (
    <>
      <SelectField
        label="Month"
        value={month}
        options={choices.map((m) => ({ value: m, label: monthLabel(m) }))}
        onChange={(event) => setMonth(event.target.value)}
        className="max-w-xs"
      />
      {state.status === 'loading' ? <Loading what="usage" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <Empty>No usage recorded for {monthLabel(month)}.</Empty>
      ) : null}
      {state.status === 'ready' && state.data.length > 0 && totals ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-800" data-testid="messaging-cost-totals">
              {monthLabel(month)}: SMS {formatMinor(totals.sms)}; WhatsApp{' '}
              {formatMinor(totals.whatsapp)} ({ESTIMATED.toLowerCase()}).
            </p>
            <UsageTable rows={state.data} caption={`Usage by company, ${monthLabel(month)}`} />
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
