import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'dark';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-slate-300 bg-white text-slate-800',
  green: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  blue: 'border-sky-300 bg-sky-50 text-sky-900',
  amber: 'border-amber-300 bg-amber-50 text-amber-900',
  red: 'border-red-300 bg-red-50 text-red-900',
  dark: 'border-slate-500 bg-slate-100 text-slate-900',
};

/** A short label with a border, so it reads the same without colour. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
