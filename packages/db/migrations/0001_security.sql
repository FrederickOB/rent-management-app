-- Security foundations (M1): company context, forced RLS, append-only tables, the hash-chained
-- audit log, approval rules enforced in the database, ADR-002 system functions and grants.
-- Applied as rent_owner. See docs/plans/M1.md sections 4.3, 4.4, 4.7 and 4.8.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rent_app, rent_system;
GRANT USAGE ON SCHEMA app TO rent_app;
GRANT USAGE, CREATE ON SCHEMA app TO rent_system;
GRANT USAGE ON SCHEMA audit TO rent_app;
--> statement-breakpoint

-- Transaction context, set only through set_config(..., true) by the @rent/db helpers.
CREATE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

CREATE FUNCTION app.current_person_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;

CREATE FUNCTION app.current_actor_kind() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.actor_kind', true), ''), 'unknown') $$;

CREATE FUNCTION app.current_request_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.request_id', true), '') $$;
--> statement-breakpoint

-- Forced RLS with one policy for every command. No context means no rows (fail closed).
CREATE FUNCTION app.enable_company_rls(p_table regclass, p_column text DEFAULT 'company_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format(
    'CREATE POLICY company_isolation ON %s USING (%I = app.current_company_id()) WITH CHECK (%I = app.current_company_id())',
    p_table, p_column, p_column);
END $$;

-- Append-only tables reject UPDATE, DELETE and TRUNCATE for every role, owners included.
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'RA001';
END $$;

CREATE FUNCTION app.make_append_only(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', p_table);
  EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', p_table);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM rent_app', p_table);
END $$;
--> statement-breakpoint

-- Audit hash chain (AD-07). The canonical form is fixed by hash_version 1.
CREATE FUNCTION audit.genesis_hash() RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', 32), 'hex') $$;

CREATE FUNCTION audit.event_hash(
  p_prev bytea, p_version smallint, p_company uuid, p_seq bigint, p_occurred timestamptz,
  p_actor uuid, p_actor_kind text, p_request text, p_action text, p_record_type text,
  p_record_id text, p_data jsonb
) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(p_prev || convert_to(concat_ws(chr(31),
    p_version::text, p_company::text, p_seq::text,
    to_char(p_occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_actor::text, ''), p_actor_kind, coalesce(p_request, ''), p_action,
    coalesce(p_record_type, ''), coalesce(p_record_id, ''), coalesce(p_data::text, 'null')
  ), 'UTF8'))
$$;

