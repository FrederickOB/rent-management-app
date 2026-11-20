import type { Metadata } from 'next';
import { DataProtectionRequests } from '@/components/data-protection-requests';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Data protection' };

/**
 * Settings, Data protection (M11 decision 5; Act 843): every tenant's requests, for company
 * admins (`data_protection.manage`). The API refuses everyone else again.
 */
export default async function DataProtectionPage() {
  const me = await getMe();
  if (!me) return null;
  if (!allowed(me, 'data_protection.manage'))
    return (
      <>
        <PageHeader title="Data protection" />
        <NoAccess what="data protection requests" />
      </>
    );
  return (
    <>
      <PageHeader
        title="Data protection"
        description="Your company is the controller of your tenants’ personal data under the Data Protection Act, 2012 (Act 843). Record every request here, answer it, and keep what the law requires you to keep."
      />
      <DataProtectionRequests canExport={allowed(me, 'data_protection.export')} />
    </>
  );
}
