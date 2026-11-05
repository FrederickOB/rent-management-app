-- A closed move-out takes its final statement (M8 e2e review, 2026-11-05). A settlement with no
-- refund closes at approval (0041), but its final statement PDF is rendered afterwards, and the
-- "closed move-out never changes" rule refused the documents.rendered job (RA088), which retried
-- for ever. The statement document and its hash may now be set once, from null, on a closed
-- move-out; every other column stays frozen, and a cancelled move-out still never changes. The
-- function is 0041's, unchanged but for that first test; CREATE OR REPLACE keeps its grants.
-- Applied as rent_owner, after 0042.

CREATE OR REPLACE FUNCTION app.check_move_out_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_fixed text[] := ARRAY['id', 'company_id', 'property_id', 'tenant_id', 'lease_id', 'unit_id', 'owner_id',
    'book_id', 'kind', 'created_by', 'created_at'];
  v_after_approval text[] := ARRAY['status', 'paid_on', 'paid_from', 'paid_reference', 'proof_document_id',
    'paid_entry_id', 'paid_by', 'statement_document_id', 'statement_sha256', 'closed_at', 'updated_at'];
  v_set_once text[] := ARRAY['paid_entry_id', 'statement_document_id', 'statement_sha256'];
  v_column text;
BEGIN
  -- 0043: a settlement with no refund closes at approval, and its final statement PDF is rendered
  -- after. A closed move-out takes its statement once, from null, and nothing else changes.
  IF OLD.status = 'closed'
     AND OLD.statement_document_id IS NULL AND OLD.statement_sha256 IS NULL
     AND NEW.statement_document_id IS NOT NULL AND NEW.statement_sha256 IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['statement_document_id', 'statement_sha256', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['statement_document_id', 'statement_sha256', 'updated_at']) THEN
    RETURN NEW;
  END IF;
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
