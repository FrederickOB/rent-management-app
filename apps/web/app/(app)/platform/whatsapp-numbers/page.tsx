import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { NumbersView } from './numbers-view';

export const metadata: Metadata = { title: 'WhatsApp numbers' };

/**
 * The shared platform number and the numbers companies send from (M6 decision 3). A company's own
 * number has its WhatsApp account shared with the platform's business, so one token serves all.
 */
export default async function WhatsAppNumbersPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'WhatsApp numbers',
    what: 'WhatsApp numbers',
    needs: 'whatsapp_account.manage',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="WhatsApp numbers"
        description="Messages go from a company’s own number when it has one, and otherwise from the shared number. Retiring a number stops sending from it; its history stays."
      />
      <NumbersView />
    </>
  );
}
