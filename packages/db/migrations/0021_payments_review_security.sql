-- M4b review fixes (database side), after 0020. Applied as rent_owner. See docs/plans/M4b.md,
-- section 5 (review fixes).
--
-- Error codes: RA055 a payment reversed while a refund of it to its payer is live or done,
-- RA056 a management agreement without a second person's approval. RA052 gains the `sent` state.

-- 1. Refunds of unmatched money: `sent` while the provider finishes it (review item 2) -------------

CREATE OR REPLACE FUNCTION app.check_refund_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'provider_refund_ref', 'failure_reason', 'entry_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'refund % keeps what was asked', OLD.id USING ERRCODE = 'RA052';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'refunded', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('refunded', 'failed'))) THEN
    RAISE EXCEPTION 'refund % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'RA052';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_match_not_refunded() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unmatched_refund r WHERE r.company_id = NEW.company_id
             AND r.payment_id = NEW.payment_id
             AND r.status IN ('awaiting_approval', 'approved', 'sent', 'refunded')) THEN
    RAISE EXCEPTION 'payment % is being refunded to its payer, so it cannot be matched', NEW.payment_id
      USING ERRCODE = 'RA052';
  END IF;
  RETURN NEW;
END $$;

-- 2. A payment refunded to its payer (P31) is never also reversed (review F2) ----------------------

CREATE FUNCTION app.check_reversal_not_refunded() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unmatched_refund r WHERE r.company_id = NEW.company_id
             AND r.payment_id = NEW.payment_id
             AND r.status IN ('awaiting_approval', 'approved', 'sent', 'refunded')) THEN
    RAISE EXCEPTION 'payment % is being or has been refunded to its payer, so it cannot be reversed', NEW.payment_id
      USING ERRCODE = 'RA055';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reversal_not_refunded BEFORE INSERT ON payment_reversal
  FOR EACH ROW EXECUTE FUNCTION app.check_reversal_not_refunded();
ALTER FUNCTION app.check_reversal_not_refunded() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.check_reversal_not_refunded() FROM PUBLIC;
--> statement-breakpoint

-- 3. Where an owner's rent goes needs a second person (review item 1; CLAUDE.md section 5) --------
-- An agreement names the request that set it: one for that owner, approved by someone other than
-- the person who asked (or self-confirmed after the cooling-off, OQ-29). The approvals engine
-- writes the row while it executes the request, before the request closes as approved. It runs
-- as the approver, an owner or agency admin, who sees the whole company's requests.

CREATE FUNCTION app.check_agreement_approved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_request_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
      WHERE r.company_id = NEW.company_id AND r.id = NEW.approval_request_id
        AND r.action_type = 'management_agreement.change'
        AND r.subject_type = 'owner' AND r.subject_id = NEW.owner_id::text
        AND r.status IN ('pending', 'cooling_off', 'approved')
        AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
          OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'where owner %''s rent goes changes only with a second person''s approval', NEW.owner_id
      USING ERRCODE = 'RA056';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreement_approved BEFORE INSERT ON management_agreement
  FOR EACH ROW EXECUTE FUNCTION app.check_agreement_approved();
--> statement-breakpoint

-- 4. How long raw webhook bodies are kept (M4b review; CLAUDE.md section 7) ------------------------
-- No value until counsel supplies one (Act 843 s.24). Bodies with a valid signature are kept in
-- webhook_inbox; bad-signature ones keep only their size and hash. A new row only.

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
VALUES ('GH', 'data_retention.other.webhook_bodies', NULL, DATE '2000-01-01',
        'Act 843 s.24; counsel must supply', 'unverified',
        'Effective-from date is a technical lower bound, not a legal commencement date. '
        || 'No value until counsel supplies one. Covers raw provider webhook bodies in webhook_inbox.',
        'migration:0021_payments_review_security');
