-- M9 review: statement locks, issue and delivery. Applied as rent_owner, after 0053 and 0054.
--
-- 1. F1 (founder, 2026-11-06): issuing an owner statement for month M locks M and every earlier
--    month of the owner's book. A book's lock date is the last day of the latest month locked by
--    an issued statement (period_lock.source = 'owner_statement'); no journal line of the book may
--    be reported on or before it. A month locked by hand ('manual', M4a; no screen makes one)
--    still locks that month alone.
-- 2. The race between issuing and posting (review must-fix 3): issuing takes an exclusive
--    transaction advisory lock per book (app.period_lock_key) before it works the figures out;
--    the posting service takes the shared form before it reads the locks, and so does RA044 here.
--    Both take it without waiting (pg_try_advisory_xact_lock_shared): a posting transaction
--    usually holds the company's audit chain head already, which the issue needs too, so waiting
--    would deadlock. A posting that meets an issue in progress is refused (RA095 here; the posting
--    service's 409 STATEMENT_ISSUING) and its caller retries.
-- 3. RA094: a statement's figures are written in the transaction that issues it. An issued
--    statement has its period lock (checked at commit, on the issue).
-- 4. Statement email (review: its own purpose, consent and opt-outs): the purpose
--    'owner_statement'; sent_at, email_message_id and email_not_sent_reason, each set once after
--    issue. delivered_at is no longer written: delivery is read from the message's events.

-- 1 and 2. The lock key, and RA044 ------------------------------------------------------------

CREATE FUNCTION app.period_lock_key(p_book_id uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT hashtextextended('period_lock:' || p_book_id::text, 0)
$$;
REVOKE ALL ON FUNCTION app.period_lock_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.period_lock_key(uuid) TO rent_app, rent_system;

-- 0013's function, unchanged but for the lock and the F1 test (CREATE OR REPLACE keeps its owner,
-- rent_system, and its grants).
CREATE OR REPLACE FUNCTION app.check_journal_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind text;
  v_books text[];
  v_entry journal_entry%ROWTYPE;
  v_month date;
BEGIN
  SELECT kind INTO v_kind FROM book WHERE company_id = NEW.company_id AND id = NEW.book_id;
  SELECT books INTO v_books FROM ledger_account WHERE code = NEW.account_code;
  IF v_kind IS NULL OR v_books IS NULL OR NOT (v_kind = ANY(v_books)) THEN
    RAISE EXCEPTION 'account % cannot be used in a % book', NEW.account_code, coalesce(v_kind, 'missing')
      USING ERRCODE = 'RA043';
  END IF;
  SELECT * INTO v_entry FROM journal_entry WHERE company_id = NEW.company_id AND id = NEW.entry_id;
  IF NOT FOUND OR v_entry.posted_at <> now() THEN
    RAISE EXCEPTION 'journal lines are written with their entry, in its transaction' USING ERRCODE = 'RA048';
  END IF;
  -- An owner statement being issued for this book holds the exclusive form until it commits.
  IF NOT pg_try_advisory_xact_lock_shared(app.period_lock_key(NEW.book_id)) THEN
    RAISE EXCEPTION 'an owner statement is being issued for this book; post again in a moment'
      USING ERRCODE = 'RA095';
  END IF;
  v_month := date_trunc('month', v_entry.accounting_date)::date;
  IF EXISTS (SELECT 1 FROM period_lock p WHERE p.company_id = NEW.company_id AND p.book_id = NEW.book_id
             AND (p.month = v_month OR (p.source = 'owner_statement' AND p.month >= v_month))) THEN
    RAISE EXCEPTION 'the month of % is locked in this book; post in the first open month', v_entry.accounting_date
      USING ERRCODE = 'RA044';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 3. A statement's figures, and its lock ----------------------------------------------------------

-- 0048's RA094, plus: the statement was issued in this transaction (its row was last written by
-- it), so figures are never added to a statement issued earlier.
CREATE OR REPLACE FUNCTION app.check_owner_statement_figure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owner_statement s WHERE s.company_id = NEW.company_id AND s.id = NEW.statement_id
                 AND s.owner_id = NEW.owner_id AND s.status = 'issued'
                 AND s.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'figures are stored for an issued statement of their owner, in the transaction that issues it'
      USING ERRCODE = 'RA094';
  END IF;
  RETURN NEW;
