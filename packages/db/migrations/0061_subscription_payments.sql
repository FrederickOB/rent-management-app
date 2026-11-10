-- M10 paying: anything the platform payments need (filled by the payments helper). Applied as
-- rent_owner, after 0060.
--
-- 1. The posting service can read RLS tables again since the support guard (0058).
-- 2. P26's journal dimensions in the platform book.

-- 1. The posting service writes journal rows as ledger_writer (SET LOCAL ROLE, ADR-003), and
-- every RLS policy it meets calls app.current_company_id(). Since 0058 that function calls
-- app.support_access_allowed(uuid) for platform admins, so ledger_writer must be able to run it
-- too, as rent_app, rent_system and rent_owner can; without it every posting (rent and P26 alike)
-- is refused with "permission denied for function support_access_allowed". The function is
-- SECURITY DEFINER, reads only whether a support grant is active, and is false for anyone but a
-- platform admin.
GRANT EXECUTE ON FUNCTION app.support_access_allowed(uuid) TO ledger_writer;
--> statement-breakpoint

-- 2. A journal line's invoice_line_id and payment_id name billing's rows (0013's foreign keys).
-- P26 (M10 plan 4.2; packages/domain/src/ledger/subscription-posting.ts) carries the subscription
-- invoice and payment ids in the same columns of the platform book, so a plain foreign key to
-- rent's tables refuses every P26 entry. The two keys become one check at commit, by the kind of
-- book: in the platform book the ids name subscription invoices and payments; in every other book,
-- as before, invoice lines and payments. So a rent line can never name a subscription record, nor
-- a P26 line a rent record (D1). All four tables refuse deletes (append-only or no-delete
-- triggers), so the keys' guard against deleting what a line names still holds.
ALTER TABLE journal_line DROP CONSTRAINT journal_line_invoice_line_fk;
ALTER TABLE journal_line DROP CONSTRAINT journal_line_payment_fk;

CREATE FUNCTION app.check_journal_line_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.invoice_line_id IS NULL AND NEW.payment_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT b.kind INTO v_kind FROM book b WHERE b.company_id = NEW.company_id AND b.id = NEW.book_id;
  IF v_kind = 'platform' THEN
    IF NEW.invoice_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM subscription_invoice i
        WHERE i.company_id = NEW.company_id AND i.id = NEW.invoice_line_id) THEN
      RAISE EXCEPTION 'journal line % names a subscription invoice that does not exist', NEW.id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM subscription_payment p
        WHERE p.company_id = NEW.company_id AND p.id = NEW.payment_id) THEN
      RAISE EXCEPTION 'journal line % names a subscription payment that does not exist', NEW.id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    IF NEW.invoice_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM invoice_line l
        WHERE l.company_id = NEW.company_id AND l.id = NEW.invoice_line_id) THEN
      RAISE EXCEPTION 'journal line % names an invoice line that does not exist', NEW.id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM payment p WHERE p.company_id = NEW.company_id AND p.id = NEW.payment_id) THEN
      RAISE EXCEPTION 'journal line % names a payment that does not exist', NEW.id
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- At commit, as the payment's key was: a receipt's entry is written before its payment row.
CREATE CONSTRAINT TRIGGER journal_line_refs AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_journal_line_refs();

-- Owned by rent_system (BYPASSRLS), as the journal's other checks, so it reads what it checks
-- whatever the session's context.
GRANT SELECT ON invoice_line, payment, subscription_invoice, subscription_payment TO rent_system;
ALTER FUNCTION app.check_journal_line_refs() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.check_journal_line_refs() FROM PUBLIC;
