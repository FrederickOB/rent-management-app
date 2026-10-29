-- Register security and integrity (M2): RLS with owner and property scope, append-only history
-- written by triggers, fixed codes, ownership shares, meter links, grants, and Ghana's regions
-- and meter suppliers. Applied as rent_owner. See docs/plans/M2.md section 4.

-- Country configuration (NFR localisation): Ghana's 16 regions (PR-03) and meter suppliers (PR-05).
UPDATE country SET
  regions = ARRAY['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra',
    'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western',
    'Western North'],
  meter_suppliers = '{"electricity": ["ECG", "NEDCo"], "water": ["Ghana Water"]}'
WHERE code = 'GH';
--> statement-breakpoint

-- Today's owners of each property: the rows with the latest date on or before today. Security
-- invoker, so RLS on property_ownership applies to whoever reads it.
CREATE VIEW property_current_ownership WITH (security_invoker = true) AS
SELECT po.company_id, po.property_id, po.owner_id, po.share_bps, po.effective_from
FROM property_ownership po
WHERE po.effective_from = (
  SELECT max(p2.effective_from) FROM property_ownership p2
  WHERE p2.company_id = po.company_id AND p2.property_id = po.property_id
    AND p2.effective_from <= current_date
);
--> statement-breakpoint

-- Scope inside a company (AD-02; architecture section 11). The request transaction sets these
-- with set_config(..., true). Unset means the session is not scoped; '{}' means it sees nothing.
CREATE FUNCTION app.property_scope() RETURNS uuid[]
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.property_scope', true), '')::uuid[] $$;

CREATE FUNCTION app.owner_scope() RETURNS uuid[]
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.owner_scope', true), '')::uuid[] $$;

CREATE FUNCTION app.in_property_scope(p_property_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.property_scope() IS NULL OR p_property_id = ANY(app.property_scope()) $$;

CREATE FUNCTION app.in_owner_scope(p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.owner_scope() IS NULL OR p_owner_id = ANY(app.owner_scope()) $$;

-- The properties a scope covers: those assigned to the person, plus those their owners hold
-- today. Called before the scope is set, so it reads every ownership row of the company.
CREATE FUNCTION app.resolve_property_scope(p_owner_ids uuid[], p_property_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT s.id ORDER BY s.id), '{}')
  FROM (
    SELECT unnest(p_property_ids) AS id
    UNION
    SELECT c.property_id FROM property_current_ownership c WHERE c.owner_id = ANY(p_owner_ids)
  ) s
$$;

-- A second, restrictive policy: a scoped session sees only rows in its scope, even when a query
-- forgets to filter. Without WITH CHECK, USING also checks writes.
CREATE FUNCTION app.enable_property_scope(p_table regclass, p_column text DEFAULT 'property_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY property_scope ON %s AS RESTRICTIVE USING (app.in_property_scope(%I))',
    p_table, p_column);
END $$;
--> statement-breakpoint

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'owner', 'portfolio', 'property', 'property_ownership', 'block', 'unit', 'unit_status_event', 'meter',
  'unit_meter', 'property_file', 'register_import'
]::regclass[]) AS t;

SELECT app.enable_property_scope('property', 'id');
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'property_ownership', 'block', 'unit', 'unit_status_event', 'meter', 'unit_meter', 'property_file'
]::regclass[]) AS t;
CREATE POLICY owner_scope ON owner AS RESTRICTIVE USING (app.in_owner_scope(id));

SELECT app.make_append_only(t) FROM unnest(ARRAY['property_ownership', 'unit_status_event']::regclass[]) AS t;
--> statement-breakpoint

-- Codes are fixed once issued and never reused (M2 plan 4.3). rent_app cannot update them either
-- (column grants below); this also stops the owner role.
CREATE FUNCTION app.forbid_code_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'the code of a % row never changes', TG_TABLE_NAME USING ERRCODE = 'RA011';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_code BEFORE UPDATE OF code ON property
  FOR EACH ROW EXECUTE FUNCTION app.forbid_code_change();
CREATE TRIGGER fixed_code BEFORE UPDATE OF code ON block
  FOR EACH ROW EXECUTE FUNCTION app.forbid_code_change();
CREATE TRIGGER fixed_code BEFORE UPDATE OF code ON unit
  FOR EACH ROW EXECUTE FUNCTION app.forbid_code_change();

ALTER TABLE property ADD CONSTRAINT property_area_code_check CHECK (split_part(code, '-', 1) = area_code);

-- A unit's code is its property code, block code and label (ACC-LEG-B2-04).
CREATE FUNCTION app.check_unit_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_expected text;
BEGIN
  SELECT p.code || '-' || b.code || '-' || NEW.label INTO v_expected
  FROM block b JOIN property p ON p.company_id = b.company_id AND p.id = b.property_id
  WHERE b.company_id = NEW.company_id AND b.id = NEW.block_id;
  IF v_expected IS DISTINCT FROM NEW.code THEN
    RAISE EXCEPTION 'unit code % does not match its property, block and label (%)', NEW.code, v_expected
      USING ERRCODE = 'RA011';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER unit_code BEFORE INSERT ON unit FOR EACH ROW EXECUTE FUNCTION app.check_unit_code();
--> statement-breakpoint

-- Ownership shares on each date add up to the whole property, and every property has an owner
-- (AD-02; ready for PR-07). Checked at commit, so a change can insert several rows first.
CREATE FUNCTION app.check_ownership_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_total bigint;
BEGIN
  SELECT coalesce(sum(share_bps), 0) INTO v_total FROM property_ownership
  WHERE company_id = NEW.company_id AND property_id = NEW.property_id AND effective_from = NEW.effective_from;
  IF v_total <> 10000 THEN
    RAISE EXCEPTION 'ownership of property % from % totals % basis points, not 10000',
      NEW.property_id, NEW.effective_from, v_total USING ERRCODE = 'RA012';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ownership_total AFTER INSERT ON property_ownership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_ownership_total();

