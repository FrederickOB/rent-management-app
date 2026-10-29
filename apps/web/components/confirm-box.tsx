'use client';

import type { ReactNode } from 'react';
import { Button } from './ui/button';

/** An inline "are you sure" for actions that cannot be undone from the screen (archiving). */
export function ConfirmBox({
  label,
  children,
  confirmText,
  pending = false,
  onConfirm,
  onCancel,
}: {
  /** Names the group for assistive technology, for example "Confirm archiving ACC-LEG". */
  readonly label: string;
  readonly children: ReactNode;
  readonly confirmText: string;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4"
    >
      <div className="text-sm text-red-900">{children}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" size="sm" pending={pending} onClick={onConfirm}>
          {confirmText}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Keep
        </Button>
      </div>
    </div>
  );
}
