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
  // M3: consent, the rent schedule, signature evidence and the signing timeline, and messages.
  'consent_event',
  'charge_period',
  'signature',
  'signing_event',
  'message',
  'message_event',
  // M4a: books, the journal and period locks, and every billing record.
  'book',
  'journal_entry',
  'journal_line',
  'period_lock',
  'payment_reference',
  'invoice',
  'invoice_line',
  'invoice_line_accrual',
  'payment',
  'payment_match',
  'payment_reversal',
  'receipt',
  'cash_record',
  'direct_receipt',
  'cash_banking',
  'credit_carry_over',
  'credit_note',
  'write_off',
  'allocation',
  'property_ownership_correction',
  // M4b: subaccounts, management agreements, settlements and reminder steps.
  'provider_subaccount',
  'management_agreement',
  'provider_settlement',
  'reminder_sent',
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
  // M4a: the chart of accounts.
  'ledger_account',
  // M4b: every provider webhook, stored before its company is known (plan 4.4).
  'webhook_inbox',
] as const;
