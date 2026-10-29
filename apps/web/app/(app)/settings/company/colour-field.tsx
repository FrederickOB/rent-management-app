'use client';

import { controlClass, Field } from '@/components/ui/field';
import { isHexColour } from '@/lib/colour';

export interface ColourFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}

/** A hex colour as text, with the browser's colour picker beside it for people who prefer one. */
export function ColourField({ label, hint, value, error, disabled, onChange }: ColourFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <div className="flex items-center gap-2">
          <input
            {...control}
            type="text"
            inputMode="text"
            spellCheck={false}
            autoCapitalize="characters"
            maxLength={7}
            pattern="#[0-9a-fA-F]{6}"
            required
            disabled={disabled}
            value={value}
            onChange={(event) => onChange(event.target.value.trim())}
            className={`${controlClass} max-w-36 font-mono`}
          />
          <input
            type="color"
            aria-label={`Pick the ${label.toLowerCase()}`}
            disabled={disabled}
            value={isHexColour(value) ? value.toLowerCase() : '#000000'}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="h-10 w-14 cursor-pointer rounded-md border border-slate-300 bg-white p-1 disabled:cursor-not-allowed"
          />
        </div>
      )}
    </Field>
  );
}
