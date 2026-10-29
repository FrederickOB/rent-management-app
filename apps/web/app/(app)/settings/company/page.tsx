import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { BrandingForm } from './branding-form';
import { LogoUpload } from './logo-upload';
import { SettingsForm } from './settings-form';

export const metadata: Metadata = { title: 'Company settings' };

export default async function CompanySettingsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me || !company) {
    return (
      <>
        <PageHeader title="Company settings" />
        <NoAccess what="company settings" />
      </>
    );
  }
  const canEdit = allowed(me, 'company.update');
  return (
    <>
      <PageHeader
        title="Company settings"
        description={
          canEdit
            ? 'Your company’s name and branding, and how reminders and approvals work.'
            : 'You can view these settings. Ask an administrator to change them.'
        }
      />
      <BrandingForm company={company} canEdit={canEdit} />
      <LogoUpload company={company} canEdit={canEdit} />
      <SettingsForm company={company} canEdit={canEdit} />
    </>
  );
}
