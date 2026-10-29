'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { toProblem } from '@/lib/errors';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { TextAreaField } from './ui/field';

/**
 * A small form that asks why before doing something that is kept in the record: revealing an ID
 * number, cancelling a lease, asking for an approval. `onSubmit` throws to show the API's message.
 */
export function ReasonForm({
  label,
  intro,
  reasonLabel = 'Reason',
  hint,
  minLength,
  maxLength = 500,
  submitText,
  danger = false,
  onSubmit,
  onCancel,
}: {
  /** Names the form for assistive technology, such as "Reveal the ID number". */
  readonly label: string;
  readonly intro?: ReactNode;
  readonly reasonLabel?: string;
  readonly hint?: string;
  readonly minLength: number;
  /** The API's upper limit for this reason. */
  readonly maxLength?: number;
  readonly submitText: string;
  readonly danger?: boolean;
  readonly onSubmit: (reason: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = reason.trim().length < minLength;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (short) return;
    setPending(true);
    try {
      await onSubmit(reason.trim());
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={label}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {intro ? <div className="text-sm text-slate-700">{intro}</div> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextAreaField
        label={reasonLabel}
        hint={hint ?? `At least ${minLength} characters. It is kept with the record.`}
        rows={2}
        maxLength={maxLength}
        value={reason}
        error={tried && short ? `Give a reason of at least ${minLength} characters.` : undefined}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={danger ? 'danger' : 'primary'} pending={pending}>
          {submitText}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
