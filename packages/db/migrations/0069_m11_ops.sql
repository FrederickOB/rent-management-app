-- M11 decision 9 and review R2 F6 (operations): who may read stored webhooks, their replay fields,
-- and pruning rejected ones. Applied as rent_owner, after 0068.
--
-- Error codes: none new.

-- 1. Review R2 F6: webhook bodies are read only in a system transaction ---------------------------
-- webhook_inbox holds every provider's raw payloads, before their company is known, so it has no
-- company to isolate by. Every read and write of it runs in a system transaction (withSystem:
-- actor 'system', no company). A request or job working for a company, staff or tenant, sees no
-- row and can write none, so an injection in any company-scoped path cannot reach the payloads.

CREATE FUNCTION app.in_system_context() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(current_setting('app.company_id', true), '') = ''
     AND coalesce(current_setting('app.actor_kind', true), '') = 'system'
$$;
REVOKE ALL ON FUNCTION app.in_system_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.in_system_context() TO rent_app, rent_system;

ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON webhook_inbox
  USING (app.in_system_context()) WITH CHECK (app.in_system_context());
-- The narrow functions owned by rent_system (the relay's claim, the console's counts, pruning) are
-- the system paths of ADR-002: they see every row whatever the caller's context.
CREATE POLICY system_functions ON webhook_inbox TO rent_system USING (true) WITH CHECK (true);

-- The console's count of failed webhooks (M10, 0060) read the table as its caller, a platform
-- admin in the platform company's context; it becomes one of those narrow functions (it checks
-- the platform admin itself).
ALTER FUNCTION app.platform_failed_webhooks(int) SECURITY DEFINER;
ALTER FUNCTION app.platform_failed_webhooks(int) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION app.platform_failed_webhooks(int) OWNER TO rent_system;
--> statement-breakpoint

-- 2. Replay (decision 9) ---------------------------------------------------------------------------
-- A platform admin's replay re-runs the stored event through the normal idempotent path; the
-- inbox row counts replays and keeps the last error as a code and a short message (never a body).

GRANT UPDATE (last_error, replay_count, last_replayed_at, last_replayed_by) ON webhook_inbox TO rent_app;
--> statement-breakpoint

-- 3. Pruning rejected webhooks (review R3 F1) ------------------------------------------------------
-- A bad-signature or oversized request is stored as rejected with its size and hash only: junk an
-- attacker chose, not a provider record. Rows older than 30 days are deleted; never a row with a
-- valid signature.

CREATE FUNCTION app.prune_rejected_webhooks(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT app.in_system_context() THEN
    RAISE EXCEPTION 'rejected webhooks are pruned by the system only' USING ERRCODE = '42501';
  END IF;
  IF p_before > now() - interval '30 days' THEN
    RAISE EXCEPTION 'rejected webhooks are kept for 30 days' USING ERRCODE = '22023';
  END IF;
  DELETE FROM webhook_inbox
  WHERE NOT signature_valid AND status = 'rejected' AND received_at < p_before;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
ALTER FUNCTION app.prune_rejected_webhooks(timestamptz) OWNER TO rent_system;
GRANT SELECT, DELETE ON webhook_inbox TO rent_system;
REVOKE ALL ON FUNCTION app.prune_rejected_webhooks(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_rejected_webhooks(timestamptz) TO rent_app;
