-- M11 (hardening and pilot readiness): security and integrity for the tables of 0067, the
-- approval eligibility check, imported paper leases, malware scan results, the rules rows of
-- decision 5, and the review's definer fixes (access control F4 and F5). Applied as rent_owner,
-- after 0067. The ops (0069), onboarding (0070), data protection (0071) and uploads (0072)
-- migrations follow with each area's own functions.
--
-- Error codes: RA018 a decision by someone not eligible when the request was made; RA120 a fixed
-- cut-over changed; RA121 a closed data protection request changed; RA122 a lease's scan
-- attached other than once, to an imported paper lease.

-- 1. Row Level Security ---------------------------------------------------------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'company_onboarding', 'onboarding_batch', 'onboarding_item', 'staff_active_day',
  'data_protection_request', 'data_protection_export', 'ops_action', 'document_scan'
]::regclass[]) AS t;

-- No tenant session sees any of them, except the scan results of the documents it may see.
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'company_onboarding', 'onboarding_batch', 'onboarding_item', 'staff_active_day',
  'data_protection_request', 'data_protection_export', 'ops_action'
]::regclass[]) AS t;

CREATE POLICY tenant_visible ON document_scan AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  -- document's own tenant policy decides which documents a tenant session sees.
  OR EXISTS (SELECT 1 FROM document d
             WHERE d.company_id = document_scan.company_id AND d.id = document_scan.document_id));

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'onboarding_item', 'staff_active_day', 'ops_action', 'document_scan', 'retention_review'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Approval eligibility (M11 review R2 F2; founder D1) ------------------------------------------
-- Who may decide a request is fixed when it is made (eligible_approvers). A decision by anyone not
-- in that set (a membership created, promoted or nominated afterwards) is refused. Null: a request
-- made before M11, decided as before.

CREATE OR REPLACE FUNCTION app.check_approval_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r approval_request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM approval_request WHERE company_id = NEW.company_id AND id = NEW.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % not found', NEW.request_id USING ERRCODE = 'RA010';
  END IF;
  IF r.status NOT IN ('pending', 'cooling_off') THEN
    RAISE EXCEPTION 'approval request % is already %', r.id, r.status USING ERRCODE = 'RA011';
  END IF;
  IF now() >= r.expires_at THEN
    RAISE EXCEPTION 'approval request % has expired', r.id USING ERRCODE = 'RA012';
  END IF;
  IF NEW.decided_by = r.initiated_by THEN
    IF NOT (NEW.kind = 'self_confirm' AND r.mode = 'single_user' AND r.status = 'cooling_off'
            AND r.cooling_off_until IS NOT NULL AND now() >= r.cooling_off_until AND NEW.step_up_verified) THEN
      RAISE EXCEPTION 'the initiator of a request can never approve it (AD-05)' USING ERRCODE = 'RA013';
    END IF;
  ELSIF NEW.kind = 'self_confirm' THEN
    RAISE EXCEPTION 'only the initiator can self-confirm after cooling off' USING ERRCODE = 'RA014';
  ELSIF r.mode = 'single_user' THEN
    RAISE EXCEPTION 'a single-user request is confirmed by its initiator after cooling off' USING ERRCODE = 'RA015';
  END IF;
  IF NEW.decided_by <> r.initiated_by AND r.eligible_approvers IS NOT NULL
     AND NOT (NEW.decided_by = ANY (r.eligible_approvers)) THEN
    RAISE EXCEPTION 'only someone eligible when the request was made can decide it (AD-05)' USING ERRCODE = 'RA018';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 3. Imported paper leases (M11 decision 2) --------------------------------------------------------
-- An imported lease names its batch; it is recorded as signed on paper before its scan arrives.
-- The scan is attached later, once, to an imported paper lease only. A lease entered by hand still
-- needs its scan as it is signed (M3 decision 7).

ALTER TABLE lease ADD CONSTRAINT lease_imported_batch_fk FOREIGN KEY (company_id, imported_batch_id)
  REFERENCES onboarding_batch (company_id, id);

