import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { filtersFromQuery } from '@/lib/portfolio-filters';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { PortfolioView } from './portfolio-view';

export const metadata: Metadata = { title: 'Portfolio' };

const buttonLink =
  'inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-medium';

/** Every unit and property this person may see, across owners (PRD section 5; M2 plan 4.11). */
export default async function PortfolioPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'register.view')) {
    return (
      <>
        <PageHeader title="Portfolio" />
        <NoAccess what="the property register" />
      </>
    );
  }
  const { tab, filters } = filtersFromQuery(query);
  const canManage = allowed(me, 'register.manage');
  const canImport = allowed(me, 'register.import');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Portfolio"
          description="Every unit and property you can see, with their status. The list refreshes every 30 seconds."
        />
        {canManage || canImport ? (
          <div className="flex flex-wrap gap-2">
            {canImport ? (
              <Link
                href="/portfolio/import"
                className={`${buttonLink} border border-slate-300 bg-white text-slate-900 hover:bg-slate-100`}
              >
                Import from a spreadsheet
              </Link>
            ) : null}
            {canManage ? (
              <Link
                href="/portfolio/new"
                className={`${buttonLink} bg-brand text-brand-contrast hover:opacity-90`}
              >
                New property
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      <PortfolioView initialTab={tab} initialFilters={filters} />
    </>
  );
}
