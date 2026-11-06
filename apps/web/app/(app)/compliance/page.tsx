import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { ComplianceView } from './compliance-view';

export const metadata: Metadata = { title: 'Compliance list' };

/**
 * The compliance list (M9 decision 14; MVP screen inventory), on every plan: rent tax due and
 * overdue, Rent Control registrations, withholding certificates, VAT returns and advances over
 * the limit, read-only, each linked to the screen where it is dealt with.
 */
export default async function CompliancePage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Compliance list',
    what: 'the compliance list',
    needs: 'compliance.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Compliance list"
        description="What needs doing for tax and Rent Control, overdue first. Each item opens the screen where it is dealt with."
      />
      <ComplianceView />
    </>
  );
}
