import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { ImportFlow } from './import-flow';

export const metadata: Metadata = { title: 'Import' };

/** Properties and units from a spreadsheet (PR-08): template, dry run, report, commit. */
export default async function ImportPage() {
  const me = await getMe();
  return (
    <>
      <PageHeader
        title="Import from a spreadsheet"
        description="Add or update properties and units in bulk. Every row is checked first, and nothing is written until the whole file passes."
      />
      {me && allowed(me, 'register.import') ? <ImportFlow /> : <NoAccess what="imports" />}
    </>
  );
}
