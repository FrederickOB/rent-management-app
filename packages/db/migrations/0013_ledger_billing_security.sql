-- Ledger and billing security and integrity (M4a): the chart of accounts, books made by the
-- database, the journal written only by ledger_writer and checked at commit, append-only billing
-- records, RLS with property, owner and tenant scope, owner changes frozen once a property has
-- ledger entries (with the same-day correction of M2's S5 before that), the billing start date
-- of each lease, row-level audit, and grants. Applied as rent_owner, after 0012. Functions marked
-- SECURITY DEFINER are owned by rent_system (ADR-002): each does one narrow thing and filters by
-- the company itself. See docs/plans/M4a.md section 4.2.
--
-- Error codes: RA040 journal written outside the posting service, RA041 an entry with fewer than
-- two lines, RA042 an entry that does not balance in a book, RA043 an account used in a book it
-- does not belong to, RA044 an entry dated in a locked month, RA045 an owner change once a property
-- has ledger entries, RA046 a lease's billing start changed after signing, RA047 a lease billed in
-- two books, RA048 a journal line added to an entry of another transaction.

-- 1. The chart of accounts (architecture section 4; packages/domain/src/ledger/accounts.ts) ------

INSERT INTO ledger_account (code, name, type, books) VALUES
  ('1010', 'Own bank and MoMo accounts', 'asset', ARRAY['owner', 'company', 'platform']),
  ('1050', 'Payment provider clearing', 'asset', ARRAY['owner', 'company', 'platform']),
  ('1060', 'Undeposited cash and cheques', 'asset', ARRAY['owner']),
  ('1070', 'Cash held by managing agent', 'asset', ARRAY['owner', 'company']),
  ('1100', 'Tenant receivables', 'asset', ARRAY['owner', 'platform']),
  ('1150', 'Withholding tax receivable', 'asset', ARRAY['owner']),
  ('1160', 'Withholding tax credits', 'asset', ARRAY['owner']),
  ('2010', 'Tenant prepayments', 'liability', ARRAY['owner']),
  ('2020', 'Deferred subscription revenue', 'liability', ARRAY['platform']),
  ('2090', 'Unmatched receipts', 'liability', ARRAY['owner', 'company']),
  ('2100', 'Security deposits held', 'liability', ARRAY['owner']),
  ('2200', 'Rent tax payable', 'liability', ARRAY['owner']),
  ('2210', 'VAT and levies payable', 'liability', ARRAY['owner']),
  ('2300', 'Due to managing agent', 'liability', ARRAY['owner']),
  ('2400', 'Refunds payable to tenants', 'liability', ARRAY['owner']),
  ('2500', 'Supplier payables', 'liability', ARRAY['owner']),
  ('3900', 'Opening balances', 'equity', ARRAY['owner']),
  ('4000', 'Rent income', 'income', ARRAY['owner']),
  ('4100', 'Service charge income', 'income', ARRAY['owner']),
  ('4200', 'Other tenant charges', 'income', ARRAY['owner']),
  ('4300', 'Deposit deductions retained', 'income', ARRAY['owner']),
  ('4600', 'Subscription revenue', 'income', ARRAY['platform']),
  ('5000', 'Repairs and maintenance', 'expense', ARRAY['owner']),
  ('5100', 'Management fees', 'expense', ARRAY['owner']),
  ('5200', 'Payment processing fees', 'expense', ARRAY['owner', 'company', 'platform']),
  ('5300', 'Rent tax', 'expense', ARRAY['owner']),
  ('5400', 'Other property expenses', 'expense', ARRAY['owner']),
  ('5900', 'Bad debts written off', 'expense', ARRAY['owner']);

CREATE FUNCTION app.forbid_account_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the chart of accounts changes only by migration' USING ERRCODE = 'RA001';
END $$;
CREATE TRIGGER read_only BEFORE UPDATE OR DELETE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION app.forbid_account_change();
CREATE TRIGGER read_only_truncate BEFORE TRUNCATE ON ledger_account
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_account_change();
--> statement-breakpoint

-- 2. Books, made by the database (plan 4.2): one per owner, one per company ---------------------

-- Existing owners and companies first, before the book table has RLS or audit. The platform
-- company's own book arrives with M10.
ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
ALTER TABLE owner NO FORCE ROW LEVEL SECURITY;
INSERT INTO book (company_id, kind) SELECT id, 'company' FROM company WHERE kind IN ('landlord', 'agency');
INSERT INTO book (company_id, kind, owner_id) SELECT company_id, 'owner', id FROM owner;
ALTER TABLE owner FORCE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;

-- Every new owner gets a book in the same transaction, and every new landlord or agency company
-- its company book. Owned by rent_system: the application role cannot insert books at all.
CREATE FUNCTION app.create_owner_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO book (company_id, kind, owner_id) VALUES (NEW.company_id, 'owner', NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE FUNCTION app.create_company_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind IN ('landlord', 'agency') THEN
    INSERT INTO book (company_id, kind) VALUES (NEW.id, 'company') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER owner_book AFTER INSERT ON owner FOR EACH ROW EXECUTE FUNCTION app.create_owner_book();
CREATE TRIGGER company_book AFTER INSERT ON company FOR EACH ROW EXECUTE FUNCTION app.create_company_book();
--> statement-breakpoint

-- 3. The billing start of each lease (decision 1) ---------------------------------------------

-- The first rent period that starts on or after a day: periods are monthly from the lease start,
-- computed from the anchor each time; no later than the first period after the term (held over).
-- The SQL twin of firstPeriodStartOnOrAfter in packages/domain/src/billing/invoicing.ts, used by
-- the backfill below; a test compares the two.
CREATE FUNCTION app.first_period_start_on_or_after(p_start date, p_end date, p_day date) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_start + make_interval(months => least(
    (SELECT count(*)::int FROM generate_series(0, 600) j
     WHERE (p_start + make_interval(months => j))::date <= p_end),
    coalesce((SELECT min(k) FROM generate_series(0, 600) k
              WHERE (p_start + make_interval(months => k))::date >= p_day), 600))))::date
$$;

-- The lease's frozen terms as in 0007, with billing_start_date among the columns that change
-- after drafting: it is set as the lease is signed (and only then, by the trigger below).
CREATE OR REPLACE FUNCTION app.freeze_lease_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'updated_at', 'signed_at', 'signing_method', 'signed_document_id',
    'activated_on', 'holding_over_since', 'ending_reason', 'ending_note', 'ending_recorded_at',
    'move_out_date', 'end_reason', 'ended_on', 'cancelled_at', 'cancel_reason',
    'rent_control_applies', 'rent_control_deadline', 'rent_control_rule_id', 'rent_control_number',
    'rent_control_registered_on', 'stamp_deadline', 'stamp_rule_id', 'stamped_on', 'stamped_document_id',
    'formal_required', 'formal_rule_id', 'formal_practitioner', 'formal_wet_signed_document_id',
    'formal_registered_on', 'formal_registration_number', 'billing_start_date'];
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.unit_id <> OLD.unit_id
     OR NEW.property_id <> OLD.property_id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a lease never moves to another unit or tenant; cancel the draft and start again'
      USING ERRCODE = 'RA021';
  END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'the terms of lease % are frozen once it is issued', OLD.id USING ERRCODE = 'RA021';
  END IF;
  RETURN NEW;
