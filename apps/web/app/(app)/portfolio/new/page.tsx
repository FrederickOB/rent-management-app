import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners, loadRegisterOptions } from '@/lib/server/session';
import { PropertyWizard } from './property-wizard';

export const metadata: Metadata = { title: 'New property' };

/** Sets up a property with its blocks and units in one go (PR-01; PRD section 5 story). */
export default async function NewPropertyPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'register.manage')) {
    return (
      <>
        <PageHeader title="New property" />
        <NoAccess what="adding properties" />
      </>
    );
  }
  const [options, owners] = await Promise.all([loadRegisterOptions(), loadOwners()]);
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <>
      <PageHeader
        title="New property"
        description="Four short steps: the property, its address, its units, then a last look before it is created."
      />
      {options.ok && owners.ok ? (
        <PropertyWizard
          options={options.data}
          owners={owners.data}
          agency={membership?.companyKind === 'agency'}
        />
      ) : (
        <NoAccess what="adding properties" />
      )}
    </>
  );
}
