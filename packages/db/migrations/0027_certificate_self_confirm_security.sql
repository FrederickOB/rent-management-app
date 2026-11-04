-- M5 decision 7 (founder, 2026-11-03; OQ-29): in a single-user company a withholding certificate's
-- uploader confirms it themselves, the way every two-person action works there: through a
-- single-user approval request, after its cooling-off, with a TOTP step-up. The approvals
-- triggers (0001) already refuse a self-confirmation before the cooling-off ends, without the
-- step-up, or in a two-person request. Here the certificate accepts its uploader as the one
-- deciding only when it names such a request: about this certificate, single-user, raised by the
-- uploader and self-confirmed by them with the step-up. Everywhere else RA057 still refuses the
-- uploader, and the check constraint refuses an uploader with no request named.

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
       NEW.status = 'confirmed' AND NEW.self_confirm_request_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM approval_request r
         WHERE r.company_id = OLD.company_id AND r.id = NEW.self_confirm_request_id
           AND r.subject_type = 'withholding_certificate' AND r.subject_id = OLD.id::text
           AND r.mode = 'single_user' AND r.initiated_by = OLD.uploaded_by
           AND EXISTS (
             SELECT 1 FROM approval_decision d
             WHERE d.company_id = r.company_id AND d.request_id = r.id AND d.kind = 'self_confirm'
               AND d.decided_by = OLD.uploaded_by AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'the person who uploaded a certificate cannot confirm it (decision 3), except in a single-user company after the cooling-off (decision 7)'
      USING ERRCODE = 'RA057';
  END IF;
  IF NEW.decided_by <> OLD.uploaded_by AND NEW.self_confirm_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'withholding certificate %: only its uploader confirms through a single-user request', OLD.id
      USING ERRCODE = 'RA057';
  END IF;
  RETURN NEW;
END $$;

-- It runs as the deciding session, which sees its own company's approval requests (the
-- approvals engine decides in an unscoped transaction).
GRANT UPDATE (self_confirm_request_id) ON withholding_certificate TO rent_app;
