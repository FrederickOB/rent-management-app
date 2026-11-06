import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { getMe } from '@/lib/server/session';
import { BackupCodesCard } from './backup-codes-card';
import { Devices } from './devices';
import { WhatsappAlertsCard } from './whatsapp-alerts';

export const metadata: Metadata = { title: 'My security' };

export default async function SecurityPage() {
  const me = await getMe();
  // M8 (decision 5): staff of a company choose whether emergency alerts reach them on WhatsApp.
  const staff = me?.actorKind === 'staff' && me.activeCompanyId !== null;
  return (
    <>
      <PageHeader
        title="My security"
        description="Where you are signed in, the backup codes for two-step sign-in, and how urgent alerts reach you."
      />
      <Devices />
      <BackupCodesCard />
      {staff ? <WhatsappAlertsCard /> : null}
    </>
  );
}
