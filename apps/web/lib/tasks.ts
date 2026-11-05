import type { TaskStatus } from '@rent/domain/tasks';
import { instantFrom } from '@rent/domain/dates';

// Staff tasks (CF-06): the kinds' labels are the domain's (TASK_KIND_LABELS); these are the
// screen's words for a task's state.

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** An open task past its due time. */
export function taskOverdue(
  task: { readonly status: TaskStatus; readonly dueAt: string },
  now: Date,
): boolean {
  if (task.status !== 'open') return false;
  try {
    return instantFrom(task.dueAt).epochMilliseconds < instantFrom(now).epochMilliseconds;
  } catch {
    return false;
  }
}

/**
 * Where a task's record is (M8): the repair to attend, or the inspection to do. A notice's task
 * links to its notice through `task.notice`, so it is not repeated here.
 */
export function taskRecordLink(task: {
  readonly relatedType: string;
  readonly relatedId: string;
}): { readonly href: string; readonly text: string } | null {
  switch (task.relatedType) {
    case 'maintenance_job':
      return { href: `/repairs/${task.relatedId}`, text: 'Open the repair' };
    case 'inspection':
      return { href: `/inspections/${task.relatedId}`, text: 'Open the inspection' };
    default:
      return null;
  }
}
