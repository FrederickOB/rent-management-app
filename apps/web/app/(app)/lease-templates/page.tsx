import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadTemplates } from '@/lib/server/session';
import { TemplatesList } from './templates-list';

export const metadata: Metadata = { title: 'Lease templates' };

/** Lease templates (TL-05): versioned clauses, the starters, and the counsel review of each. */
export default async function LeaseTemplatesPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'lease.view_terms')) {
    return (
      <>
        <PageHeader title="Lease templates" />
        <NoAccess what="lease templates" />
      </>
    );
  }
  const templates = await loadTemplates();
  return (
    <>
      <PageHeader
        title="Lease templates"
        description="The clauses your leases are built from. Each published version is kept as it was, and a lease keeps the version it was built from."
      />
      {templates.ok ? (
        <TemplatesList initial={templates.data} canManage={allowed(me, 'lease_template.manage')} />
      ) : (
        <NoAccess what="lease templates" />
      )}
    </>
  );
}
