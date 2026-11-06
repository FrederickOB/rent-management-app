import { DomainError } from '../errors';

/**
 * Staff tasks (CF-06; M7 plan 4.1 and 4.9): an assignee, a due time and a related record.
 * Notices create them in M7 (in-person reminders, posting on the premises, physical service);
 * M8 and the caretaker field app add more kinds.
 */
export const TASK_KINDS = [
  'notice_in_person_reminder',
  'notice_post_on_premises',
  'notice_physical_service',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  notice_in_person_reminder: 'Remind the tenant in person',
  notice_post_on_premises: 'Post the notice on the premises',
  notice_physical_service: 'Serve the notice in person',
};

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_RELATED_TYPES = ['notice'] as const;
export type TaskRelatedType = (typeof TASK_RELATED_TYPES)[number];

/** An open task is completed or cancelled once; a closed one stays closed. */
export function checkTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== 'open' || to === 'open')
    throw new DomainError(
      'task.transition',
      from === 'open'
        ? 'The task is already open'
        : `The task is already ${from === 'done' ? 'done' : 'cancelled'}`,
    );
}

/** A note on completing, cancelling or updating a task: up to 2000 characters, trimmed. */
export function checkTaskNote(note: string | null | undefined, required: boolean): string | null {
  const text = note?.trim() ?? '';
  if (text.length > 2000)
    throw new DomainError('task.note_too_long', 'A task note is at most 2000 characters');
  if (required && text.length < 2) throw new DomainError('task.note_required', 'Add a note');
  return text || null;
}
