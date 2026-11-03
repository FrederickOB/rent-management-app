-- Tenancy, e-signing and messaging security and integrity (M3): RLS with property and tenant
-- scope, the person functions, append-only tables, frozen lease terms, the lease machine,
-- occupancy written by triggers, no overlapping leases, audit with redaction, and grants.
-- Applied as rent_owner. See docs/plans/M3.md sections 4.2, 4.3, 4.7 and 4.9.
--
-- Error codes: RA020 template version immutable, RA021 lease terms frozen, RA022 lease
-- transition not allowed, RA023 a state's required facts missing, RA024 lease rows frozen,
-- RA025 schedule without a signature, RA026 unit status conflicts with a lease, RA027 cancelling
-- a signed lease without approval, RA028 a lease that does not start as a draft, RA029 person
-- function misuse.

-- The exclusion constraint on leases needs equality on uuid in a GiST index (M3 plan section 7).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Tenant scope (TL-01; M3 plan 4.3). A tenant-app transaction sets app.tenant_scope to the tenant
-- records of the signed-in person in that company, with set_config(..., true). Unset means the
-- transaction is not a tenant session.
CREATE FUNCTION app.tenant_scope() RETURNS uuid[]
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_scope', true), '')::uuid[] $$;

CREATE FUNCTION app.in_tenant_scope(p_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.tenant_scope() IS NULL OR p_tenant_id = ANY(app.tenant_scope()) $$;

CREATE FUNCTION app.enable_tenant_scope(p_table regclass, p_column text DEFAULT 'tenant_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY tenant_scope ON %s AS RESTRICTIVE USING (app.in_tenant_scope(%I))',
    p_table, p_column);
END $$;

-- Tables a tenant session never reads: templates, links and codes.
CREATE FUNCTION app.enable_staff_only(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY no_tenant_session ON %s AS RESTRICTIVE USING (app.tenant_scope() IS NULL)',
    p_table);
END $$;

-- The properties a tenant session sees in the register: those of its issued leases. Called
-- before the property scope is set, as app.resolve_property_scope is for staff.
CREATE FUNCTION app.resolve_tenant_property_scope(p_tenant_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT l.property_id ORDER BY l.property_id), '{}')
  FROM lease l WHERE l.tenant_id = ANY(p_tenant_ids) AND l.status <> 'draft'
$$;
--> statement-breakpoint

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'tenant', 'tenant_contact', 'id_check', 'consent_event', 'lease_template', 'lease_template_version',
  'lease', 'lease_party', 'rent_step', 'lease_charge', 'charge_period', 'signing_request', 'signer',
  'secure_link', 'otp_challenge', 'signature', 'signing_event', 'message', 'message_event'
]::regclass[]) AS t;

-- Property scope (AD-02, as in M2) on every table that carries the property.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'lease', 'lease_party', 'rent_step', 'lease_charge', 'charge_period', 'signing_request', 'signer',
  'secure_link', 'otp_challenge', 'signature', 'signing_event', 'message'
]::regclass[]) AS t;

-- Tenant scope on every table that carries the tenant. A row without a tenant is hidden from
-- tenant sessions.
SELECT app.enable_tenant_scope('tenant', 'id');
SELECT app.enable_tenant_scope(t) FROM unnest(ARRAY[
  'tenant_contact', 'id_check', 'consent_event', 'lease_party', 'rent_step', 'lease_charge',
  'charge_period', 'signing_request', 'signer', 'signature', 'signing_event', 'message'
]::regclass[]) AS t;
-- A tenant session sees issued leases only, never a draft.
CREATE POLICY tenant_scope ON lease AS RESTRICTIVE
  USING (app.tenant_scope() IS NULL OR (tenant_id = ANY(app.tenant_scope()) AND status <> 'draft'));
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'lease_template', 'lease_template_version', 'secure_link', 'otp_challenge'
]::regclass[]) AS t;
--> statement-breakpoint