CREATE OR REPLACE FUNCTION app.check_lease_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
      -- M11 decision 2: an imported paper lease's scan may follow.
      OR (NEW.signing_method = 'paper' AND NEW.signed_document_id IS NULL AND NEW.imported_batch_id IS NULL)) THEN
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

-- When, how and on which copy a lease was signed is set once, as it is signed; an imported paper
-- lease's scan is the one exception, attached once afterwards (RA122).
CREATE OR REPLACE FUNCTION app.check_lease_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.signed_at, NEW.signing_method, NEW.signed_document_id)
     IS NOT DISTINCT FROM (OLD.signed_at, OLD.signing_method, OLD.signed_document_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.signed_at IS NULL AND OLD.signing_method IS NULL AND OLD.signed_document_id IS NULL
     AND OLD.status IN ('draft', 'pending_signatures') AND NEW.status = 'signed' THEN
    RETURN NEW;
  END IF;
  IF OLD.imported_batch_id IS NOT NULL AND OLD.signing_method = 'paper'
     AND OLD.signed_document_id IS NULL AND NEW.signed_document_id IS NOT NULL
     AND (NEW.signed_at, NEW.signing_method) IS NOT DISTINCT FROM (OLD.signed_at, OLD.signing_method) THEN
    RETURN NEW;
  END IF;
  IF OLD.imported_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'the scan of imported lease % is attached once, and nothing else about its signing changes', OLD.id
      USING ERRCODE = 'RA122';
  END IF;
  RAISE EXCEPTION 'lease % records when, how and on which copy it was signed once, as it is signed', OLD.id
    USING ERRCODE = 'RA034';
END $$;
--> statement-breakpoint

-- 4. The cut-over and data protection requests -----------------------------------------------------

-- A cut-over fixed by posting opening balances never changes, and is never unfixed (RA120).
CREATE FUNCTION app.check_company_onboarding_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'a cut-over belongs to its company' USING ERRCODE = 'RA120';
  END IF;
  IF OLD.fixed_at IS NOT NULL AND (NEW.fixed_at IS DISTINCT FROM OLD.fixed_at
      OR NEW.cut_over_date <> OLD.cut_over_date) THEN
    RAISE EXCEPTION 'the cut-over is fixed once opening balances are posted' USING ERRCODE = 'RA120';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_cut_over BEFORE UPDATE ON company_onboarding
  FOR EACH ROW EXECUTE FUNCTION app.check_company_onboarding_update();

-- A completed or refused request never changes (RA121); what it is about never changes at all.
CREATE FUNCTION app.check_data_protection_request_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.company_id, NEW.tenant_id, NEW.kind, NEW.received_on, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.company_id, OLD.tenant_id, OLD.kind, OLD.received_on, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a data protection request never changes what it is about' USING ERRCODE = 'RA121';
  END IF;
  IF OLD.status IN ('completed', 'refused') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'data protection request % is closed', OLD.id USING ERRCODE = 'RA121';
  END IF;
  IF OLD.messaging_stopped_at IS NOT NULL AND NEW.messaging_stopped_at IS DISTINCT FROM OLD.messaging_stopped_at THEN
    RAISE EXCEPTION 'messaging stopped by request % stays stopped' , OLD.id USING ERRCODE = 'RA121';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closed_request BEFORE UPDATE ON data_protection_request
  FOR EACH ROW EXECUTE FUNCTION app.check_data_protection_request_update();
--> statement-breakpoint

-- 5. Scan results for documents stored before M11 ---------------------------------------------------
-- Rendered by us, or uploaded before any deployment (no pilot has run), so recorded as clean by
-- `pre_m11`. From now on a document without a result is pending (decision 6).

ALTER TABLE document NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_scan NO FORCE ROW LEVEL SECURITY;
INSERT INTO document_scan (company_id, document_id, status, engine, scanned_at)
SELECT d.company_id, d.id, 'clean', 'pre_m11', now() FROM document d
ON CONFLICT DO NOTHING;
ALTER TABLE document_scan FORCE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 6. Rules rows (decision 5; CLAUDE.md section 7) -----------------------------------------------------
-- The response time to a data protection request, and retention for the two categories that had
-- no row: null and unverified until counsel supplies them (OQ-65, OQ-14). New rows only.

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', v.key, NULL, DATE '2000-01-01', v.source, 'unverified',
       'Effective-from date is a technical lower bound, not a legal commencement date. No value until counsel supplies one.',
       'migration:0068_m11_security'
FROM (VALUES
  ('data_protection.request_response_days', 'Act 843; counsel must supply (OQ-65)'),
  ('data_retention.other.webhook_bodies', 'Act 843 s.24; counsel must supply'),
  ('data_retention.other.tenant_profile', 'Act 843 s.24; counsel must supply')
) AS v(key, source)
WHERE NOT EXISTS (SELECT 1 FROM rule r WHERE r.country = 'GH' AND r.key = v.key);
--> statement-breakpoint

-- 7. Definer functions (M11 review R2 F4 and F5) ----------------------------------------------------
-- F4: pg_temp last on every function that fixes its search_path, so a temporary table can never
-- shadow period_lock, journal_line, membership or any other table a check reads. rent_app also
-- loses TEMPORARY on this database (it uses none), which closes the same hole for functions that
-- run with the caller's path.

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('app', 'audit')
      AND (p.prosecdef OR EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f.sig);
  END LOOP;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM rent_app, PUBLIC', current_database());
END $$;

-- F5: the deposit's room is read in the company's own context only (it was callable for any).
CREATE OR REPLACE FUNCTION app.deposit_deduction_room(p_company_id uuid, p_lease_id uuid, p_move_out_id uuid)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_company_id IS DISTINCT FROM app.current_company_id() THEN
    RAISE EXCEPTION 'the deposit held is read in its own company only' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT 0 - coalesce(sum(l.amount_minor), 0) FROM journal_line l
          WHERE l.company_id = p_company_id AND l.account_code = '2100' AND l.lease_id = p_lease_id)
       - (SELECT coalesce(sum(d.amount_minor), 0) FROM deposit_deduction d
          WHERE d.company_id = p_company_id AND d.move_out_id = p_move_out_id
            AND NOT EXISTS (SELECT 1 FROM deposit_deduction_withdrawal w
                            WHERE w.company_id = d.company_id AND w.deduction_id = d.id));