END $$;

-- Existing signed leases (in their company's context, so each change is audited in its chain):
-- an e-signed lease bills from its start; a paper lease from the first period starting on or
-- after the day it was recorded.
DO $$
DECLARE
  c record;
BEGIN
  ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
  FOR c IN SELECT id, time_zone FROM company ORDER BY id LOOP
    PERFORM set_config('app.company_id', c.id::text, true);
    PERFORM set_config('app.actor_kind', 'system', true);
    UPDATE lease l SET billing_start_date = CASE
        WHEN l.signing_method = 'esign' THEN l.start_date
        ELSE app.first_period_start_on_or_after(l.start_date, l.end_date,
               (l.created_at AT TIME ZONE c.time_zone)::date)
      END
    WHERE l.company_id = c.id AND l.signing_method IS NOT NULL AND l.billing_start_date IS NULL;
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
  ALTER TABLE company FORCE ROW LEVEL SECURITY;
END $$;

-- From here on the billing start is set once, as the lease is signed, and never changed.
CREATE FUNCTION app.check_billing_start() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_start_date IS NOT DISTINCT FROM OLD.billing_start_date THEN
    RETURN NEW;
  END IF;
  IF OLD.billing_start_date IS NULL AND OLD.status IN ('draft', 'pending_signatures') AND NEW.status = 'signed' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lease % records where billing starts once, as it is signed', OLD.id USING ERRCODE = 'RA046';
END $$;

CREATE TRIGGER billing_start_once BEFORE UPDATE ON lease
  FOR EACH ROW EXECUTE FUNCTION app.check_billing_start();

CREATE FUNCTION app.check_billing_start_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_start_date IS NOT NULL THEN
    RAISE EXCEPTION 'a lease records where billing starts as it is signed' USING ERRCODE = 'RA046';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER billing_start_insert BEFORE INSERT ON lease
  FOR EACH ROW EXECUTE FUNCTION app.check_billing_start_insert();
--> statement-breakpoint

-- 4. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'book', 'journal_entry', 'journal_line', 'period_lock', 'payment_reference', 'invoice', 'invoice_line',
  'invoice_line_accrual', 'payment', 'payment_match', 'payment_reversal', 'receipt', 'company_counter',
  'cash_record', 'direct_receipt', 'cash_banking', 'credit_carry_over', 'credit_note', 'write_off',
  'allocation', 'idempotent_request', 'property_ownership_correction'
]::regclass[]) AS t;