-- Whether a tenant has no lease at all, whatever the session's scope. Narrow (ADR-002): one
-- boolean, for a tenant of the transaction's own company.
CREATE FUNCTION app.tenant_unleased(p_company_id uuid, p_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_company_id = app.current_company_id()
     AND NOT EXISTS (SELECT 1 FROM lease l WHERE l.company_id = p_company_id AND l.tenant_id = p_tenant_id)
$$;

-- Scoped staff see a tenant through its leases on properties in their scope (M3 plan 4.3). A
-- tenant with no lease yet is visible to the person who created it, so a scoped manager can add
-- a tenant and then draft its lease. Once any lease exists, anywhere, visibility follows the leases.
CREATE POLICY property_scope ON tenant AS RESTRICTIVE USING (
  app.property_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l
             WHERE l.company_id = tenant.company_id AND l.tenant_id = tenant.id
               AND l.property_id = ANY(app.property_scope()))
  OR (tenant.created_by = app.current_person_id() AND app.tenant_unleased(tenant.company_id, tenant.id)));

-- Contacts, identity checks and consent follow their tenant, under both scopes.
CREATE FUNCTION app.enable_tenant_visibility(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE POLICY tenant_visible ON %1$s AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM tenant t WHERE t.company_id = %1$s.company_id AND t.id = %1$s.tenant_id))',
    p_table);
END $$;
SELECT app.enable_tenant_visibility(t) FROM unnest(ARRAY[
  'tenant_contact', 'id_check', 'consent_event'
]::regclass[]) AS t;

-- A tenant session sees a lease's parties, steps, charges and schedule only with the lease itself.
CREATE FUNCTION app.enable_lease_visibility(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE POLICY lease_visible ON %1$s AS RESTRICTIVE USING (app.tenant_scope() IS NULL OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = %1$s.company_id AND l.id = %1$s.lease_id))',
    p_table);
END $$;
SELECT app.enable_lease_visibility(t) FROM unnest(ARRAY[
  'lease_party', 'rent_step', 'lease_charge', 'charge_period'
]::regclass[]) AS t;

-- Message events follow their message.
CREATE POLICY message_visible ON message_event AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM message m WHERE m.company_id = message_event.company_id AND m.id = message_event.message_id));
--> statement-breakpoint

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'consent_event', 'charge_period', 'signature', 'signing_event', 'message', 'message_event'
]::regclass[]) AS t;

-- A published template version never changes (TL-05). Only its counsel review is recorded, once,
-- and nothing deletes it.
CREATE FUNCTION app.check_template_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_review text[] := ARRAY['counsel_reviewed_at', 'counsel_reviewed_by', 'counsel_review_note'];
BEGIN
  IF (to_jsonb(NEW) - v_review) IS DISTINCT FROM (to_jsonb(OLD) - v_review) THEN
    RAISE EXCEPTION 'a lease template version never changes; publish a new version' USING ERRCODE = 'RA020';
  END IF;
  IF OLD.counsel_reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'the counsel review of a template version is recorded once' USING ERRCODE = 'RA020';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER immutable_version BEFORE UPDATE ON lease_template_version
  FOR EACH ROW EXECUTE FUNCTION app.check_template_version_update();
CREATE TRIGGER no_delete BEFORE DELETE ON lease_template_version
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON lease_template_version
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Every lease starts as a draft; paper leases are drafted, then marked signed (M3 decision 7).
CREATE FUNCTION app.check_lease_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.signed_at IS NOT NULL OR NEW.signing_method IS NOT NULL THEN
    RAISE EXCEPTION 'a lease starts as a draft' USING ERRCODE = 'RA028';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lease_insert BEFORE INSERT ON lease FOR EACH ROW EXECUTE FUNCTION app.check_lease_insert();

