import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { NoAccess } from '@/components/no-access';
import { getCompany, getMe, loadNotice } from '@/lib/server/session';
import { NoticeComposer } from '../../notice-composer';

export const metadata: Metadata = { title: 'Edit notice' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A draft's composer. An issued notice is never edited: it is corrected (plan 4.8). */
export default async function EditNoticePage({
  params,
}: {
  readonly params: Promise<{ readonly noticeId: string }>;
}) {
  const [{ noticeId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(noticeId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Edit notice',
    what: 'drafting notices',
    needs: 'notices.draft',
    feature: 'notices',
  });
  if (refused) return refused;
  const loaded = await loadNotice(noticeId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Edit notice" />
        <NoAccess what="this notice" />
      </>
    );
  }
  // Only a draft the API says may be edited opens here; anything else goes to its tracker.
  if (!loaded.data.actions.edit) redirect(`/notices/${noticeId}`);
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/notices" className="underline underline-offset-2">
          Notices
        </Link>{' '}
        <span aria-hidden="true">›</span>{' '}
        <Link href={`/notices/${noticeId}`} className="underline underline-offset-2">
          {loaded.data.typeLabel}
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Edit</span>
      </nav>
      <PageHeader
        title={`Edit the draft: ${loaded.data.typeLabel}`}
        description={
          loaded.data.corrects
            ? `This draft corrects ${loaded.data.corrects.number ?? 'an issued notice'}. Issuing it closes that one as superseded.`
            : undefined
        }
      />
      <NoticeComposer start={{ kind: 'edit', notice: loaded.data }} />
    </>
  );
}
