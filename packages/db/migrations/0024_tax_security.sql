-- Advance rent and tax security and integrity (M5): RLS with property and owner scope on the new
-- company tables, staff only; append-only facts; a withholding certificate's decision taken by
-- someone other than its uploader, and only once; a GRA payment never settling an item beyond
-- what it still owes; an early termination's states; row-level audit; and grants. Applied as
-- rent_owner, after 0023. See docs/plans/M5.md section 5.
--
-- Error codes: RA057 a withholding certificate decided other than through its states, or by its
-- uploader (decision 3); RA058 a GRA payment settling an item beyond what it still owes; RA059 an
-- early termination changed other than through its states.

-- 1. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'rent_tax_item', 'rent_tax_item_line', 'withholding', 'withholding_certificate',
  'withholding_write_off', 'gra_payment', 'gra_payment_item', 'vat_payment', 'rent_tax_alert',
  'payment_advance', 'paid_until_prompt', 'early_termination', 'early_termination_refund_part'
]::regclass[]) AS t;

-- Property scope (AD-02) where a row always carries its property.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'rent_tax_item', 'rent_tax_item_line', 'withholding', 'withholding_certificate',
  'withholding_write_off', 'rent_tax_alert', 'payment_advance', 'paid_until_prompt',
  'early_termination', 'early_termination_refund_part'
]::regclass[]) AS t;

-- Payments to GRA belong to an owner, not a property: people who see that owner, and unscoped
-- people (an owner sees only their own reports). Settled items follow their payment.
CREATE POLICY owner_scope ON gra_payment AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON vat_payment AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR owner_id = ANY(app.owner_scope()));
CREATE POLICY payment_visible ON gra_payment_item AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM gra_payment g WHERE g.company_id = gra_payment_item.company_id
          AND g.id = gra_payment_item.gra_payment_id));

-- Tax and these records are for staff: tenant sessions read none of it.
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'rent_tax_item', 'rent_tax_item_line', 'withholding', 'withholding_certificate',
  'withholding_write_off', 'gra_payment', 'gra_payment_item', 'vat_payment', 'rent_tax_alert',
  'payment_advance', 'paid_until_prompt', 'early_termination', 'early_termination_refund_part'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only facts (CLAUDE.md section 6) -------------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'rent_tax_item', 'rent_tax_item_line', 'withholding', 'withholding_write_off', 'gra_payment',
  'gra_payment_item', 'vat_payment', 'rent_tax_alert', 'payment_advance', 'paid_until_prompt',
  'early_termination_refund_part'
]::regclass[]) AS t;
--> statement-breakpoint

-- 3. State machines the database keeps -------------------------------------------------------

-- A withholding certificate keeps what was uploaded. It is confirmed or rejected once, by someone
-- other than its uploader (decision 3; the check constraint holds the same), and stays so.
CREATE FUNCTION app.check_withholding_certificate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'decided_by', 'decided_at', 'reject_reason', 'debit_account',
    'entry_id', 'value_date', 'accounting_date', 'updated_at'];
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
  IF NEW.decided_by IS NULL OR NEW.decided_by = OLD.uploaded_by THEN
    RAISE EXCEPTION 'the person who uploaded a certificate cannot confirm it (decision 3)'
      USING ERRCODE = 'RA057';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withholding_certificate_states BEFORE UPDATE ON withholding_certificate
  FOR EACH ROW EXECUTE FUNCTION app.check_withholding_certificate_update();
CREATE FUNCTION app.check_withholding_certificate_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'awaiting_confirmation' OR NEW.decided_by IS NOT NULL THEN
    RAISE EXCEPTION 'a withholding certificate starts waiting for confirmation' USING ERRCODE = 'RA057';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withholding_certificate_starts BEFORE INSERT ON withholding_certificate
  FOR EACH ROW EXECUTE FUNCTION app.check_withholding_certificate_insert();
CREATE TRIGGER withholding_certificate_no_delete BEFORE DELETE OR TRUNCATE ON withholding_certificate
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- A GRA payment settles an item only up to what it still owes: its tax, net of its corrections,
-- less what earlier GRA payments settled. The tax module locks the owner's items first.
CREATE FUNCTION app.check_gra_payment_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind text;
  v_owed bigint;
