-- Owner reporting: security and integrity (M9 plan 4.6). Applied as rent_owner, after 0047.
-- Forced RLS on every new table, with owner scope (an owner and their adviser see their own
-- owner's rows only, decision 15) and property scope where a row has a property; staff only (no
-- tenant session); append-only where a row holds money or evidence; an issued statement frozen;
-- row audit; grants. Error codes: RA093 an issued statement changed (only its PDF and delivery are
-- recorded, once); RA094 a statement figure for a statement not issued.

-- 1. Row Level Security -------------------------------------------------------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'management_fee_terms', 'owner_statement', 'owner_statement_figure', 'remittance', 'owner_funding',
  'lease_snapshot', 'metric_daily', 'dashboard_export'
]::regclass[]) AS t;

SELECT app.enable_property_scope('lease_snapshot');

-- Owner scope (decision 15, as 0045): limits rows only when the session's scope names owners. An
-- issued statement belongs to its owner's book, whatever happens to the property later.
CREATE POLICY owner_scope ON management_fee_terms AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR management_fee_terms.owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON owner_statement AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR owner_statement.owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON owner_statement_figure AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR owner_statement_figure.owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON remittance AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR remittance.owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON owner_funding AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR owner_funding.owner_id = ANY(app.owner_scope()));
CREATE POLICY owner_scope ON lease_snapshot AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR lease_snapshot.owner_id = ANY(app.owner_scope()));

SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'management_fee_terms', 'owner_statement', 'owner_statement_figure', 'remittance', 'owner_funding',
  'lease_snapshot', 'metric_daily', 'dashboard_export'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only --------------------------------------------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'management_fee_terms', 'owner_statement_figure', 'remittance', 'owner_funding'
]::regclass[]) AS t;
--> statement-breakpoint

-- 3. A statement is frozen once issued ----------------------------------------------------------

CREATE FUNCTION app.check_owner_statement_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.owner_id <> OLD.owner_id OR NEW.book_id <> OLD.book_id
     OR NEW.month <> OLD.month OR NEW.first_day <> OLD.first_day OR NEW.last_day <> OLD.last_day THEN
    RAISE EXCEPTION 'owner statement % keeps its owner and month', OLD.id USING ERRCODE = 'RA093';
  END IF;
  IF OLD.status = 'issued' THEN
    -- Once issued: only the PDF (render, document and hash, each once) and its delivery.
    IF NEW.status <> 'issued' OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
       OR NEW.template_key <> OLD.template_key OR NEW.template_version <> OLD.template_version
       OR (OLD.render_request_id IS NOT NULL AND NEW.render_request_id IS DISTINCT FROM OLD.render_request_id)
       OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
       OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
       OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
      RAISE EXCEPTION 'owner statement % was issued and is frozen', OLD.id USING ERRCODE = 'RA093';
    END IF;
  ELSIF NEW.document_id IS NOT NULL OR NEW.sha256 IS NOT NULL OR NEW.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'draft statement % has no PDF or delivery', OLD.id USING ERRCODE = 'RA093';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_statement_frozen BEFORE UPDATE ON owner_statement
  FOR EACH ROW EXECUTE FUNCTION app.check_owner_statement_update();
CREATE TRIGGER no_delete BEFORE DELETE ON owner_statement FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Figures are stored once, when the statement is issued, and only for its own owner.
CREATE FUNCTION app.check_owner_statement_figure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owner_statement s WHERE s.company_id = NEW.company_id AND s.id = NEW.statement_id
                 AND s.owner_id = NEW.owner_id AND s.status = 'issued') THEN
    RAISE EXCEPTION 'figures are stored for an issued statement of their owner' USING ERRCODE = 'RA094';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_statement_figure_issued BEFORE INSERT ON owner_statement_figure
  FOR EACH ROW EXECUTE FUNCTION app.check_owner_statement_figure();
--> statement-breakpoint

-- 4. Audit and grants ---------------------------------------------------------------------------

CREATE TRIGGER audit_row AFTER INSERT ON management_fee_terms
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON owner_statement
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON remittance
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON owner_funding
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');

REVOKE ALL ON FUNCTION app.check_owner_statement_update(), app.check_owner_statement_figure() FROM PUBLIC;
GRANT SELECT, INSERT ON management_fee_terms, owner_statement_figure, remittance, owner_funding TO rent_app;
GRANT SELECT, INSERT ON owner_statement TO rent_app;
GRANT UPDATE (status, template_key, template_version, generated_at, issued_at, issued_by, render_request_id,
  document_id, sha256, delivered_at, updated_at) ON owner_statement TO rent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lease_snapshot, metric_daily TO rent_app;
GRANT SELECT, INSERT ON dashboard_export TO rent_app;
GRANT UPDATE (status, document_id) ON dashboard_export TO rent_app;
