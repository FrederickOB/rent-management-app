import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { keptUploads } from '../../../lib/job-sheet-store';
import { clientFrom, isToken, openJobSheet } from '../../../lib/links-api';
import { ClosedScreen, DoneScreen, SheetScreen, Trouble } from './screens';

export const metadata: Metadata = { title: 'Job sheet' };

/**
 * An artisan's job sheet (MI-04, MI-06; M8 decision 6 and plan 4.5): one artisan, one job. It
 * shows the unit, the description, the tenant's photos and the property contact's phone; the
 * artisan accepts or declines, records the start with a before photo (or a reason), and sends
 * the finished work with after photos, a note and a one-time code. Rendered on the server for
 * every request, with no cookies and no script of its own; an unknown token is simply not found.
 */
export default async function JobSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isToken(token)) notFound();
  const query = Object.fromEntries(
    Object.entries(await searchParams).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const opened = await openJobSheet(token, clientFrom(await headers()));
  if (!opened.ok) {
    if (opened.status === 404) notFound();
    return <Trouble busy={opened.status === 429} />;
  }
  const sheet = opened.value;
  switch (sheet.screen) {
    case 'sheet':
      return (
        <SheetScreen
          token={token}
          sheet={sheet}
          query={query}
          kept={sheet.actions.complete ? keptUploads(token).length : 0}
        />
      );
    case 'done':
      return <DoneScreen sheet={sheet} done={query.done === 'completed'} />;
    default:
      return <ClosedScreen sheet={sheet} />;
  }
}
