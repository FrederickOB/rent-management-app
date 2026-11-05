-- Legal notices: the M7 review's database rules. Applied as rent_owner, after 0038. See
-- docs/plans/M7.md section 9.3.
--
-- Error codes: RA070 (as in 0037) an issued notice changed beyond what moves; RA073 a notice to quit
-- issued without a second person's approval or without the OQ-16 statement in force; RA074 a
-- recipient added to a notice already issued; RA075 an assessment corrected or voided twice, or a
-- voided one corrected.

-- 1. The voided assessments (review C4): RLS, property scope, staff only, append-only -----------

SELECT app.enable_company_rls('rent_assessment_void');
SELECT app.enable_property_scope('rent_assessment_void');
SELECT app.enable_staff_only('rent_assessment_void');
SELECT app.make_append_only('rent_assessment_void');
CREATE TRIGGER audit_row AFTER INSERT ON rent_assessment_void
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
GRANT SELECT, INSERT ON rent_assessment_void TO rent_app;
--> statement-breakpoint

-- 2. What an issued notice may still change (0037, amended) ------------------------------------
-- New: `ladder_shift_seconds` moves with the ladder flags (review D-B), and a closed notice may
-- still take the late-service flag (its detail) once, when service recorded after it closed
-- shows it was served too late (review MF-8). Everything else is as in 0037.

CREATE OR REPLACE FUNCTION app.check_notice_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_moving text[] := ARRAY['status', 'ladder_paused', 'ladder_cancelled', 'ladder_reason', 'ladder_changed_at',
    'ladder_changed_by', 'ladder_shift_seconds', 'served_too_late', 'outcome', 'close_note', 'closed_at',
    'closed_by', 'updated_at', 'document_id', 'document_sha256', 'service_pack_render_request_id',
    'service_pack_document_id'];
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
  IF OLD.served_too_late IS NOT NULL AND NEW.served_too_late IS DISTINCT FROM OLD.served_too_late THEN
    RAISE EXCEPTION 'notice % was served too late; that stays on record', OLD.id USING ERRCODE = 'RA070';
  END IF;
  IF NEW.status IN ('draft', 'pending_approval', 'approved', 'cancelled') THEN
    RAISE EXCEPTION 'issued notice % cannot go back to %', OLD.id, NEW.status USING ERRCODE = 'RA070';
  END IF;
  IF OLD.status = 'closed' AND ((to_jsonb(NEW) - v_set_once - 'updated_at' - 'served_too_late')
      IS DISTINCT FROM (to_jsonb(OLD) - v_set_once - 'updated_at' - 'served_too_late')) THEN
    RAISE EXCEPTION 'notice % is closed', OLD.id USING ERRCODE = 'RA070';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 3. A notice to quit is issued only on a second person's approval, with OQ-16 in force --------
-- (review data S4; decision 2, OQ-16, OQ-29). The approval engine records the decision before it
-- runs the action, so the decision is there when the notice moves to sent; M4b's
-- check_agreement_approved (0021) is the precedent. A single-user company's own confirmation counts
-- only after its cooling-off, with step-up (OQ-29). This guards the issuing transition; the app
-- never inserts a notice already issued.

CREATE FUNCTION app.check_quit_notice_issued() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type <> 'notice_to_quit' OR NEW.status = OLD.status
     OR OLD.status NOT IN ('draft', 'pending_approval', 'approved')
     OR NEW.status IN ('draft', 'pending_approval', 'approved', 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF NEW.approval_request_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
      WHERE r.company_id = NEW.company_id AND r.id = NEW.approval_request_id
        AND r.action_type = 'notice.issue_quit'
        AND r.subject_type = 'notice' AND r.subject_id = NEW.id::text
        AND r.status IN ('pending', 'cooling_off', 'approved')
        AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
          OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'notice to quit % is issued only on a second person''s approval', NEW.id
      USING ERRCODE = 'RA073';
  END IF;
  IF COALESCE((SELECT a.action FROM notice_quit_acknowledgement a
                WHERE a.company_id = NEW.company_id
                ORDER BY a.at DESC, a.id DESC LIMIT 1), 'withdraw') <> 'grant' THEN
    RAISE EXCEPTION 'notices to quit are switched off for company % (OQ-16)', NEW.company_id
      USING ERRCODE = 'RA073';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quit_notice_approved BEFORE UPDATE OF status ON notice
  FOR EACH ROW EXECUTE FUNCTION app.check_quit_notice_issued();
--> statement-breakpoint

-- 4. No recipient is added once a notice is issued (review data S5) ------------------------------
-- Issue writes the recipients, then the notice's `sent` event, in one transaction; after that the
-- recipients are fixed.

CREATE FUNCTION app.check_recipient_before_issue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notice_event e
             WHERE e.company_id = NEW.company_id AND e.notice_id = NEW.notice_id AND e.kind = 'sent') THEN
    RAISE EXCEPTION 'notice % has been issued: its recipients are fixed', NEW.notice_id USING ERRCODE = 'RA074';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipients_fixed_at_issue BEFORE INSERT ON notice_recipient
  FOR EACH ROW EXECUTE FUNCTION app.check_recipient_before_issue();
--> statement-breakpoint

-- 5. An assessment is corrected or voided once, never both (review C4) ---------------------------

CREATE FUNCTION app.check_assessment_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.replaces_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM rent_assessment_void v
      WHERE v.company_id = NEW.company_id AND v.assessment_id = NEW.replaces_id) THEN
    RAISE EXCEPTION 'assessment % was voided; record a new one instead', NEW.replaces_id USING ERRCODE = 'RA075';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_correction_live BEFORE INSERT ON rent_assessment
  FOR EACH ROW EXECUTE FUNCTION app.check_assessment_correction();

CREATE FUNCTION app.check_assessment_void() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rent_assessment a
             WHERE a.company_id = NEW.company_id AND a.replaces_id = NEW.assessment_id) THEN
    RAISE EXCEPTION 'assessment % was corrected; void the correction instead', NEW.assessment_id
      USING ERRCODE = 'RA075';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_void_live BEFORE INSERT ON rent_assessment_void
  FOR EACH ROW EXECUTE FUNCTION app.check_assessment_void();
--> statement-breakpoint

-- 6. Grants -------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.check_quit_notice_issued(), app.check_recipient_before_issue(),
  app.check_assessment_correction(), app.check_assessment_void() FROM PUBLIC;
GRANT UPDATE (ladder_shift_seconds) ON notice TO rent_app;
