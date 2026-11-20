import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/ui/card';
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
        description="Your password, where you are signed in, the backup codes for two-step sign-in, and how urgent alerts reach you."
      />
      {me?.authMethod === 'password_totp' ? (
        <Card>
          <CardHeader
            title="Password"
            description="Changing it signs you out on every other device."
            actions={
              <Link
                href="/settings/security/password"
                className="text-sm font-medium underline underline-offset-2"
              >
                Change your password
              </Link>
            }
          />
        </Card>
      ) : null}
      <Devices />
      <BackupCodesCard />
      {staff ? <WhatsappAlertsCard /> : null}
    </>
  );
}