-- Property scope (AD-02, as in M2 and M3) on every table that always carries its property.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'payment_reference', 'invoice', 'invoice_line', 'invoice_line_accrual', 'payment_match', 'receipt',
  'cash_record', 'credit_carry_over', 'credit_note', 'write_off', 'allocation',
  'property_ownership_correction'
]::regclass[]) AS t;

-- Money not yet tied to a property (a transfer whose lease is not known): in scope for people who
-- see its owner. Money in the agency's account with no owner yet is for unscoped people only.
CREATE FUNCTION app.in_money_scope(p_property_id uuid, p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.property_scope() IS NULL
      OR p_property_id = ANY(app.property_scope())
      OR (p_property_id IS NULL AND p_owner_id = ANY(app.owner_scope()))
$$;

CREATE POLICY property_scope ON payment AS RESTRICTIVE USING (
  app.in_money_scope(property_id, owner_id)
  OR EXISTS (SELECT 1 FROM payment_match m WHERE m.company_id = payment.company_id
             AND m.payment_id = payment.id AND app.in_property_scope(m.property_id)));
CREATE POLICY property_scope ON direct_receipt AS RESTRICTIVE USING (app.in_money_scope(property_id, owner_id));
-- A reversal follows its payment.
CREATE POLICY payment_visible ON payment_reversal AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM payment p WHERE p.company_id = payment_reversal.company_id AND p.id = payment_reversal.payment_id));
-- Cash banked: the collector's own, or their owners' for people who see owners.
CREATE POLICY property_scope ON cash_banking AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR collector_person_id = app.current_person_id()
  OR owner_id = ANY(app.owner_scope()));

