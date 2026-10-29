'use client';

import { useId, type Ref } from 'react';
import { acceptFor, fileTypesLabel, sizeLabel, type UploadRule } from '@/lib/upload';

/**
 * A file picker with its label and the limits it takes. The parent reads the file from the input
 * itself when the form is sent, so a choice made before the page finished loading still counts.
 */
export function FileField({
  ref,
  label,
  rule,
  disabled,
  error,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly label: string;
  readonly rule: UploadRule;
  readonly disabled?: boolean;
  readonly error?: string | null;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        type="file"
        accept={acceptFor(rule)}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        aria-invalid={error ? true : undefined}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
      />
      <p id={`${id}-hint`} className="text-sm text-slate-600">
        {fileTypesLabel(rule)}, up to {sizeLabel(rule.maxBytes)}.
      </p>
      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
    </div>
  );
}
