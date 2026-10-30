'use client';

import { useId, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { controlClass } from './ui/field';

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface MultiSelectProps {
  readonly legend: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly options: readonly MultiSelectOption[];
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  /** With 1, a choice of one (radio buttons with "None"); otherwise any number. */
  readonly max?: number;
  readonly noneLabel?: string;
  readonly emptyText?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

const FILTER_FROM = 8;

/**
 * A list of checkboxes with a filter for long lists: works with a keyboard, a screen reader and
 * a thumb on a small screen. Chosen values that are no longer offered (an archived property, say)
 * stay listed, so saving never drops them without the person seeing it.
 */
export function MultiSelect({
  legend,
  hint,
  error,
  options,
  value,
  onChange,
  max,
  noneLabel = 'None',
  emptyText = 'Nothing to choose from yet.',
  disabled = false,
  className,
}: MultiSelectProps) {
  const id = useId();
  const [filter, setFilter] = useState('');
  const single = max === 1;
  const all = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    const missing = value
      .filter((v) => !known.has(v))
      .map((v) => ({ value: v, label: `Not in the list (${v.slice(0, 8)}…)`, hint: undefined }));
    return [...options, ...missing];
  }, [options, value]);
  const wanted = filter.trim().toLowerCase();
  const visible = wanted
    ? all.filter((o) => o.label.toLowerCase().includes(wanted) || value.includes(o.value))
    : all;
  const chosen = new Set(value);
  const atMax = !single && max !== undefined && value.length >= max;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  function toggle(option: string, on: boolean) {
    if (single) {
      onChange(on ? [option] : []);
      return;
    }
    onChange(on ? [...value, option] : value.filter((v) => v !== option));
  }

  return (
    <fieldset
      className={cn('space-y-2', className)}
      aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      disabled={disabled}
    >
      <legend className="text-sm font-medium text-slate-800">{legend}</legend>
      {hint ? (
        <p id={hintId} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
      {all.length > FILTER_FROM ? (
        <input
          type="search"
          aria-label={`Filter: ${legend}`}
          placeholder="Type to filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={controlClass}
        />
      ) : null}
      {all.length === 0 ? (
        <p className="text-sm text-slate-600">{emptyText}</p>
      ) : (
        <ul
          className={cn(
            'max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-md border bg-white',
            error ? 'border-red-600' : 'border-slate-300',
          )}
        >
          {single ? (
            <li>
              <label className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="radio"
                  name={id}
                  className="size-5 shrink-0"
                  checked={value.length === 0}
                  onChange={() => onChange([])}
                />
                <span>{noneLabel}</span>
              </label>
            </li>
          ) : null}
          {visible.map((option) => {
            const checked = chosen.has(option.value);
            return (
              <li key={option.value}>
                <label className="flex min-h-11 items-start gap-3 px-3 py-2 text-sm">
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    name={single ? id : undefined}
                    className="mt-0.5 size-5 shrink-0"
                    checked={checked}
                    disabled={!checked && atMax}
                    onChange={(event) => toggle(option.value, event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block break-words">{option.label}</span>
                    {option.hint ? (
                      <span className="block text-slate-600">{option.hint}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {single ? null : (
        <p className="text-sm text-slate-600" aria-live="polite">
          {value.length === 0 ? 'None chosen' : `${value.length} chosen`}
        </p>
      )}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
