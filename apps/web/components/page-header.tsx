import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {description ? <p className="text-sm text-slate-600">{description}</p> : null}
    </div>
  );
}
