-- M3 review fixes: integrity and security (docs/plans/M3.md section 5, "Progress, review fixes").
-- Applied as rent_owner, after 0010. Functions marked SECURITY DEFINER are owned by rent_system
-- (ADR-002): each does one narrow thing and filters by the company itself.
--
-- Error codes: RA030 a new lease while the tenant holds over, RA031 a lease that starts on a day
-- another lease of the unit is already charged for, RA032 a charge on a day another lease of the
-- unit charges or holds, RA033 archiving a tenant who holds a lease, RA034 a lease's signing
-- evidence changed, RA035 a closed signing request or its fingerprints changed, RA036 a signer's
-- signature or decline changed.

-- 1. A lease out for signature holds its unit (finding 2) ---------------------------------------

-- No two leases on one unit overlap while either holds it, a lease waiting for signatures included,
-- so a completed signing never finds the unit taken.
ALTER TABLE lease DROP CONSTRAINT lease_no_overlap;
ALTER TABLE lease ADD CONSTRAINT lease_no_overlap EXCLUDE USING gist (
  company_id WITH =, unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (status IN ('pending_signatures', 'signed', 'active', 'ending', 'holding_over'));
--> statement-breakpoint

-- The units a lease holds or waits to hold, for the register's guards and its import's dry run.
-- Occupancy (unit_occupancy) is unchanged: a lease waiting for signatures neither reserves nor
-- occupies the unit (PB-09). Security invoker, so RLS on lease applies to whoever reads it.
CREATE VIEW unit_lease_hold WITH (security_invoker = true) AS
SELECT DISTINCT l.company_id, l.property_id, l.unit_id
FROM lease l
WHERE l.status IN ('pending_signatures', 'signed', 'active', 'ending', 'holding_over');
GRANT SELECT ON unit_lease_hold TO rent_app;

-- While a lease holds the unit (or waits for signatures), its availability is only "available"
-- or "under repair", and the unit cannot be archived.
CREATE OR REPLACE FUNCTION app.check_unit_against_leases() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_held boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM lease l WHERE l.company_id = NEW.company_id AND l.unit_id = NEW.id
                 AND l.status IN ('pending_signatures', 'signed', 'active', 'ending', 'holding_over'))
    INTO v_held;
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
--> statement-breakpoint

-- 2. No two leases charge a unit for the same day (finding 3) -----------------------------------

-- One transaction at a time changes what holds or charges a unit. Services take it before any
-- lease row lock, so every path locks in the same order; the triggers below take it again.
CREATE FUNCTION app.lock_unit_leases(p_company_id uuid, p_unit_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_unit_id::text, 7));
END $$;

