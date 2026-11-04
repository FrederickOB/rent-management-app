-- Legal notices and tasks: security and integrity (M7). RLS with property and tenant scope on the
-- new company tables; append-only recipients, events, service records, Rent Officer assessments and
-- OQ-16 acknowledgements; an issued notice that only moves its status, ladder flags and outcome; a
-- task closed once; the notice's signing requests tied to it; the s.23 bar rule (unverified); the
-- notice message templates; row-level audit; and grants. Applied as rent_owner, after 0036. See
-- docs/plans/M7.md section 4.
--
-- Error codes: RA070 an issued notice changed beyond its status, ladder flags and outcome, or a
-- closed or cancelled notice changed at all; RA071 a closed task changed; RA072 a notice deleted.

-- 1. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'notice', 'notice_recipient', 'notice_event', 'service_record', 'rent_assessment',
  'notice_quit_acknowledgement', 'task'
]::regclass[]) AS t;

-- Property scope (AD-02): a caretaker sees the notices, records and tasks of assigned properties.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'notice', 'notice_recipient', 'notice_event', 'service_record', 'rent_assessment', 'task'
]::regclass[]) AS t;

-- A tenant session sees an issued notice it received (through its own recipient rows), never a
-- draft and never another tenant's; and its own recipient rows. Everything else is staff only.
CREATE POLICY tenant_scope ON notice AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR (
    notice.status NOT IN ('draft', 'pending_approval', 'approved', 'cancelled', 'received')
    AND EXISTS (SELECT 1 FROM notice_recipient r
                WHERE r.company_id = notice.company_id AND r.notice_id = notice.id
                  AND r.tenant_id = ANY(app.tenant_scope()))));
SELECT app.enable_tenant_scope('notice_recipient');
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'notice_event', 'service_record', 'rent_assessment', 'notice_quit_acknowledgement', 'task'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only (CLAUDE.md section 6; plan 4.9) -----------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'notice_recipient', 'notice_event', 'service_record', 'rent_assessment', 'notice_quit_acknowledgement'
]::regclass[]) AS t;
--> statement-breakpoint

-- 3. Integrity the database keeps --------------------------------------------------------------

-- Plan 4.8: once issued, a notice's fields, dates, recipients, document and hashes never change.
-- Only its status, ladder flags, late-service flag and outcome move; its frozen document and
-- service pack are recorded once, as they render. A closed or cancelled notice moves no further,
-- and nothing deletes a notice: a draft is cancelled, an issued notice closed.
CREATE FUNCTION app.check_notice_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_moving text[] := ARRAY['status', 'ladder_paused', 'ladder_cancelled', 'ladder_reason', 'ladder_changed_at',
    'ladder_changed_by', 'served_too_late', 'outcome', 'close_note', 'closed_at', 'closed_by', 'updated_at',
    'document_id', 'document_sha256', 'service_pack_render_request_id', 'service_pack_document_id'];
  v_set_once text[] := ARRAY['document_id', 'document_sha256', 'service_pack_render_request_id',
    'service_pack_document_id'];
  v_column text;
BEGIN
  IF OLD.status IN ('draft', 'pending_approval', 'approved') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'notice % was discarded and never changes', OLD.id USING ERRCODE = 'RA070';
  END IF;
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'notice % has been issued: correct it with a new notice that references it', OLD.id
      USING ERRCODE = 'RA070';
  END IF;
  FOREACH v_column IN ARRAY v_set_once LOOP
    IF (to_jsonb(OLD) -> v_column) <> 'null'::jsonb AND (to_jsonb(NEW) -> v_column) IS DISTINCT FROM (to_jsonb(OLD) -> v_column) THEN
      RAISE EXCEPTION 'the % of notice % is recorded once', v_column, OLD.id USING ERRCODE = 'RA070';
    END IF;
  END LOOP;
  IF NEW.status IN ('draft', 'pending_approval', 'approved', 'cancelled') THEN
    RAISE EXCEPTION 'issued notice % cannot go back to %', OLD.id, NEW.status USING ERRCODE = 'RA070';
  END IF;
  IF OLD.status = 'closed' AND ((to_jsonb(NEW) - v_set_once - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - v_set_once - 'updated_at')) THEN
    RAISE EXCEPTION 'notice % is closed', OLD.id USING ERRCODE = 'RA070';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issued_notice_frozen BEFORE UPDATE ON notice
  FOR EACH ROW EXECUTE FUNCTION app.check_notice_update();

CREATE FUNCTION app.forbid_notice_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notices are never deleted: discard a draft, close an issued notice' USING ERRCODE = 'RA072';
END $$;
CREATE TRIGGER notice_no_delete BEFORE DELETE ON notice
  FOR EACH ROW EXECUTE FUNCTION app.forbid_notice_delete();
