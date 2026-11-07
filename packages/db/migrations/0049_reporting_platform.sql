-- Gate 1 across companies (M9 decision 13): platform admins read each company's latest stored
-- figures for a month through one narrow function (ADR-002), never a BYPASSRLS application role.
-- The function checks the session is a platform admin's; the service checks the caller first.
CREATE FUNCTION app.platform_gate1(p_month text)
RETURNS TABLE (company_id uuid, display_name text, metric_date date, figures jsonb, computed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Gate 1 across companies is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'not a month: %', p_month USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.id, c.display_name, m.metric_date, m.figures, m.computed_at
    FROM company c
    LEFT JOIN LATERAL (
      SELECT d.metric_date, d.figures, d.computed_at FROM metric_daily d
      WHERE d.company_id = c.id AND d.month = p_month
      ORDER BY d.metric_date DESC LIMIT 1
    ) m ON true
    WHERE c.kind <> 'platform' AND c.status = 'active'
    ORDER BY c.display_name, c.id;
END $$;

GRANT SELECT ON metric_daily TO rent_system;
ALTER FUNCTION app.platform_gate1(text) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.platform_gate1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_gate1(text) TO rent_app;
