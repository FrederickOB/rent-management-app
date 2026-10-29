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