-- The unit, property and tenant of a lease never change. Once a lease leaves draft its terms are
-- frozen: only its status, lifecycle facts and trackers change (architecture section 3,
-- "immutable once issued"). A column added later is frozen unless it is added to this list.
CREATE FUNCTION app.freeze_lease_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'updated_at', 'signed_at', 'signing_method', 'signed_document_id',
    'activated_on', 'holding_over_since', 'ending_reason', 'ending_note', 'ending_recorded_at',
    'move_out_date', 'end_reason', 'ended_on', 'cancelled_at', 'cancel_reason',
    'rent_control_applies', 'rent_control_deadline', 'rent_control_rule_id', 'rent_control_number',
    'rent_control_registered_on', 'stamp_deadline', 'stamp_rule_id', 'stamped_on', 'stamped_document_id',
    'formal_required', 'formal_rule_id', 'formal_practitioner', 'formal_wet_signed_document_id',
    'formal_registered_on', 'formal_registration_number'];
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

CREATE TRIGGER frozen_terms BEFORE UPDATE ON lease FOR EACH ROW EXECUTE FUNCTION app.freeze_lease_terms();

-- The lease machine (M3 plan 4.7; packages/domain/src/tenancy/lease-states.ts) and what each
-- state needs. Cancelling a signed lease needs a second person's approval (AD-05, decision 6).
CREATE FUNCTION app.check_lease_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
      ('draft', 'pending_signatures'), ('draft', 'signed'), ('draft', 'cancelled'),
      ('pending_signatures', 'draft'), ('pending_signatures', 'signed'), ('pending_signatures', 'cancelled'),
      ('signed', 'active'), ('signed', 'cancelled'),
      ('active', 'ending'), ('active', 'holding_over'), ('active', 'ended'), ('active', 'terminated'),
      ('holding_over', 'ending'), ('holding_over', 'ended'), ('holding_over', 'terminated'),
      ('ending', 'ended')) THEN
    RAISE EXCEPTION 'a lease cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'RA022';
  END IF;
  IF NEW.status = 'signed' AND (NEW.signed_at IS NULL OR NEW.signing_method IS NULL
      OR (OLD.status = 'draft') <> (NEW.signing_method = 'paper')
      OR (NEW.signing_method = 'paper' AND NEW.signed_document_id IS NULL)) THEN
    RAISE EXCEPTION 'a signed lease records when and how it was signed: on paper from a draft, with the scan, or electronically'
      USING ERRCODE = 'RA023';
  END IF;
  IF NEW.status = 'signed' AND EXISTS (
      SELECT 1 FROM unit u WHERE u.company_id = NEW.company_id AND u.id = NEW.unit_id
        AND (u.archived_at IS NOT NULL OR u.availability = 'not_lettable')) THEN
    RAISE EXCEPTION 'the unit of lease % is archived or not lettable', NEW.id USING ERRCODE = 'RA026';
  END IF;
  IF (NEW.status = 'active' AND NEW.activated_on IS NULL)
     OR (NEW.status = 'holding_over' AND NEW.holding_over_since IS NULL)
     OR (NEW.status = 'ending' AND NEW.ending_reason IS NULL)
     OR (NEW.status = 'ended' AND (NEW.end_reason IS NULL OR NEW.ended_on IS NULL
         OR (NEW.end_reason = 'moved_out' AND NEW.move_out_date IS NULL)))
     OR (NEW.status = 'cancelled' AND (NEW.cancel_reason IS NULL OR NEW.cancelled_at IS NULL)) THEN
    RAISE EXCEPTION 'lease % is missing what the % state records', NEW.id, NEW.status USING ERRCODE = 'RA023';
  END IF;
  IF NEW.status = 'ended' AND NEW.end_reason = 'renewed' AND NOT EXISTS (
      SELECT 1 FROM lease r WHERE r.company_id = NEW.company_id AND r.renews_lease_id = NEW.id
        AND r.status IN ('signed', 'active', 'ending', 'holding_over')) THEN
    RAISE EXCEPTION 'lease % ends by renewal only once its renewal is signed', NEW.id USING ERRCODE = 'RA023';
  END IF;
  IF OLD.status = 'signed' AND NEW.status = 'cancelled' AND NOT EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.company_id = r.company_id AND d.request_id = r.id
      WHERE r.company_id = NEW.company_id AND r.action_type = 'lease.cancel_signed'
        AND r.subject_type = 'lease' AND r.subject_id = NEW.id::text
        AND r.status IN ('pending', 'cooling_off', 'approved')
        AND ((d.kind = 'approve' AND d.decided_by <> r.initiated_by)
          OR (d.kind = 'self_confirm' AND r.mode = 'single_user' AND d.step_up_verified))) THEN
    RAISE EXCEPTION 'cancelling signed lease % needs a second person''s approval (AD-05)', NEW.id
      USING ERRCODE = 'RA027';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lease_transition BEFORE UPDATE OF status ON lease
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_transition();

