import { INVOICE_STATUSES } from '@rent/domain/billing';
import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { InvoicesView, type InvoiceFilters } from './invoices-view';

export const metadata: Metadata = { title: 'Invoices' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (value: string | string[] | undefined) =>
  typeof value === 'string' && UUID.test(value) ? value : null;

/**
 * Invoices this person may see (BC-01; plan 4.19), by status, property, owner and due date.
 * A link from a lease, a tenant or the arrears screen opens it already filtered.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'billing.view')) {
    return (
      <>
        <PageHeader title="Invoices" />
        <NoAccess what="invoices" />
      </>
    );
  }
  const initial: InvoiceFilters = {
    leaseId: idParam(query.leaseId),
    tenantId: idParam(query.tenantId),
    propertyId: idParam(query.propertyId) ?? '',
    ownerId: idParam(query.ownerId) ?? '',
    status: INVOICE_STATUSES.find((s) => s === query.status) ?? '',
    overdue: query.overdue === 'true',
    dueFrom: '',
    dueTo: '',
  };
  return (
    <>
      <PageHeader
        title="Invoices"
        description="One invoice per billing cycle, issued ahead of its due date, and a deposit invoice at signing. Status and balances come from the payments allocated to each line."
      />
      <InvoicesView initial={initial} filterOwners={allowed(me, 'owner.view')} />
    </>
  );
}
