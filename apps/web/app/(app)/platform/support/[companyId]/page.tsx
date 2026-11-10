import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { SupportOverview } from './support-overview';

export const metadata: Metadata = { title: 'Support view' };

/** A company opened read-only under its grant (AD-10): each visit is audited in its chain. */
export default async function PlatformSupportCompanyPage({
  params,
}: {
  readonly params: Promise<{ readonly companyId: string }>;
}) {
  const [{ companyId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Support view',
    what: 'support access',
    needs: 'support.use',
  });
  if (refused) return refused;
  return <SupportOverview companyId={companyId} />;
}
