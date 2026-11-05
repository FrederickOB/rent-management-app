import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { getCompany, getMe } from '@/lib/server/session';
import { InspectionTemplates } from './inspection-templates';
import { MaintenanceSettingsForm } from './maintenance-settings-form';

export const metadata: Metadata = { title: 'Maintenance settings' };

/**
 * Maintenance settings (M8 decisions 4, 7 and 10): the target times per priority and the days a
 * job closes without the tenant's reply, for the board (Growth); and the inspection checklist per
 * unit type, on every plan (move-in and move-out use it). Product settings, not law.
 */
export default async function MaintenanceSettingsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Maintenance settings',
    what: 'maintenance settings',
    needs: 'company.update',
  });
  if (refused || !company) return refused;
  return (
    <>
      <PageHeader
        title="Maintenance settings"
        description="How fast repairs should be answered and finished, when a finished job closes by itself, and the checklists inspections are done from."
      />
      {hasFeature(company, 'maintenance') ? <MaintenanceSettingsForm company={company} /> : null}
      <InspectionTemplates />
    </>
  );
}
