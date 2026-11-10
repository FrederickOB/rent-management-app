import type { Metadata } from 'next';
import Link from 'next/link';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { SupportView } from './support-view';

export const metadata: Metadata = { title: 'Support access' };

/**
 * Support access across companies (AD-10; M10 decision 13): the grants customers made, the
 * requests made under each, and opening a company read-only while its grant lasts.
 */
export default async function PlatformSupportPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Support access',
    what: 'support access',
    needs: 'support.use',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Support access"
        description="A company is open to support only while its admin’s grant lasts, and only to read. Every request is recorded in the company’s audit log."
      />
      {/* M11 founder D4: account recovery sits beside support, outside the menu. */}
      {allowed(me, 'person.two_factor.reset') || allowed(me, 'person.sessions.revoke') ? (
        <p className="text-sm">
          <Link href="/platform/people" className="font-medium underline underline-offset-2">
            Account recovery
          </Link>
          : a lost authenticator, or signing someone out everywhere.
        </p>
      ) : null}
      <SupportView />
    </>
  );
}
