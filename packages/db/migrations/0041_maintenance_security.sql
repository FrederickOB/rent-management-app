-- Maintenance, inspections, expenses and move-out: security and integrity (M8). RLS with property,
-- owner and tenant scope on the new company tables; append-only evidence (job events, consent,
-- inspection photos, deductions, deposit applications, expenses); the job machine with MI-06's
-- evidence; frozen submitted inspections; deductions that never exceed the deposit held; the
-- move-out machine with its two-person approval; the foreign keys the schema files cannot hold;
-- the maintenance message templates; row-level audit; and grants. Applied as rent_owner, after
-- 0040. See docs/plans/M8.md section 4.
--
-- Error codes: RA080 a job move the machine does not allow; RA081 a job step without its evidence
-- (a before photo or a reason; an after photo and a completion note); RA082 a closed or cancelled
-- job changed, or a job's fixed facts changed; RA083 a submitted inspection, or its items and
-- photos, changed; RA084 an inspection submitted with an item that has no condition; RA085 the
-- deductions changed once the settlement left drafting; RA086 deductions beyond the deposit held;
-- RA087 a deduction's evidence not from the move-out's inspection; RA088 a move-out move the
-- machine does not allow, or its settlement changed after approval; RA089 a settlement approved
-- without a second person's approval; RA090 an expense paid twice, or paid or reversed after a
-- reversal.

-- 1. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'artisan', 'contact_consent_event', 'maintenance_job_event', 'job_sheet_code', 'inspection_template',
  'inspection', 'inspection_item', 'inspection_photo', 'expense', 'expense_payment', 'expense_reversal',
  'move_out', 'deposit_deduction', 'deposit_deduction_withdrawal', 'deposit_application', 'move_out_refund_part'
]::regclass[]) AS t;

-- Property scope (AD-02): a caretaker sees the jobs, inspections, expenses and move-outs of the
-- properties assigned to them; an owner's people, those of the properties their owners hold.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'maintenance_job_event', 'job_sheet_code', 'inspection', 'inspection_item', 'inspection_photo', 'expense',
  'expense_payment', 'expense_reversal', 'move_out', 'deposit_deduction', 'deposit_deduction_withdrawal',
  'deposit_application', 'move_out_refund_part'
]::regclass[]) AS t;

-- Owner scope (decision 9): an agency's client owner and their advisers see only their own owner's
-- expenses and settlements, even on a property that changed hands.
CREATE POLICY owner_scope ON expense AS RESTRICTIVE USING (app.in_owner_scope(owner_id));
CREATE POLICY owner_scope ON move_out AS RESTRICTIVE USING (app.in_owner_scope(owner_id));

-- A tenant session sees its own jobs (0031) and now, through them, the job's files and the steps it
-- hears about (CM-04), never a staff note or an alert. It sees its own move-outs once approved (the
-- final statement, TL-11). Everything else is staff only.
DROP POLICY no_tenant_session ON maintenance_job_attachment;
CREATE POLICY tenant_scope ON maintenance_job_attachment AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR EXISTS (
    SELECT 1 FROM maintenance_job j
    WHERE j.company_id = maintenance_job_attachment.company_id AND j.id = maintenance_job_attachment.job_id
      AND j.tenant_id = ANY(app.tenant_scope())));
CREATE POLICY job_visible ON maintenance_job_event AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR (
    maintenance_job_event.kind IN ('reported', 'assigned', 'visit_planned', 'started', 'work_done', 'confirmed',
      'disputed', 'closed', 'auto_closed', 'cancelled')
    AND EXISTS (SELECT 1 FROM maintenance_job j
                WHERE j.company_id = maintenance_job_event.company_id AND j.id = maintenance_job_event.job_id)));