-- A book: unscoped people see every book; scoped people see the books of their owners and of the
-- owners of the properties they see; nobody scoped sees the company book.
CREATE POLICY owner_scope ON book AS RESTRICTIVE FOR SELECT USING (
  app.property_scope() IS NULL OR owner_id = ANY(app.owner_scope())
  OR EXISTS (SELECT 1 FROM property_ownership po WHERE po.company_id = book.company_id AND po.owner_id = book.owner_id));

-- Journal lines: those of the properties a scoped person sees, and lines with no property in the
-- books of their owners. Entries and locks follow their lines and books. The journal is written
-- only by unscoped transactions (the posting service runs in system and approval contexts).
CREATE POLICY property_scope ON journal_line AS RESTRICTIVE FOR SELECT USING (
  app.property_scope() IS NULL OR property_id = ANY(app.property_scope())
  OR (property_id IS NULL AND EXISTS (SELECT 1 FROM book b WHERE b.company_id = journal_line.company_id
        AND b.id = journal_line.book_id AND b.owner_id = ANY(app.owner_scope()))));
CREATE POLICY property_scope ON journal_entry AS RESTRICTIVE FOR SELECT USING (
  app.property_scope() IS NULL
  OR EXISTS (SELECT 1 FROM journal_line l WHERE l.company_id = journal_entry.company_id AND l.entry_id = journal_entry.id));
CREATE POLICY unscoped_writes ON journal_entry AS RESTRICTIVE FOR INSERT WITH CHECK (app.property_scope() IS NULL);
CREATE POLICY unscoped_writes ON journal_line AS RESTRICTIVE FOR INSERT WITH CHECK (app.property_scope() IS NULL);
CREATE POLICY book_visible ON period_lock AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM book b WHERE b.company_id = period_lock.company_id AND b.id = period_lock.book_id));

-- Each person sees only their own stored requests; a system transaction (no person) sees all.
CREATE POLICY own_requests ON idempotent_request AS RESTRICTIVE USING (
  app.current_person_id() IS NULL OR person_id IS NOT DISTINCT FROM app.current_person_id());

-- Tenant sessions (M3 plan 4.3): a tenant reads its own invoices, their lines and accruals, its
-- payments, allocations and receipts, and its payment reference; never the journal, books, cash
-- records, corrections or anything else.
SELECT app.enable_tenant_scope(t) FROM unnest(ARRAY[
  'payment_reference', 'invoice', 'invoice_line', 'invoice_line_accrual', 'payment_match', 'receipt', 'allocation'
]::regclass[]) AS t;
CREATE POLICY tenant_scope ON payment AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR tenant_id = ANY(app.tenant_scope())
  OR EXISTS (SELECT 1 FROM payment_match m WHERE m.company_id = payment.company_id
             AND m.payment_id = payment.id AND m.tenant_id = ANY(app.tenant_scope())));
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'book', 'journal_entry', 'journal_line', 'period_lock', 'payment_reversal', 'company_counter',
  'cash_record', 'direct_receipt', 'cash_banking', 'credit_carry_over', 'credit_note', 'write_off',
  'idempotent_request', 'property_ownership_correction'
]::regclass[]) AS t;
--> statement-breakpoint

-- 5. Append-only (CLAUDE.md section 6): no UPDATE, DELETE or TRUNCATE for any role -------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'book', 'journal_entry', 'journal_line', 'period_lock', 'payment_reference', 'invoice', 'invoice_line',
  'invoice_line_accrual', 'payment', 'payment_match', 'payment_reversal', 'receipt', 'cash_record',
  'direct_receipt', 'cash_banking', 'credit_carry_over', 'credit_note', 'write_off', 'allocation',
  'property_ownership_correction'
]::regclass[]) AS t;
--> statement-breakpoint

-- 6. The journal (ADR-003; plan 4.2) -----------------------------------------------------------

-- Only ledger_writer inserts journal rows, which the posting service becomes with SET LOCAL ROLE
-- inside its transaction. This holds whatever the role memberships inherit.
CREATE FUNCTION app.check_journal_writer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ledger_writer' THEN
    RAISE EXCEPTION 'only the posting service writes the journal' USING ERRCODE = 'RA040';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_writer BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.check_journal_writer();