-- Parties, escalation steps and charges are frozen with their lease.
CREATE FUNCTION app.check_lease_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_company uuid;
  v_lease uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_company := OLD.company_id; v_lease := OLD.lease_id;
  ELSE
    v_company := NEW.company_id; v_lease := NEW.lease_id;
  END IF;
  SELECT status INTO v_status FROM lease WHERE company_id = v_company AND id = v_lease;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '% rows of lease % are frozen once it is issued', TG_TABLE_NAME, v_lease USING ERRCODE = 'RA024';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER frozen_with_lease BEFORE INSERT OR UPDATE OR DELETE ON lease_party
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_draft();
CREATE TRIGGER frozen_with_lease BEFORE INSERT OR UPDATE OR DELETE ON rent_step
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_draft();
CREATE TRIGGER frozen_with_lease BEFORE INSERT OR UPDATE OR DELETE ON lease_charge
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_draft();

-- The rent schedule exists only once a lease is signed (TL-06, TL-07).
CREATE FUNCTION app.check_schedule_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM lease WHERE company_id = NEW.company_id AND id = NEW.lease_id;
  IF v_status IS NULL OR v_status NOT IN ('signed', 'active', 'ending', 'holding_over') THEN
    RAISE EXCEPTION 'a rent schedule exists only for a signed lease' USING ERRCODE = 'RA025';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signed_only BEFORE INSERT ON charge_period
  FOR EACH ROW EXECUTE FUNCTION app.check_schedule_insert();

-- No two leases on one unit overlap while either holds it (PB-09; M3 plan 4.2).
ALTER TABLE lease ADD CONSTRAINT lease_no_overlap EXCLUDE USING gist (
  company_id WITH =, unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (status IN ('signed', 'active', 'ending', 'holding_over'));
--> statement-breakpoint

-- Occupancy (PB-09; M3 plan 4.7): occupied while a lease is active, ending or holding over,
-- reserved between signature and start, vacant otherwise. Derived, never stored.
CREATE FUNCTION app.occupancy_of(p_statuses text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_statuses && ARRAY['active', 'ending', 'holding_over'] THEN 'occupied'
    WHEN p_statuses && ARRAY['signed'] THEN 'reserved'
    ELSE 'vacant' END
$$;

-- Units held by a lease, and how. Security invoker, so RLS on lease applies to whoever reads it.
CREATE VIEW unit_occupancy WITH (security_invoker = true) AS
SELECT l.company_id, l.property_id, l.unit_id, app.occupancy_of(array_agg(l.status)) AS occupancy
FROM lease l
WHERE l.status IN ('signed', 'active', 'ending', 'holding_over')
GROUP BY l.company_id, l.property_id, l.unit_id;

-- Each change of occupancy goes into the unit's history (PR-06), written here and nowhere else:
-- rent_app cannot insert history rows. The lease service may name a reason for the transaction.
CREATE FUNCTION app.log_unit_occupancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_others text[];
  v_before text;
  v_after text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(status), '{}') INTO v_others FROM lease
  WHERE company_id = NEW.company_id AND unit_id = NEW.unit_id AND id <> NEW.id;
  v_before := app.occupancy_of(v_others || CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.status] ELSE '{}'::text[] END);
  v_after := app.occupancy_of(v_others || ARRAY[NEW.status]);
  IF v_before = v_after THEN
    RETURN NULL;
  END IF;
  INSERT INTO unit_status_event (company_id, property_id, unit_id, kind, from_value, to_value, reason, source,
    lease_id, actor_person_id)
  VALUES (NEW.company_id, NEW.property_id, NEW.unit_id, 'occupancy', v_before, v_after,
    nullif(current_setting('app.status_reason', true), ''), 'lease', NEW.id, app.current_person_id());
  RETURN NULL;
