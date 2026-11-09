import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { CompaniesView } from './companies-view';

export const metadata: Metadata = { title: 'Companies' };

/** The console's companies (AD-10; M10 plan 4.8): every subscriber, and onboarding a new one. */
export default async function PlatformCompaniesPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Companies',
    what: 'the platform’s companies',
    needs: ['company.manage', 'company.create'],
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Companies"
        description="Every subscriber with its plan, status, last month’s billable units and invoice, and what it owes. A new company starts on a free trial, and its first admin is invited by email."
      />
      <CompaniesView canCreate={allowed(me, 'company.create')} />
    </>
  );
}
