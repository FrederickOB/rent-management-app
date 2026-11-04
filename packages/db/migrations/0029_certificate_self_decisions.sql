-- M5 review 4 (2026-11-03): a sole landlord's certificate never gets stuck. When nobody but its
-- uploader may decide it and its single-user request was cancelled or expired, the uploader raises
-- a fresh one: to confirm it (`withholding.certificate_confirm`, decision 7) or to withdraw it
-- (`withholding.certificate_withdraw`: rejected, nothing posted). Either way the request is
-- single-user, about this certificate, raised by the uploader and self-confirmed by them after the
-- cooling-off with the step-up; the certificate names it. Everywhere else RA057 still refuses the
-- uploader as the one deciding, and the check constraint refuses an uploader with no request
-- named (decision 3). Applied as rent_owner, after 0028.

CREATE OR REPLACE FUNCTION app.check_withholding_certificate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'debit_account',
    'entry_id', 'value_date', 'accounting_date', 'self_confirm_request_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'withholding certificate % keeps what was uploaded', OLD.id USING ERRCODE = 'RA057';
  END IF;
  IF OLD.status <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'withholding certificate % was already %', OLD.id, OLD.status USING ERRCODE = 'RA057';
  END IF;
  IF NEW.status NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'withholding certificate % is confirmed or rejected', OLD.id USING ERRCODE = 'RA057';
  END IF;
  IF NEW.decided_by IS NULL THEN
    RAISE EXCEPTION 'withholding certificate % needs the person deciding it', OLD.id USING ERRCODE = 'RA057';
  END IF;
  IF NEW.decided_by = OLD.uploaded_by AND NOT (
       NEW.self_confirm_request_id IS NOT NULL
       AND (NEW.status = 'confirmed' OR NEW.entry_id IS NULL)
       AND EXISTS (
         SELECT 1 FROM approval_request r
         WHERE r.company_id = OLD.company_id AND r.id = NEW.self_confirm_request_id
           AND r.subject_type = 'withholding_certificate' AND r.subject_id = OLD.id::text
           AND r.action_type = CASE NEW.status WHEN 'confirmed' THEN 'withholding.certificate_confirm'
                                               ELSE 'withholding.certificate_withdraw' END
           AND r.mode = 'single_user' AND r.initiated_by = OLD.uploaded_by
           AND EXISTS (
             SELECT 1 FROM approval_decision d
             WHERE d.company_id = r.company_id AND d.request_id = r.id AND d.kind = 'self_confirm'
               AND d.decided_by = OLD.uploaded_by AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'the person who uploaded a certificate cannot confirm or reject it (decision 3), except in a single-user company after the cooling-off (decision 7)'
      USING ERRCODE = 'RA057';
  END IF;
  IF NEW.decided_by <> OLD.uploaded_by AND NEW.self_confirm_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'withholding certificate %: only its uploader decides through a single-user request', OLD.id
      USING ERRCODE = 'RA057';
  END IF;
  RETURN NEW;
END $$;