-- The only way to write an audit event. Runs as rent_owner, which is still subject to the
-- forced RLS policies, so it can only write to the chain of the transaction's company.
CREATE FUNCTION audit.append(
  p_company_id uuid, p_action text, p_record_type text, p_record_id text, p_data jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_seq bigint;
  v_prev bytea;
  v_hash bytea;
  v_occurred timestamptz := clock_timestamp();
  v_actor uuid := app.current_person_id();
  v_actor_kind text := app.current_actor_kind();
  v_request text := app.current_request_id();
BEGIN
  IF p_company_id IS NULL OR p_company_id IS DISTINCT FROM app.current_company_id() THEN
    RAISE EXCEPTION 'audit events can only be written to the transaction''s own company' USING ERRCODE = 'RA002';
  END IF;
  INSERT INTO audit_chain_head (company_id, last_seq, last_hash)
  VALUES (p_company_id, 0, audit.genesis_hash())
  ON CONFLICT (company_id) DO NOTHING;
  SELECT last_seq, last_hash INTO v_seq, v_prev FROM audit_chain_head WHERE company_id = p_company_id FOR UPDATE;
  v_seq := v_seq + 1;
  v_hash := audit.event_hash(v_prev, 1::smallint, p_company_id, v_seq, v_occurred, v_actor, v_actor_kind,
                             v_request, p_action, p_record_type, p_record_id, p_data);
  INSERT INTO audit_event (company_id, seq, occurred_at, actor_person_id, actor_kind, request_id, action,
                           record_type, record_id, data, prev_hash, hash, hash_version)
  VALUES (p_company_id, v_seq, v_occurred, v_actor, v_actor_kind, v_request, p_action,
          p_record_type, p_record_id, p_data, v_prev, v_hash, 1);
  UPDATE audit_chain_head SET last_seq = v_seq, last_hash = v_hash, updated_at = now() WHERE company_id = p_company_id;
  RETURN v_seq;
END $$;

-- Row-change capture. TG_ARGV[0] names the company column ('' = the transaction's company);
-- the remaining arguments name columns recorded only as changed, never by value.
CREATE FUNCTION audit.capture_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_before jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_after jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_company uuid;
  v_changed text[] := '{}';
  v_col text;
  i int;
BEGIN
  IF TG_ARGV[0] = '' THEN
    v_company := app.current_company_id();
  ELSE
    v_company := (coalesce(v_after, v_before) ->> TG_ARGV[0])::uuid;
  END IF;
  IF v_company IS NULL THEN
    RETURN NULL; -- migrations run without a company context; the rows carry their own provenance
  END IF;
  FOR i IN 1 .. coalesce(array_length(TG_ARGV, 1), 0) - 1 LOOP
    v_col := TG_ARGV[i];
    IF v_before ? v_col AND v_after ? v_col AND (v_before -> v_col) IS DISTINCT FROM (v_after -> v_col) THEN
      v_changed := v_changed || v_col;
    END IF;
    IF v_before ? v_col THEN v_before := jsonb_set(v_before, ARRAY[v_col], '"[redacted]"'); END IF;
    IF v_after ? v_col THEN v_after := jsonb_set(v_after, ARRAY[v_col], '"[redacted]"'); END IF;
  END LOOP;
  PERFORM audit.append(
    v_company,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    coalesce(v_after, v_before) ->> 'id',
    jsonb_strip_nulls(jsonb_build_object('before', v_before, 'after', v_after,
      'redacted_changed', CASE WHEN cardinality(v_changed) > 0 THEN to_jsonb(v_changed) END))
  );
  RETURN NULL;
END $$;

-- Recomputes a chain from its first event. Reports the first sequence number that fails.
CREATE FUNCTION audit.verify_chain(p_company_id uuid)
RETURNS TABLE (ok boolean, events bigint, first_bad_seq bigint, problem text, head_seq bigint, head_hash bytea)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  e record;
  v_expected bigint := 1;
  v_prev bytea := audit.genesis_hash();
  v_count bigint := 0;
  v_head_seq bigint;
  v_head_hash bytea;
BEGIN
  FOR e IN SELECT * FROM audit_event a WHERE a.company_id = p_company_id ORDER BY a.seq LOOP
    v_count := v_count + 1;
    IF e.seq <> v_expected THEN
      RETURN QUERY SELECT false, v_count, v_expected, 'event missing from the chain'::text, NULL::bigint, NULL::bytea; RETURN;
    END IF;
    IF e.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_count, e.seq, 'previous hash does not match the previous event'::text, NULL::bigint, NULL::bytea; RETURN;
    END IF;
    IF audit.event_hash(e.prev_hash, e.hash_version, e.company_id, e.seq, e.occurred_at, e.actor_person_id,
         e.actor_kind, e.request_id, e.action, e.record_type, e.record_id, e.data) <> e.hash THEN
      RETURN QUERY SELECT false, v_count, e.seq, 'hash does not match the event contents'::text, NULL::bigint, NULL::bytea; RETURN;
    END IF;
    v_prev := e.hash;
    v_expected := e.seq + 1;
  END LOOP;
  SELECT h.last_seq, h.last_hash INTO v_head_seq, v_head_hash FROM audit_chain_head h WHERE h.company_id = p_company_id;
  IF FOUND AND (v_head_seq <> v_expected - 1 OR v_head_hash <> v_prev) THEN
    RETURN QUERY SELECT false, v_count, v_head_seq, 'chain head does not match the last event'::text, v_head_seq, v_head_hash; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text, v_expected - 1, v_prev;
END $$;
--> statement-breakpoint

-- Approvals (AD-05): the database itself refuses an initiator's approval.
CREATE FUNCTION app.check_approval_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r approval_request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM approval_request WHERE company_id = NEW.company_id AND id = NEW.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % not found', NEW.request_id USING ERRCODE = 'RA010';
  END IF;
  IF r.status NOT IN ('pending', 'cooling_off') THEN
    RAISE EXCEPTION 'approval request % is already %', r.id, r.status USING ERRCODE = 'RA011';
  END IF;
  IF now() >= r.expires_at THEN
    RAISE EXCEPTION 'approval request % has expired', r.id USING ERRCODE = 'RA012';
  END IF;
  IF NEW.decided_by = r.initiated_by THEN
    IF NOT (NEW.kind = 'self_confirm' AND r.mode = 'single_user' AND r.status = 'cooling_off'
            AND r.cooling_off_until IS NOT NULL AND now() >= r.cooling_off_until AND NEW.step_up_verified) THEN
      RAISE EXCEPTION 'the initiator of a request can never approve it (AD-05)' USING ERRCODE = 'RA013';
    END IF;
  ELSIF NEW.kind = 'self_confirm' THEN
    RAISE EXCEPTION 'only the initiator can self-confirm after cooling off' USING ERRCODE = 'RA014';
  ELSIF r.mode = 'single_user' THEN
    RAISE EXCEPTION 'a single-user request is confirmed by its initiator after cooling off' USING ERRCODE = 'RA015';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER check_decision BEFORE INSERT ON approval_decision
FOR EACH ROW EXECUTE FUNCTION app.check_approval_decision();

-- Only status moves, only from an open state, and "approved" needs the decisions to exist.
CREATE FUNCTION app.check_approval_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_approvals int;
BEGIN
  IF OLD.status NOT IN ('pending', 'cooling_off') THEN
    RAISE EXCEPTION 'approval request % is closed', OLD.id USING ERRCODE = 'RA011';
  END IF;
  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'approval request % did not change status', OLD.id USING ERRCODE = 'RA016';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'approval request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'RA016';
  END IF;
  IF NEW.status = 'approved' THEN
    IF OLD.mode = 'two_person' THEN
      SELECT count(*) INTO v_approvals FROM approval_decision
      WHERE company_id = OLD.company_id AND request_id = OLD.id AND kind = 'approve' AND decided_by <> OLD.initiated_by;
      IF v_approvals < OLD.required_approvals THEN
        RAISE EXCEPTION 'approval request % has % of % approvals', OLD.id, v_approvals, OLD.required_approvals USING ERRCODE = 'RA017';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM approval_decision WHERE company_id = OLD.company_id AND request_id = OLD.id
                      AND kind = 'self_confirm' AND decided_by = OLD.initiated_by AND step_up_verified) THEN
      RAISE EXCEPTION 'approval request % has no self-confirmation', OLD.id USING ERRCODE = 'RA017';
    END IF;
  ELSIF NEW.status = 'rejected' AND NOT EXISTS (
      SELECT 1 FROM approval_decision WHERE company_id = OLD.company_id AND request_id = OLD.id AND kind = 'reject') THEN
    RAISE EXCEPTION 'approval request % has no rejection', OLD.id USING ERRCODE = 'RA017';
  ELSIF NEW.status = 'expired' AND now() < OLD.expires_at THEN
    RAISE EXCEPTION 'approval request % has not expired', OLD.id USING ERRCODE = 'RA016';
  END IF;
  NEW.closed_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER check_request_update BEFORE UPDATE ON approval_request
FOR EACH ROW EXECUTE FUNCTION app.check_approval_request_update();
--> statement-breakpoint

-- Company logo: a document of the same company. Deferred, because the document is written after.
ALTER TABLE company ADD CONSTRAINT company_logo_document_fk
  FOREIGN KEY (id, logo_document_id) REFERENCES document (company_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- RLS on every company-scoped table (ADR-002). The coverage test fails if a table is missed.
SELECT app.enable_company_rls('company', 'id');
SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'membership', 'company_key', 'audit_chain_head', 'audit_event', 'audit_anchor', 'approval_request',
  'approval_decision', 'outbox_event', 'processed_job', 'document', 'document_render_request', 'upload_intent'
]::regclass[]) AS t;

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'rule', 'company_key', 'audit_event', 'audit_anchor', 'approval_decision', 'processed_job', 'document'
]::regclass[]) AS t;