-- When a lease starts to hold its unit (sent for signing, or recorded as signed on paper) and when
-- it is signed: its unit is live and lettable; no other lease of the unit has charged any day of
-- its term; and, when it starts to hold the unit, no earlier lease is held over (holding over, or
-- active or ending past its end date with no move-out recorded) unless this lease renews it. A
-- held-over tenancy holds the unit open-ended until it ends, so the tenant's move-out comes first.
CREATE FUNCTION app.check_lease_holds_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_today date;
  v_held uuid;
  v_charged uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('pending_signatures', 'signed') THEN
    RETURN NEW;
  END IF;
  PERFORM app.lock_unit_leases(NEW.company_id, NEW.unit_id);
  IF EXISTS (SELECT 1 FROM unit u WHERE u.company_id = NEW.company_id AND u.id = NEW.unit_id
             AND (u.archived_at IS NOT NULL OR u.availability = 'not_lettable')) THEN
    RAISE EXCEPTION 'the unit of lease % is archived or not lettable', NEW.id USING ERRCODE = 'RA026';
  END IF;
  IF OLD.status = 'draft' THEN
    SELECT (now() AT TIME ZONE c.time_zone)::date INTO v_today FROM company c WHERE c.id = NEW.company_id;
    SELECT l.id INTO v_held FROM lease l
    WHERE l.company_id = NEW.company_id AND l.unit_id = NEW.unit_id AND l.id <> NEW.id
      AND l.start_date < NEW.start_date
      AND (l.status = 'holding_over' OR (l.status IN ('active', 'ending') AND l.end_date < v_today))
      AND l.id IS DISTINCT FROM NEW.renews_lease_id
    LIMIT 1;
    IF v_held IS NOT NULL THEN
      RAISE EXCEPTION 'the tenant of lease % is holding over on this unit; record their move-out first', v_held
        USING ERRCODE = 'RA030';
    END IF;
  END IF;
  SELECT l.id INTO v_charged FROM lease l
  WHERE l.company_id = NEW.company_id AND l.unit_id = NEW.unit_id AND l.id <> NEW.id
    AND l.status IN ('signed', 'active', 'ending', 'holding_over')
    AND EXISTS (SELECT 1 FROM charge_period p WHERE p.company_id = l.company_id AND p.lease_id = l.id
                AND daterange(p.period_start, p.period_end, '[]') && daterange(NEW.start_date, NEW.end_date, '[]'))
  LIMIT 1;
  IF v_charged IS NOT NULL THEN
    RAISE EXCEPTION 'lease % starts on a day lease % is already charged for', NEW.id, v_charged
      USING ERRCODE = 'RA031';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lease_holds_unit BEFORE UPDATE OF status ON lease
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_holds_unit();

-- A charge period is refused on any day another lease of the unit charges, or holds while it is
-- out for signature, signed or current. Leases that have ended keep their rows (an early move-out
-- leaves later rows for M4a's invoicing and M5's early-termination rules).
CREATE FUNCTION app.check_charge_period_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_unit uuid;
  v_other uuid;
BEGIN
  SELECT unit_id INTO v_unit FROM lease WHERE company_id = NEW.company_id AND id = NEW.lease_id;
  PERFORM app.lock_unit_leases(NEW.company_id, v_unit);
  SELECT l.id INTO v_other FROM lease l
  WHERE l.company_id = NEW.company_id AND l.unit_id = v_unit AND l.id <> NEW.lease_id
    AND l.status IN ('pending_signatures', 'signed', 'active', 'ending', 'holding_over')
    AND (daterange(l.start_date, l.end_date, '[]') && daterange(NEW.period_start, NEW.period_end, '[]')
         OR EXISTS (SELECT 1 FROM charge_period p WHERE p.company_id = l.company_id AND p.lease_id = l.id
                    AND daterange(p.period_start, p.period_end, '[]') && daterange(NEW.period_start, NEW.period_end, '[]')))
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'lease % would charge its unit from % to %, days lease % charges or holds',
      NEW.lease_id, NEW.period_start, NEW.period_end, v_other USING ERRCODE = 'RA032';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER one_lease_a_day BEFORE INSERT ON charge_period
  FOR EACH ROW EXECUTE FUNCTION app.check_charge_period_unit();

-- The lease machine as in 0007, plus: a lease ends as "superseded" only when the next lease on its
-- unit has started the next day.
CREATE OR REPLACE FUNCTION app.check_lease_transition() RETURNS trigger
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
  IF NEW.status = 'ended' AND NEW.end_reason = 'superseded' AND NOT EXISTS (
      SELECT 1 FROM lease r WHERE r.company_id = NEW.company_id AND r.unit_id = NEW.unit_id
        AND r.id <> NEW.id AND r.status IN ('active', 'ending', 'holding_over')
        AND r.start_date = NEW.ended_on + 1) THEN
    RAISE EXCEPTION 'lease % ends when the next lease on its unit starts, the day after', NEW.id
      USING ERRCODE = 'RA023';
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
--> statement-breakpoint

-- 3. The landlord a lease names (finding 5) ------------------------------------------------------