CREATE TRIGGER journal_writer BEFORE INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION app.check_journal_writer();

-- Each line: its account belongs in its kind of book, its entry was posted in this transaction,
-- and the entry's accounting month is open in the line's book.
CREATE FUNCTION app.check_journal_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind text;
  v_books text[];
  v_entry journal_entry%ROWTYPE;
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
  IF EXISTS (SELECT 1 FROM period_lock p WHERE p.company_id = NEW.company_id AND p.book_id = NEW.book_id
             AND p.month = date_trunc('month', v_entry.accounting_date)::date) THEN
    RAISE EXCEPTION 'the month of % is locked in this book; post in the first open month', v_entry.accounting_date
      USING ERRCODE = 'RA044';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_line_valid BEFORE INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION app.check_journal_line();

-- Invariant 1, at commit: every entry has two lines or more and sums to zero within each book.
CREATE FUNCTION app.check_journal_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_entry uuid;
  v_lines int;
  v_book uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;
  SELECT count(*) INTO v_lines FROM journal_line WHERE company_id = NEW.company_id AND entry_id = v_entry;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal entry % has % lines; an entry needs two or more', v_entry, v_lines
      USING ERRCODE = 'RA041';
  END IF;
  SELECT book_id INTO v_book FROM journal_line WHERE company_id = NEW.company_id AND entry_id = v_entry
  GROUP BY book_id HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF v_book IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % does not balance in book %', v_entry, v_book USING ERRCODE = 'RA042';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entry_balanced AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_journal_entry();
CREATE CONSTRAINT TRIGGER entry_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_journal_entry();

-- The dimensions that point at billing's rows. The payment's is checked at commit: a receipt's
-- entry is written before its payment row, which records the entry.
ALTER TABLE journal_line ADD CONSTRAINT journal_line_invoice_line_fk
  FOREIGN KEY (company_id, invoice_line_id) REFERENCES invoice_line (company_id, id);
ALTER TABLE journal_line ADD CONSTRAINT journal_line_payment_fk
  FOREIGN KEY (company_id, payment_id) REFERENCES payment (company_id, id) DEFERRABLE INITIALLY DEFERRED;

-- A lease is billed in one book: its invoices all name the same one.
CREATE FUNCTION app.check_invoice_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice i WHERE i.company_id = NEW.company_id AND i.lease_id = NEW.lease_id
             AND i.book_id <> NEW.book_id) THEN
    RAISE EXCEPTION 'lease % is already billed in another book', NEW.lease_id USING ERRCODE = 'RA047';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER one_book_per_lease BEFORE INSERT ON invoice
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_book();
--> statement-breakpoint

-- 7. Locks the billing services take before reading a lease's money (plan 8, risk 2) -----------

-- One transaction at a time changes a lease's invoices, allocations and postings. Services take
-- it before anything they write is audited, so every path locks in the same order.
CREATE FUNCTION app.lock_lease_billing(p_company_id uuid, p_lease_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_lease_id::text, 11));
END $$;

-- One transaction at a time changes what a collector holds in a book (banking, reversals).
CREATE FUNCTION app.lock_collector_cash(p_company_id uuid, p_collector_id uuid, p_book_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || p_collector_id::text || ':' || p_book_id::text, 13));
END $$;
--> statement-breakpoint

-- 8. Owners once a property is billed (decision 6), and the same-day correction (M2 S5) --------