CREATE FUNCTION app.check_property_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM property_ownership WHERE company_id = NEW.company_id AND property_id = NEW.id) THEN
    RAISE EXCEPTION 'property % has no owner', NEW.id USING ERRCODE = 'RA013';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER property_owned AFTER INSERT ON property
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_property_owned();
--> statement-breakpoint

-- Only a shared meter serves more than one unit (PR-05).
CREATE FUNCTION app.check_meter_links() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_meter uuid;
  v_type text;
  v_links bigint;
BEGIN
  IF TG_TABLE_NAME = 'meter' THEN
    v_meter := NEW.id;
  ELSE
    v_meter := NEW.meter_id;
  END IF;
  SELECT meter_type INTO v_type FROM meter WHERE company_id = NEW.company_id AND id = v_meter;
  SELECT count(*) INTO v_links FROM unit_meter WHERE company_id = NEW.company_id AND meter_id = v_meter;
  IF v_type <> 'shared' AND v_links > 1 THEN
    RAISE EXCEPTION 'only a shared meter can serve more than one unit' USING ERRCODE = 'RA014';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER meter_links AFTER INSERT ON unit_meter
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_meter_links();
CREATE CONSTRAINT TRIGGER meter_links AFTER UPDATE OF meter_type ON meter
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_meter_links();
--> statement-breakpoint

-- Unit status history (PR-06, PB-09) is written here and nowhere else, so every availability
-- change is recorded and no history row can be forged. The service may name a reason and a
-- source with set_config(..., true) in the same transaction. Occupancy rows come from leases (M3).
CREATE FUNCTION app.log_unit_availability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_from text;
  v_source text := nullif(current_setting('app.status_source', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.availability IS NOT DISTINCT FROM OLD.availability THEN
      RETURN NULL;
    END IF;
    v_from := OLD.availability;
  END IF;
  INSERT INTO unit_status_event (company_id, property_id, unit_id, kind, from_value, to_value, reason, source,
    actor_person_id)
  VALUES (NEW.company_id, NEW.property_id, NEW.id, 'availability', v_from, NEW.availability,
    nullif(current_setting('app.status_reason', true), ''),
    coalesce(v_source, CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'manual' END),
    app.current_person_id());
  RETURN NULL;
END $$;

CREATE TRIGGER availability_history AFTER INSERT OR UPDATE OF availability ON unit
  FOR EACH ROW EXECUTE FUNCTION app.log_unit_availability();
--> statement-breakpoint

-- Row-change audit (AD-07). Contact details are recorded only as changed, so an Act 843 request
-- can anonymise them in place; the import report is large and is kept on its own row.
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON owner
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'email');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON portfolio
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON property
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON property_ownership
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON block
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON unit
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON unit_status_event
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON meter
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON unit_meter
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON property_file
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON register_import
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'report');
--> statement-breakpoint

-- Grants. No DELETE on properties, blocks, units or meters: archiving keeps codes taken. Codes,
-- area codes and unit labels are not in any UPDATE grant. History rows come only from triggers.
REVOKE ALL ON FUNCTION app.property_scope(), app.owner_scope(), app.in_property_scope(uuid),
  app.in_owner_scope(uuid), app.resolve_property_scope(uuid[], uuid[]), app.enable_property_scope(regclass, text),
  app.forbid_code_change(), app.check_unit_code(), app.check_ownership_total(), app.check_property_owned(),
  app.check_meter_links(), app.log_unit_availability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.property_scope(), app.owner_scope(), app.in_property_scope(uuid),
  app.in_owner_scope(uuid), app.resolve_property_scope(uuid[], uuid[]) TO rent_app;

GRANT SELECT ON property_current_ownership TO rent_app;
GRANT SELECT, INSERT ON owner TO rent_app;
GRANT UPDATE (reference, kind, display_name, legal_name, phone, email, residence_country, time_zone, notes,
  is_test_contact, archived_at, updated_at) ON owner TO rent_app;
GRANT SELECT, INSERT ON portfolio TO rent_app;
GRANT UPDATE (name, archived_at, updated_at) ON portfolio TO rent_app;
GRANT SELECT, INSERT ON property TO rent_app;
GRANT UPDATE (portfolio_id, name, property_type, use, ghanapost_gps, region, district, mmda, town, street,
  latitude, longitude, address_source, archived_at, updated_at) ON property TO rent_app;
GRANT SELECT, INSERT ON property_ownership TO rent_app;
GRANT SELECT, INSERT ON block TO rent_app;
GRANT UPDATE (name, archived_at, updated_at) ON block TO rent_app;
GRANT SELECT, INSERT ON unit TO rent_app;
GRANT UPDATE (unit_type, bedrooms, billing_band, band_override_reason, availability, floor, description,
  amenities, archived_at, updated_at) ON unit TO rent_app;
GRANT SELECT ON unit_status_event TO rent_app;
GRANT SELECT, INSERT ON meter TO rent_app;
GRANT UPDATE (supplier, meter_number, meter_type, notes, archived_at, updated_at) ON meter TO rent_app;
GRANT SELECT, INSERT, DELETE ON unit_meter TO rent_app;
GRANT SELECT, INSERT ON property_file TO rent_app;
GRANT UPDATE (status, document_id, thumbnail_document_id, caption, error, archived_at, updated_at)
  ON property_file TO rent_app;
GRANT SELECT, INSERT ON register_import TO rent_app;
GRANT UPDATE (status, file_sha256, report, error, updated_at, validated_at, committed_at)
  ON register_import TO rent_app;