CREATE POLICY tenant_scope ON move_out AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR (
    move_out.tenant_id = ANY(app.tenant_scope()) AND move_out.status IN ('approved', 'refund_paid', 'closed')));
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'artisan', 'contact_consent_event', 'job_sheet_code', 'inspection_template', 'inspection', 'inspection_item',
  'inspection_photo', 'expense', 'expense_payment', 'expense_reversal', 'deposit_deduction',
  'deposit_deduction_withdrawal', 'deposit_application', 'move_out_refund_part'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only (CLAUDE.md section 6; plan 4.10) ----------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'contact_consent_event', 'maintenance_job_event', 'inspection_photo', 'expense', 'expense_payment',
  'expense_reversal', 'deposit_deduction', 'deposit_deduction_withdrawal', 'deposit_application',
  'move_out_refund_part'
]::regclass[]) AS t;

-- Never deleted, though they move: artisans are archived, jobs, inspections and move-outs closed or
-- cancelled, codes spent.
CREATE TRIGGER no_delete BEFORE DELETE ON artisan FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON inspection FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON inspection_item FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON move_out FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON job_sheet_code FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON artisan FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON inspection FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON inspection_item FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON move_out FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON job_sheet_code FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- 3. The job machine (plan 4.2; MI-06; decision 7) ---------------------------------------------
-- The same moves as MAINTENANCE_JOB_TRANSITIONS in packages/domain/src/maintenance/jobs.ts (a test
-- checks the two agree). A job is created Reported; it starts work only with a before photo or a
-- recorded reason, and reaches Work done or Closed only with an after photo and a completion note.
-- A closed or cancelled job never changes, and what was reported is fixed.

CREATE FUNCTION app.maintenance_job_moves() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['reported>triaged', 'triaged>triaged', 'triaged>assigned', 'assigned>assigned', 'assigned>triaged',
    'assigned>in_progress', 'in_progress>work_done', 'work_done>closed', 'work_done>in_progress',
    'reported>cancelled', 'triaged>cancelled']
$$;

CREATE FUNCTION app.check_maintenance_job_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'reported' THEN
    RAISE EXCEPTION 'a maintenance job starts as reported, not %', NEW.status USING ERRCODE = 'RA080';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_starts_reported BEFORE INSERT ON maintenance_job
  FOR EACH ROW EXECUTE FUNCTION app.check_maintenance_job_insert();

CREATE FUNCTION app.check_maintenance_job_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_moving text[] := ARRAY['status', 'priority', 'category', 'assignee_kind', 'assignee_person_id',
    'assignee_artisan_id', 'artisan_response', 'respond_by', 'complete_by', 'responded_at', 'work_done_at',
    'closed_at', 'visit_at', 'before_photo_reason', 'completion_note', 'tenant_response', 'tenant_response_reason',
    'tenant_response_at', 'tenant_response_via', 'cancel_reason', 'updated_at'];
