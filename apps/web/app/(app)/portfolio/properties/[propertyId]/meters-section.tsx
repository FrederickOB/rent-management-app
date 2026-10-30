'use client';

import type { MeterRow, PropertyDetailView } from '@rent/contracts';
import {
  checkMeterNumber,
  checkMeterUnits,
  checkSupplier,
  METER_TYPE_LABELS,
  METER_TYPES,
  UTILITIES,
  type MeterType,
  type Utility,
} from '@rent/domain/portfolio';
import { useId, useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { MultiSelect } from '@/components/multi-select';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { controlClass, Field, SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { changedFields } from '@/lib/patch';
import { domainProblem, UTILITY_LABELS, unitTypeLabel } from '@/lib/register-format';
import type { RegisterOptions } from './types';

type Suppliers = RegisterOptions['meterSuppliers'];

interface UnitChoice {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * Electricity and water meters (PR-05). A prepaid or postpaid meter serves one unit at most; a
 * shared meter may serve several. Readings and utility billing come later (Module 7).
 */
export function MetersSection({
  property,
  canManage,
  suppliers,
  onChanged,
}: {
  readonly property: PropertyDetailView;
  readonly canManage: boolean;
  readonly suppliers: Suppliers | null;
  readonly onChanged: (message: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const units = property.blocks.flatMap((b) => b.units);
  const choices: UnitChoice[] = units.map((u) => ({
    value: u.id,
    label: u.code,
    hint: unitTypeLabel(u.unitType, u.bedrooms),
  }));
  const codes = new Map(units.map((u) => [u.id, u.code]));

  return (
    <Card>
      <CardHeader
        title="Meters"
        description="Electricity and water meters, and the units each one serves."
        actions={
          canManage && !adding ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add a meter
            </Button>
          ) : null
        }
      />
      <CardBody>
        {adding ? (
          <AddMeterForm
            propertyId={property.id}
            choices={choices}
            suppliers={suppliers}
            onDone={async (message) => {
              setAdding(false);
              await onChanged(message);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {property.meters.length === 0 ? (
          <p className="text-sm text-slate-600">No meters yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {property.meters.map((meter) => (
              <MeterItem
                key={meter.id}
                meter={meter}
                codes={codes}
                choices={choices}
                suppliers={suppliers}
                canManage={canManage}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

const meterName = (m: Pick<MeterRow, 'utility' | 'supplier' | 'meterNumber'>) =>
  `${UTILITY_LABELS[m.utility]} meter ${m.meterNumber}`;

function MeterItem({
  meter,
  codes,
  choices,
  suppliers,
  canManage,
  onChanged,
}: {
  readonly meter: MeterRow;
  readonly codes: ReadonlyMap<string, string>;
  readonly choices: readonly UnitChoice[];
  readonly suppliers: Suppliers | null;
  readonly canManage: boolean;
  readonly onChanged: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'units' | 'archive'>('view');
  const [unitIds, setUnitIds] = useState<string[]>([...meter.unitIds]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const served = meter.unitIds.map((id) => codes.get(id) ?? 'an archived unit');

  async function run(action: () => Promise<unknown>, message: string) {
    setPending(true);
    setError(null);
    try {
      await action();
      setMode('view');
      await onChanged(message);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  function saveUnits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = domainProblem(() => checkMeterUnits(meter.meterType, unitIds.length));
    if (problem) {
      setError(problem);
      return;
    }
    void run(
      () => api().register.setMeterUnits({ meterId: meter.id, unitIds }),
      `Saved the units for ${meterName(meter)}.`,
    );
  }

  return (
    <li className="space-y-2 py-3" data-testid="meter">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium text-slate-900">
            {UTILITY_LABELS[meter.utility]} · {meter.supplier} ·{' '}
            <span className="font-mono">{meter.meterNumber}</span>{' '}
            <Badge>{METER_TYPE_LABELS[meter.meterType]}</Badge>
          </p>
          <p className="break-words text-slate-700">
            {served.length ? `Serves ${served.join(', ')}` : 'Not linked to a unit yet'}
          </p>
          {meter.notes ? <p className="break-words text-slate-600">{meter.notes}</p> : null}
        </div>
        {canManage && mode === 'view' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Edit ${meterName(meter)}`}
              onClick={() => {
                setError(null);
                setMode('edit');
              }}
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Choose units for ${meterName(meter)}`}
              onClick={() => {
                setError(null);
                setUnitIds([...meter.unitIds]);
                setMode('units');
              }}
            >
              Units
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Archive ${meterName(meter)}`}
              onClick={() => {
                setError(null);
                setMode('archive');
              }}
            >
              Archive
            </Button>
          </div>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {mode === 'edit' ? (
        <EditMeterForm
          meter={meter}
          suppliers={suppliers}
          pending={pending}
          onSave={(patch) =>
            void run(
              () => api().register.updateMeter({ meterId: meter.id, ...patch }),
              `Saved ${meterName({ ...meter, ...patch })}.`,
            )
          }
          onProblem={setError}
          onCancel={() => setMode('view')}
        />
      ) : null}
      {mode === 'units' ? (
        <form
          onSubmit={saveUnits}
          aria-label={`Units served by ${meterName(meter)}`}
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <MultiSelect
            legend="Units served"
            hint={
              meter.meterType === 'shared'
                ? 'A shared meter can serve several units.'
                : 'A prepaid or postpaid meter serves one unit.'
            }
            options={choices}
            value={unitIds}
            max={meter.meterType === 'shared' ? undefined : 1}
            noneLabel="No unit"
            onChange={setUnitIds}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Save units
            </Button>
            <Button variant="ghost" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {mode === 'archive' ? (
        <ConfirmBox
          label={`Confirm archiving ${meterName(meter)}`}
          confirmText="Archive meter"
          pending={pending}
          onConfirm={() =>
            void run(
              () => api().register.archiveMeter({ meterId: meter.id }),
              `Archived ${meterName(meter)}.`,
            )
          }
          onCancel={() => setMode('view')}
        >
          Archive {meterName(meter)}? It stops serving its units.
        </ConfirmBox>
      ) : null}
    </li>
  );
}

function SupplierField({
  utility,
  suppliers,
  value,
  error,
  onChange,
}: {
  readonly utility: Utility;
  readonly suppliers: Suppliers | null;
  readonly value: string;
  readonly error?: string;
  readonly onChange: (value: string) => void;
}) {
  const listId = useId();
  const suggestions = suppliers?.[utility] ?? [];
  return (
    <Field
      label="Supplier"
      hint={suggestions.length ? `For example ${suggestions.join(' or ')}.` : undefined}
      error={error}
    >
      {(control) => (
        <>
          <input
            {...control}
            list={listId}
            maxLength={40}
            autoComplete="off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={controlClass}
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

const TYPE_OPTIONS = METER_TYPES.map((t) => ({ value: t, label: METER_TYPE_LABELS[t] }));

function AddMeterForm({
  propertyId,
  choices,
  suppliers,
  onDone,
  onCancel,
}: {
  readonly propertyId: string;
  readonly choices: readonly UnitChoice[];
  readonly suppliers: Suppliers | null;
  readonly onDone: (message: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [utility, setUtility] = useState<Utility>('electricity');
  const [supplier, setSupplier] = useState(suppliers?.electricity[0] ?? '');
  const [meterNumber, setMeterNumber] = useState('');
  const [meterType, setMeterType] = useState<MeterType>('prepaid');
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = {
    supplier: domainProblem(() => checkSupplier(supplier)) ?? undefined,
    meterNumber: domainProblem(() => checkMeterNumber(meterNumber)) ?? undefined,
    units: domainProblem(() => checkMeterUnits(meterType, unitIds.length)) ?? undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (invalid) return;
    setPending(true);
    try {
      await api().register.addMeter({
        propertyId,
        utility,
        supplier: supplier.trim(),
        meterNumber: meterNumber.trim(),
        meterType,
        notes: notes.trim() || null,
        unitIds,
      });
      await onDone(
        `Added the ${UTILITY_LABELS[utility].toLowerCase()} meter ${meterNumber.trim()}.`,
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add a meter"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Utility"
          value={utility}
          options={UTILITIES.map((u) => ({ value: u, label: UTILITY_LABELS[u] }))}
          onChange={(event) => {
            const next = UTILITIES.find((u) => u === event.target.value);
            if (!next) return;
            setUtility(next);
            if (!supplier.trim() || suppliers?.[utility].includes(supplier))
              setSupplier(suppliers?.[next][0] ?? '');
          }}
        />
        <SupplierField
          utility={utility}
          suppliers={suppliers}
          value={supplier}
          error={tried ? errors.supplier : undefined}
          onChange={setSupplier}
        />
        <TextField
          label="Meter number"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={meterNumber}
          error={tried ? errors.meterNumber : undefined}
          onChange={(event) => setMeterNumber(event.target.value)}
        />
        <SelectField
          label="Meter type"
          value={meterType}
          options={TYPE_OPTIONS}
          onChange={(event) => {
            const next = METER_TYPES.find((t) => t === event.target.value);
            if (!next) return;
            setMeterType(next);
            if (next !== 'shared') setUnitIds((ids) => ids.slice(0, 1));
          }}
        />
      </div>
      <MultiSelect
        legend="Units served"
        hint={
          meterType === 'shared'
            ? 'A shared meter can serve several units.'
            : 'A prepaid or postpaid meter serves one unit.'
        }
        options={choices}
        value={unitIds}
        max={meterType === 'shared' ? undefined : 1}
        noneLabel="No unit yet"
        error={tried ? errors.units : undefined}
        onChange={setUnitIds}
      />
      <TextField
        label="Notes (optional)"
        maxLength={300}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Add meter
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditMeterForm({
  meter,
  suppliers,
  pending,
  onSave,
  onProblem,
  onCancel,
}: {
  readonly meter: MeterRow;
  readonly suppliers: Suppliers | null;
  readonly pending: boolean;
  readonly onSave: (patch: {
    supplier?: string;
    meterNumber?: string;
    meterType?: MeterType;
    notes?: string | null;
  }) => void;
  readonly onProblem: (message: string) => void;
  readonly onCancel: () => void;
}) {
  const [supplier, setSupplier] = useState(meter.supplier);
  const [meterNumber, setMeterNumber] = useState(meter.meterNumber);
  const [meterType, setMeterType] = useState<MeterType>(meter.meterType);
  const [notes, setNotes] = useState(meter.notes ?? '');
  const [tried, setTried] = useState(false);
  const errors = {
    supplier: domainProblem(() => checkSupplier(supplier)) ?? undefined,
    meterNumber: domainProblem(() => checkMeterNumber(meterNumber)) ?? undefined,
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (errors.supplier || errors.meterNumber) return;
    const typeProblem = domainProblem(() => checkMeterUnits(meterType, meter.unitIds.length));
    if (typeProblem) {
      onProblem(`${typeProblem}. Choose its units first.`);
      return;
    }
    const patch = changedFields(
      {
        supplier: meter.supplier,
        meterNumber: meter.meterNumber,
        meterType: meter.meterType,
        notes: meter.notes ?? null,
      },
      {
        supplier: supplier.trim(),
        meterNumber: meterNumber.trim(),
        meterType,
        notes: notes.trim() || null,
      },
    );
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    onSave(patch);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Edit ${meterName(meter)}`}
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SupplierField
          utility={meter.utility}
          suppliers={suppliers}
          value={supplier}
          error={tried ? errors.supplier : undefined}
          onChange={setSupplier}
        />
        <TextField
          label="Meter number"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={meterNumber}
          error={tried ? errors.meterNumber : undefined}
          onChange={(event) => setMeterNumber(event.target.value)}
        />
        <SelectField
          label="Meter type"
          value={meterType}
          options={TYPE_OPTIONS}
          onChange={(event) => {
            const next = METER_TYPES.find((t) => t === event.target.value);
            if (next) setMeterType(next);
          }}
        />
        <TextField
          label="Notes (optional)"
          maxLength={300}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Save meter
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
