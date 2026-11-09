'use client';

import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { ConsoleTab } from '@/lib/platform-console';

/**
 * Tabs for a page with several parts (the console's billing page, a company's detail). The
 * chosen tab is the caller's state; arrow keys move between tabs, as assistive technology expects.
 */
export function Tabs({
  label,
  tabs,
  current,
  onChange,
  children,
}: {
  readonly label: string;
  readonly tabs: readonly ConsoleTab[];
  readonly current: string;
  readonly onChange: (key: string) => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === current),
  );

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length]!;
    onChange(next.key);
    document.getElementById(`${id}-${next.key}`)?.focus();
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={label}
        className="flex flex-wrap gap-1 border-b border-slate-200"
      >
        {tabs.map((tab) => {
          const selected = tab.key === tabs[index]?.key;
          return (
            <button
              key={tab.key}
              id={`${id}-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={onKeyDown}
              className={cn(
                '-mb-px min-h-11 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium',
                selected
                  ? 'border-brand text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={tabs[index] ? `${id}-${tabs[index].key}` : undefined}
      >
        {children}
      </div>
    </div>
  );
}