BEGIN
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'maintenance job % is % and never changes', OLD.id, OLD.status USING ERRCODE = 'RA082';
  END IF;
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'what was reported on maintenance job % is fixed', OLD.id USING ERRCODE = 'RA082';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status || '>' || NEW.status) = ANY(app.maintenance_job_moves()) THEN
    RAISE EXCEPTION 'maintenance job % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'RA080';
  END IF;
  IF NEW.status = 'in_progress' AND OLD.status = 'assigned'
     AND length(btrim(coalesce(NEW.before_photo_reason, ''))) < 3
     AND NOT EXISTS (SELECT 1 FROM maintenance_job_attachment a
                     WHERE a.company_id = NEW.company_id AND a.job_id = NEW.id AND a.stage = 'before') THEN
    RAISE EXCEPTION 'work on job % starts with a before photo or a reason for none', NEW.id
      USING ERRCODE = 'RA081';
  END IF;
  IF NEW.status IN ('work_done', 'closed') AND NEW.status IS DISTINCT FROM OLD.status AND (
       length(btrim(coalesce(NEW.completion_note, ''))) < 3 OR NEW.work_done_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM maintenance_job_attachment a
                      WHERE a.company_id = NEW.company_id AND a.job_id = NEW.id AND a.stage = 'after'
                        AND a.kind = 'image')) THEN
    RAISE EXCEPTION 'job % is done only with an after photo and a completion note (MI-06)', NEW.id
      USING ERRCODE = 'RA081';
  END IF;
  IF NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'job % closes with its time', NEW.id USING ERRCODE = 'RA081';
  END IF;
  IF NEW.status = 'cancelled' AND length(btrim(coalesce(NEW.cancel_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'job % is cancelled with a reason', NEW.id USING ERRCODE = 'RA081';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_machine BEFORE UPDATE ON maintenance_job
  FOR EACH ROW EXECUTE FUNCTION app.check_maintenance_job_update();

-- An attachment belongs to an open job (files are evidence of the work, not added afterwards).
CREATE FUNCTION app.check_job_attachment_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM maintenance_job j WHERE j.company_id = NEW.company_id AND j.id = NEW.job_id
             AND j.status IN ('closed', 'cancelled')) THEN
    RAISE EXCEPTION 'maintenance job % is closed; its files are fixed', NEW.job_id USING ERRCODE = 'RA082';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_on_open_job BEFORE INSERT ON maintenance_job_attachment
  FOR EACH ROW EXECUTE FUNCTION app.check_job_attachment_open();
--> statement-breakpoint

-- 4. Inspections are frozen once submitted (plan 4.6; decision 10) ------------------------------

CREATE FUNCTION app.check_inspection_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'in_progress' THEN
    RAISE EXCEPTION 'an inspection starts in progress' USING ERRCODE = 'RA083';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_starts_open BEFORE INSERT ON inspection
  FOR EACH ROW EXECUTE FUNCTION app.check_inspection_insert();

CREATE FUNCTION app.check_inspection_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_moving text[] := ARRAY['status', 'submitted_at', 'submitted_by', 'updated_at'];
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'inspection % was submitted: correct it with a new inspection that references it', OLD.id
      USING ERRCODE = 'RA083';
  END IF;
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'inspection % keeps its unit, lease and kind', OLD.id USING ERRCODE = 'RA083';
  END IF;
  IF NEW.status = 'submitted' AND (
       NOT EXISTS (SELECT 1 FROM inspection_item i WHERE i.company_id = NEW.company_id AND i.inspection_id = NEW.id)
       OR EXISTS (SELECT 1 FROM inspection_item i WHERE i.company_id = NEW.company_id AND i.inspection_id = NEW.id
                  AND i.condition IS NULL)) THEN
    RAISE EXCEPTION 'inspection % is submitted only when every item has a condition', OLD.id
      USING ERRCODE = 'RA084';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_frozen BEFORE UPDATE ON inspection
  FOR EACH ROW EXECUTE FUNCTION app.check_inspection_update();

CREATE FUNCTION app.check_inspection_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_moving text[] := ARRAY['condition', 'note', 'updated_by', 'updated_at'];
BEGIN
  IF EXISTS (SELECT 1 FROM inspection i WHERE i.company_id = NEW.company_id AND i.id = NEW.inspection_id
             AND i.status = 'submitted') THEN
    RAISE EXCEPTION 'inspection % was submitted and never changes', NEW.inspection_id USING ERRCODE = 'RA083';
  END IF;
  IF TG_TABLE_NAME = 'inspection_item' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'an inspection item keeps its room and item' USING ERRCODE = 'RA083';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_item_open BEFORE INSERT OR UPDATE ON inspection_item
  FOR EACH ROW EXECUTE FUNCTION app.check_inspection_open();
CREATE TRIGGER inspection_photo_open BEFORE INSERT ON inspection_photo
  FOR EACH ROW EXECUTE FUNCTION app.check_inspection_open();
--> statement-breakpoint

-- 5. Deductions never exceed the deposit held (MI-11; plan 4.8) ---------------------------------
-- The deposit held is the lease's 2100 balance in the journal, read under the move-out's row lock so
-- two deductions added at once are checked one after the other. Deductions and withdrawals are
-- written only while the settlement is drafted, and each deduction's evidence comes from the
-- move-out's own inspection.

CREATE FUNCTION app.check_deposit_deduction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_move move_out%ROWTYPE;
  v_held bigint;
  v_live bigint;
BEGIN
  SELECT * INTO v_move FROM move_out m WHERE m.company_id = NEW.company_id AND m.id = NEW.move_out_id FOR UPDATE;
  IF v_move.status NOT IN ('planned', 'inspected', 'settlement_drafted') THEN
    RAISE EXCEPTION 'the deductions of move-out % are fixed once it leaves drafting', NEW.move_out_id
      USING ERRCODE = 'RA085';
  END IF;
  IF TG_TABLE_NAME = 'deposit_deduction_withdrawal' THEN
    RETURN NEW;
  END IF;
  IF cardinality(NEW.inspection_item_ids) > 0 AND (
       v_move.inspection_id IS NULL OR EXISTS (
         SELECT 1 FROM unnest(NEW.inspection_item_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM inspection_item i WHERE i.company_id = NEW.company_id
                           AND i.inspection_id = v_move.inspection_id AND i.id = x.id))) THEN
    RAISE EXCEPTION 'a deduction names items of its move-out inspection only' USING ERRCODE = 'RA087';
  END IF;
  IF cardinality(NEW.photo_ids) > 0 AND (
       v_move.inspection_id IS NULL OR EXISTS (
         SELECT 1 FROM unnest(NEW.photo_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM inspection_photo p WHERE p.company_id = NEW.company_id
                           AND p.inspection_id = v_move.inspection_id AND p.id = x.id))) THEN
    RAISE EXCEPTION 'a deduction names photos of its move-out inspection only' USING ERRCODE = 'RA087';
  END IF;
  SELECT 0 - coalesce(sum(l.amount_minor), 0) INTO v_held FROM journal_line l
    WHERE l.company_id = NEW.company_id AND l.account_code = '2100' AND l.lease_id = NEW.lease_id;
  SELECT coalesce(sum(d.amount_minor), 0) INTO v_live FROM deposit_deduction d
    WHERE d.company_id = NEW.company_id AND d.move_out_id = NEW.move_out_id
      AND NOT EXISTS (SELECT 1 FROM deposit_deduction_withdrawal w
                      WHERE w.company_id = d.company_id AND w.deduction_id = d.id);
  IF v_live + NEW.amount_minor > v_held THEN
    RAISE EXCEPTION 'deductions on move-out % would exceed the deposit held', NEW.move_out_id
      USING ERRCODE = 'RA086';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deductions_within_deposit BEFORE INSERT ON deposit_deduction
  FOR EACH ROW EXECUTE FUNCTION app.check_deposit_deduction();
CREATE TRIGGER withdrawals_while_drafting BEFORE INSERT ON deposit_deduction_withdrawal
  FOR EACH ROW EXECUTE FUNCTION app.check_deposit_deduction();
--> statement-breakpoint

-- 6. The move-out machine (plan 4.8; packages/domain/src/moveout/moveout.ts) -------------------
-- A move-out starts planned (a deposit settlement, drafted); it is approved only on a second
-- person's approval of `lease.move_out_settlement` (OQ-29 for a single user, as 0039); once sent for
-- approval its charges are fixed, and once approved its statement, entries and documents are
-- recorded once. A closed or cancelled move-out never changes.

CREATE FUNCTION app.move_out_moves() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['planned>inspected', 'planned>settlement_drafted', 'inspected>settlement_drafted',
    'settlement_drafted>awaiting_approval', 'awaiting_approval>settlement_drafted', 'awaiting_approval>approved',
    'approved>refund_paid', 'approved>closed', 'refund_paid>closed', 'planned>cancelled', 'inspected>cancelled',
    'settlement_drafted>cancelled']
$$;

CREATE FUNCTION app.check_move_out_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind = 'deposit_settlement' AND NEW.status <> 'settlement_drafted')
     OR (NEW.kind = 'move_out' AND NEW.status <> 'planned') THEN
    RAISE EXCEPTION 'a move-out starts planned, and a deposit settlement drafted' USING ERRCODE = 'RA088';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER move_out_starts BEFORE INSERT ON move_out
  FOR EACH ROW EXECUTE FUNCTION app.check_move_out_insert();

CREATE FUNCTION app.check_move_out_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_fixed text[] := ARRAY['id', 'company_id', 'property_id', 'tenant_id', 'lease_id', 'unit_id', 'owner_id',
    'book_id', 'kind', 'created_by', 'created_at'];
  v_after_approval text[] := ARRAY['status', 'paid_on', 'paid_from', 'paid_reference', 'proof_document_id',
    'paid_entry_id', 'paid_by', 'statement_document_id', 'statement_sha256', 'closed_at', 'updated_at'];
  v_set_once text[] := ARRAY['paid_entry_id', 'statement_document_id', 'statement_sha256'];
  v_column text;
BEGIN
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'move-out % is % and never changes', OLD.id, OLD.status USING ERRCODE = 'RA088';
  END IF;
  FOREACH v_column IN ARRAY v_fixed LOOP
    IF (to_jsonb(NEW) -> v_column) IS DISTINCT FROM (to_jsonb(OLD) -> v_column) THEN
      RAISE EXCEPTION 'the % of move-out % never changes', v_column, OLD.id USING ERRCODE = 'RA088';
    END IF;
  END LOOP;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status || '>' || NEW.status) = ANY(app.move_out_moves()) THEN
    RAISE EXCEPTION 'move-out % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'RA088';
  END IF;
  -- Sent for approval: the settlement as asked is fixed until it is returned to drafting.
  IF OLD.status = 'awaiting_approval' AND NEW.status <> 'settlement_drafted'
     AND (to_jsonb(NEW) - ARRAY['status', 'approved_on', 'approved_at', 'statement', 'credit_refund_minor',
            'deposit_refund_minor', 'refund_entry_id', 'statement_document_id', 'statement_sha256', 'updated_at'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'approved_on', 'approved_at', 'statement', 'credit_refund_minor',
            'deposit_refund_minor', 'refund_entry_id', 'statement_document_id', 'statement_sha256', 'updated_at']) THEN
    RAISE EXCEPTION 'move-out % is with its approver; return it to drafting to change it', OLD.id
      USING ERRCODE = 'RA088';
  END IF;
  IF OLD.status IN ('approved', 'refund_paid') THEN
    IF (to_jsonb(NEW) - v_after_approval) IS DISTINCT FROM (to_jsonb(OLD) - v_after_approval) THEN
      RAISE EXCEPTION 'move-out % was approved: its settlement is fixed', OLD.id USING ERRCODE = 'RA088';
    END IF;
    FOREACH v_column IN ARRAY v_set_once LOOP
      IF (to_jsonb(OLD) -> v_column) <> 'null'::jsonb
         AND (to_jsonb(NEW) -> v_column) IS DISTINCT FROM (to_jsonb(OLD) -> v_column) THEN
        RAISE EXCEPTION 'the % of move-out % is recorded once', v_column, OLD.id USING ERRCODE = 'RA088';
      END IF;
    END LOOP;
  END IF;
  IF NEW.status = 'approved' AND OLD.status = 'awaiting_approval' AND (
       NEW.approval_request_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM approval_request r
         JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
         WHERE r.company_id = NEW.company_id AND r.id = NEW.approval_request_id
           AND r.action_type = 'lease.move_out_settlement'
           AND r.subject_type = 'move_out' AND r.subject_id = NEW.id::text
           AND r.status IN ('pending', 'cooling_off', 'approved')
           AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
             OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified)))) THEN
    RAISE EXCEPTION 'move-out % is settled only on a second person''s approval', NEW.id USING ERRCODE = 'RA089';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER move_out_machine BEFORE UPDATE ON move_out
  FOR EACH ROW EXECUTE FUNCTION app.check_move_out_update();