-- Whether a property has invoices, payments or journal lines, whatever the session's scope.
-- Narrow (ADR-002): one boolean, for a property of the transaction's own company.
CREATE FUNCTION app.property_has_ledger(p_company_id uuid, p_property_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_company_id = app.current_company_id() AND (
    EXISTS (SELECT 1 FROM invoice WHERE company_id = p_company_id AND property_id = p_property_id)
    OR EXISTS (SELECT 1 FROM payment WHERE company_id = p_company_id AND property_id = p_property_id)
    OR EXISTS (SELECT 1 FROM journal_line WHERE company_id = p_company_id AND property_id = p_property_id))
$$;

-- Once a property has ledger entries its owner is fixed until a transfer flow exists (Phase 2):
-- income would otherwise land in the wrong owner's book.
CREATE FUNCTION app.check_owner_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.property_has_ledger(NEW.company_id, NEW.property_id) THEN
    RAISE EXCEPTION 'property % has ledger entries, so its owner cannot change', NEW.property_id
      USING ERRCODE = 'RA045';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER owner_fixed_once_billed BEFORE INSERT ON property_ownership
  FOR EACH ROW EXECUTE FUNCTION app.check_owner_fixed();
CREATE TRIGGER owner_fixed_once_billed BEFORE INSERT ON property_ownership_correction
  FOR EACH ROW EXECUTE FUNCTION app.check_owner_fixed();

-- A corrected row no longer counts: today's owners, the shares on each date, and the owner a
-- lease names all ignore it.
CREATE OR REPLACE VIEW property_current_ownership WITH (security_invoker = true) AS
SELECT po.company_id, po.property_id, po.owner_id, po.share_bps, po.effective_from
FROM property_ownership po
WHERE NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                  WHERE c.company_id = po.company_id AND c.ownership_id = po.id)
  AND po.effective_from = (
    SELECT max(p2.effective_from) FROM property_ownership p2
    WHERE p2.company_id = po.company_id AND p2.property_id = po.property_id
      AND p2.effective_from <= current_date
      AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c2
                      WHERE c2.company_id = p2.company_id AND c2.ownership_id = p2.id));

-- Ownership shares on each date add up to the whole property (0005), counting only rows that are
-- not corrected; a correction must leave its date whole too.
CREATE OR REPLACE FUNCTION app.check_ownership_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_property uuid;
  v_date date;
  v_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'property_ownership_correction' THEN
    SELECT property_id, effective_from INTO v_property, v_date FROM property_ownership
    WHERE company_id = NEW.company_id AND id = NEW.ownership_id;
  ELSE
    v_property := NEW.property_id;
    v_date := NEW.effective_from;
  END IF;
  SELECT coalesce(sum(po.share_bps), 0) INTO v_total FROM property_ownership po
  WHERE po.company_id = NEW.company_id AND po.property_id = v_property AND po.effective_from = v_date
    AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                    WHERE c.company_id = po.company_id AND c.ownership_id = po.id);
  IF v_total <> 10000 THEN
    RAISE EXCEPTION 'ownership of property % from % totals % basis points, not 10000',
      v_property, v_date, v_total USING ERRCODE = 'RA012';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ownership_total AFTER INSERT ON property_ownership_correction
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_ownership_total();

CREATE OR REPLACE FUNCTION app.property_owner_name(p_company_id uuid, p_property_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(o.legal_name, o.display_name)
  FROM property_ownership po
  JOIN owner o ON o.company_id = po.company_id AND o.id = po.owner_id
  WHERE p_company_id = app.current_company_id() AND app.in_property_scope(p_property_id)
    AND po.company_id = p_company_id AND po.property_id = p_property_id
    AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                    WHERE c.company_id = po.company_id AND c.ownership_id = po.id)
    AND po.effective_from = (
      SELECT max(p2.effective_from) FROM property_ownership p2
      WHERE p2.company_id = po.company_id AND p2.property_id = po.property_id
        AND p2.effective_from <= current_date
        AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c2
                        WHERE c2.company_id = p2.company_id AND c2.ownership_id = p2.id))
  ORDER BY po.share_bps DESC, o.reference
  LIMIT 1
$$;
--> statement-breakpoint

