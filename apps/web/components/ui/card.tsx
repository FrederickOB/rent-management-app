import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('rounded-lg border border-slate-200 bg-white shadow-sm', className)}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** Heading level inside the page; cards under a page title are h2. */
  readonly level?: 2 | 3;
}

export function CardHeader({ title, description, actions, level = 2 }: CardHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-6">
      <div className="min-w-0 space-y-1">
        <Heading className="text-base font-semibold text-slate-900">{title}</Heading>
        {description ? <div className="text-sm text-slate-600">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-4 px-4 py-4 sm:px-6', className)} {...rest} />;
}