END $$;
GRANT EXECUTE ON FUNCTION app.current_company_id() TO rent_system;
--> statement-breakpoint

-- 8. Audit and grants -----------------------------------------------------------------------------

CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON company_onboarding
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON onboarding_batch
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON onboarding_item
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON data_protection_request
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON data_protection_export
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON ops_action
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON document_scan
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');

GRANT SELECT, INSERT ON company_onboarding, onboarding_batch, onboarding_item, staff_active_day,
  data_protection_request, data_protection_export, ops_action, document_scan TO rent_app;
GRANT UPDATE (cut_over_date, set_by, set_at, fixed_at, updated_at) ON company_onboarding TO rent_app;
GRANT UPDATE (status, file_sha256, cut_over_date, validation_id, report, error, approval_request_id,
  updated_at, validated_at, committed_at, posted_at) ON onboarding_batch TO rent_app;
GRANT UPDATE (status, notes, outcome, messaging_stopped_at, result, updated_at, completed_at)
  ON data_protection_request TO rent_app;
GRANT UPDATE (status, document_id, error, updated_at, ready_at) ON data_protection_export TO rent_app;
-- Identity (M11 review): the name an inviter typed, and who may decide a request.
GRANT UPDATE (invited_name) ON membership TO rent_app;
-- System tables: no company, no personal data.
GRANT SELECT, INSERT ON retention_review TO rent_app;
GRANT SELECT, INSERT ON worker_heartbeat TO rent_app;
GRANT UPDATE (started_at, beat_at, beats) ON worker_heartbeat TO rent_app;