-- 9. Row-change audit (AD-07): every business record. Journal entries are audited by the posting
-- service as one semantic event each (ledger.entry_posted; plan 4.2), not row by row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'book', 'period_lock', 'payment_reference', 'invoice', 'invoice_line', 'invoice_line_accrual',
    'payment', 'payment_match', 'payment_reversal', 'receipt', 'cash_record', 'direct_receipt',
    'cash_banking', 'credit_carry_over', 'credit_note', 'write_off', 'allocation',
    'property_ownership_correction'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change(%L)',
      t, 'company_id');
  END LOOP;
END $$;
--> statement-breakpoint

-- 10. Ownership and grants ---------------------------------------------------------------------

-- The definer functions read what their checks need, whatever the session's scope.
GRANT SELECT, INSERT ON book TO rent_system;
GRANT SELECT ON ledger_account, journal_entry, journal_line, period_lock, invoice, payment,
  property_ownership_correction TO rent_system;
ALTER FUNCTION app.create_owner_book() OWNER TO rent_system;
ALTER FUNCTION app.create_company_book() OWNER TO rent_system;
ALTER FUNCTION app.check_journal_line() OWNER TO rent_system;
ALTER FUNCTION app.check_journal_entry() OWNER TO rent_system;
ALTER FUNCTION app.check_invoice_book() OWNER TO rent_system;
ALTER FUNCTION app.property_has_ledger(uuid, uuid) OWNER TO rent_system;

REVOKE ALL ON FUNCTION app.forbid_account_change(), app.create_owner_book(), app.create_company_book(),
  app.first_period_start_on_or_after(date, date, date), app.check_billing_start(),
  app.check_billing_start_insert(), app.in_money_scope(uuid, uuid), app.check_journal_writer(),
  app.check_journal_line(), app.check_journal_entry(), app.check_invoice_book(),
  app.lock_lease_billing(uuid, uuid), app.lock_collector_cash(uuid, uuid, uuid),
  app.property_has_ledger(uuid, uuid), app.check_owner_fixed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.first_period_start_on_or_after(date, date, date), app.in_money_scope(uuid, uuid),
  app.lock_lease_billing(uuid, uuid), app.lock_collector_cash(uuid, uuid, uuid),
  app.property_has_ledger(uuid, uuid) TO rent_app;
GRANT EXECUTE ON FUNCTION app.current_company_id(), app.current_person_id() TO rent_system;

-- The application reads the ledger; only ledger_writer writes it (ADR-003). rent_app becomes
-- ledger_writer with SET LOCAL ROLE in the posting transaction; the bootstrap grants that
-- membership without inheritance, and the journal_writer triggers refuse anyone else.
GRANT SELECT ON ledger_account, book, journal_entry, journal_line TO rent_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON journal_entry, journal_line FROM rent_app;
GRANT USAGE ON SCHEMA public, app TO ledger_writer;
GRANT INSERT ON journal_entry, journal_line TO ledger_writer;
GRANT EXECUTE ON FUNCTION app.current_company_id(), app.property_scope(), app.tenant_scope() TO ledger_writer;

GRANT SELECT, INSERT ON period_lock, payment_reference, invoice, invoice_line, invoice_line_accrual, payment,
  payment_match, payment_reversal, receipt, cash_record, direct_receipt, cash_banking, credit_carry_over,
  credit_note, write_off, allocation, property_ownership_correction TO rent_app;
-- The billing start is set as a lease is signed (by markSigned; the trigger above allows it once).
GRANT UPDATE (billing_start_date) ON lease TO rent_app;
GRANT SELECT, INSERT ON company_counter TO rent_app;
GRANT UPDATE (value) ON company_counter TO rent_app;
-- A stored request is reserved, marked written in its write's transaction, answered, and freed
-- again (deleted) only when its request failed before writing anything.
GRANT SELECT, INSERT, DELETE ON idempotent_request TO rent_app;
GRANT UPDATE (written_at, response, completed_at) ON idempotent_request TO rent_app;
