'use client';

import {
  AMENITIES,
  AMENITY_LABELS,
  UNIT_TYPE_LABELS,
  UNIT_TYPES,
  type UnitType,
} from '@rent/domain/portfolio';
import {
  batchErrors,
  MAX_BATCHES,
  newBatch,
  unitTotal,
  type BatchDraft,
} from '@/lib/property-wizard';
import { bedroomsRule } from '@/lib/register-format';
import { Button } from './ui/button';
import { CheckboxField, SelectField, TextField } from './ui/field';

const TYPE_OPTIONS = [
  { value: '', label: 'Choose a type' },
  ...UNIT_TYPES.map((t) => ({ value: t, label: UNIT_TYPE_LABELS[t] })),
];

export interface UnitBatchesProps {
  readonly batches: readonly BatchDraft[];
  readonly onChange: (batches: BatchDraft[]) => void;
  /** Show problems once the person has tried to go on. */
  readonly showErrors: boolean;
  /** The unit type a new group starts with. */
  readonly newType?: UnitType | '';
  /** Lets the last group go, for a block that starts empty. */
  readonly allowEmpty?: boolean;
}

/**
 * Units in bulk by type and count (PR-01, PR-02, PR-09): "6 single rooms, then 6 chamber and
 * hall". Each group is numbered after the previous one when the units are created.
 */
export function UnitBatches({
  batches,
  onChange,
  showErrors,
  newType = '',
  allowEmpty = false,
}: UnitBatchesProps) {
  const replace = (index: number, batch: BatchDraft) =>
    onChange(batches.map((b, i) => (i === index ? batch : b)));
  const total = unitTotal(batches);

  return (
    <div className="space-y-3">
      {batches.map((batch, index) => {
        const errors = showErrors ? batchErrors(batch) : {};
        const rule = batch.unitType ? bedroomsRule(batch.unitType) : 'none';
        return (
          <fieldset
            key={batch.key}
            className="space-y-3 rounded-md border border-slate-200 bg-white p-3"
          >
            <legend className="px-1 text-sm font-medium text-slate-800">Group {index + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)_8rem]">
              <TextField
                label="How many"
                inputMode="numeric"
                autoComplete="off"
                value={batch.count}
                error={errors.count}
                onChange={(event) =>
                  replace(index, { ...batch, count: event.target.value.replace(/\D/g, '') })
                }
              />
              <SelectField
                label="Unit type"
                value={batch.unitType}
                options={TYPE_OPTIONS}
                error={errors.unitType}
                onChange={(event) => {
                  const unitType = UNIT_TYPES.find((t) => t === event.target.value) ?? '';
                  const keepBedrooms = unitType && bedroomsRule(unitType) !== 'none';
                  replace(index, {
                    ...batch,
                    unitType,
                    bedrooms: keepBedrooms ? batch.bedrooms : '',
                  });
                }}
              />
              {rule !== 'none' ? (
                <TextField
                  label={rule === 'required' ? 'Bedrooms' : 'Bedrooms (optional)'}
                  inputMode="numeric"
                  autoComplete="off"
                  value={batch.bedrooms}
                  error={errors.bedrooms}
                  onChange={(event) =>
                    replace(index, { ...batch, bedrooms: event.target.value.replace(/\D/g, '') })
                  }
                />
              ) : null}
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer py-1 font-medium text-slate-700">
                Amenities (optional)
                {batch.amenities.length ? `: ${batch.amenities.length} chosen` : ''}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {AMENITIES.map((amenity) => (
                  <CheckboxField
                    key={amenity}
                    label={AMENITY_LABELS[amenity]}
                    checked={batch.amenities.includes(amenity)}
                    onChange={(event) =>
                      replace(index, {
                        ...batch,
                        amenities: event.target.checked
                          ? AMENITIES.filter((a) => a === amenity || batch.amenities.includes(a))
                          : batch.amenities.filter((a) => a !== amenity),
                      })
                    }
                  />
                ))}
              </div>
            </details>
            {batches.length > 1 || allowEmpty ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(batches.filter((_, i) => i !== index))}
              >
                Remove group {index + 1}
              </Button>
            ) : null}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {batches.length < MAX_BATCHES ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange([...batches, newBatch(newType)])}
          >
            {batches.length ? 'Add another group' : 'Add units'}
          </Button>
        ) : (
          <p className="text-sm text-slate-600">At most {MAX_BATCHES} groups at a time.</p>
        )}
        <p className="text-sm text-slate-700" aria-live="polite" data-testid="unit-total">
          {total === 1 ? '1 unit' : `${total} units`}
        </p>
      </div>
    </div>
  );
}
