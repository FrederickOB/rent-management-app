'use client';

import { INSPECTION_KINDS, INSPECTION_KIND_LABELS } from '@rent/domain/maintenance';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { PropertyUnitFields } from '@/components/property-unit-fields';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { inspectionStatusText, kindLabel, progressText } from '@/lib/inspections';
import { useLoad } from '@/lib/use-load';

type KindFilter = '' | (typeof INSPECTION_KINDS)[number];

export function InspectionsView({ canStartRoutine }: { readonly canStartRoutine: boolean }) {
  const { timeZone } = useApp();
  const [kind, setKind] = useState<KindFilter>('');
  const [status, setStatus] = useState<'' | 'in_progress' | 'submitted'>('');
  const load = useCallback(
    () =>
      api().inspections.list({
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      }),
    [kind, status],
  );
  const { state, reload } = useLoad(load);

  return (
    <>
      {canStartRoutine ? <StartRoutine /> : null}
      <Card>
        <CardHeader title="Inspections" description="Newest first." />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Kind"
              value={kind}
              options={[
                { value: '', label: 'Every kind' },
                ...INSPECTION_KINDS.map((k) => ({ value: k, label: INSPECTION_KIND_LABELS[k] })),
              ]}
              onChange={(event) =>
                setKind(INSPECTION_KINDS.find((k) => k === event.target.value) ?? '')
              }
            />
            <SelectField
              label="Status"
              value={status}
              options={[
                { value: '', label: 'In progress and submitted' },
                { value: 'in_progress', label: 'In progress' },
                { value: 'submitted', label: 'Submitted' },
              ]}
              onChange={(event) => {
                const value = event.target.value;
                setStatus(value === 'in_progress' || value === 'submitted' ? value : '');
              }}
            />
          </div>
          {state.status === 'loading' ? <Loading what="the inspections" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <Empty>No inspection matches.</Empty>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {state.data.map((row) => (
                <li key={row.id} className="space-y-1 py-3" data-testid="inspection-row">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/inspections/${row.id}`}
                      className="font-medium underline underline-offset-2"
                    >
                      {kindLabel(row.kind)}, <span className="font-mono">{row.unit.code}</span>
                    </Link>
                    <Badge tone={row.status === 'submitted' ? 'green' : 'amber'}>
                      {inspectionStatusText(row)}
                    </Badge>
                    {row.corrects ? <Badge>A correction</Badge> : null}
                  </p>
                  <p className="text-slate-700">
                    {row.property.name}
                    {row.tenant ? ` · ${row.tenant.name}` : ''} ·{' '}
                    {progressText(row.itemsDone, row.itemCount)}
                  </p>
                  <p className="text-slate-600">
                    Started {formatTime(row.startedAt, timeZone)}
                    {row.performedByName ? ` by ${row.performedByName}` : ''}
                    {row.submittedAt ? ` · submitted ${formatTime(row.submittedAt, timeZone)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

/** A routine inspection of any unit (Growth); schedules are MI-08, P2. */
function StartRoutine() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ propertyId: '', unitId: '' });
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!place.unitId) return;
    setPending(true);
    try {
      const started = await api().inspections.start({ unitId: place.unitId, kind: 'routine' });
      router.push(`/inspections/${started.id}`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Start a routine inspection</Button>
      </div>
    );
  return (
    <Card>
      <CardHeader
        title="Start a routine inspection"
        description="The checklist comes from the unit’s type. Move-in and move-out inspections start from the lease."
      />
      <CardBody>
        <form
          onSubmit={submit}
          noValidate
          aria-label="Start a routine inspection"
          className="space-y-4"
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <PropertyUnitFields
            propertyId={place.propertyId}
            unitId={place.unitId}
            onChange={setPlace}
            unitLabel="Unit"
            noUnitLabel="Choose the unit"
            errors={tried && !place.unitId ? { unitId: 'Choose the unit' } : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Start
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
