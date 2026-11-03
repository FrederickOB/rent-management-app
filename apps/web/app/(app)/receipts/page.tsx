import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { ReceiptsView } from './receipts-view';

export const metadata: Metadata = { title: 'Receipts' };

/** Every receipt issued (the numbering half of BC-06), with its PDF. */
export default async function ReceiptsPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'billing.view')) {
    return (
      <>
        <PageHeader title="Receipts" />
        <NoAccess what="receipts" />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Receipts"
        description="One receipt per payment, numbered in order with no gaps, issued as the payment posts. A reversal adds a credit receipt; the receipt itself stays."
      />
      <ReceiptsView />
    </>
  );
}