-- The name of a property's main owner today (the largest share, then the earliest reference),
-- whatever owners the session may see: an agency's lease names its client, never the agency. Only
-- for a property of the transaction's own company, in the session's property scope; the name only.
CREATE FUNCTION app.property_owner_name(p_company_id uuid, p_property_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(o.legal_name, o.display_name)
  FROM property_ownership po
  JOIN owner o ON o.company_id = po.company_id AND o.id = po.owner_id
  WHERE p_company_id = app.current_company_id() AND app.in_property_scope(p_property_id)
    AND po.company_id = p_company_id AND po.property_id = p_property_id
    AND po.effective_from = (
      SELECT max(p2.effective_from) FROM property_ownership p2
      WHERE p2.company_id = po.company_id AND p2.property_id = po.property_id
        AND p2.effective_from <= current_date)
  ORDER BY po.share_bps DESC, o.reference
  LIMIT 1
$$;
--> statement-breakpoint

-- 4. A tenant who holds a lease stays open (finding 8) ------------------------------------------

CREATE FUNCTION app.check_tenant_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND EXISTS (
      SELECT 1 FROM lease l WHERE l.company_id = NEW.company_id AND l.tenant_id = NEW.id
        AND l.status IN ('pending_signatures', 'signed', 'active', 'ending', 'holding_over')) THEN
    RAISE EXCEPTION 'tenant % holds a lease, so the record stays open', NEW.id USING ERRCODE = 'RA033';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER archive_without_lease BEFORE UPDATE OF archived_at ON tenant
  FOR EACH ROW EXECUTE FUNCTION app.check_tenant_archive();
--> statement-breakpoint

-- 5. Signing evidence is written once (finding 12) ----------------------------------------------

-- A lease starts as a draft with no signing evidence at all.
CREATE OR REPLACE FUNCTION app.check_lease_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.signed_at IS NOT NULL OR NEW.signing_method IS NOT NULL
     OR NEW.signed_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'a lease starts as a draft' USING ERRCODE = 'RA028';
  END IF;
  RETURN NEW;
END $$;

-- When, how and on which copy a lease was signed: set once, as it becomes signed, never changed.
CREATE FUNCTION app.check_lease_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.signed_at, NEW.signing_method, NEW.signed_document_id)
     IS NOT DISTINCT FROM (OLD.signed_at, OLD.signing_method, OLD.signed_document_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.signed_at IS NULL AND OLD.signing_method IS NULL AND OLD.signed_document_id IS NULL
     AND OLD.status IN ('draft', 'pending_signatures') AND NEW.status = 'signed' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lease % records when, how and on which copy it was signed once, as it is signed', OLD.id
    USING ERRCODE = 'RA034';
END $$;

CREATE TRIGGER signed_once BEFORE UPDATE ON lease
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_evidence();

-- A signing request moves forward only; once completed, declined or cancelled it never changes;
-- its documents, their fingerprints and its times are set once.
CREATE FUNCTION app.check_signing_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'declined', 'cancelled')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'signing request % is % and never changes', OLD.id, OLD.status USING ERRCODE = 'RA035';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('preparing', 'pending'), ('preparing', 'cancelled'),
      ('pending', 'completed'), ('pending', 'declined'), ('pending', 'cancelled')) THEN
    RAISE EXCEPTION 'a signing request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'RA035';
  END IF;
  IF (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
     OR (OLD.document_sha256 IS NOT NULL AND NEW.document_sha256 IS DISTINCT FROM OLD.document_sha256)
     OR (OLD.html_document_id IS NOT NULL AND NEW.html_document_id IS DISTINCT FROM OLD.html_document_id)
     OR (OLD.html_sha256 IS NOT NULL AND NEW.html_sha256 IS DISTINCT FROM OLD.html_sha256)
     OR (OLD.final_document_id IS NOT NULL AND NEW.final_document_id IS DISTINCT FROM OLD.final_document_id)
     OR (OLD.final_sha256 IS NOT NULL AND NEW.final_sha256 IS DISTINCT FROM OLD.final_sha256)
     OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'the documents, fingerprints and times of signing request % are set once', OLD.id
      USING ERRCODE = 'RA035';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER closed_and_fingerprinted BEFORE UPDATE ON signing_request
  FOR EACH ROW EXECUTE FUNCTION app.check_signing_request_update();

-- A signature or a decline is final, and its time set once. Opens and code locks still change.
CREATE FUNCTION app.check_signer_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('signed', 'declined') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'signer % has % and that never changes', OLD.id, OLD.status USING ERRCODE = 'RA036';
  END IF;
  IF (OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at)
     OR (OLD.declined_at IS NOT NULL AND (NEW.declined_at IS DISTINCT FROM OLD.declined_at
         OR NEW.decline_reason IS DISTINCT FROM OLD.decline_reason)) THEN
    RAISE EXCEPTION 'when signer % signed or declined is recorded once', OLD.id USING ERRCODE = 'RA036';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signed_or_declined_once BEFORE UPDATE ON signer
  FOR EACH ROW EXECUTE FUNCTION app.check_signer_update();
--> statement-breakpoint

-- 6. The tenant's person link in the audit log (finding 13) -------------------------------------

-- A person id is a uuidv7, which tells when the person was first created, and so whether another
-- company had this tenant first. It is recorded only as changed, like the ID columns.
DROP TRIGGER audit_row ON tenant;
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON tenant
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'phone', 'whatsapp_phone', 'email',
    'id_number_encrypted', 'id_number_index', 'id_number_masked', 'tin_encrypted', 'tin_index', 'tin_masked',
    'person_id');