END $$;

CREATE TRIGGER occupancy_history AFTER INSERT OR UPDATE OF status ON lease
  FOR EACH ROW EXECUTE FUNCTION app.log_unit_occupancy();

ALTER TABLE unit_status_event ADD CONSTRAINT unit_status_event_lease_fk
  FOREIGN KEY (company_id, lease_id) REFERENCES lease (company_id, id);

-- While a lease holds a unit, its availability is only "available" or "under repair" (M3 plan
-- 4.7; architecture section 7), and the unit cannot be archived. Owned by rent_system, so the
-- check sees every lease of the unit whatever the session's scope.
CREATE FUNCTION app.check_unit_against_leases() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_held boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM lease l WHERE l.company_id = NEW.company_id AND l.unit_id = NEW.id
                 AND l.status IN ('signed', 'active', 'ending', 'holding_over')) INTO v_held;
  IF v_held AND NEW.availability NOT IN ('available', 'under_repair')
     AND NEW.availability IS DISTINCT FROM OLD.availability THEN
    RAISE EXCEPTION 'unit % has a lease, so it can only be available or under repair', NEW.code
      USING ERRCODE = 'RA026';
  END IF;
  IF v_held AND NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    RAISE EXCEPTION 'unit % has a lease, so it cannot be archived', NEW.code USING ERRCODE = 'RA026';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER unit_with_lease BEFORE UPDATE OF availability, archived_at ON unit
  FOR EACH ROW EXECUTE FUNCTION app.check_unit_against_leases();

ALTER TABLE secure_link ADD CONSTRAINT secure_link_message_fk
  FOREIGN KEY (company_id, message_id) REFERENCES message (company_id, id);
--> statement-breakpoint

