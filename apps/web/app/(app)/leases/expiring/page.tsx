import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { promptWindowDays } from '@/lib/paid-until-prompt';
import { ExpiringView } from './expiring-view';
import { PaidUntilEnding } from './paid-until-ending';

export const metadata: Metadata = { title: 'Leases ending soon' };

const WINDOWS = [30, 60, 90, 180] as const;

/** Leases ending soon (TL-09): the list behind the home page's card, with renewals. */
export default async function ExpiringPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query, company] = await Promise.all([getMe(), searchParams, getCompany()]);
  if (!me || !allowed(me, 'lease.view')) {
    return (
      <>
        <PageHeader title="Leases ending soon" />
        <NoAccess what="leases" />
      </>
    );
  }
  const asked = Number(typeof query.days === 'string' ? query.days : '90');
  const days = WINDOWS.find((w) => w === asked) ?? 90;
  const reminders = company?.settings.renewalReminderDays ?? [];
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/leases" className="underline underline-offset-2">
          Leases
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Ending soon</span>
      </nav>
      <PageHeader
        title="Leases ending soon"
        description={`Active leases that end within the window, with their renewals.${reminders.length ? ` Your company is reminded ${reminders.join(', ')} days before a lease ends.` : ''}`}
      />
      <ExpiringView initialDays={days} windows={WINDOWS} canRenew={allowed(me, 'lease.manage')} />
      {/* AR-06 (M5 decision 5): leases paid until a date within the prompt's window. */}
      {allowed(me, 'billing.view') ? (
        <PaidUntilEnding windowDays={promptWindowDays(company?.settings)} />
      ) : null}
    </>
  );
}
