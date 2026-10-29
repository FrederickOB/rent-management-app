import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { BackupCodesCard } from './backup-codes-card';
import { Devices } from './devices';

export const metadata: Metadata = { title: 'My security' };

export default function SecurityPage() {
  return (
    <>
      <PageHeader
        title="My security"
        description="Where you are signed in, and the backup codes for two-step sign-in."
      />
      <Devices />
      <BackupCodesCard />
    </>
  );
}
