'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { isPayable, leasePickLabel, pickedLeaseOf, type PickedLease } from '@/lib/lease-pick';
import { SelectField, TextField } from './ui/field';

const SEARCH_DELAY_MS = 300;

/**
 * Finds the lease a payment is for, among the leases this person may see (AD-02): a caretaker
 * sees their properties' leases by unit and dates. Only signed leases are offered.
 */
export function LeasePicker({
  value,
  onChange,
  error,
  label = 'Lease',
  optional,
  disabled,
}: {
  readonly value: PickedLease | null;
  readonly onChange: (lease: PickedLease | null) => void;
  readonly error?: string | null;
  readonly label?: string;
  /** When set, the empty choice reads like this instead of asking for a lease. */
  readonly optional?: string;
  readonly disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly PickedLease[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let current = true;
    api()
      .leases.list({ search: query.trim() || undefined })
      .then(
        (list) => {
          if (!current) return;
          setRows(
            list
              .filter((row) => isPayable(row.status))
              .slice(0, 50)
              .map(pickedLeaseOf),
          );
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

  const found = rows ?? [];
  const options = value && !found.some((r) => r.id === value.id) ? [value, ...found] : found;
  const empty =
    optional ??
    (rows === null ? 'Loading leases…' : options.length ? 'Choose a lease' : 'No lease matches');
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-slate-800">{label}</legend>
      <TextField
        label="Find a lease"
        hint="Type part of a unit code, such as ACC-LEG-B1, or a tenant’s name."
        autoComplete="off"
        spellCheck={false}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <SelectField
        label="The lease"
        value={value?.id ?? ''}
        error={problem ?? error}
        options={[
          { value: '', label: empty },
          ...options.map((lease) => ({ value: lease.id, label: leasePickLabel(lease) })),
        ]}
        onChange={(event) => onChange(options.find((l) => l.id === event.target.value) ?? null)}
      />
    </fieldset>
  );
}
