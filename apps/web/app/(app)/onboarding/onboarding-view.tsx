'use client';

import type { OnboardingState } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  cutOverProblem,
  cutOverText,
  onboardingMessage,
  STEP_DESCRIPTIONS,
  STEP_LABELS,
  STEP_STATUS_LABELS,
} from '@/lib/onboarding';
import { useLoad } from '@/lib/use-load';
import { ImportFlow } from '../portfolio/import/import-flow';
import { BatchFlow } from './batch-flow';

const problemText = (failure: unknown): string =>
  onboardingMessage(failure) ?? toProblem(failure).message;

export function OnboardingView() {
  const load = useCallback(() => api().onboarding.get(), []);
  const { state, reload } = useLoad(load);

  if (state.status === 'loading') return <Loading what="onboarding" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const onboarding = state.data;
  const step = (key: OnboardingState['steps'][number]['step']) =>
    onboarding.steps.find((s) => s.step === key);
  const balancesPosted = step('balances')?.status === 'done';

  return (
    <>
      <CutOver state={onboarding} onChanged={reload} />
      {(['register', 'tenancies', 'balances'] as const).map((key, index) => (
        <section
          key={key}
          aria-labelledby={`step-${key}`}
          className="space-y-4"
          data-testid={`onboarding-step-${key}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`step-${key}`} className="text-lg font-semibold text-slate-900">
              Step {index + 1}: {STEP_LABELS[key]}
            </h2>
            <Badge
              tone={
                step(key)?.status === 'done'
                  ? 'green'
                  : step(key)?.status === 'in_progress'
                    ? 'amber'
                    : 'neutral'
              }
            >
              {STEP_STATUS_LABELS[step(key)?.status ?? 'not_started']}
            </Badge>
          </div>
          <p className="text-sm text-slate-700">{STEP_DESCRIPTIONS[key]}</p>
          {key === 'register' ? (
            <ImportFlow
              template={() => api().onboarding.registerTemplate()}
              templateNote="Four sheets: Owners (for an agency), Properties, Units, and Lists with every allowed value."
            />
          ) : null}
          {key === 'tenancies' ? <BatchFlow kind="tenancies" onChanged={reload} /> : null}
          {key === 'balances' ? (
            <>
              <BatchFlow kind="balances" onChanged={reload} />
              {balancesPosted ? <BatchFlow kind="adjustment" onChanged={reload} /> : null}
            </>
          ) : null}
        </section>
      ))}
      <MissingScans count={onboarding.leasesMissingScan} />
    </>
  );
}

/** The cut-over date (decision 3): every opening entry is dated it; fixed once posted. */
function CutOver({
  state,
  onChanged,
}: {
  readonly state: OnboardingState;
  readonly onChanged: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [value, setValue] = useState(state.cutOverDate ?? today);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = cutOverProblem(value, today);
    setError(problem);
    setNotice(null);
    if (problem) return;
    setPending(true);
    try {
      const next = await api().onboarding.setCutOver({ cutOverDate: value });
      setNotice(`The cut-over is ${formatBusinessDate(next.cutOverDate ?? value)}.`);
      onChanged();
    } catch (failure) {
      setError(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="onboarding-cut-over">
      <CardHeader
        title="The cut-over date"
        description="The day the landlord’s records move onto the platform: every opening balance is dated it, and billing and reminders start from it, with no catch-up for earlier due dates."
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-slate-800" data-testid="cut-over-text">
          {cutOverText(state)}
        </p>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {state.cutOverFixed ? null : (
          <form
            aria-label="Set the cut-over date"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => void save(event)}
          >
            <TextField
              label="Cut-over date"
              type="date"
              max={today}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="secondary" pending={pending}>
              Set the cut-over
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

/** Imported leases still waiting for their paper scan (decision 2). */
function MissingScans({ count }: { readonly count: number }) {
  const { timeZone } = useApp();
  const load = useCallback(
    () => (count > 0 ? api().onboarding.leasesMissingScan() : Promise.resolve([])),
    [count],
  );
  const { state, reload } = useLoad(load);
  return (
    <Card data-testid="leases-missing-scan">
      <CardHeader
        title="Scans to follow"
        description="Leases brought in from the workbook whose signed paper scan is still to come. Upload each one on its lease page."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the leases" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>Every imported lease has its scan.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <Table caption="Imported leases without a scan">
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Tenant</Th>
                <Th>Starts</Th>
                <Th>Imported</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.data.map((lease) => (
                <tr key={lease.leaseId} data-testid="missing-scan-row">
                  <Td className="font-medium">
                    <Link
                      href={`/leases/${lease.leaseId}`}
                      className="underline underline-offset-2"
                    >
                      {lease.unitCode}
                    </Link>
                  </Td>
                  <Td>{lease.tenantName}</Td>
                  <Td>{formatBusinessDate(lease.startDate)}</Td>
                  <Td>{formatTime(lease.importedAt, timeZone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardBody>
    </Card>
  );
}
