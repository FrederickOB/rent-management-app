import { cn } from '@/lib/cn';
import { barParts, bpsText } from '@/lib/reporting';

// Plain bars drawn with flex weights (M9 decision 12: no chart library). The browser shares the
// width out between the parts, so nothing is divided here, and every bar has its figure in text
// beside it: the bar is never the only way to read it.

/** A share out of the whole, from basis points; "—" with no bar when there is nothing to show. */
export function ShareBar({
  bps,
  label,
  tone = 'brand',
}: {
  readonly bps: number | null;
  /** The accessible name: what the share is of. */
  readonly label: string;
  readonly tone?: 'brand' | 'amber' | 'red';
}) {
  const parts = barParts(bps);
  return (
    <div
      role="img"
      aria-label={`${label}: ${bpsText(bps)}`}
      className="flex h-3 w-full overflow-hidden rounded-full border border-slate-300 bg-slate-100"
      data-testid="share-bar"
    >
      {parts ? (
        <>
          <span
            className={cn(
              'block h-full',
              tone === 'brand' ? 'bg-brand' : tone === 'amber' ? 'bg-amber-500' : 'bg-red-600',
            )}
            style={{ flexGrow: parts.filled, flexBasis: 0 }}
          />
          <span className="block h-full" style={{ flexGrow: parts.empty, flexBasis: 0 }} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Amounts side by side (arrears by age): each part's width follows its amount, and its label and
 * figure are listed below the bar.
 */
export function StackBar({
  parts,
  label,
}: {
  readonly parts: readonly {
    readonly key: string;
    readonly amount: number;
    readonly className: string;
  }[];
  readonly label: string;
}) {
  const shown = parts.filter((p) => p.amount > 0);
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-3 w-full overflow-hidden rounded-full border border-slate-300 bg-slate-100"
      data-testid="stack-bar"
    >
      {shown.map((p) => (
        <span
          key={p.key}
          className={cn('block h-full', p.className)}
          style={{ flexGrow: p.amount, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}
