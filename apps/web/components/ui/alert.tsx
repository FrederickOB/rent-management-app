import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-900',
};

export interface AlertProps {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  /**
   * False for a second copy of a message already announced elsewhere on the page, such as a
   * refusal repeated next to a form's button: it is shown, not announced twice.
   */
  readonly live?: boolean;
}

/** Errors interrupt screen readers (`role="alert"`); everything else is announced politely. */
export function Alert({ tone = 'info', title, children, className, live = true }: AlertProps) {
  return (
    <div
      role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}
      className={cn('rounded-md border px-4 py-3 text-sm', TONES[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-1' : undefined}>{children}</div> : null}
    </div>
  );
}
