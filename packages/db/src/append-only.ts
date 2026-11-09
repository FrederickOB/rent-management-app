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
  // M6: attachments, broadcast recipients, repair media and the template registry.
  'message_attachment',
  'broadcast_recipient',
  'maintenance_job_attachment',
  'message_template',
  // M7: notice recipients and events, physical service, Rent Officer assessments and the OQ-16
  // acknowledgements.
  'notice_recipient',
  'notice_event',
  'service_record',
  'rent_assessment',
  'rent_assessment_void',
  'notice_quit_acknowledgement',
  // M8: staff and artisan consent, the job's history, inspection photos, expenses, and the
  // deposit's deductions and applications at move-out.
  'contact_consent_event',
  'maintenance_job_event',
  'inspection_photo',
  'expense',
  'expense_payment',
  'expense_reversal',
  'deposit_deduction',
  'deposit_deduction_withdrawal',
  'deposit_application',
  'move_out_refund_part',
  // M10: the subscription's history, snapshots, invoice lines, allocations, discount codes and
  // their redemptions, and the platform's price lists, terms, WhatsApp rates and stored alerts.
  'subscription_event',
  'billing_snapshot',
  'billing_snapshot_unit',
  'subscription_invoice_line',
  'subscription_allocation',
  'discount_code',
  'discount_redemption',
  'price_list',
  'subscription_terms',
  'whatsapp_rate',
  'alert_event',
  // M10 review BE-5: billing turned on, one row per change.
  'billing_activation',
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
  // M6: WhatsApp numbers and templates (platform data, read through system functions) and push
  // devices (a person's, across companies; read through a narrow function).
  'whatsapp_account',
  'message_template',
  'whatsapp_template_status',
  'push_device',
  // M10: the platform's price lists, subscription terms, WhatsApp rates and stored alerts
  // (versioned or append-only, written through narrow functions).
  'price_list',
  'subscription_terms',
  'whatsapp_rate',
  'alert_event',
  'billing_activation',
] as const;
