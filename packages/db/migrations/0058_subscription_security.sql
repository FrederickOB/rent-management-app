-- Subscription billing and the platform admin console: security and integrity (M10 plan 4.2,
-- 4.5, 4.6 and 4.7). Applied as rent_owner, after 0057.
--
-- 1. company.plan from interim_plan (dropped in 0059); the platform book.
-- 2. RLS: platform company tables isolated by company, with a select-only policy for the
--    subscriber's own rows (decision 1); customer tables isolated; no tenant session sees any.
-- 3. Append-only and frozen records.
-- 4. The support guard in app.current_company_id() (decision 13).
-- 5. Narrow functions: the subscription engine's plan and access, the M6 plan functions, company
--    onboarding, the platform tables, grants and alerts.
-- 6. The VAT rule (decision 10), audit and grants.
--
-- Error codes: RA110 a frozen subscription record changed; RA111 a platform-table write by
-- someone other than a platform admin or the platform system; RA112 a price list or terms version
-- dated in the past; RA113 the subscription engine's state set outside the platform company.

-- 1. The plan and the platform book ------------------------------------------------------------

-- Each company's plan from its interim plan, in its own context so the change is in its chain.
DO $$
DECLARE
  c record;
BEGIN
  ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
  FOR c IN SELECT id, interim_plan FROM company WHERE kind <> 'platform' ORDER BY id LOOP
    PERFORM set_config('app.company_id', c.id::text, true);
    PERFORM set_config('app.actor_kind', 'system', true);
    UPDATE company SET plan = c.interim_plan WHERE id = c.id AND plan IS DISTINCT FROM c.interim_plan;
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
  ALTER TABLE company FORCE ROW LEVEL SECURITY;
END $$;
--> statement-breakpoint

-- Every new company gets its book in the same transaction: a landlord or agency its company book,
-- the platform company its platform book (subscriptions, P26). Rent never touches it (D1).
CREATE OR REPLACE FUNCTION app.create_company_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind IN ('landlord', 'agency') THEN
    INSERT INTO book (company_id, kind) VALUES (NEW.id, 'company') ON CONFLICT DO NOTHING;
  ELSIF NEW.kind = 'platform' THEN
    INSERT INTO book (company_id, kind) VALUES (NEW.id, 'platform') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

-- An existing platform company's book.
DO $$
DECLARE
  c record;
BEGIN
  ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
  FOR c IN SELECT id FROM company WHERE kind = 'platform' ORDER BY id LOOP
    PERFORM set_config('app.company_id', c.id::text, true);
    PERFORM set_config('app.actor_kind', 'system', true);
    INSERT INTO book (company_id, kind) VALUES (c.id, 'platform') ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
  ALTER TABLE company FORCE ROW LEVEL SECURITY;
END $$;
--> statement-breakpoint

-- 2. Row Level Security -------------------------------------------------------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'subscription', 'subscription_event', 'billing_snapshot', 'billing_snapshot_unit',
  'subscription_invoice', 'subscription_invoice_line', 'subscription_payment',
  'subscription_allocation', 'subscription_receipt', 'discount_code', 'discount_redemption',
  'subscription_export', 'support_grant'
]::regclass[]) AS t;

SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'subscription', 'subscription_event', 'billing_snapshot', 'billing_snapshot_unit',
  'subscription_invoice', 'subscription_invoice_line', 'subscription_payment',
  'subscription_allocation', 'subscription_receipt', 'discount_code', 'discount_redemption',
  'subscription_export', 'support_grant'
]::regclass[]) AS t;

