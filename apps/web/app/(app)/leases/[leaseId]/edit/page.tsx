import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { signerRecordsOf } from '@/lib/lease-form';
import { allowed } from '@/lib/policy';
import { getMe, loadLease, loadMemberships, loadTemplates, loadTenant } from '@/lib/server/session';
import { LeaseBuilder } from '../../lease-builder';

export const metadata: Metadata = { title: 'Edit the draft' };

type Params = Promise<{ readonly leaseId: string }>;

/**
 * The draft editor (TL-06): terms, template, signers and electronic-service contacts. Signers can
 * be linked to the tenant, the tenant's contacts or the company's staff, whose records give their
 * phone and email when the lease is sent (plan 4.8); whatever cannot be read is left to the API.
 */
export default async function EditLeasePage({ params }: { readonly params: Params }) {
  const [{ leaseId }, me] = await Promise.all([params, getMe()]);
  if (!me) return null;
  if (!allowed(me, 'lease.manage')) {
    return (
      <>
        <PageHeader title="Edit the draft" />
        <NoAccess what="drafting leases" />
      </>
    );
  }
  const [loaded, templates] = await Promise.all([loadLease(leaseId), loadTemplates()]);
  if (!loaded.ok || loaded.data.access !== 'full') notFound();
  const lease = loaded.data;
  if (lease.status !== 'draft') {
    return (
      <>
        <PageHeader title="Edit the draft" />
        <p className="text-sm text-slate-700">
          This lease is no longer a draft, so its terms cannot change.{' '}
          <Link href={`/leases/${lease.id}`} className="font-medium underline underline-offset-2">
            Back to the lease
          </Link>
        </p>
      </>
    );
  }
  const [tenant, people] = await Promise.all([
    loadTenant(lease.tenant.id),
    allowed(me, 'membership.view') ? loadMemberships() : null,
  ]);
  const records = signerRecordsOf(
    tenant.ok && tenant.data.access === 'full' ? tenant.data : null,
    people?.ok ? people.data : null,
  );
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/leases" className="underline underline-offset-2">
          Leases
        </Link>{' '}
        <span aria-hidden="true">›</span>{' '}
        <Link href={`/leases/${lease.id}`} className="font-mono underline underline-offset-2">
          {lease.unit.code}
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Edit</span>
      </nav>
      <PageHeader
        title={`Edit the draft for ${lease.unit.code}`}
        description={`${lease.unit.propertyName} · ${lease.tenant.displayName}. The unit and the tenant stay as they are.`}
      />
      <LeaseBuilder
        lease={lease}
        templates={templates.ok ? templates.data : []}
        records={records}
      />
    </>
  );
}
