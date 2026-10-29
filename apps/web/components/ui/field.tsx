'use client';

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

export const controlClass =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-sm placeholder:text-slate-400 disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-red-600 sm:text-sm';

interface ControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly className?: string;
  readonly children: (control: ControlProps) => ReactNode;
}

/** A label, the control, a hint and an error, wired together for assistive technology. */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> &
  Omit<FieldProps, 'children'>;

export function TextField({ label, hint, error, className, ...input }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(control) => <input {...control} {...input} className={controlClass} />}
    </Field>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> &
  Omit<FieldProps, 'children'>;

export function TextAreaField({ label, hint, error, className, ...textarea }: TextAreaFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(control) => (
        <textarea {...control} {...textarea} className={cn(controlClass, 'font-mono')} />
      )}
    </Field>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> &
  Omit<FieldProps, 'children'> & {
    readonly options: readonly { readonly value: string; readonly label: string }[];
  };

export function SelectField({
  label,
  hint,
  error,
  className,
  options,
  ...select
}: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(control) => (
        <select {...control} {...select} className={controlClass}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> & {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
};

export function CheckboxField({ label, hint, className, ...input }: CheckboxFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={hintId}
        className="mt-0.5 size-5 shrink-0 rounded border-slate-400"
        {...input}
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-slate-800">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-sm text-slate-600">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
