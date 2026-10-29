import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadTemplate } from '@/lib/server/session';
import { TemplateEditor } from './template-editor-view';

type Params = Promise<{ readonly templateId: string }>;

const template = cache((templateId: string) => loadTemplate(templateId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const loaded = await template((await params).templateId);
  return { title: loaded.ok ? loaded.data.name : 'Lease template' };
}

/** One template (TL-05): its clauses, its versions, and the counsel review of each version. */
export default async function LeaseTemplatePage({ params }: { readonly params: Params }) {
  const [{ templateId }, me] = await Promise.all([params, getMe()]);
  if (!me) return null;
  if (!allowed(me, 'lease.view_terms')) {
    return (
      <>
        <PageHeader title="Lease template" />
        <NoAccess what="lease templates" />
      </>
    );
  }
  const loaded = await template(templateId);
  if (!loaded.ok) notFound();
  return <TemplateEditor initial={loaded.data} canManage={allowed(me, 'lease_template.manage')} />;
}
