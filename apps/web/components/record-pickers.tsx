'use client';

import { DISPLAY_STATUS_LABELS } from '@rent/domain/portfolio';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  pickedTenantOf,
  pickedUnitOf,
  type PickedTenant,
  type PickedUnit,
} from '@/lib/record-picks';
import { SelectField, TextField } from './ui/field';

const SEARCH_DELAY_MS = 300;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [value]);
  return debounced;
}

/** Finds a unit by its code or property, among the units this person may see (AD-02). */
export function UnitPicker({
  value,
  onChange,
  error,
}: {
  readonly value: PickedUnit | null;
  readonly onChange: (unit: PickedUnit | null) => void;
  readonly error?: string | null;
}) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const [rows, setRows] = useState<readonly PickedUnit[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api()
      .register.listUnits({ search: query.trim() || undefined, limit: 50 })
      .then(
        (result) => {
          if (!current) return;
          setRows(result.rows.map(pickedUnitOf));
          setProblem(null);
        },
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [query]);

  const options = value && !rows.some((r) => r.id === value.id) ? [value, ...rows] : rows;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800">Unit</legend>
      <TextField
        label="Find a unit"
        hint="Type part of a unit code or a property name, such as ACC-LEG or Osu."
        autoComplete="off"
        spellCheck={false}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <SelectField
        label="Unit for this lease"
        value={value?.id ?? ''}
        error={problem ?? error}
        options={[
          { value: '', label: options.length ? 'Choose a unit' : 'No unit matches' },
          ...options.map((u) => ({
            value: u.id,
            label: `${u.code} · ${u.propertyName} · ${DISPLAY_STATUS_LABELS[u.status]}`,
          })),
        ]}
        onChange={(event) => onChange(options.find((u) => u.id === event.target.value) ?? null)}
      />
    </fieldset>
  );
}

/** Finds a tenant by name, phone or unit, among the tenants this person may see. */
export function TenantPicker({
  value,
  onChange,
  error,
  label = 'Tenant for this lease',
}: {
  readonly value: PickedTenant | null;
  readonly onChange: (tenant: PickedTenant | null) => void;
  readonly error?: string | null;
  /** The choice's label; lease forms keep the default. */
  readonly label?: string;
}) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const [rows, setRows] = useState<readonly PickedTenant[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api()
      .tenants.list({ search: query.trim() || undefined })
      .then(
        (result) => {
          if (!current) return;
          setRows(result.slice(0, 50).map(pickedTenantOf));
          setProblem(null);
        },
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [query]);

  const options = value && !rows.some((r) => r.id === value.id) ? [value, ...rows] : rows;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800">Tenant</legend>
      <TextField
        label="Find a tenant"
        hint="Type part of a name, a phone number or a unit code."
        autoComplete="off"
        spellCheck={false}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <SelectField
        label={label}
        value={value?.id ?? ''}
        error={problem ?? error}
        options={[
          { value: '', label: options.length ? 'Choose a tenant' : 'No tenant matches' },
          ...options.map((t) => ({
            value: t.id,
            label: t.phone ? `${t.displayName} · ${t.phone}` : t.displayName,
          })),
        ]}
        onChange={(event) => onChange(options.find((t) => t.id === event.target.value) ?? null)}
      />
    </fieldset>
  );
}
