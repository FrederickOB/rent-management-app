-- M11 decisions 2 and 3 (P25): an onboarding batch's moves, and opening balances posted only after
-- a second person's approval. Applied as rent_owner, after 0069.
--
-- Error codes: RA123 an onboarding batch's move not allowed; RA124 opening balances posted without
-- an approved `opening_balances` request; RA125 an opening item written outside its batch's posting.

-- A batch moves forward only (plan 4.1, 4.2):
--   uploaded -> validating -> validated | invalid | failed; invalid or failed -> validating again;
--   validated -> validating (re-validated), committing (tenancies) or awaiting_approval (money);
--   committing -> committed | failed; awaiting_approval -> posting | rejected (rejected, cancelled
--   or expired); posting -> posted | failed. committed, posted and rejected are final.
-- What it is about (company, kind, upload, creator) never changes.
CREATE FUNCTION app.check_onboarding_batch_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.company_id, NEW.kind, NEW.upload_intent_id, NEW.storage_key, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.company_id, OLD.kind, OLD.upload_intent_id, OLD.storage_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'an onboarding batch never changes what it imports' USING ERRCODE = 'RA123';
  END IF;
  IF OLD.status IN ('committed', 'posted', 'rejected')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'onboarding batch % is % and never changes', OLD.id, OLD.status USING ERRCODE = 'RA123';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('uploaded', 'validating'), ('uploaded', 'failed'),
      ('validating', 'validated'), ('validating', 'invalid'), ('validating', 'failed'),
      ('invalid', 'validating'), ('failed', 'validating'),
      ('validated', 'validating'), ('validated', 'committing'), ('validated', 'awaiting_approval'),
      ('committing', 'committed'), ('committing', 'failed'),
      ('awaiting_approval', 'posting'), ('awaiting_approval', 'rejected'),
      ('posting', 'posted'), ('posting', 'failed')) THEN
    RAISE EXCEPTION 'an onboarding batch cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'RA123';
  END IF;
  IF NEW.status = 'committing' AND NEW.kind <> 'tenancies' THEN
    RAISE EXCEPTION 'opening balances post through a second person, not a direct commit' USING ERRCODE = 'RA123';
  END IF;
  IF NEW.status = 'awaiting_approval' AND NEW.kind = 'tenancies' THEN
    RAISE EXCEPTION 'tenancies commit directly' USING ERRCODE = 'RA123';
  END IF;
  -- RA124: posting money needs the second person's approval of this very batch (AD-05; OQ-29).
  IF NEW.status = 'posting' AND OLD.status <> 'posting' AND NOT EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
      WHERE r.company_id = NEW.company_id AND r.id = NEW.approval_request_id
        AND r.action_type = 'opening_balances'
        AND r.subject_type = 'onboarding_batch' AND r.subject_id = NEW.id::text
        AND r.status IN ('pending', 'cooling_off', 'approved')
        AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
          OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'opening balances of batch % post only once a second person approved them (AD-05)', NEW.id
      USING ERRCODE = 'RA124';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_moves BEFORE UPDATE ON onboarding_batch
  FOR EACH ROW EXECUTE FUNCTION app.check_onboarding_batch_update();

-- A batch starts uploaded, with nothing validated, committed, approved or posted.
CREATE FUNCTION app.check_onboarding_batch_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'uploaded' OR NEW.validated_at IS NOT NULL OR NEW.committed_at IS NOT NULL
     OR NEW.posted_at IS NOT NULL OR NEW.approval_request_id IS NOT NULL OR NEW.report IS NOT NULL THEN
    RAISE EXCEPTION 'an onboarding batch starts as uploaded' USING ERRCODE = 'RA123';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_starts BEFORE INSERT ON onboarding_batch
  FOR EACH ROW EXECUTE FUNCTION app.check_onboarding_batch_insert();

-- RA125: an opening item is written only while its own balances or adjustment batch is posting.
CREATE FUNCTION app.check_onboarding_item_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM onboarding_batch b
      WHERE b.company_id = NEW.company_id AND b.id = NEW.batch_id
        AND b.kind IN ('balances', 'adjustment') AND b.status = 'posting') THEN
    RAISE EXCEPTION 'opening item % is written only while its batch posts', NEW.item_key USING ERRCODE = 'RA125';
  END IF;
  IF NEW.item_key NOT LIKE 'P25:' || NEW.batch_id::text || ':%' THEN
    RAISE EXCEPTION 'opening item % does not belong to batch %', NEW.item_key, NEW.batch_id USING ERRCODE = 'RA125';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_in_posting BEFORE INSERT ON onboarding_item
  FOR EACH ROW EXECUTE FUNCTION app.check_onboarding_item_insert();

REVOKE ALL ON FUNCTION app.check_onboarding_batch_update(), app.check_onboarding_batch_insert(),
  app.check_onboarding_item_insert() FROM PUBLIC;
