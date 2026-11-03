'use client';

import type { Ref } from 'react';
import { NO_ID_COPY_NOTE, NO_ID_COPY_TICK } from '@/lib/lease-upload';
import { LEASE_PAPER_UPLOAD } from '@/lib/upload';
import { FileField } from './file-field';
import { CheckboxField } from './ui/field';

/**
 * A lease paper to upload (decision 7, OQ-44, OQ-45): the file, the reminder that it must not
 * carry a copy of an ID card or passport (CLAUDE.md section 10), and the tick that confirms it.
 * The form checks the tick with `leasePaperProblems` before anything is sent.
 */
export function LeasePaperField({
  ref,
  label,
  disabled,
  error,
  noIdCopy,
  onNoIdCopy,
  tickError,
  required = false,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly label: string;
  readonly disabled?: boolean;
  readonly error?: string | null;
  readonly noIdCopy: boolean;
  readonly onNoIdCopy: (checked: boolean) => void;
  readonly tickError?: string | null;
  /** The file, and so the tick, is needed before the form is sent. */
  readonly required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <FileField
        ref={ref}
        label={label}
        rule={LEASE_PAPER_UPLOAD}
        disabled={disabled}
        error={error}
        note={NO_ID_COPY_NOTE}
      />
      <CheckboxField
        label={NO_ID_COPY_TICK}
        checked={noIdCopy}
        disabled={disabled}
        required={required}
        error={tickError}
        onChange={(event) => onNoIdCopy(event.target.checked)}
      />
    </div>
  );
}