--> statement-breakpoint

-- 7. What a tenant session reads (finding 14) ---------------------------------------------------

-- Every company-scoped table is either limited to the tenant's own rows (tenant_scope and the
-- visibility policies) or kept from tenant sessions altogether. The M1 coverage test checks it.
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'membership', 'company_key', 'audit_chain_head', 'audit_event', 'audit_anchor', 'approval_request',
  'approval_decision', 'outbox_event', 'processed_job', 'upload_intent', 'owner', 'portfolio',
  'property_ownership', 'block', 'unit_status_event', 'meter', 'unit_meter', 'property_file',
  'register_import', 'message_event'
]::regclass[]) AS t;

-- The tenant app reads a unit and its property only through a lease the tenant can see (issued,
-- their own), and a document or render request only of their own lease or signing request.
CREATE POLICY tenant_visible ON unit AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = unit.company_id AND l.unit_id = unit.id));
CREATE POLICY tenant_visible ON property AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = property.company_id AND l.property_id = property.id));
CREATE POLICY tenant_visible ON document_render_request AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM signing_request r WHERE r.company_id = document_render_request.company_id
             AND r.render_request_id = document_render_request.id));
CREATE POLICY tenant_visible ON document AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = document.company_id AND l.signed_document_id = document.id)
  OR EXISTS (SELECT 1 FROM signing_request r WHERE r.company_id = document.company_id
             AND document.id IN (r.document_id, r.html_document_id, r.final_document_id)));
--> statement-breakpoint

-- Ownership and grants ---------------------------------------------------------------------------

GRANT SELECT ON unit, company, charge_period, property_ownership, owner TO rent_system;
ALTER FUNCTION app.check_lease_holds_unit() OWNER TO rent_system;
ALTER FUNCTION app.check_charge_period_unit() OWNER TO rent_system;
ALTER FUNCTION app.property_owner_name(uuid, uuid) OWNER TO rent_system;
ALTER FUNCTION app.check_tenant_archive() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.lock_unit_leases(uuid, uuid), app.check_lease_holds_unit(),
  app.check_charge_period_unit(), app.property_owner_name(uuid, uuid), app.check_tenant_archive(),
  app.check_lease_evidence(), app.check_signing_request_update(), app.check_signer_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_unit_leases(uuid, uuid), app.property_owner_name(uuid, uuid) TO rent_app;
GRANT EXECUTE ON FUNCTION app.lock_unit_leases(uuid, uuid), app.in_property_scope(uuid), app.property_scope()
  TO rent_system;