-- Decision 1: a subscriber reads its own subscription records, which belong to the platform
-- company, and never writes them (select only: inserts and updates still need the platform
-- company's context). A tenant session sees none (the restrictive policy above).
CREATE POLICY subscriber_read ON subscription FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON subscription_event FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON billing_snapshot FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON billing_snapshot_unit FOR SELECT USING (EXISTS (
  SELECT 1 FROM billing_snapshot s WHERE s.company_id = billing_snapshot_unit.company_id
    AND s.id = billing_snapshot_unit.snapshot_id AND s.subscriber_company_id = app.current_company_id()));
CREATE POLICY subscriber_read ON subscription_invoice FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON subscription_invoice_line FOR SELECT USING (EXISTS (
  SELECT 1 FROM subscription_invoice i WHERE i.company_id = subscription_invoice_line.company_id
    AND i.id = subscription_invoice_line.invoice_id AND i.subscriber_company_id = app.current_company_id()));
CREATE POLICY subscriber_read ON subscription_payment FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON subscription_allocation FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON subscription_receipt FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE POLICY subscriber_read ON discount_redemption FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
-- The code a subscriber redeemed, and nothing else of the code list.
CREATE POLICY subscriber_read ON discount_code FOR SELECT USING (EXISTS (
  SELECT 1 FROM discount_redemption r WHERE r.company_id = discount_code.company_id
    AND r.discount_code_id = discount_code.id AND r.subscriber_company_id = app.current_company_id()));
--> statement-breakpoint

-- 3. Append-only and frozen records -------------------------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'subscription_event', 'billing_snapshot', 'billing_snapshot_unit', 'subscription_invoice_line',
  'subscription_allocation', 'discount_code', 'discount_redemption', 'price_list',
  'subscription_terms', 'whatsapp_rate', 'alert_event'
]::regclass[]) AS t;

-- A record whose listed columns may change and nothing else; TG_ARGV are the mutable columns.
-- A column listed with a trailing '!' may be set once (from null) and never again.
CREATE FUNCTION app.freeze_except() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_mutable text[] := '{}';
  v_once text[] := '{}';
  v_arg text;
  v_col text;
BEGIN
  FOREACH v_arg IN ARRAY TG_ARGV LOOP
    IF right(v_arg, 1) = '!' THEN
      v_once := v_once || left(v_arg, -1);
    ELSE
      v_mutable := v_mutable || v_arg;
    END IF;
  END LOOP;
  IF (to_jsonb(NEW) - v_mutable - v_once) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable - v_once) THEN
    RAISE EXCEPTION '% % is frozen: only % may change', TG_TABLE_NAME, OLD.id,
      array_to_string(v_mutable || v_once, ', ') USING ERRCODE = 'RA110';
  END IF;
  FOREACH v_col IN ARRAY v_once LOOP
    IF (to_jsonb(OLD) -> v_col) <> 'null'::jsonb AND (to_jsonb(NEW) -> v_col) IS DISTINCT FROM (to_jsonb(OLD) -> v_col) THEN
      RAISE EXCEPTION '% % records % once', TG_TABLE_NAME, OLD.id, v_col USING ERRCODE = 'RA110';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER frozen BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'tier', 'status', 'trial_ends_on', 'pending_tier', 'pending_tier_from', 'cancels_on', 'cancel_reason',
  'cancelled_on', 'read_only_until', 'updated_at');
-- An invoice's amounts, lines and pricing never change: only whether it is paid, and its PDF.
CREATE TRIGGER frozen BEFORE UPDATE ON subscription_invoice FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'status', 'paid_at', 'render_request_id!', 'document_id!', 'sha256!', 'updated_at');
-- A payment's amount, reference and purpose never change: only its progress at the provider.
CREATE TRIGGER frozen BEFORE UPDATE ON subscription_payment FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'status', 'provider_reference', 'checkout_url', 'message', 'succeeded_at!', 'failed_at', 'failure_reason',
  'reversed_at!', 'updated_at');
CREATE TRIGGER frozen BEFORE UPDATE ON subscription_receipt FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'render_request_id!', 'document_id!', 'sha256!');
CREATE TRIGGER frozen BEFORE UPDATE ON support_grant FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'revoked_at!', 'revoked_by!');
CREATE TRIGGER frozen BEFORE UPDATE ON subscription_export FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'status', 'document_id!', 'updated_at');

-- A paid invoice stays paid unless its payment is reversed (then open again); void is final.
CREATE FUNCTION app.check_subscription_invoice_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'subscription invoice % is void' , OLD.id USING ERRCODE = 'RA110';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER status_rules BEFORE UPDATE ON subscription_invoice
  FOR EACH ROW EXECUTE FUNCTION app.check_subscription_invoice_status();

