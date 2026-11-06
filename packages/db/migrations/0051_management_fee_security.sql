-- Management fees (M9 plan 4.2): security. Applied as rent_owner, after 0050. Forced RLS with
-- owner and property scope, staff only, append-only (a take-back is a row of its own), audit.
SELECT app.enable_company_rls('management_fee');
SELECT app.enable_property_scope('management_fee');
CREATE POLICY owner_scope ON management_fee AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR management_fee.owner_id = ANY(app.owner_scope()));
SELECT app.enable_staff_only('management_fee');
SELECT app.make_append_only('management_fee');
CREATE TRIGGER audit_row AFTER INSERT ON management_fee
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
GRANT SELECT, INSERT ON management_fee TO rent_app;