--> statement-breakpoint

-- 7. Expenses: a payable is paid once, and nothing follows a reversal (P15, P21a) ----------------

CREATE FUNCTION app.check_expense_follow_up() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM expense_reversal r WHERE r.company_id = NEW.company_id AND r.expense_id = NEW.expense_id) THEN
    RAISE EXCEPTION 'expense % was reversed; record the right one as a new expense', NEW.expense_id
      USING ERRCODE = 'RA090';
  END IF;
  IF TG_TABLE_NAME = 'expense_payment' AND NOT EXISTS (
       SELECT 1 FROM expense e WHERE e.company_id = NEW.company_id AND e.id = NEW.expense_id AND e.paid_by = 'unpaid') THEN
    RAISE EXCEPTION 'expense % was paid when it was recorded', NEW.expense_id USING ERRCODE = 'RA090';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_of_payable BEFORE INSERT ON expense_payment
  FOR EACH ROW EXECUTE FUNCTION app.check_expense_follow_up();
CREATE TRIGGER reversal_once BEFORE INSERT ON expense_reversal
  FOR EACH ROW EXECUTE FUNCTION app.check_expense_follow_up();
--> statement-breakpoint

-- 8. Foreign keys the schema files cannot hold (they would import each other) -----------------

ALTER TABLE secure_link ADD CONSTRAINT secure_link_job_fk
  FOREIGN KEY (company_id, property_id, job_id) REFERENCES maintenance_job (company_id, property_id, id);