-- Row-change audit (AD-07). Secrets are recorded only as changed.
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON company
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON membership
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON company_key
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'wrapped_key');
CREATE TRIGGER audit_row AFTER INSERT ON rule
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('');
--> statement-breakpoint

-- ADR-002 system paths. Owned by rent_system (BYPASSRLS, cannot log in); each does one narrow thing.
CREATE FUNCTION app.memberships_for_person(p_person_id uuid)
RETURNS TABLE (membership_id uuid, company_id uuid, company_kind text, company_name text, company_status text,
               role text, status text, nominated_approver boolean, scope jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.id, m.company_id, c.kind, c.display_name, c.status, m.role, m.status, m.nominated_approver, m.scope
  FROM membership m JOIN company c ON c.id = m.company_id
  WHERE m.person_id = p_person_id AND m.status IN ('invited', 'active')
  ORDER BY c.display_name
$$;

CREATE FUNCTION app.company_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM company WHERE status = 'active' ORDER BY id
$$;

CREATE FUNCTION app.create_company(
  p_id uuid, p_kind text, p_legal_name text, p_display_name text, p_country char(2),
  p_time_zone text, p_sender_name text, p_settings jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.company_id', true), '');
  v_id uuid := coalesce(p_id, uuidv7());
BEGIN
  -- The new company's own context, so its creation is the first event in its own audit chain.
  PERFORM set_config('app.company_id', v_id::text, true);
  INSERT INTO company (id, kind, legal_name, display_name, country_code, time_zone, sender_name, settings)
  VALUES (v_id, p_kind, p_legal_name, p_display_name, p_country, p_time_zone, p_sender_name, coalesce(p_settings, '{}'));
  PERFORM set_config('app.company_id', v_previous, true);
  RETURN v_id;
END $$;

CREATE FUNCTION app.claim_outbox_events(p_limit int) RETURNS SETOF outbox_event
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE outbox_event SET published_at = now()
  WHERE id IN (
    SELECT id FROM outbox_event WHERE published_at IS NULL ORDER BY id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  RETURNING *
$$;

GRANT SELECT ON company, membership TO rent_system;
GRANT INSERT ON company TO rent_system;
GRANT SELECT, UPDATE ON outbox_event TO rent_system;
ALTER FUNCTION app.memberships_for_person(uuid) OWNER TO rent_system;
ALTER FUNCTION app.company_ids() OWNER TO rent_system;
ALTER FUNCTION app.create_company(uuid, text, text, text, char, text, text, jsonb) OWNER TO rent_system;
ALTER FUNCTION app.claim_outbox_events(int) OWNER TO rent_system;
--> statement-breakpoint

-- Outbox events wake the relay at once (ADR-005); a one-second poll is the fallback.
CREATE FUNCTION app.notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER notify_outbox AFTER INSERT ON outbox_event FOR EACH STATEMENT EXECUTE FUNCTION app.notify_outbox();
--> statement-breakpoint

-- Function privileges: nothing for PUBLIC; the application role gets what it calls.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app, audit FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_company_id(), app.current_person_id(), app.current_actor_kind(),
  app.current_request_id(), app.memberships_for_person(uuid), app.company_ids(),
  app.create_company(uuid, text, text, text, char, text, text, jsonb), app.claim_outbox_events(int)
  TO rent_app;
GRANT EXECUTE ON FUNCTION audit.append(uuid, text, text, text, jsonb), audit.verify_chain(uuid),
  audit.event_hash(bytea, smallint, uuid, bigint, timestamptz, uuid, text, text, text, text, text, jsonb),
  audit.genesis_hash() TO rent_app;
--> statement-breakpoint

-- Table privileges for the application role (column lists where only some columns may change).
GRANT SELECT ON country TO rent_app;
GRANT SELECT, INSERT ON rule TO rent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON person, session, account, verification, two_factor, rate_limit TO rent_app;
GRANT SELECT ON company TO rent_app;
GRANT UPDATE (legal_name, display_name, time_zone, logo_document_id, primary_colour, accent_colour, sender_name,
              settings, status, updated_at) ON company TO rent_app;
GRANT SELECT, INSERT ON membership TO rent_app;
GRANT UPDATE (role, scope, nominated_approver, status, updated_at, revoked_at) ON membership TO rent_app;
GRANT SELECT, INSERT ON company_key TO rent_app;
GRANT SELECT ON audit_chain_head, audit_event TO rent_app;
GRANT SELECT, INSERT ON audit_anchor TO rent_app;
GRANT SELECT, INSERT ON approval_request TO rent_app;
GRANT UPDATE (status, closed_at, close_reason, updated_at) ON approval_request TO rent_app;
GRANT SELECT, INSERT ON approval_decision TO rent_app;
GRANT SELECT, INSERT ON outbox_event TO rent_app;
GRANT SELECT, INSERT ON processed_job TO rent_app;
GRANT SELECT, INSERT ON document TO rent_app;
GRANT SELECT, INSERT ON document_render_request TO rent_app;
GRANT UPDATE (status, document_id, attempts, last_error, updated_at) ON document_render_request TO rent_app;
GRANT SELECT, INSERT ON upload_intent TO rent_app;
GRANT UPDATE (status, document_id, reject_reason) ON upload_intent TO rent_app;
