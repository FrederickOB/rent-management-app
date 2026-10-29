import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A table that scrolls sideways on narrow screens instead of squeezing its columns. The wrapper
 * is positioned so screen-reader-only text inside cannot escape it and widen the page.
 */
export function Table({
  className,
  caption,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { readonly caption?: string }) {
  return (
    <div className="relative overflow-x-auto">
      <table
        className={cn('min-w-full divide-y divide-slate-200 text-left text-sm', className)}
        {...rest}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn('px-3 py-2 font-semibold whitespace-nowrap text-slate-700', className)}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-3 align-top text-slate-800', className)} {...rest} />;
}