ALTER TABLE secure_link ADD CONSTRAINT secure_link_artisan_fk
  FOREIGN KEY (company_id, artisan_id) REFERENCES artisan (company_id, id);
ALTER TABLE signing_request ADD CONSTRAINT signing_request_inspection_fk
  FOREIGN KEY (company_id, property_id, lease_id, inspection_id)
  REFERENCES inspection (company_id, property_id, lease_id, id);
ALTER TABLE message ADD CONSTRAINT message_artisan_fk
  FOREIGN KEY (company_id, artisan_id) REFERENCES artisan (company_id, id);
--> statement-breakpoint

-- 9. Maintenance and move-out message templates (CM-07; plan 4.4, 4.5 and 4.8). The texts are
-- `TEMPLATE_DEFINITIONS` in packages/domain/src/messaging/whatsapp.ts; a test checks the two agree.

INSERT INTO message_template (key, version, whatsapp_name, category, language, body, parameters, created_by)
SELECT v.key, v.version, v.whatsapp_name, v.category, v.language, v.body, v.parameters, 'migration 0041'
FROM (VALUES
  ('maintenance_alert', 1, 'maintenance_alert_v1', 'utility', 'en',
   'An emergency repair was reported to {{1}}: {{2}} at {{3}}. Please open the maintenance board now.',
   '["landlord","ticket","place"]'::jsonb),
  ('job_sheet_link', 1, 'job_sheet_link_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has a repair job for you: {{3}}. See the details and reply at {{4}} please.',
   '["landlord","artisan","job","link"]'::jsonb),
  ('repair_update', 1, 'repair_update_v1', 'utility', 'en',
   'Hello {{2}}, an update from {{1}} on your repair {{3}}: {{4}}. Reply here if you have a question.',
   '["landlord","tenant","ticket","update"]'::jsonb),
  ('final_statement_ready', 1, 'final_statement_ready_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has settled your tenancy. Your final statement is in the tenant app, or reply here and we will send it.',
   '["landlord","tenant"]'::jsonb)
) AS v(key, version, whatsapp_name, category, language, body, parameters)
ON CONFLICT (key, language, version) DO NOTHING;
--> statement-breakpoint

