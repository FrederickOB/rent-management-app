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
