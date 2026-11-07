-- M9 review: the dashboard agrees with the statement, and Gate 1's months are finalised. Applied as
-- rent_owner, after 0055.
--
-- 1. The snapshot splits 2010 as the statement does (AR-03; one definition, `prepaymentSplit`):
--    unearned rent (the existing column), unearned service charge and credit, which add up to the
--    lease's 2010. Arrears are 1100 past due; months billed and past due but not charged yet (an
--    annual invoice's months not started) are kept apart. Derived, like the rest of the row.
ALTER TABLE "lease_snapshot" ADD COLUMN "unearned_service_charge_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_snapshot" ADD COLUMN "credit_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_snapshot" ADD COLUMN "due_not_started_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 2. Gate 1 across companies carries whether each company's month is final (`finalised_at`, 0053).
--    A function's result columns cannot change in place, so it is dropped and created again, with
--    the same checks, owner and grants as 0049.
DROP FUNCTION app.platform_gate1(text);--> statement-breakpoint
CREATE FUNCTION app.platform_gate1(p_month text)
RETURNS TABLE (company_id uuid, display_name text, metric_date date, figures jsonb,
               computed_at timestamptz, finalised_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Gate 1 across companies is for platform admins' USING ERRCODE = 'RA063';
  END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'not a month: %', p_month USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.id, c.display_name, m.metric_date, m.figures, m.computed_at, m.finalised_at
    FROM company c
    LEFT JOIN LATERAL (
      SELECT d.metric_date, d.figures, d.computed_at, d.finalised_at FROM metric_daily d
      WHERE d.company_id = c.id AND d.month = p_month
      ORDER BY d.metric_date DESC LIMIT 1
    ) m ON true
    WHERE c.kind <> 'platform' AND c.status = 'active'
    ORDER BY c.display_name, c.id;
END $$;--> statement-breakpoint
ALTER FUNCTION app.platform_gate1(text) OWNER TO rent_system;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_gate1(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_gate1(text) TO rent_app;