BEGIN
  SELECT i.kind, i.tax_minor
      + coalesce((SELECT sum(c.tax_minor) FROM rent_tax_item c
                  WHERE c.company_id = i.company_id AND c.reverses_item_id = i.id), 0)
      - coalesce((SELECT sum(g.amount_minor) FROM gra_payment_item g
                  WHERE g.company_id = i.company_id AND g.item_id = i.id AND g.id <> NEW.id), 0)
    INTO v_kind, v_owed
  FROM rent_tax_item i WHERE i.company_id = NEW.company_id AND i.id = NEW.item_id;
  IF v_kind IS NULL OR NOT (v_kind IN ('receipt', 'carry_over') OR (v_kind = 'withholding' AND EXISTS (
       SELECT 1 FROM rent_tax_item w JOIN withholding_write_off o ON o.company_id = w.company_id AND o.withholding_id = w.withholding_id
       WHERE w.company_id = NEW.company_id AND w.id = NEW.item_id))) OR NEW.amount_minor > v_owed THEN
    RAISE EXCEPTION 'a GRA payment settles rent tax item % only up to what it still owes', NEW.item_id
      USING ERRCODE = 'RA058';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gra_payment_item_within BEFORE INSERT ON gra_payment_item
  FOR EACH ROW EXECUTE FUNCTION app.check_gra_payment_item();

-- An early termination keeps what was asked; it is settled (approved) or rejected once, and a
-- settled refund is recorded as paid once.
CREATE FUNCTION app.check_early_termination_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'settled_on', 'refund_entry_id', 'refund_accounting_date', 'paid_on',
    'paid_from', 'paid_reference', 'proof_document_id', 'paid_entry_id', 'paid_accounting_date', 'paid_by',
    'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'early termination % keeps what was asked', OLD.id USING ERRCODE = 'RA059';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_approval' AND NEW.status IN ('settled', 'rejected'))
    OR (OLD.status = 'settled' AND NEW.status = 'refund_paid' AND OLD.refund_minor > 0)) THEN
    RAISE EXCEPTION 'early termination % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'RA059';
  END IF;
  IF NEW.status = OLD.status AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'early termination % changes only with its state', OLD.id USING ERRCODE = 'RA059';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER early_termination_states BEFORE UPDATE ON early_termination
  FOR EACH ROW EXECUTE FUNCTION app.check_early_termination_update();
CREATE FUNCTION app.check_early_termination_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'an early termination starts waiting for a second person''s approval'
      USING ERRCODE = 'RA059';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER early_termination_starts BEFORE INSERT ON early_termination
  FOR EACH ROW EXECUTE FUNCTION app.check_early_termination_insert();
CREATE TRIGGER early_termination_no_delete BEFORE DELETE OR TRUNCATE ON early_termination
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- A withholding item and an offset name the withholding that caused them.
ALTER TABLE rent_tax_item ADD CONSTRAINT rent_tax_item_withholding_fk
  FOREIGN KEY (company_id, withholding_id) REFERENCES withholding (company_id, id);
-- A refunded payment is never also reversed (P13, as RA055 for P31): its refund left already.
CREATE FUNCTION app.check_reversal_not_refunded_at_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM early_termination_refund_part r WHERE r.company_id = NEW.company_id
             AND r.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % was partly refunded at an early end, so it cannot also be reversed', NEW.payment_id
      USING ERRCODE = 'RA055';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reversal_not_refunded_at_end BEFORE INSERT ON payment_reversal
  FOR EACH ROW EXECUTE FUNCTION app.check_reversal_not_refunded_at_end();
--> statement-breakpoint

-- 4. Row-change audit (AD-07): every new money and tax record. --------------------------------

CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON withholding_certificate
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON early_termination
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_tax_item', 'rent_tax_item_line', 'withholding', 'withholding_write_off',
    'gra_payment', 'gra_payment_item', 'vat_payment', 'early_termination_refund_part'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change(%L)',
      t, 'company_id');
  END LOOP;
END $$;
--> statement-breakpoint

-- 5. Ownership and grants ------------------------------------------------------------------------

GRANT SELECT ON rent_tax_item, gra_payment_item, withholding_write_off TO rent_system;
ALTER FUNCTION app.check_gra_payment_item() OWNER TO rent_system;
GRANT SELECT ON early_termination_refund_part TO rent_system;
ALTER FUNCTION app.check_reversal_not_refunded_at_end() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.check_withholding_certificate_update(),
  app.check_withholding_certificate_insert(), app.check_gra_payment_item(),
  app.check_early_termination_update(), app.check_early_termination_insert(),
  app.check_reversal_not_refunded_at_end() FROM PUBLIC;

GRANT SELECT, INSERT ON rent_tax_item, rent_tax_item_line, withholding, withholding_certificate,
  withholding_write_off, gra_payment, gra_payment_item, vat_payment, rent_tax_alert, payment_advance,
  paid_until_prompt, early_termination, early_termination_refund_part TO rent_app;
GRANT UPDATE (status, decided_by, decided_at, reject_reason, debit_account, entry_id, value_date,
  accounting_date, updated_at) ON withholding_certificate TO rent_app;
GRANT UPDATE (status, settled_on, refund_entry_id, refund_accounting_date, paid_on, paid_from,
  paid_reference, proof_document_id, paid_entry_id, paid_accounting_date, paid_by, updated_at)
  ON early_termination TO rent_app;
