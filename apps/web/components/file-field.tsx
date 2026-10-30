'use client';

import { useId, type ReactNode, type Ref } from 'react';
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
  note,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly label: string;
  readonly rule: UploadRule;
  readonly disabled?: boolean;
  readonly error?: string | null;
  /** What the file must or must not contain, read with the field. */
  readonly note?: ReactNode;
}) {
  const id = useId();
  const noteId = note ? `${id}-note` : undefined;
  const errorId = error ? `${id}-error` : undefined;
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
        aria-describedby={[noteId, `${id}-hint`, errorId].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
      />
      {note ? (
        <p id={noteId} className="text-sm font-medium text-slate-800">
          {note}
        </p>
      ) : null}
      <p id={`${id}-hint`} className="text-sm text-slate-600">
        {fileTypesLabel(rule)}, up to {sizeLabel(rule.maxBytes)}.
      </p>
      {error ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
