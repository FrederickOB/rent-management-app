-- M9 review: owner scope, and security for the new fee and reversal tables. Applied as rent_owner,
-- after 0053.
--
-- 1. An empty owner scope sees nothing (0005's rule; review must-fix 2). 0048 and 0051 let an
--    empty `app.owner_scope()` see every owner, so an adviser or an agency client owner whose
--    scope was not saved yet saw every owner's statements, fees and money. Now:
--    - unscoped (NULL): every owner;
--    - limited to owners: those owners;
--    - limited to properties only (owner scope '{}'): an owner whose every property, as recorded,
--      is in the property scope, for rows that cover the owner's whole book (statements, figures,
--      fee terms, remittances, funding and their reversals; decision 15). For rows that name a
--      property (the snapshot and fees), the property scope policy limits them as before.
--    - neither: nothing.

-- Reads every ownership row of the company (a property-limited session sees only its own), so a
-- definer owned by rent_system (ADR-002). It answers one question about one owner.
CREATE FUNCTION app.owner_wholly_in_property_scope(p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
           SELECT 1 FROM property_ownership po
           WHERE po.company_id = app.current_company_id() AND po.owner_id = p_owner_id
             AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                             WHERE c.company_id = po.company_id AND c.ownership_id = po.id))
     AND NOT EXISTS (
           SELECT 1 FROM property_ownership po
           WHERE po.company_id = app.current_company_id() AND po.owner_id = p_owner_id
             AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                             WHERE c.company_id = po.company_id AND c.ownership_id = po.id)
             AND NOT (po.property_id = ANY(coalesce(app.property_scope(), '{}'::uuid[]))))
$$;
ALTER FUNCTION app.owner_wholly_in_property_scope(uuid) OWNER TO rent_system;
GRANT SELECT ON property_ownership, property_ownership_correction TO rent_system;
REVOKE ALL ON FUNCTION app.owner_wholly_in_property_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owner_wholly_in_property_scope(uuid) TO rent_app;

-- Rows that cover an owner's whole book.
CREATE FUNCTION app.owner_book_visible(p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN app.owner_scope() IS NULL THEN true
    WHEN cardinality(app.owner_scope()) > 0 THEN p_owner_id = ANY(app.owner_scope())
    WHEN cardinality(coalesce(app.property_scope(), '{}'::uuid[])) = 0 THEN false
    ELSE app.owner_wholly_in_property_scope(p_owner_id)
  END
$$;

-- Rows that name a property: a property-limited session is limited by the property scope policy.
CREATE FUNCTION app.owner_row_visible(p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN app.owner_scope() IS NULL THEN true
    WHEN cardinality(app.owner_scope()) > 0 THEN p_owner_id = ANY(app.owner_scope())
    ELSE cardinality(coalesce(app.property_scope(), '{}'::uuid[])) > 0
  END
$$;
REVOKE ALL ON FUNCTION app.owner_book_visible(uuid), app.owner_row_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owner_book_visible(uuid), app.owner_row_visible(uuid) TO rent_app;

DROP POLICY owner_scope ON management_fee_terms;
CREATE POLICY owner_scope ON management_fee_terms AS RESTRICTIVE
  USING (app.owner_book_visible(management_fee_terms.owner_id));
DROP POLICY owner_scope ON owner_statement;
CREATE POLICY owner_scope ON owner_statement AS RESTRICTIVE
  USING (app.owner_book_visible(owner_statement.owner_id));
DROP POLICY owner_scope ON owner_statement_figure;
CREATE POLICY owner_scope ON owner_statement_figure AS RESTRICTIVE
  USING (app.owner_book_visible(owner_statement_figure.owner_id));
DROP POLICY owner_scope ON remittance;
CREATE POLICY owner_scope ON remittance AS RESTRICTIVE
  USING (app.owner_book_visible(remittance.owner_id));
DROP POLICY owner_scope ON owner_funding;
CREATE POLICY owner_scope ON owner_funding AS RESTRICTIVE
  USING (app.owner_book_visible(owner_funding.owner_id));
DROP POLICY owner_scope ON lease_snapshot;
CREATE POLICY owner_scope ON lease_snapshot AS RESTRICTIVE
  USING (app.owner_row_visible(lease_snapshot.owner_id));
DROP POLICY owner_scope ON management_fee;
CREATE POLICY owner_scope ON management_fee AS RESTRICTIVE
  USING (app.owner_row_visible(management_fee.owner_id));
--> statement-breakpoint

-- 2. Each allocation's fee (must-fix 1) and owner money reversals (#8) ---------------------------

SELECT app.enable_company_rls('allocation_fee');
SELECT app.enable_property_scope('allocation_fee');
CREATE POLICY owner_scope ON allocation_fee AS RESTRICTIVE
  USING (app.owner_row_visible(allocation_fee.owner_id));
SELECT app.enable_staff_only('allocation_fee');
SELECT app.make_append_only('allocation_fee');
CREATE TRIGGER audit_row AFTER INSERT ON allocation_fee
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
GRANT SELECT, INSERT ON allocation_fee TO rent_app;

SELECT app.enable_company_rls('owner_money_reversal');
CREATE POLICY owner_scope ON owner_money_reversal AS RESTRICTIVE
  USING (app.owner_book_visible(owner_money_reversal.owner_id));
SELECT app.enable_staff_only('owner_money_reversal');
SELECT app.make_append_only('owner_money_reversal');
CREATE TRIGGER audit_row AFTER INSERT ON owner_money_reversal
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
GRANT SELECT, INSERT ON owner_money_reversal TO rent_app;
--> statement-breakpoint

-- 3. The agent's cash for an owner (F3) ---------------------------------------------------------
-- 1070 in one owner's book, whatever the caller's scope: a property-limited manager paying a bill
-- must be checked against all the agent holds for the owner, not the part of it they can see.
CREATE FUNCTION app.agent_cash_held(p_book_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(sum(l.amount_minor), 0)::bigint FROM journal_line l
  WHERE l.company_id = app.current_company_id() AND l.book_id = p_book_id AND l.account_code = '1070'
$$;
ALTER FUNCTION app.agent_cash_held(uuid) OWNER TO rent_system;
GRANT SELECT ON journal_line TO rent_system;
REVOKE ALL ON FUNCTION app.agent_cash_held(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.agent_cash_held(uuid) TO rent_app;
