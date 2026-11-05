import { AppError, conflict } from './errors';

/** Reads a database failure. Drizzle wraps the driver's error and keeps it as `cause`. */
interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: { readonly code?: unknown; readonly constraint?: unknown };
}

export function sqlStateOf(error: unknown): string | null {
  const e = error as PgErrorShape | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : null;
}

export function constraintOf(error: unknown): string | null {
  const e = error as PgErrorShape | null;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return typeof constraint === 'string' ? constraint : null;
}

/** A unique constraint refused the write; optionally a particular one. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    sqlStateOf(error) === '23505' &&
    (constraint === undefined || constraintOf(error) === constraint)
  );
}

/**
 * The register's commit-time checks (migration 0005) as clear conflicts. They fire when the
 * transaction commits, usually because two people changed the same thing at once. Null for any
 * other failure. The database's own message is never shown: it names internal ids.
 */
export function registerCheckConflict(error: unknown): AppError | null {
  switch (sqlStateOf(error)) {
    case 'RA012':
      return conflict(
        'ownership_total',
        'The owners’ shares no longer add up to the whole property. Reload the page and try again.',
      );
    case 'RA013':
      return conflict('property_owner_missing', 'Every property needs an owner. Choose one.');
    case 'RA014':
      return conflict(
        'meter_not_shared',
        'Only a shared meter can serve more than one unit. Reload the page and try again.',
      );
    default:
      return null;
  }
}

/**
 * M7's database rules on notices, tasks and assessments (0037, 0039) as named conflicts (review
 * MF-8): the services check first, so these fire only when two writes race or a check was missed.
 */
export function noticeCheckConflict(error: unknown): AppError | null {
  switch (sqlStateOf(error)) {
    case 'RA070':
      return conflict(
        'notice_frozen',
        'This notice has been issued or closed, so it can no longer change that way. Reload it.',
      );
    case 'RA071':
      return conflict('task_closed', 'This task is already done or cancelled. Reload it.');
    case 'RA072':
      return conflict('notice_never_deleted', 'Notices are never deleted.');
    case 'RA073':
      return conflict(
        'notice_two_person_required',
        'A notice to quit is issued only on a second person’s approval, while notices to quit are switched on (OQ-16).',
      );
    case 'RA074':
      return conflict('notice_frozen', 'This notice has been issued; its recipients are fixed.');
    case 'RA075':
      return conflict(
        'assessment_changed',
        'This assessment has already been corrected or voided. Reload the unit.',
      );
    default:
      return null;
  }
}

/** Runs `fn`, turning a commit-time register check into its clear conflict (409). */
export async function withRegisterChecks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const mapped = registerCheckConflict(error);
    if (mapped) throw mapped;
    throw error;
  }
}
