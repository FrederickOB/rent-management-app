import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { RulesView } from './rules-view';

export const metadata: Metadata = { title: 'Rules' };

/**
 * The rules table (TX-08; M10 decision 16): every legal, tax and regulatory value with its source
 * and status, and a new row added as `pnpm rules:add` does. Rows are never edited.
 */
export default async function PlatformRulesPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Rules',
    what: 'the rules table',
    needs: 'rules.view',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Rules"
        description="Legal, tax and regulatory values, each with its source and who verified it. A change is a new row from its own date, so past receipts, notices and reports keep the value they used. Unverified values are highlighted."
      />
      <RulesView canAdd={allowed(me, 'rules.add')} />
    </>
  );
}