-- 10. Row-change audit (AD-07). Artisans' phones and codes are recorded only as changed. ---------

CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON artisan
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone');
CREATE TRIGGER audit_row AFTER INSERT ON contact_consent_event
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON maintenance_job_event
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON inspection_template
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON inspection
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON inspection_item
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON inspection_photo
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON expense
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON expense_payment
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON expense_reversal
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON move_out
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON deposit_deduction
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON deposit_deduction_withdrawal
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON deposit_application
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
--> statement-breakpoint

-- 11. The lease machine (0011, amended for M8 plan 4.8) ----------------------------------------
-- New: an ending lease may be terminated (an early move-out approved) or go back to active or held
-- over (its move-out cancelled), and a terminated lease records its last day. Everything else is as
-- in 0011.

CREATE OR REPLACE FUNCTION app.check_lease_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
      ('draft', 'pending_signatures'), ('draft', 'signed'), ('draft', 'cancelled'),
      ('pending_signatures', 'draft'), ('pending_signatures', 'signed'), ('pending_signatures', 'cancelled'),
      ('signed', 'active'), ('signed', 'cancelled'),
      ('active', 'ending'), ('active', 'holding_over'), ('active', 'ended'), ('active', 'terminated'),
      ('holding_over', 'ending'), ('holding_over', 'ended'), ('holding_over', 'terminated'),
      ('ending', 'ended'),
      -- M8 (plan 4.8): an early move-out ends the lease as terminated, and a cancelled move-out
      -- returns it to what it was before it was planned.
      ('ending', 'terminated'), ('ending', 'active'), ('ending', 'holding_over')) THEN
    RAISE EXCEPTION 'a lease cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'RA022';
  END IF;
  IF NEW.status = 'signed' AND (NEW.signed_at IS NULL OR NEW.signing_method IS NULL
      OR (OLD.status = 'draft') <> (NEW.signing_method = 'paper')
      OR (NEW.signing_method = 'paper' AND NEW.signed_document_id IS NULL)) THEN
    RAISE EXCEPTION 'a signed lease records when and how it was signed: on paper from a draft, with the scan, or electronically'
      USING ERRCODE = 'RA023';
  END IF;
  IF NEW.status = 'signed' AND EXISTS (
      SELECT 1 FROM unit u WHERE u.company_id = NEW.company_id AND u.id = NEW.unit_id
        AND (u.archived_at IS NOT NULL OR u.availability = 'not_lettable')) THEN
    RAISE EXCEPTION 'the unit of lease % is archived or not lettable', NEW.id USING ERRCODE = 'RA026';
  END IF;
  IF (NEW.status = 'active' AND NEW.activated_on IS NULL)
     OR (NEW.status = 'holding_over' AND NEW.holding_over_since IS NULL)
     OR (NEW.status = 'ending' AND NEW.ending_reason IS NULL)
     OR (NEW.status = 'ended' AND (NEW.end_reason IS NULL OR NEW.ended_on IS NULL
         OR (NEW.end_reason = 'moved_out' AND NEW.move_out_date IS NULL)))
     OR (NEW.status = 'cancelled' AND (NEW.cancel_reason IS NULL OR NEW.cancelled_at IS NULL))
     OR (NEW.status = 'terminated' AND (NEW.ended_on IS NULL OR NEW.move_out_date IS NULL)) THEN
    RAISE EXCEPTION 'lease % is missing what the % state records', NEW.id, NEW.status USING ERRCODE = 'RA023';
  END IF;
  IF NEW.status = 'ended' AND NEW.end_reason = 'renewed' AND NOT EXISTS (
      SELECT 1 FROM lease r WHERE r.company_id = NEW.company_id AND r.renews_lease_id = NEW.id
        AND r.status IN ('signed', 'active', 'ending', 'holding_over')) THEN
    RAISE EXCEPTION 'lease % ends by renewal only once its renewal is signed', NEW.id USING ERRCODE = 'RA023';
  END IF;
  IF NEW.status = 'ended' AND NEW.end_reason = 'superseded' AND NOT EXISTS (
      SELECT 1 FROM lease r WHERE r.company_id = NEW.company_id AND r.unit_id = NEW.unit_id
        AND r.id <> NEW.id AND r.status IN ('active', 'ending', 'holding_over')
        AND r.start_date = NEW.ended_on + 1) THEN
    RAISE EXCEPTION 'lease % ends when the next lease on its unit starts, the day after', NEW.id
      USING ERRCODE = 'RA023';
  END IF;
  IF OLD.status = 'signed' AND NEW.status = 'cancelled' AND NOT EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
      WHERE r.company_id = NEW.company_id AND r.action_type = 'lease.cancel_signed'
        AND r.subject_type = 'lease' AND r.subject_id = NEW.id::text
        AND r.status IN ('pending', 'cooling_off', 'approved')
        AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
          OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'cancelling signed lease % needs a second person''s approval (AD-05)', NEW.id
      USING ERRCODE = 'RA027';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 12. Grants ------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.maintenance_job_moves(), app.check_maintenance_job_insert(),
  app.check_maintenance_job_update(), app.check_job_attachment_open(), app.check_inspection_insert(),
  app.check_inspection_update(), app.check_inspection_open(), app.check_deposit_deduction(),
  app.move_out_moves(), app.check_move_out_insert(), app.check_move_out_update(), app.check_expense_follow_up()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.maintenance_job_moves(), app.move_out_moves() TO rent_app;

