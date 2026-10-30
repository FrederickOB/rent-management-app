/**
 * Tables that reject UPDATE, DELETE and TRUNCATE (architecture section 3, CLAUDE.md section 6).
 * Every migration that adds one must call app.make_append_only(); a test checks this list
 * against the triggers in the database.
 */
export const APPEND_ONLY_TABLES = [
  'rule',
  'company_key',
  'audit_event',
  'audit_anchor',
  'approval_decision',
  'processed_job',
  'document',
  'property_ownership',
  'unit_status_event',
] as const;

/** Global tables: no company_id and no RLS (ADR-002). Everything else is company-scoped. */
export const GLOBAL_TABLES = [
  'country',
  'rule',
  'person',
  'session',
  'account',
  'verification',
  'two_factor',
  'rate_limit',
] as const;
