'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  isPayable,
  leasePickLabel,
  pickedLeaseOf,
  uniqueLeases,
  type PickedLease,
} from '@/lib/lease-pick';
import { SelectField, TextField } from './ui/field';

const SEARCH_DELAY_MS = 300;

/**
 * Finds the lease a payment is for, among the leases this person may see (AD-02): a caretaker
 * sees their properties' leases by unit and dates. Only signed leases are offered. With
 * `ownerId`, only that owner's leases: money in an owner's own account can pay only their
 * leases (P23), so nobody is offered a match the API refuses.
 */
export function LeasePicker({
  value,
  onChange,
  error,
  label = 'Lease',
  optional,
  disabled,
  ownerId = null,
}: {
  readonly value: PickedLease | null;
  readonly onChange: (lease: PickedLease | null) => void;
  readonly error?: string | null;
  readonly label?: string;
  /** When set, the empty choice reads like this instead of asking for a lease. */
  readonly optional?: string;
  readonly disabled?: boolean;
  /** Offer only this owner's leases. */
  readonly ownerId?: string | null;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly PickedLease[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The owner's properties, when limited to one owner; null while they load. */
  const [properties, setProperties] = useState<readonly string[] | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  // The lease list has no owner filter, so an owner's leases are those of their properties.
  useEffect(() => {
    if (!ownerId) return;
    let current = true;
    api()
      .register.listProperties({ ownerId })
      .then(
        (list) => {
          if (current) setProperties(list.rows.map((p) => p.id));
        },
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [ownerId]);

  useEffect(() => {
    if (ownerId && properties === null) return;
    let current = true;
    const text = query.trim() || undefined;
    // By POST (M11 decision 6, review): a name or phone never sits in a URL.
    const found = ownerId
      ? Promise.all(
          (properties ?? []).map((propertyId) => api().leases.search({ propertyId, search: text })),
        ).then((lists) => lists.flat())
      : api().leases.search({ search: text });
    found.then(
      (list) => {
        if (!current) return;
        setRows(
          uniqueLeases(list.filter((row) => isPayable(row.status)).map(pickedLeaseOf)).slice(0, 50),
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
  }, [query, ownerId, properties]);

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