-- ADR-002 system paths for tenants (TL-01, OQ-30; M3 plan 4.3), owned by rent_system.
--
-- The global person for a tenant's phone. It returns an id whether or not the person existed and
-- never changes an existing person, so a company learns nothing about other companies' tenants.
-- Only a company transaction may call it.
CREATE FUNCTION app.ensure_tenant_person(p_phone text, p_name text DEFAULT NULL, p_test_contact boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF app.current_company_id() IS NULL THEN
    RAISE EXCEPTION 'tenants are linked to people inside a company transaction' USING ERRCODE = 'RA029';
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{6,14}$' THEN
    RAISE EXCEPTION 'a tenant person needs an E.164 phone number' USING ERRCODE = 'RA029';
  END IF;
  SELECT id INTO v_id FROM person WHERE phone_number = p_phone;
  IF v_id IS NULL THEN
    v_id := uuidv7();
    INSERT INTO person (id, name, email, email_verified, phone_number, phone_number_verified, is_test_contact)
    VALUES (v_id, coalesce(nullif(btrim(p_name), ''), 'Tenant'), 'phone-' || v_id || '@users.invalid', false,
            p_phone, false, coalesce(p_test_contact, false))
    ON CONFLICT (phone_number) DO NOTHING;
    SELECT id INTO v_id FROM person WHERE phone_number = p_phone;
  END IF;
  RETURN v_id;
END $$;

-- A person's tenant records across companies, as company and tenant ids only. Only for the
-- tenant the transaction acts for, so no other session can list them.
CREATE FUNCTION app.tenancies_for_person(p_person_id uuid)
RETURNS TABLE (company_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.company_id, t.id FROM tenant t JOIN company c ON c.id = t.company_id
  WHERE t.person_id = p_person_id AND p_person_id = app.current_person_id()
    AND app.current_actor_kind() = 'tenant' AND t.archived_at IS NULL AND c.status = 'active'
  ORDER BY t.company_id, t.id
$$;

-- The company and id of a secure link, from the SHA-256 of its token, for the links API to open
-- the right company context (CLAUDE.md section 9). Nothing else about the link.
CREATE FUNCTION app.secure_link_company(p_token_hash text)
RETURNS TABLE (company_id uuid, link_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.company_id, l.id FROM secure_link l WHERE l.token_hash = p_token_hash
$$;

GRANT SELECT, INSERT ON person TO rent_system;
-- The definer functions above read the transaction's context, as every policy does.
GRANT EXECUTE ON FUNCTION app.current_company_id(), app.current_person_id(), app.current_actor_kind()
  TO rent_system;
GRANT SELECT ON tenant, lease, secure_link TO rent_system;
ALTER FUNCTION app.tenant_unleased(uuid, uuid) OWNER TO rent_system;
ALTER FUNCTION app.check_unit_against_leases() OWNER TO rent_system;
ALTER FUNCTION app.ensure_tenant_person(text, text, boolean) OWNER TO rent_system;
ALTER FUNCTION app.tenancies_for_person(uuid) OWNER TO rent_system;
ALTER FUNCTION app.secure_link_company(text) OWNER TO rent_system;
--> statement-breakpoint

-- Row-change audit (AD-07). ID numbers, TINs, phone numbers and emails are recorded only as
-- changed, never by value; template content is kept on its own immutable row.
DROP TRIGGER audit_row ON owner;
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON owner
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'email', 'tin_encrypted',
    'tin_index', 'tin_masked');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON tenant
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'whatsapp_phone', 'email',
    'id_number_encrypted', 'id_number_index', 'id_number_masked', 'tin_encrypted', 'tin_index', 'tin_masked');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON tenant_contact
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'email');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON id_check
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON consent_event
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON lease_template
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON lease_template_version
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'content');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON lease
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'service_phones', 'service_emails');
CREATE TRIGGER audit_row AFTER INSERT OR DELETE ON lease_party
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'email');
CREATE TRIGGER audit_row AFTER INSERT OR DELETE ON rent_step
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR DELETE ON lease_charge
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON signing_request
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON signer
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'email');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON secure_link
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'token_hash');
CREATE TRIGGER audit_row AFTER INSERT ON signature
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON signing_event
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
--> statement-breakpoint

-- Grants. No DELETE anywhere except the rows of a draft lease (its parties, steps and charges,
-- which the trigger above allows only while the lease is a draft). History, schedules,
-- evidence, consent and messages are insert-only.
REVOKE ALL ON FUNCTION app.tenant_scope(), app.in_tenant_scope(uuid), app.enable_tenant_scope(regclass, text),
  app.enable_staff_only(regclass), app.resolve_tenant_property_scope(uuid[]), app.tenant_unleased(uuid, uuid),
  app.enable_tenant_visibility(regclass), app.enable_lease_visibility(regclass),
  app.check_template_version_update(), app.check_lease_insert(), app.freeze_lease_terms(),
  app.check_lease_transition(), app.check_lease_draft(), app.check_schedule_insert(), app.occupancy_of(text[]),
  app.log_unit_occupancy(), app.check_unit_against_leases(), app.ensure_tenant_person(text, text, boolean),
  app.tenancies_for_person(uuid), app.secure_link_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_scope(), app.in_tenant_scope(uuid), app.resolve_tenant_property_scope(uuid[]),
  app.tenant_unleased(uuid, uuid), app.occupancy_of(text[]), app.ensure_tenant_person(text, text, boolean),
  app.tenancies_for_person(uuid), app.secure_link_company(text) TO rent_app;

