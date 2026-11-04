'use client';

import type { ReactNode } from 'react';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

/** Shown while a section's data is on its way. */
export function Loading({ what }: { readonly what: string }) {
  return (
    <p role="status" className="text-sm text-slate-600">
      Loading {what}…
    </p>
  );
}

/** A section that could not load, with a way to try again. */
export function LoadFailed({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="space-y-2">
      <Alert tone="error">{message}</Alert>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Nothing to show yet: said plainly, so an empty table never looks like a failure. */
export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-slate-600">{children}</p>;
}