CREATE TRIGGER no_delete BEFORE DELETE ON subscription FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON subscription_invoice FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON subscription_payment FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON subscription_receipt FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON support_grant FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON subscription_export FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- 4. The support guard (decision 13) -----------------------------------------------------------

-- Whether a platform admin may work in a company: their own (the platform company), or one whose
-- admin has granted support access that is active now. Owned by rent_system, so it reads the
-- grants whatever the transaction's context.
CREATE FUNCTION app.support_access_allowed(p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_company_id IS NOT NULL AND app.is_platform_admin() AND (
    EXISTS (SELECT 1 FROM company c WHERE c.id = p_company_id AND c.kind = 'platform')
    OR EXISTS (SELECT 1 FROM support_grant g WHERE g.company_id = p_company_id AND g.revoked_at IS NULL
               AND g.starts_at <= now() AND g.ends_at > now()))
$$;

-- The active grant, for the support session's audit (null when there is none).
CREATE FUNCTION app.active_support_grant(p_company_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT g.id FROM support_grant g WHERE g.company_id = p_company_id AND g.revoked_at IS NULL
    AND g.starts_at <= now() AND g.ends_at > now() AND app.is_platform_admin()
  ORDER BY g.ends_at DESC LIMIT 1
$$;

-- Every RLS policy compares with this. For anyone but a platform admin it is the transaction's
-- company, as before. A platform admin gets nothing in a customer company without an active
-- grant, so a support path sees nothing without consent, whatever the code does.
CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.actor_kind', true) IS DISTINCT FROM 'platform_admin'
      THEN nullif(current_setting('app.company_id', true), '')::uuid
    WHEN app.support_access_allowed(nullif(current_setting('app.company_id', true), '')::uuid)
      THEN nullif(current_setting('app.company_id', true), '')::uuid
  END
$$;
--> statement-breakpoint

-- 5. Narrow functions ---------------------------------------------------------------------------

-- The subscription engine sets a subscriber's plan and access (decisions 1 and 11), from the
-- platform company's context, in the subscriber's own context so the change is in its chain.
CREATE FUNCTION app.apply_subscription_state(p_company_id uuid, p_plan text, p_access text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_changed boolean;
BEGIN
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM app.platform_company_id() THEN
    RAISE EXCEPTION 'the subscription engine works from the platform company' USING ERRCODE = 'RA113';
  END IF;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  PERFORM set_config('app.actor_kind', 'system', true);
  UPDATE company SET plan = p_plan, access = p_access, updated_at = now()
  WHERE id = p_company_id AND kind <> 'platform' AND (plan, access) IS DISTINCT FROM (p_plan, p_access);
  v_changed := FOUND;
  PERFORM set_config('app.company_id', v_company, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_changed;
END $$;

-- M6 decision 9's plan functions, now on `plan` (M10 replaces the interim plan). A platform admin
-- sets it in the company's chain as the platform's system path (decision 13: a platform admin's
-- own context never enters a customer company without a grant).
DROP FUNCTION app.company_plans();
CREATE FUNCTION app.company_plans()
RETURNS TABLE (company_id uuid, display_name text, kind text, status text, plan text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'plans are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY SELECT c.id, c.display_name, c.kind, c.status, c.plan FROM company c
    WHERE c.kind <> 'platform' ORDER BY c.display_name, c.id;
END $$;

CREATE OR REPLACE FUNCTION app.set_company_plan(p_company_id uuid, p_plan text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_changed boolean;
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'plans are set by platform admins' USING ERRCODE = 'RA063';
  END IF;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  PERFORM set_config('app.actor_kind', 'system', true);
  UPDATE company SET plan = p_plan, updated_at = now()
  WHERE id = p_company_id AND kind <> 'platform' AND plan IS DISTINCT FROM p_plan;
  v_changed := FOUND;
  PERFORM set_config('app.company_id', v_previous, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_changed;
END $$;

-- Company onboarding (decision 14) as before, now also from a platform admin's session: the new
-- company's creation is the first event in its own chain, written as the platform's system path.
CREATE OR REPLACE FUNCTION app.create_company(
  p_id uuid, p_kind text, p_legal_name text, p_display_name text, p_country char(2),
  p_time_zone text, p_sender_name text, p_settings jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_id uuid := coalesce(p_id, uuidv7());
BEGIN
  PERFORM set_config('app.company_id', v_id::text, true);
  IF v_kind = 'platform_admin' THEN
    PERFORM set_config('app.actor_kind', 'system', true);
  END IF;
  INSERT INTO company (id, kind, legal_name, display_name, country_code, time_zone, sender_name, settings)
  VALUES (v_id, p_kind, p_legal_name, p_display_name, p_country, p_time_zone, p_sender_name, coalesce(p_settings, '{}'));
  PERFORM set_config('app.company_id', v_previous, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_id;
END $$;

-- Every landlord and agency company with its plan, access and creation, for the subscription
-- engine (from the platform company) and the console (platform admins).
CREATE FUNCTION app.subscriber_companies()
RETURNS TABLE (company_id uuid, kind text, display_name text, legal_name text, time_zone text,
  status text, plan text, access text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.is_platform_admin() OR app.is_platform_system()
          OR (app.current_company_id() IS NOT NULL AND app.current_company_id() = app.platform_company_id())) THEN
    RAISE EXCEPTION 'subscriber companies are for the platform' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY SELECT c.id, c.kind, c.display_name, c.legal_name, c.time_zone, c.status, c.plan, c.access, c.created_at
    FROM company c WHERE c.kind IN ('landlord', 'agency') ORDER BY c.display_name, c.id;
END $$;

-- Support grants across companies, for the console (platform admins only).
CREATE FUNCTION app.support_grants_all(p_active_only boolean)
RETURNS TABLE (id uuid, company_id uuid, company_name text, granted_by uuid, granted_by_name text, reason text,
  starts_at timestamptz, ends_at timestamptz, revoked_at timestamptz, revoked_by_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'support grants are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY SELECT g.id, g.company_id, c.display_name, g.granted_by, p.name, g.reason, g.starts_at, g.ends_at,
      g.revoked_at, r.name
    FROM support_grant g JOIN company c ON c.id = g.company_id JOIN person p ON p.id = g.granted_by
    LEFT JOIN person r ON r.id = g.revoked_by
    WHERE NOT coalesce(p_active_only, false) OR (g.revoked_at IS NULL AND g.starts_at <= now() AND g.ends_at > now())
    ORDER BY g.starts_at DESC, g.id;
END $$;

-- The platform tables: written only by platform admins (versions from a future date) and the
-- platform system (the bootstrap and the seed). Read by anyone: prices are not secret.
CREATE FUNCTION app.check_platform_writer() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.is_platform_admin() OR app.is_platform_system()) THEN
    RAISE EXCEPTION 'platform settings are changed by platform admins' USING ERRCODE = 'RA111';
  END IF;
END $$;

CREATE FUNCTION app.add_price_list(p_tier text, p_single_room bigint, p_self_contained bigint, p_commercial bigint,
  p_minimum bigint, p_annual_discount_bps int, p_effective_from date, p_placeholder boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid := uuidv7();
BEGIN
  PERFORM app.check_platform_writer();
  IF app.is_platform_admin() AND p_effective_from <= current_date THEN
    RAISE EXCEPTION 'a new price list takes effect from a future date' USING ERRCODE = 'RA112';
  END IF;
  INSERT INTO price_list (id, tier, rate_single_room_minor, rate_self_contained_minor, rate_commercial_minor,
    minimum_minor, annual_discount_bps, effective_from, placeholder, created_by)
  VALUES (v_id, p_tier, p_single_room, p_self_contained, p_commercial, p_minimum, p_annual_discount_bps,
    p_effective_from, coalesce(p_placeholder, false), app.current_person_id());
  RETURN v_id;
END $$;

CREATE FUNCTION app.add_subscription_terms(p_effective_from date, p_trial_days int, p_grace_days int,
  p_read_only_enabled boolean, p_due_days int, p_retention_days int, p_vat_registered boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid := uuidv7();
BEGIN
  PERFORM app.check_platform_writer();
  IF app.is_platform_admin() AND p_effective_from < current_date THEN
    RAISE EXCEPTION 'new terms take effect from today or later' USING ERRCODE = 'RA112';
  END IF;
  INSERT INTO subscription_terms (id, effective_from, trial_days, grace_days, read_only_enabled, due_days,
    retention_days_after_cancel, vat_registered, created_by)
  VALUES (v_id, p_effective_from, p_trial_days, p_grace_days, p_read_only_enabled, p_due_days, p_retention_days,
    coalesce(p_vat_registered, false), app.current_person_id());
  RETURN v_id;
END $$;

CREATE FUNCTION app.add_whatsapp_rate(p_category text, p_rate bigint, p_effective_from date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid := uuidv7();
BEGIN
  PERFORM app.check_platform_writer();
  INSERT INTO whatsapp_rate (id, category, rate_minor, effective_from, created_by)
  VALUES (v_id, p_category, p_rate, p_effective_from, app.current_person_id());
  RETURN v_id;
END $$;

-- The access of each company a person belongs to (decision 11), read with their memberships on
-- every request so the policy can refuse changes while a company is read-only.
CREATE FUNCTION app.company_access_for_person(p_person_id uuid)
RETURNS TABLE (company_id uuid, access text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.access FROM membership m JOIN company c ON c.id = m.company_id
  WHERE m.person_id = p_person_id AND m.status IN ('invited', 'active')
$$;

-- Recent alerts, for the console's system health (platform admins only).
CREATE FUNCTION app.recent_alerts(p_limit int)
RETURNS SETOF alert_event
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'alerts are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY SELECT * FROM alert_event ORDER BY occurred_at DESC, id DESC LIMIT least(coalesce(p_limit, 50), 500);
END $$;
--> statement-breakpoint

-- 6. The VAT rule, audit and grants -------------------------------------------------------------

-- Decision 10 (OQ-48): VAT and levies on subscription invoices read their own row, unverified, with
-- the same breakdown as vat.commercial_rent; charged only while the terms record the platform's
-- VAT registration (off). Its effective-from date is vat.commercial_rent's, a technical bound.
INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', 'vat.platform_subscription', r.value, r.effective_from,
       'M10 decision 10; Act 1151; tax adviser to confirm whether and how VAT applies to the subscription (OQ-48)',
       'unverified',
       'Effective-from date is a technical lower bound. Charged only while the subscription terms record the '
       || 'platform''s VAT registration, which is off by default.',
       'migration:0058_subscription_security'
FROM rule r
WHERE r.country = 'GH' AND r.key = 'vat.commercial_rent'
ORDER BY r.effective_from, r.created_at
LIMIT 1;

CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON subscription_invoice
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON subscription_payment
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON subscription_receipt
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON discount_code
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON discount_redemption
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON support_grant
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON subscription_export
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');

-- Who may run what.
REVOKE ALL ON FUNCTION app.freeze_except(), app.check_subscription_invoice_status(),
  app.support_access_allowed(uuid), app.active_support_grant(uuid),
  app.apply_subscription_state(uuid, text, text), app.company_plans(), app.subscriber_companies(),
  app.support_grants_all(boolean), app.check_platform_writer(),
  app.add_price_list(text, bigint, bigint, bigint, bigint, int, date, boolean),
  app.add_subscription_terms(date, int, int, boolean, int, int, boolean),
  app.add_whatsapp_rate(text, bigint, date), app.recent_alerts(int), app.company_access_for_person(uuid) FROM PUBLIC;

GRANT SELECT ON support_grant TO rent_system;
GRANT UPDATE (plan, access, updated_at) ON company TO rent_system;
GRANT SELECT ON person TO rent_system;
GRANT SELECT, INSERT ON price_list, subscription_terms, whatsapp_rate, alert_event TO rent_system;

ALTER FUNCTION app.support_access_allowed(uuid) OWNER TO rent_system;
ALTER FUNCTION app.active_support_grant(uuid) OWNER TO rent_system;
ALTER FUNCTION app.apply_subscription_state(uuid, text, text) OWNER TO rent_system;
ALTER FUNCTION app.company_plans() OWNER TO rent_system;
ALTER FUNCTION app.subscriber_companies() OWNER TO rent_system;
ALTER FUNCTION app.support_grants_all(boolean) OWNER TO rent_system;
ALTER FUNCTION app.check_platform_writer() OWNER TO rent_system;
ALTER FUNCTION app.add_price_list(text, bigint, bigint, bigint, bigint, int, date, boolean) OWNER TO rent_system;
ALTER FUNCTION app.add_subscription_terms(date, int, int, boolean, int, int, boolean) OWNER TO rent_system;
ALTER FUNCTION app.add_whatsapp_rate(text, bigint, date) OWNER TO rent_system;
ALTER FUNCTION app.recent_alerts(int) OWNER TO rent_system;
ALTER FUNCTION app.company_access_for_person(uuid) OWNER TO rent_system;

GRANT EXECUTE ON FUNCTION app.support_access_allowed(uuid), app.active_support_grant(uuid),
  app.apply_subscription_state(uuid, text, text), app.company_plans(), app.subscriber_companies(),
  app.support_grants_all(boolean), app.add_price_list(text, bigint, bigint, bigint, bigint, int, date, boolean),
  app.add_subscription_terms(date, int, int, boolean, int, int, boolean), app.add_whatsapp_rate(text, bigint, date),
  app.recent_alerts(int), app.company_access_for_person(uuid) TO rent_app;
GRANT EXECUTE ON FUNCTION app.support_access_allowed(uuid), app.check_platform_writer() TO rent_system;
-- audit.append and the row-change trigger run as rent_owner and read app.current_company_id().
GRANT EXECUTE ON FUNCTION app.support_access_allowed(uuid) TO rent_owner;

GRANT SELECT ON price_list, subscription_terms, whatsapp_rate TO rent_app;
GRANT INSERT ON alert_event TO rent_app;
GRANT SELECT, INSERT ON subscription_event, billing_snapshot, billing_snapshot_unit, subscription_invoice_line,
  subscription_allocation, discount_code, discount_redemption, subscription_receipt, support_grant,
  subscription_export TO rent_app;
GRANT SELECT, INSERT ON subscription, subscription_invoice, subscription_payment TO rent_app;
GRANT UPDATE (tier, status, trial_ends_on, pending_tier, pending_tier_from, cancels_on, cancel_reason, cancelled_on,
  read_only_until, updated_at) ON subscription TO rent_app;
GRANT UPDATE (status, paid_at, render_request_id, document_id, sha256, updated_at) ON subscription_invoice TO rent_app;
GRANT UPDATE (status, provider_reference, checkout_url, message, succeeded_at, failed_at, failure_reason, reversed_at,
  updated_at) ON subscription_payment TO rent_app;
GRANT UPDATE (render_request_id, document_id, sha256) ON subscription_receipt TO rent_app;
GRANT UPDATE (revoked_at, revoked_by) ON support_grant TO rent_app;
GRANT UPDATE (status, document_id, updated_at) ON subscription_export TO rent_app;

-- The placeholder price lists and terms (decisions 3, 5, 7, 10, 11 and 12; OQ-37 rates stay
-- placeholders, marked as such in the console until a platform admin adds real versions). The
-- effective date is a technical lower bound.
INSERT INTO subscription_terms (effective_from, trial_days, grace_days, read_only_enabled, due_days,
  retention_days_after_cancel, vat_registered)
VALUES ('2026-01-01', 30, 14, true, 7, 90, false);
INSERT INTO price_list (tier, rate_single_room_minor, rate_self_contained_minor, rate_commercial_minor,
  minimum_minor, annual_discount_bps, effective_from, placeholder)
VALUES ('starter', 500, 1000, 2000, 5000, 1000, '2026-01-01', true),
       ('growth', 800, 1500, 3000, 15000, 1000, '2026-01-01', true),
       ('portfolio', 1200, 2200, 4500, 40000, 1000, '2026-01-01', true);
