import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink } from '@/components/link-styles';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { RepairsView } from './repairs-view';

export const metadata: Metadata = { title: 'Maintenance board' };

/**
 * The maintenance board (MI-01 to MI-06, CM-04; M8 plan 4.11), at M6's address: every repair by
 * status, with filters, emergencies marked. Growth only (decision 1). Accountants, an agency's
 * client owners and advisers read it, within their scope (decision 9); the API sends only the
 * jobs each reader may see and what they may do to each.
 */
export default async function RepairsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Maintenance board',
    what: 'repairs',
    needs: ['maintenance.view', 'maintenance.read'],
    feature: 'maintenance',
  });
  if (refused) return refused;
  const canReport = allowed(me, 'maintenance.report');
  const manages = allowed(me, 'maintenance.manage');
  return (
    <>
      <PageHeader
        title="Maintenance board"
        description="Every repair by where it stands: reported on WhatsApp, in the tenant app, or logged by staff. Emergencies come first."
      />
      {canReport ? (
        <div>
          <Link href="/repairs/new" className={primaryLink}>
            Log a repair
          </Link>
        </div>
      ) : null}
      <RepairsView
        can={{
          manage: manages,
          readOnly: !manages && !canReport && !allowed(me, 'maintenance.attend'),
          listStaff: manages && allowed(me, 'membership.view'),
          listArtisans: allowed(me, 'maintenance.read'),
        }}
      />
    </>
  );
}
