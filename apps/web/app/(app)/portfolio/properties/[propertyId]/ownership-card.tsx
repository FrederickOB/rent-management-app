'use client';

import type { OwnerRow, PropertyDetailView } from '@rent/contracts';
import { useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { earliestOwnerChange, formatBusinessDate, notBefore, todayIn } from '@/lib/business-dates';
import { shareLabel } from '@/lib/register-format';

/**
 * Who owns the property, and since when (AD-02; PR-07 ready). A change adds rows from a date;
 * the earlier rows stay as history.
 */
export function OwnershipCard({
  property,
  owners,
  canChange,
  onChanged,
}: {
  readonly property: PropertyDetailView;
  readonly owners: readonly OwnerRow[];
  readonly canChange: boolean;
  readonly onChanged: (next: PropertyDetailView, message: string) => void;
}) {
  const { timeZone } = useApp();
  const [open, setOpen] = useState(false);
  const today = todayIn(timeZone);
  const earliest = earliestOwnerChange(
    property.ownership.map((o) => o.effectiveFrom),
    today,
  );
  const currentIds = new Set(property.ownership.filter((o) => o.current).map((o) => o.ownerId));
  const choices = owners.filter((o) => !currentIds.has(o.id));
  const [ownerId, setOwnerId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(earliest);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!ownerId) {
      setError('Choose the new owner.');
      return;
    }
    if (!notBefore(effectiveFrom, earliest)) {
      setError(`Choose a date on or after ${formatBusinessDate(earliest)}.`);
      return;
    }
    setPending(true);
    try {
      const next = await api().register.changeOwner({
        propertyId: property.id,
        ownerId,
        effectiveFrom,
      });
      const name = owners.find((o) => o.id === ownerId)?.displayName ?? 'The new owner';
      setOpen(false);
      setOwnerId('');
      onChanged(next, `${name} owns this property from ${formatBusinessDate(effectiveFrom)}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Ownership"
        description="Owner changes take effect from a date; the history is kept."
        actions={
          canChange && !open ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEffectiveFrom(earliest);
                setOpen(true);
              }}
            >
              Change owner
            </Button>
          ) : null
        }
      />
      <CardBody>
        {open ? (
          <form
            onSubmit={submit}
            noValidate
            aria-label="Change owner"
            className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
          >
            {error ? <Alert tone="error">{error}</Alert> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="New owner"
                value={ownerId}
                options={[
                  { value: '', label: choices.length ? 'Choose the owner' : 'No other owners yet' },
                  ...choices.map((o) => ({
                    value: o.id,
                    label: `${o.displayName} (${o.reference})`,
                  })),
                ]}
                onChange={(event) => setOwnerId(event.target.value)}
              />
              <TextField
                label="Owner from"
                type="date"
                min={earliest}
                hint={`On or after ${formatBusinessDate(earliest)}.`}
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={pending}>
                Change owner
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        <ul className="divide-y divide-slate-100 text-sm" aria-label="Ownership history">
          {property.ownership.map((row) => (
            <li
              key={`${row.ownerId}-${row.effectiveFrom}`}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <span className="min-w-0">
                <span className="font-medium">{row.displayName}</span>{' '}
                <span className="text-slate-600">({row.reference})</span>{' '}
                {row.current ? <Badge tone="green">Current</Badge> : null}
                {notBefore(today, row.effectiveFrom) ? null : <Badge tone="blue">Upcoming</Badge>}
              </span>
              <span className="text-slate-700">
                {shareLabel(row.shareBps)} from {formatBusinessDate(row.effectiveFrom)}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
