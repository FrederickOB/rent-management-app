import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { CompanyDetail } from './company-detail';

export const metadata: Metadata = { title: 'Company' };

/** A subscriber in the console (AD-10; M10 plan 4.8): its subscription, invoices, usage and support. */
export default async function PlatformCompanyPage({
  params,
}: {
  readonly params: Promise<{ readonly companyId: string }>;
}) {
  const [{ companyId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Company',
    what: 'the platform’s companies',
    needs: 'company.manage',
  });
  if (refused) return refused;
  return (
    <CompanyDetail
      companyId={companyId}
      can={{
        manage: allowed(me, 'company.manage'),
        discount: allowed(me, 'discount.manage') || allowed(me, 'company.manage'),
        support: allowed(me, 'support.use'),
      }}
    />
  );
}