END $$;

-- Checked at commit when a draft is issued: the statement's month is locked in its book. Read by
-- a definer, so the issuer's scope never hides the lock.
CREATE FUNCTION app.check_owner_statement_locked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'issued' AND NOT EXISTS (
       SELECT 1 FROM period_lock p
       WHERE p.company_id = NEW.company_id AND p.book_id = NEW.book_id AND p.month = NEW.first_day) THEN
    RAISE EXCEPTION 'owner statement % was issued without locking its month', NEW.id USING ERRCODE = 'RA096';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app.check_owner_statement_locked() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.check_owner_statement_locked() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER owner_statement_locked AFTER UPDATE OF status ON owner_statement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'issued')
  EXECUTE FUNCTION app.check_owner_statement_locked();
--> statement-breakpoint

-- 4. Delivery: the purpose, and the columns set once ------------------------------------------------

ALTER TABLE "message" DROP CONSTRAINT "message_purpose_check";
ALTER TABLE "message" ADD CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert', 'conversation_reply', 'bot_reply', 'broadcast', 'opt_out_confirmation', 'consent_request', 'overdue_alert', 'renewal_reminder', 'paid_until_prompt', 'inbound', 'notice_link', 'notice_reminder', 'notice_in_force', 'maintenance_alert', 'job_sheet_link', 'repair_update', 'final_statement', 'owner_statement'));

-- 0048's RA093, plus the delivery columns: on an issued statement, sent_at with email_message_id,
-- or email_not_sent_reason, each set once from null; a draft has none of them.
CREATE OR REPLACE FUNCTION app.check_owner_statement_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.owner_id <> OLD.owner_id OR NEW.book_id <> OLD.book_id
     OR NEW.month <> OLD.month OR NEW.first_day <> OLD.first_day OR NEW.last_day <> OLD.last_day THEN
    RAISE EXCEPTION 'owner statement % keeps its owner and month', OLD.id USING ERRCODE = 'RA093';
  END IF;
  IF NEW.email_not_sent_reason IS NOT NULL
     AND NEW.email_not_sent_reason NOT IN ('no_email', 'no_consent', 'opted_out') THEN
    RAISE EXCEPTION 'owner statement %: % is not a reason an email was not sent', OLD.id, NEW.email_not_sent_reason
      USING ERRCODE = 'RA093';
  END IF;
  IF (NEW.sent_at IS NULL) <> (NEW.email_message_id IS NULL)
     OR (NEW.sent_at IS NOT NULL AND NEW.email_not_sent_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'owner statement % was either emailed (with its message) or not, with a reason', OLD.id
      USING ERRCODE = 'RA093';
  END IF;
  IF OLD.status = 'issued' THEN
    -- Once issued: only the PDF (render, document and hash) and its delivery, each once.
    IF NEW.status <> 'issued' OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
       OR NEW.template_key <> OLD.template_key OR NEW.template_version <> OLD.template_version
       OR (OLD.render_request_id IS NOT NULL AND NEW.render_request_id IS DISTINCT FROM OLD.render_request_id)
       OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
       OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
       OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
       OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
       OR (OLD.email_message_id IS NOT NULL AND NEW.email_message_id IS DISTINCT FROM OLD.email_message_id)
       OR (OLD.email_not_sent_reason IS NOT NULL
           AND NEW.email_not_sent_reason IS DISTINCT FROM OLD.email_not_sent_reason)
       OR (OLD.sent_at IS NOT NULL AND NEW.email_not_sent_reason IS NOT NULL)
       OR (OLD.email_not_sent_reason IS NOT NULL AND NEW.sent_at IS NOT NULL) THEN
      RAISE EXCEPTION 'owner statement % was issued and is frozen', OLD.id USING ERRCODE = 'RA093';
    END IF;
  ELSIF NEW.document_id IS NOT NULL OR NEW.sha256 IS NOT NULL OR NEW.delivered_at IS NOT NULL
        OR NEW.sent_at IS NOT NULL OR NEW.email_message_id IS NOT NULL
        OR NEW.email_not_sent_reason IS NOT NULL THEN
    RAISE EXCEPTION 'draft statement % has no PDF or delivery', OLD.id USING ERRCODE = 'RA093';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (sent_at, email_message_id, email_not_sent_reason) ON owner_statement TO rent_app;
