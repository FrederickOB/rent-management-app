-- M10 console and support access (plan 4.6, 4.8 and 4.9; decisions 13 and 15). Applied as
-- rent_owner, after 0059. Narrow functions for the platform admin console. Each refuses anyone but
-- a platform admin (app.is_platform_admin(): the actor kind and an active platform-admin membership
-- of the platform company) and returns ids, counts and amounts, never personal data.
--
-- 1. Usage across companies (decision 15): units per company, and the messages each sent by channel,
--    with the SMS cost as recorded per message and the WhatsApp cost estimated from whatsapp_rate.
-- 2. Support sessions across companies (decision 13): the support.request events in each customer's
--    chain, so the console lists them without entering a company that has granted nothing.
-- 3. System health (decision 15): pg-boss's queues, dead letters and schedules, and failed webhooks.
--    pg-boss installs its schema after these migrations (pnpm db:migrate), so these functions read
--    it with dynamic SQL and return nothing while it is missing. They run as the caller (rent_app),
--    to whom pg-boss's install grants its tables, as it already has webhook_inbox.
--
-- Error codes: RA063 (as 0031) not a platform admin; 22023 not a month.

-- 1. Usage ---------------------------------------------------------------------------------------

-- The units in each landlord's and agency's register today, archived units left out.
CREATE FUNCTION app.platform_unit_counts()
RETURNS TABLE (company_id uuid, units bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'usage across companies is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
    SELECT c.id, count(u.id)::bigint
    FROM company c LEFT JOIN unit u ON u.company_id = c.id AND u.archived_at IS NULL
    WHERE c.kind IN ('landlord', 'agency')
    GROUP BY c.id
    ORDER BY c.id;
END $$;

-- The messages each landlord and agency sent in a month (its own calendar month, in its time zone),
-- by channel: each message once per channel it went by, on the day of its first `sent` event. The
-- SMS cost is what the providers reported for those messages. The WhatsApp cost is an estimate
-- (decision 15), never an invoice: each message once, at the pricing category Meta first reported
-- for it (none reported: not counted; reported not billable: free), at the whatsapp_rate in force
-- on the day it was sent (no rate yet: not counted).
CREATE FUNCTION app.platform_messaging_usage(p_month text)
RETURNS TABLE (company_id uuid, sms bigint, whatsapp bigint, email bigint, push bigint,
  sms_cost_minor bigint, whatsapp_estimated_minor bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_first date;
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'usage across companies is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'not a month: %', p_month USING ERRCODE = '22023';
  END IF;
  v_first := to_date(p_month || '-01', 'YYYY-MM-DD');
  RETURN QUERY
    WITH k AS (
      SELECT c.id, c.time_zone,
        (v_first::timestamp AT TIME ZONE c.time_zone) AS from_at,
        ((v_first + interval '1 month')::timestamp AT TIME ZONE c.time_zone) AS to_at
      FROM company c WHERE c.kind IN ('landlord', 'agency')
    ),
    sent AS (
      SELECT DISTINCT ON (e.company_id, e.message_id, e.channel)
        e.company_id, e.message_id, e.channel,
        (e.occurred_at AT TIME ZONE k.time_zone)::date AS day
      FROM k JOIN message_event e ON e.company_id = k.id
      WHERE e.status = 'sent' AND e.channel IN ('sms', 'whatsapp', 'email', 'push')
        AND e.occurred_at >= k.from_at AND e.occurred_at < k.to_at
      ORDER BY e.company_id, e.message_id, e.channel, e.occurred_at, e.id
    ),
    counts AS (
      SELECT s.company_id,
        count(*) FILTER (WHERE s.channel = 'sms') AS sms,
        count(*) FILTER (WHERE s.channel = 'whatsapp') AS whatsapp,
        count(*) FILTER (WHERE s.channel = 'email') AS email,
        count(*) FILTER (WHERE s.channel = 'push') AS push
      FROM sent s GROUP BY s.company_id
    ),
    sms_cost AS (
      SELECT s.company_id, sum(e.cost_minor) AS cost
      FROM sent s
      JOIN message_event e ON e.company_id = s.company_id AND e.message_id = s.message_id
        AND e.channel = 'sms' AND e.cost_minor IS NOT NULL
      WHERE s.channel = 'sms'
      GROUP BY s.company_id
    ),
    whatsapp_cost AS (
      SELECT s.company_id, sum(r.rate_minor) AS cost
      FROM sent s
      JOIN LATERAL (
        SELECT e.pricing_category, e.billable FROM message_event e
        WHERE e.company_id = s.company_id AND e.message_id = s.message_id
          AND e.channel = 'whatsapp' AND e.pricing_category IS NOT NULL
        ORDER BY e.occurred_at, e.id LIMIT 1
      ) p ON true
      JOIN LATERAL (
        SELECT x.rate_minor FROM whatsapp_rate x
        WHERE x.category = p.pricing_category AND x.effective_from <= s.day
        ORDER BY x.effective_from DESC, x.created_at DESC LIMIT 1
      ) r ON true
      WHERE s.channel = 'whatsapp' AND p.billable IS DISTINCT FROM false
      GROUP BY s.company_id
    )
    SELECT k.id,
      coalesce(n.sms, 0)::bigint, coalesce(n.whatsapp, 0)::bigint, coalesce(n.email, 0)::bigint,
      coalesce(n.push, 0)::bigint, coalesce(sc.cost, 0)::bigint, coalesce(wc.cost, 0)::bigint
    FROM k
    LEFT JOIN counts n ON n.company_id = k.id
    LEFT JOIN sms_cost sc ON sc.company_id = k.id
    LEFT JOIN whatsapp_cost wc ON wc.company_id = k.id
    ORDER BY k.id;
END $$;
--> statement-breakpoint

-- 2. Support sessions (decision 13) ------------------------------------------------------------

-- Each request a platform admin made under the given grants: the `support.request` events the
-- support session appended to the customer's own chain (route and record), newest first.
CREATE FUNCTION app.support_sessions(p_grant_ids uuid[])
RETURNS TABLE (grant_id uuid, occurred_at timestamptz, admin_name text, route text, record text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'support sessions are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
    SELECT g.id, e.occurred_at, p.name, e.data ->> 'route', e.data ->> 'record'
    FROM support_grant g
    JOIN audit_event e ON e.company_id = g.company_id AND e.record_type = 'support_grant'
      AND e.record_id = g.id::text
    LEFT JOIN person p ON p.id = e.actor_person_id
    WHERE g.id = ANY(coalesce(p_grant_ids, '{}')) AND e.action = 'support.request'
    ORDER BY e.occurred_at DESC, e.seq DESC;
END $$;
--> statement-breakpoint

-- 3. System health (decision 15) ---------------------------------------------------------------

-- Each pg-boss queue: jobs waiting (created or to retry), running, failed for good in the last 24
-- hours, and created in the last 24 hours (for the dead-letter queue: the jobs dead-lettered).
CREATE FUNCTION app.platform_job_queues()
RETURNS TABLE (name text, queued bigint, active bigint, failed_24h bigint, created_24h bigint)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'system health is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  IF to_regclass('pgboss.queue') IS NULL OR to_regclass('pgboss.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $q$
    SELECT q.name::text,
      count(j.id) FILTER (WHERE j.state::text IN ('created', 'retry'))::bigint,
      count(j.id) FILTER (WHERE j.state::text = 'active')::bigint,
      count(j.id) FILTER (WHERE j.state::text = 'failed'
        AND j.completed_on > now() - interval '24 hours')::bigint,
      count(j.id) FILTER (WHERE j.created_on > now() - interval '24 hours')::bigint
    FROM pgboss.queue q
    LEFT JOIN pgboss.job j ON j.name = q.name AND (
      j.state::text IN ('created', 'retry', 'active')
      OR j.created_on > now() - interval '24 hours'
      OR (j.state::text = 'failed' AND j.completed_on > now() - interval '24 hours'))
    GROUP BY q.name
    ORDER BY q.name $q$;
END $$;

-- Each scheduled job: when its latest run started and how that run stands. pg-boss keeps finished
-- jobs only for its retention period, so a monthly job can show no run between its runs.
CREATE FUNCTION app.platform_scheduled_jobs()
RETURNS TABLE (name text, last_run_at timestamptz, last_state text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'system health is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  IF to_regclass('pgboss.schedule') IS NULL OR to_regclass('pgboss.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $q$
    SELECT s.name::text, l.started_on, l.state::text
    FROM (SELECT DISTINCT x.name FROM pgboss.schedule x) s
    LEFT JOIN LATERAL (
      SELECT j.started_on, j.state FROM pgboss.job j
      WHERE j.name = s.name AND j.started_on IS NOT NULL
      ORDER BY j.started_on DESC LIMIT 1
    ) l ON true
    ORDER BY s.name $q$;
END $$;

-- Provider webhooks whose processing failed in the last hours (rejected signatures are not
-- counted: they alert on their own, M4b).
CREATE FUNCTION app.platform_failed_webhooks(p_hours int)
RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'system health is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN (SELECT count(*) FROM webhook_inbox w
          WHERE w.status = 'failed'
            AND w.received_at > now() - make_interval(hours => coalesce(p_hours, 24)));
END $$;
--> statement-breakpoint

-- Owners and grants ----------------------------------------------------------------------------

-- The support sessions read the customers' chains through the function above only.
GRANT SELECT ON audit_event TO rent_system;

ALTER FUNCTION app.platform_unit_counts() OWNER TO rent_system;
ALTER FUNCTION app.platform_messaging_usage(text) OWNER TO rent_system;
ALTER FUNCTION app.support_sessions(uuid[]) OWNER TO rent_system;

REVOKE ALL ON FUNCTION app.platform_unit_counts(), app.platform_messaging_usage(text),
  app.support_sessions(uuid[]), app.platform_job_queues(), app.platform_scheduled_jobs(),
  app.platform_failed_webhooks(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_unit_counts(), app.platform_messaging_usage(text),
  app.support_sessions(uuid[]), app.platform_job_queues(), app.platform_scheduled_jobs(),
  app.platform_failed_webhooks(int) TO rent_app;
