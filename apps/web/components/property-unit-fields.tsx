'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { SelectField } from './ui/field';

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * A property, then one of its units or none (a common area), among those this person may see
 * (AD-02). Used to log a repair and record an expense; the API checks the scope again.
 */
export function PropertyUnitFields({
  propertyId,
  unitId,
  onChange,
  errors,
  disabled,
  noUnitLabel = 'None: a common area',
  unitLabel = 'Unit (optional)',
}: {
  readonly propertyId: string;
  readonly unitId: string;
  readonly onChange: (next: { propertyId: string; unitId: string }) => void;
  readonly errors?: { readonly propertyId?: string; readonly unitId?: string };
  readonly disabled?: boolean;
  readonly noUnitLabel?: string;
  readonly unitLabel?: string;
}) {
  const [properties, setProperties] = useState<readonly Option[] | null>(null);
  const [units, setUnits] = useState<readonly Option[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api()
      .register.listProperties({})
      .then(
        (result) => {
          if (current)
            setProperties(
              result.rows.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })),
            );
        },
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!propertyId) return undefined;
    let current = true;
    api()
      .register.listUnits({ propertyId, limit: 500 })
      .then(
        (result) => {
          if (current)
            setUnits(result.rows.map((u) => ({ value: u.id, label: `${u.code} · ${u.label}` })));
        },
        () => {
          if (current) setUnits([]);
        },
      );
    return () => {
      current = false;
    };
  }, [propertyId]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SelectField
        label="Property"
        value={propertyId}
        disabled={disabled}
        error={problem ?? errors?.propertyId}
        options={[
          {
            value: '',
            label: properties === null ? 'Loading the properties…' : 'Choose the property',
          },
          ...(properties ?? []),
        ]}
        onChange={(event) => onChange({ propertyId: event.target.value, unitId: '' })}
      />
      <SelectField
        label={unitLabel}
        value={unitId}
        disabled={disabled || !propertyId}
        error={errors?.unitId}
        options={[{ value: '', label: noUnitLabel }, ...(propertyId ? units : [])]}
        onChange={(event) => onChange({ propertyId, unitId: event.target.value })}
      />
    </div>
  );
}
