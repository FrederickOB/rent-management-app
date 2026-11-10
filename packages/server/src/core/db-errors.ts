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

/**
 * M8's database rules (0041) as named conflicts: the services check first, so these fire only when
 * two writes race or a check was missed. The messages never name ids or tables.
 */
export function maintenanceCheckConflict(error: unknown): AppError | null {
  switch (sqlStateOf(error)) {
    case 'RA080':
      return conflict('maintenance_transition', 'This repair cannot move that way now. Reload it.');
    case 'RA081':
      return conflict(
        'maintenance_evidence_required',
        'Starting work needs a before photo or a reason; marking it done needs an after photo and a completion note.',
      );
    case 'RA082':
      return conflict(
        'maintenance_closed',
        'This repair is closed or cancelled and no longer changes.',
      );
    case 'RA083':
      return conflict(
        'inspection_submitted',
        'This inspection was submitted and is frozen. Start a correction instead.',
      );
    case 'RA084':
      return conflict('inspection_incomplete', 'Every item needs a condition before submitting.');
    case 'RA085':
      return conflict(
        'settlement_not_drafting',
        'The deductions are fixed once the settlement is sent for approval.',
      );
    case 'RA086':
      return conflict(
        'deductions_exceed_deposit',
        'The deductions would be more than the deposit held. Record damage beyond the deposit as a charge.',
      );
    case 'RA087':
      return conflict(
        'deduction_evidence',
        'A deduction can name only items and photos of this move-out’s inspection.',
      );
    case 'RA088':
      return conflict('moveout_transition', 'This move-out cannot change that way now. Reload it.');
    case 'RA089':
      return conflict(
        'moveout_two_person_required',
        'A move-out settlement is approved only by a second person.',
      );
    case 'RA090':
      return conflict('expense_closed', 'This expense was already paid or reversed. Reload it.');
    // M9 review (0055): an owner statement being issued, and an issue without its month's lock.
    case 'RA095':
      return conflict(
        'statement_issuing',
        'An owner statement for this book is being issued. Try again in a moment.',
      );
    case 'RA096':
      return conflict(
        'statement_lock_missing',
        'An owner statement was issued without locking its month. Nothing was recorded.',
      );
    default:
      return null;
  }
}

/**
 * M11 review B8 (0078): an anonymised tenant or contact keeps no personal data (Act 843), so its
 * personal fields are never filled in again. The service refuses first; the database (RA127, and
 * RA126 for `anonymised_at` itself) is the backstop.
 */
export const tenantAnonymised = () =>
  conflict(
    'tenant_anonymised',
    'This tenant’s personal data was erased on request (Data Protection Act, 2012), so it is not filled in again.',
  );

/** RA126 and RA127 as the same clear conflict (409); null for any other failure. */
export function tenantCheckConflict(error: unknown): AppError | null {
  switch (sqlStateOf(error)) {
    case 'RA126':
    case 'RA127':
      return tenantAnonymised();
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
