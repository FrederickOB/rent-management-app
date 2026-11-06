'use client';

import type { CompanyProfile, Me } from '@rent/contracts';
import { DEFAULT_TIME_ZONE } from '@rent/domain/dates';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { isHexColour, textOn } from '@/lib/colour';
import { initials } from '@/lib/format';
import { activeNavHref } from '@/lib/nav-match';
import { companyFeatures } from '@/lib/plan';
import { AppProvider } from './app-context';
import { navFor } from './nav';
import { SignOutButton } from './sign-out-button';

const PLATFORM_PRIMARY = '#0F766E';
const PLATFORM_ACCENT = '#F59E0B';

type BrandStyle = CSSProperties & Record<`--${string}`, string>;

function brandStyle(company: CompanyProfile | null): BrandStyle {
  const primary =
    company && isHexColour(company.branding.primaryColour)
      ? company.branding.primaryColour
      : PLATFORM_PRIMARY;
  const accent =
    company && isHexColour(company.branding.accentColour)
      ? company.branding.accentColour
      : PLATFORM_ACCENT;
  return {
    '--brand-primary': primary,
    '--brand-on-primary': textOn(primary),
    '--brand-accent': accent,
    '--brand-on-accent': textOn(accent),
  };
}

export interface AppShellProps {
  readonly me: Me;
  readonly company: CompanyProfile | null;
  readonly children: ReactNode;
}

/** The signed-in frame (AD-01): the active company's logo, name and colours, and the person. */
export function AppShell({ me, company, children }: AppShellProps) {
  const pathname = usePathname();
  const items = navFor(me, companyFeatures(company));
  const activeHref = activeNavHref(
    pathname,
    items.map((item) => item.href),
  );
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const companyName = company?.displayName ?? membership?.companyName ?? null;
  const context = useMemo(
    () => ({ me, company, timeZone: company?.timeZone ?? DEFAULT_TIME_ZONE }),
    [me, company],
  );

  return (
    <AppProvider value={context}>
      <div className="flex min-h-screen flex-col" style={brandStyle(company)}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header data-testid="app-header" className="bg-brand text-brand-contrast">
          {/* On a phone the company takes the first row and the person the second. */}
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-auto">
              {company?.branding.logoUrl ? (
                // A short-lived signed link from the API, so a plain img: next/image would cache it past its expiry.
                <img
                  src={company.branding.logoUrl}
                  alt=""
                  className="size-11 shrink-0 rounded-md bg-white object-contain p-1"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="bg-brand-accent text-brand-accent-contrast flex size-11 shrink-0 items-center justify-center rounded-md text-base font-bold"
                >
                  {initials(companyName ?? 'Rent Platform') || 'RP'}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-base font-semibold" data-testid="shell-company-name">
                  {companyName ?? 'No company'}
                </p>
                {company ? (
                  <p className="truncate text-sm opacity-90" data-testid="shell-sender-name">
                    Sender name: {company.branding.senderName}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
              <p className="max-w-48 truncate text-sm" data-testid="shell-person">
                {me.name}
              </p>
              {me.memberships.length > 1 ? (
                <Link href="/choose-company" className="text-sm underline underline-offset-2">
                  Switch company
                </Link>
              ) : null}
              <SignOutButton />
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:flex-row">
          <nav aria-label="Main" className="md:w-56 md:shrink-0">
            {/* Wraps on a phone rather than scrolling, so no section hides off screen. */}
            <ul className="flex flex-wrap gap-1 md:flex-col">
              {items.map((item) => {
                const current = item.href === activeHref;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'block rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap',
                        current
                          ? 'bg-brand text-brand-contrast'
                          : 'text-slate-700 hover:bg-slate-200',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <main id="main" className="min-w-0 flex-1 space-y-6">
            {children}
          </main>
        </div>
      </div>
    </AppProvider>
  );
}
