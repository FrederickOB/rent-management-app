import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { TasksView } from './tasks-view';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Staff tasks (CF-06): reminding a tenant in person, posting a notice on the premises and serving
 * it. Caretakers see the tasks on their properties and complete their own; the field app comes
 * later (P2).
 */
export default async function TasksPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Tasks',
    what: 'tasks',
    needs: 'tasks.read',
    feature: 'notices',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Things to do in person for a notice. Record how a notice was served on the notice itself."
      />
      <TasksView />
    </>
  );
}