CREATE TRIGGER notice_no_truncate BEFORE TRUNCATE ON notice
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- CF-06: an open task is completed or cancelled once; a closed task never changes. Tasks are
-- never deleted.
CREATE FUNCTION app.check_task_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'task % is % and never changes', OLD.id, OLD.status USING ERRCODE = 'RA071';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'note', 'assignee_person_id', 'due_at', 'completed_at', 'completed_by',
        'cancelled_at', 'cancelled_by', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'note', 'assignee_person_id', 'due_at', 'completed_at',
        'completed_by', 'cancelled_at', 'cancelled_by', 'updated_at']) THEN
    RAISE EXCEPTION 'task % keeps what it is about', OLD.id USING ERRCODE = 'RA071';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_closed_once BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION app.check_task_update();
CREATE TRIGGER task_no_delete BEFORE DELETE OR TRUNCATE ON task
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- A notice's signing requests (plan 4.5) belong to it and to its property.
ALTER TABLE signing_request ADD CONSTRAINT signing_request_notice_fk
  FOREIGN KEY (company_id, property_id, notice_id) REFERENCES notice (company_id, property_id, id);
ALTER TABLE notice_recipient ADD CONSTRAINT notice_recipient_request_fk
  FOREIGN KEY (company_id, property_id, signing_request_id) REFERENCES signing_request (company_id, property_id, id);
ALTER TABLE notice ADD CONSTRAINT notice_approval_fk
  FOREIGN KEY (company_id, approval_request_id) REFERENCES approval_request (company_id, id);
ALTER TABLE notice_event ADD CONSTRAINT notice_event_message_fk
  FOREIGN KEY (company_id, message_id) REFERENCES message (company_id, id);
--> statement-breakpoint

-- 4. The s.23 bar (decision 3; prd-issues 43): no notice to quit within this many months of a Rent
-- Officer assessment. Unverified until counsel confirms. New row only; rows are never edited.
INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
VALUES ('GH', 'notice_to_quit.assessment_bar_months', '{"months": 24}'::jsonb, DATE '2000-01-01',
        'Act 220 s.23; M7 decision 3; counsel to confirm', 'unverified',
        'Effective-from date is a technical lower bound, not a legal commencement date. '
        || 'The anniversary of the assessment counts as inside the bar until counsel confirms.',
        'migration:0037_notices_security');
--> statement-breakpoint

-- 5. Notice message templates (CM-07; plan 4.6 and 4.7). The texts are `TEMPLATE_DEFINITIONS` in
-- packages/domain/src/messaging/whatsapp.ts; a test checks the two agree.
INSERT INTO message_template (key, version, whatsapp_name, category, language, body, parameters, created_by)
SELECT v.key, v.version, v.whatsapp_name, v.category, v.language, v.body, v.parameters, 'migration 0037'
FROM (VALUES
  ('notice_link', 1, 'notice_link_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has sent you a notice. Read it at {{3}} and confirm you received it with a code sent to your phone.',
   '["landlord","tenant","link"]'::jsonb),
  ('notice_reminder', 1, 'notice_reminder_v1', 'utility', 'en',
   'Hello {{2}}, a reminder from {{1}}: a notice is waiting for you at {{3}}. Please open it and confirm you received it.',
   '["landlord","tenant","link"]'::jsonb),
  ('notice_in_force', 1, 'notice_in_force_v1', 'utility', 'en',
   'Hello {{2}}, a reminder from {{1}}: the notice sent to you remains in force whether or not you sign it. Read it at {{3}} when you are ready.',
   '["landlord","tenant","link"]'::jsonb)
) AS v(key, version, whatsapp_name, category, language, body, parameters)
ON CONFLICT (key, language, version) DO NOTHING;
--> statement-breakpoint

-- 6. Row-change audit (AD-07; plan 4.8: every status change in the audit log). Recipients' phones
-- and emails are recorded only as changed, never by value.
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON notice
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON notice_recipient
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'whatsapp_phone', 'email');
CREATE TRIGGER audit_row AFTER INSERT ON service_record
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON rent_assessment
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON notice_quit_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
--> statement-breakpoint

-- 7. Grants ------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.check_notice_update(), app.forbid_notice_delete(), app.check_task_update() FROM PUBLIC;

GRANT SELECT, INSERT ON notice TO rent_app;
GRANT UPDATE (number, type, subtype, status, unit_id, block_ids, fields, template_key, template_version,
  counsel_reviewed, completion, issue_date, issued_at, effective_date, earliest_lawful_date, earliest, warnings,
  rule_versions, statutory_rule_id, bar_rule_id, electronic_service, ladder, ladder_paused, ladder_cancelled,
  ladder_reason, ladder_changed_at, ladder_changed_by, link_expires_at, render_request_id, document_id,
  document_sha256, service_pack_render_request_id, service_pack_document_id, approval_request_id,
  served_too_late, outcome, close_note, closed_at, closed_by, returned_reason, updated_at) ON notice TO rent_app;
GRANT SELECT, INSERT ON notice_recipient, notice_event, service_record, rent_assessment,
  notice_quit_acknowledgement TO rent_app;
GRANT SELECT, INSERT ON task TO rent_app;
GRANT UPDATE (status, note, assignee_person_id, due_at, completed_at, completed_by, cancelled_at, cancelled_by,
  updated_at) ON task TO rent_app;
-- M7 (plan 4.5): the first open's evidence on each token.
GRANT UPDATE (first_open_ip, first_open_user_agent) ON secure_link TO rent_app;
