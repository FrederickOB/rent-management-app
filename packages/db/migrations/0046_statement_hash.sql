-- A move-out's final statement carries its document's own hash (founder, 2026-11-06; M8 review).
-- Wherever a statement is attached (approved, refund paid, or closed through 0043's path),
-- statement_sha256 must equal the SHA-256 stored with the document it names. Read by a definer
-- function, so the caller's scope never hides the document from the check. Applied as rent_owner,
-- after 0045. The trigger is named to run after move_out_machine, whose rules come first.

CREATE FUNCTION app.check_move_out_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.statement_document_id IS NOT NULL
     AND (NEW.statement_document_id IS DISTINCT FROM OLD.statement_document_id
          OR NEW.statement_sha256 IS DISTINCT FROM OLD.statement_sha256)
     AND NOT EXISTS (
       SELECT 1 FROM document d
       WHERE d.company_id = NEW.company_id AND d.id = NEW.statement_document_id
         AND d.sha256 = NEW.statement_sha256) THEN
    RAISE EXCEPTION 'the final statement of move-out % does not carry its document''s hash', NEW.id
      USING ERRCODE = 'RA092';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.check_move_out_statement() OWNER TO rent_system;
GRANT SELECT ON document TO rent_system;
REVOKE ALL ON FUNCTION app.check_move_out_statement() FROM PUBLIC;
CREATE TRIGGER move_out_statement_hash BEFORE UPDATE ON move_out
  FOR EACH ROW EXECUTE FUNCTION app.check_move_out_statement();