GRANT UPDATE (status, priority, category, assignee_kind, assignee_person_id, assignee_artisan_id, artisan_response,
  respond_by, complete_by, responded_at, work_done_at, closed_at, visit_at, before_photo_reason, completion_note,
  tenant_response, tenant_response_reason, tenant_response_at, tenant_response_via, cancel_reason, updated_at)
  ON maintenance_job TO rent_app;
GRANT SELECT, INSERT ON artisan TO rent_app;
GRANT UPDATE (name, trades, archived_at, updated_at) ON artisan TO rent_app;
GRANT SELECT, INSERT ON contact_consent_event, maintenance_job_event, inspection_photo, expense, expense_payment,
  expense_reversal, deposit_deduction, deposit_deduction_withdrawal, deposit_application, move_out_refund_part
  TO rent_app;
GRANT SELECT, INSERT ON job_sheet_code TO rent_app;
GRANT UPDATE (attempts, consumed_at) ON job_sheet_code TO rent_app;
GRANT SELECT, INSERT, DELETE ON inspection_template TO rent_app;
GRANT UPDATE (rooms, updated_by, updated_at) ON inspection_template TO rent_app;
GRANT SELECT, INSERT ON inspection TO rent_app;
GRANT UPDATE (status, submitted_at, submitted_by, updated_at) ON inspection TO rent_app;
GRANT SELECT, INSERT ON inspection_item TO rent_app;
GRANT UPDATE (condition, note, updated_by, updated_at) ON inspection_item TO rent_app;
GRANT SELECT, INSERT ON move_out TO rent_app;
GRANT UPDATE (reason, planned_date, early, notice_id, note, status, prior_lease_status, inspection_id,
  move_in_inspection_id, charges, approval_request_id, statement, approved_on, approved_at, credit_refund_minor,
  deposit_refund_minor, refund_entry_id, paid_on, paid_from, paid_reference, proof_document_id, paid_entry_id,
  paid_by, statement_document_id, statement_sha256, cancelled_at, cancel_reason, closed_at, updated_at)
  ON move_out TO rent_app;