GRANT SELECT ON unit_occupancy TO rent_app;
GRANT UPDATE (letting_business, vat_registered, tin_encrypted, tin_index, tin_masked) ON owner TO rent_app;
GRANT SELECT, INSERT ON tenant TO rent_app;
GRANT UPDATE (display_name, legal_name, phone, whatsapp_phone, email, occupation, business_type,
  registration_number, tin_encrypted, tin_index, tin_masked, id_type, id_number_encrypted, id_number_index,
  id_number_masked, id_status, id_verified_at, person_id, notes, is_test_contact, archived_at, updated_at)
  ON tenant TO rent_app;
GRANT SELECT, INSERT ON tenant_contact TO rent_app;
GRANT UPDATE (name, phone, email, relationship, organisation, position, notes, is_test_contact, archived_at,
  updated_at) ON tenant_contact TO rent_app;
GRANT SELECT, INSERT ON id_check TO rent_app;
GRANT UPDATE (provider_check_id, status, last_result, polls, last_polled_at, checked_at, completed_at, updated_at)
  ON id_check TO rent_app;
GRANT SELECT, INSERT ON consent_event TO rent_app;
GRANT SELECT, INSERT ON lease_template TO rent_app;
GRANT UPDATE (name, archived_at, updated_at) ON lease_template TO rent_app;
GRANT SELECT, INSERT ON lease_template_version TO rent_app;
GRANT UPDATE (counsel_reviewed_at, counsel_reviewed_by, counsel_review_note) ON lease_template_version TO rent_app;
GRANT SELECT, INSERT ON lease TO rent_app;
GRANT UPDATE (status, use, template_version_id, start_date, end_date, monthly_rent_minor, rent_cycle,
  initial_advance_months, deposit_minor, notice_days, break_from_date, break_party, break_notice_days,
  break_credit_unused_days, service_phones, service_emails, witness_required, renews_lease_id,
  advance_months_demanded, advance_rule, advance_limit_months, advance_exceeds_limit, advance_rule_id,
  advance_policy, advance_flagged, advance_checked_at, signed_at, signing_method, signed_document_id,
  activated_on, holding_over_since, ending_reason, ending_note, ending_recorded_at, move_out_date, end_reason,
  ended_on, cancelled_at, cancel_reason, rent_control_applies, rent_control_deadline, rent_control_rule_id,
  rent_control_number, rent_control_registered_on, stamp_deadline, stamp_rule_id, stamped_on, stamped_document_id,
  formal_required, formal_rule_id, formal_practitioner, formal_wet_signed_document_id, formal_registered_on,
  formal_registration_number, updated_at) ON lease TO rent_app;
GRANT SELECT, INSERT, DELETE ON lease_party, rent_step, lease_charge TO rent_app;
GRANT SELECT, INSERT ON charge_period TO rent_app;
GRANT SELECT, INSERT ON signing_request TO rent_app;
GRANT UPDATE (status, render_request_id, document_id, document_sha256, html_document_id, html_sha256,
  final_document_id, final_sha256, updated_at, opened_at, completed_at, declined_at, decline_reason,
  cancelled_at, cancel_reason) ON signing_request TO rent_app;
GRANT SELECT, INSERT ON signer TO rent_app;
GRANT UPDATE (status, first_opened_at, last_opened_at, signed_at, declined_at, decline_reason,
  failed_code_attempts, locked_until, updated_at) ON signer TO rent_app;
GRANT SELECT, INSERT ON secure_link TO rent_app;
GRANT UPDATE (revoked_at, revoke_reason, first_opened_at, last_opened_at, open_count, used_at)
  ON secure_link TO rent_app;
GRANT SELECT, INSERT ON otp_challenge TO rent_app;
GRANT UPDATE (attempts, consumed_at) ON otp_challenge TO rent_app;
GRANT SELECT, INSERT ON signature, signing_event, message, message_event TO rent_app;
