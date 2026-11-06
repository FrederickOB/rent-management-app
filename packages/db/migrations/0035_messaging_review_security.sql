-- M6 review (S-6, M4): the system functions that look across companies answer only the platform's
-- own jobs (the system outside any company, ADR-002), as app.tenancies_for_person checks its
-- caller; and the WhatsApp numbers a company may send from, for replying on the number a tenant
-- wrote to. Applied as rent_owner, after 0034. CREATE OR REPLACE keeps owners and grants.
--
-- Error code: RA063 a platform-only function called by someone else (as in 0031).

CREATE OR REPLACE FUNCTION app.companies_for_phone(p_phone text)
RETURNS TABLE (company_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_system() THEN
    RAISE EXCEPTION 'shared-number routing is for the platform''s jobs' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
  SELECT c.id, c.display_name FROM company c
  WHERE c.status = 'active' AND p_phone ~ '^\+[1-9][0-9]{6,14}$' AND (
    EXISTS (SELECT 1 FROM tenant t WHERE t.company_id = c.id AND t.archived_at IS NULL
            AND (t.phone = p_phone OR t.whatsapp_phone = p_phone))
    OR EXISTS (SELECT 1 FROM tenant_contact k JOIN tenant t ON t.company_id = k.company_id AND t.id = k.tenant_id
               WHERE k.company_id = c.id AND k.archived_at IS NULL AND t.archived_at IS NULL AND k.phone = p_phone)
    OR EXISTS (SELECT 1 FROM channel_identity i WHERE i.company_id = c.id AND i.revoked_at IS NULL
               AND i.channel IN ('whatsapp', 'sms') AND i.address = p_phone))
  ORDER BY c.display_name, c.id;
END $$;

CREATE OR REPLACE FUNCTION app.recent_whatsapp_companies(p_account_id uuid, p_phone text, p_since timestamptz)
RETURNS TABLE (company_id uuid, last_outbound_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_system() THEN
    RAISE EXCEPTION 'shared-number routing is for the platform''s jobs' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
  SELECT x.company_id, max(x.last_outbound_at) FROM conversation_channel x JOIN company c ON c.id = x.company_id
  WHERE x.channel = 'whatsapp' AND x.whatsapp_account_id = p_account_id AND x.address = p_phone
    AND x.last_outbound_at >= p_since AND c.status = 'active'
  GROUP BY x.company_id ORDER BY 2 DESC;
END $$;

CREATE OR REPLACE FUNCTION app.recent_channel_companies(p_channel text, p_address text, p_since timestamptz)
RETURNS TABLE (company_id uuid, last_outbound_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_system() THEN
    RAISE EXCEPTION 'shared-number routing is for the platform''s jobs' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
  SELECT x.company_id, max(x.last_outbound_at) FROM conversation_channel x JOIN company c ON c.id = x.company_id
  WHERE x.channel = p_channel AND x.address = p_address AND x.last_outbound_at >= p_since AND c.status = 'active'
  GROUP BY x.company_id ORDER BY 2 DESC;
END $$;

CREATE OR REPLACE FUNCTION app.message_by_provider_id(p_provider text, p_provider_message_id text)
RETURNS TABLE (company_id uuid, message_id uuid, channel text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_system() THEN
    RAISE EXCEPTION 'delivery reports are matched by the platform''s jobs' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
  SELECT e.company_id, e.message_id, e.channel FROM message_event e
  WHERE e.provider = p_provider AND e.provider_message_id = p_provider_message_id AND e.status = 'sent'
  LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION app.drop_push_token(p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_system() THEN
    RAISE EXCEPTION 'dead push tokens are dropped by the platform''s jobs' USING ERRCODE = 'RA063';
  END IF;
  DELETE FROM push_device d WHERE d.token = p_token;
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- The numbers a company may send WhatsApp from: its own (first) and the shared one, active only,
-- for the transaction's own company. A reply goes from the number the tenant wrote to (M4).
CREATE FUNCTION app.whatsapp_company_accounts(p_company_id uuid)
RETURNS TABLE (account_id uuid, phone_number_id text, kind text, display_phone text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.phone_number_id, a.kind, a.display_phone, a.display_name FROM whatsapp_account a
  WHERE p_company_id = app.current_company_id() AND a.status = 'active'
    AND ((a.kind = 'company' AND a.owner_company_id = p_company_id) OR a.kind = 'shared')
  ORDER BY (a.kind = 'company') DESC, a.created_at
$$;
ALTER FUNCTION app.whatsapp_company_accounts(uuid) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.whatsapp_company_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_company_accounts(uuid) TO rent_app;
