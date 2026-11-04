import { NOTICE_TYPES, type NoticeType } from '@rent/domain/notices';
import type { Metadata } from 'next';
import Link from 'next/link';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { pickedLeaseOf } from '@/lib/lease-pick';
import { getCompany, getMe, loadLease } from '@/lib/server/session';
import { NoticeComposer } from '../notice-composer';

export const metadata: Metadata = { title: 'New notice' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

/** A new notice (LN-01): `?type=`, `?leaseId=` and `?propertyId=` start it. */
export default async function NewNoticePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'New notice',
    what: 'drafting notices',
    needs: 'notices.draft',
    feature: 'notices',
  });
  if (refused) return refused;
  const typeParam = one(query.type);
  const type =
    typeParam && (NOTICE_TYPES as readonly string[]).includes(typeParam)
      ? (typeParam as NoticeType)
      : null;
  const leaseId = one(query.leaseId);
  const propertyId = one(query.propertyId);
  const lease = leaseId && UUID.test(leaseId) ? await loadLease(leaseId) : null;
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/notices" className="underline underline-offset-2">
          Notices
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>New notice</span>
      </nav>
      <PageHeader
        title="New notice"
        description="Choose the type and the lease. The checks on the right update as you type; nothing is sent until the notice is issued."
      />
      <NoticeComposer
        start={{
          kind: 'new',
          type,
          lease: lease?.ok ? pickedLeaseOf(lease.data) : null,
          propertyId: propertyId && UUID.test(propertyId) ? propertyId : null,
        }}
      />
    </>
  );
}
