'use client';

import { useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-contrast enabled:hover:opacity-90 border border-transparent',
  secondary: 'bg-white text-slate-900 border border-slate-300 enabled:hover:bg-slate-100',
  danger: 'bg-red-700 text-white border border-transparent enabled:hover:bg-red-800',
  ghost: 'bg-transparent text-slate-700 border border-transparent enabled:hover:bg-slate-100',
};

const SIZES: Record<Size, string> = {
  md: 'min-h-11 px-4 py-2 text-sm',
  sm: 'min-h-9 px-3 py-1.5 text-sm',
};

const noSubscription = () => () => {};

/** False in the server-rendered HTML and while hydrating; true once React runs in the browser. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly size?: Size;
  /** Disables the button and tells assistive technology that work is in progress. */
  readonly pending?: boolean;
}

/**
 * Buttons default to `type="button"`, so only an explicit submit button submits a form.
 *
 * Every button stays disabled until React has hydrated. Before that a click does nothing,
 * except on a submit button, where the browser would submit the form itself as a GET and put
 * its fields (a password, an email address) in the URL and the server's request log. While
 * waiting, buttons look normal; only a real `disabled` or `pending` dims them.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  pending = false,
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const hydrated = useHydrated();
  const off = Boolean(disabled) || pending;
  return (
    <button
      type={type}
      disabled={off || !hydrated}
      aria-busy={pending || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition',
        off && 'cursor-not-allowed opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
