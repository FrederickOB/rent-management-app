-- Messaging security and integrity (M6): RLS with property and tenant scope on the new company
-- tables; append-only messages, attachments and broadcast recipients; ticket numbers per company;
-- a conversation's identity fixed once linked; the narrow system functions for WhatsApp numbers
-- and templates, shared-number routing, email tokens, push devices and the interim plan (ADR-002:
-- ids and the least else); NOTIFY for the live inbox, ids only; row-level audit; and grants.
-- Applied as rent_owner, after 0030. See docs/plans/M6.md section 4.
--
-- Error codes: RA060 a conversation's tenant, merge or triage address changed once set; RA061 a
-- message filed in a conversation of another tenant; RA062 a linked identity changed or revoked
-- twice; RA063 a platform-only function called by someone else; RA064 a push device registered for
-- another person or session.

-- 1. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'conversation', 'conversation_channel', 'message_attachment', 'channel_identity', 'bot_session',
  'reply_address', 'unsubscribe_token', 'tenant_group', 'tenant_group_member', 'broadcast',
  'broadcast_recipient', 'maintenance_job', 'maintenance_job_attachment'
]::regclass[]) AS t;

-- A conversation follows its tenant: scoped staff see it through the tenant's leases on their
-- properties (the tenant table's own policies decide), and a tenant session sees only its own.
-- Triage names no tenant, so only people who see the whole company see it (plan 4.6).
SELECT app.enable_tenant_scope('conversation');
CREATE POLICY property_scope ON conversation AS RESTRICTIVE USING (
  app.property_scope() IS NULL
  OR (conversation.tenant_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tenant t WHERE t.company_id = conversation.company_id AND t.id = conversation.tenant_id)));

-- What hangs off a conversation follows it.
CREATE FUNCTION app.enable_conversation_visibility(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE POLICY conversation_visible ON %1$s AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM conversation c WHERE c.company_id = %1$s.company_id AND c.id = %1$s.conversation_id))',
    p_table);
END $$;
SELECT app.enable_conversation_visibility(t) FROM unnest(ARRAY[
  'conversation_channel', 'bot_session', 'reply_address'
]::regclass[]) AS t;

-- Attachments follow their message, as message events do (M3). A tenant session reads the
-- attachments of its own messages (the photos in its thread), nothing else.
CREATE POLICY message_visible ON message_attachment AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM message m WHERE m.company_id = message_attachment.company_id AND m.id = message_attachment.message_id));
CREATE POLICY tenant_visible ON message_attachment AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR EXISTS (
    SELECT 1 FROM message m WHERE m.company_id = message_attachment.company_id AND m.id = message_attachment.message_id
      AND m.tenant_id = ANY(app.tenant_scope())));

-- Linked identities, unsubscribe tokens and group members follow their tenant.
SELECT app.enable_tenant_visibility(t) FROM unnest(ARRAY[
  'channel_identity', 'unsubscribe_token', 'tenant_group_member'
]::regclass[]) AS t;

-- A broadcast: its property in scope, or its sender, or a whole-company session. Its recipients
-- follow it and their own property.
CREATE POLICY property_scope ON broadcast AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR broadcast.created_by = app.current_person_id()
  OR broadcast.property_id = ANY(app.property_scope()));
SELECT app.enable_property_scope('broadcast_recipient');
CREATE POLICY broadcast_visible ON broadcast_recipient AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM broadcast b WHERE b.company_id = broadcast_recipient.company_id AND b.id = broadcast_recipient.broadcast_id));

-- Maintenance jobs carry their property (AD-02) and, when a tenant reported them, the tenant.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'maintenance_job', 'maintenance_job_attachment'
]::regclass[]) AS t;
SELECT app.enable_tenant_scope('maintenance_job');
CREATE POLICY job_visible ON maintenance_job_attachment AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM maintenance_job j WHERE j.company_id = maintenance_job_attachment.company_id AND j.id = maintenance_job_attachment.job_id));

-- Staff only: tenant sessions never read the bot's state, tokens, identities, groups or broadcasts.
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'conversation_channel', 'bot_session', 'reply_address', 'unsubscribe_token', 'channel_identity', 'tenant_group',
  'tenant_group_member', 'broadcast', 'broadcast_recipient', 'maintenance_job_attachment'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only (CLAUDE.md section 6; plan section 6) ----------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'message_attachment', 'broadcast_recipient', 'maintenance_job_attachment', 'message_template'
]::regclass[]) AS t;
--> statement-breakpoint

-- 3. Integrity the database keeps --------------------------------------------------------------

-- A conversation's tenant is set once (when triage is linked) and never moved; a merge is set
-- once; the triage channel and address it began with never change (CM-02, CM-05).
CREATE FUNCTION app.check_conversation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'conversation % already belongs to a tenant', OLD.id USING ERRCODE = 'RA060';
  END IF;
  IF OLD.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    RAISE EXCEPTION 'conversation % was already merged', OLD.id USING ERRCODE = 'RA060';
  END IF;
  IF NEW.triage_channel IS DISTINCT FROM OLD.triage_channel
     OR NEW.triage_address IS DISTINCT FROM OLD.triage_address THEN
    RAISE EXCEPTION 'conversation % keeps the address it began with', OLD.id USING ERRCODE = 'RA060';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_identity BEFORE UPDATE ON conversation
  FOR EACH ROW EXECUTE FUNCTION app.check_conversation_update();
CREATE TRIGGER conversation_no_delete BEFORE DELETE OR TRUNCATE ON conversation
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- A message goes in its own tenant's conversation (or a triage one, with no tenant). Definer, so
-- a scoped sender is checked against the conversation even where its policies hide it.
CREATE FUNCTION app.check_message_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid;
  v_found boolean;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT true, c.tenant_id INTO v_found, v_tenant FROM conversation c
  WHERE c.company_id = NEW.company_id AND c.id = NEW.conversation_id;
  IF v_found AND v_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'message % belongs in its own tenant''s conversation', NEW.id USING ERRCODE = 'RA061';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_conversation BEFORE INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION app.check_message_conversation();

-- A linked identity keeps what was linked; it is revoked once, and stays revoked.
CREATE FUNCTION app.check_channel_identity_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by'])
     OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'linked identity % is revoked once, and otherwise never changes', OLD.id
      USING ERRCODE = 'RA062';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_identity_revoke BEFORE UPDATE ON channel_identity
  FOR EACH ROW EXECUTE FUNCTION app.check_channel_identity_update();
CREATE TRIGGER channel_identity_no_delete BEFORE DELETE OR TRUNCATE ON channel_identity
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Ticket numbers (CM-04): 1, 2, 3 … per company, assigned here whatever the insert says. Definer,
-- so a session scoped to some properties still counts every job of the company; the advisory lock
-- serialises concurrent reports in one company.
CREATE FUNCTION app.assign_maintenance_ticket() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('maintenance_job:' || NEW.company_id::text, 0));
  SELECT coalesce(max(j.ticket_number), 0) + 1 INTO NEW.ticket_number
  FROM maintenance_job j WHERE j.company_id = NEW.company_id;
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_job_ticket BEFORE INSERT ON maintenance_job
  FOR EACH ROW EXECUTE FUNCTION app.assign_maintenance_ticket();
CREATE TRIGGER maintenance_job_no_delete BEFORE DELETE OR TRUNCATE ON maintenance_job
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
-- The interim plan's column is the platform admin's alone (decision 9): the application role has no
-- UPDATE on it (grants below), and app.set_company_plan() checks who is asking.
--> statement-breakpoint

-- 4. Narrow system functions (ADR-002) ----------------------------------------------------------

-- Whether this transaction is a platform admin's: the actor kind and an active platform-admin
-- membership of the platform company for the person in context.
CREATE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.current_actor_kind() = 'platform_admin' AND EXISTS (
    SELECT 1 FROM membership m JOIN company c ON c.id = m.company_id
    WHERE c.kind = 'platform' AND c.status = 'active' AND m.person_id = app.current_person_id()
      AND m.role = 'platform_admin' AND m.status = 'active')
$$;

-- A platform-level job: the system, outside any company.
CREATE FUNCTION app.is_platform_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_actor_kind() = 'system' AND app.current_company_id() IS NULL
$$;

-- WhatsApp numbers (CM-01; decision 3). The number a webhook names: whose it is.
CREATE FUNCTION app.whatsapp_account_by_number(p_phone_number_id text)
RETURNS TABLE (account_id uuid, kind text, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.kind, a.owner_company_id FROM whatsapp_account a
  WHERE a.phone_number_id = p_phone_number_id AND a.status = 'active'
$$;

-- The number a company sends from: its own when it has one, otherwise the shared one.
CREATE FUNCTION app.whatsapp_sending_account(p_company_id uuid)
RETURNS TABLE (account_id uuid, phone_number_id text, kind text, display_phone text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.phone_number_id, a.kind, a.display_phone, a.display_name FROM whatsapp_account a
  WHERE p_company_id = app.current_company_id() AND a.status = 'active'
    AND ((a.kind = 'company' AND a.owner_company_id = p_company_id) OR a.kind = 'shared')
  ORDER BY (a.kind = 'company') DESC LIMIT 1
$$;

-- Each template's approval on the numbers a company uses (CM-07): its own and the shared one.
CREATE FUNCTION app.whatsapp_template_statuses(p_company_id uuid)
RETURNS TABLE (account_id uuid, account_kind text, display_phone text, display_name text, is_sending boolean,
  template_id uuid, template_key text, template_version int, language text, status text, category text,
  reason text, checked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH accounts AS (
    SELECT a.*, (a.id = (SELECT s.account_id FROM app.whatsapp_sending_account(p_company_id) s)) AS is_sending
    FROM whatsapp_account a
    WHERE p_company_id = app.current_company_id() AND a.status = 'active'
      AND ((a.kind = 'company' AND a.owner_company_id = p_company_id) OR a.kind = 'shared')
  )
  SELECT a.id, a.kind, a.display_phone, a.display_name, a.is_sending, t.id, t.key, t.version, t.language,
         s.status, s.category, s.reason, s.checked_at
  FROM accounts a JOIN whatsapp_template_status s ON s.whatsapp_account_id = a.id
  JOIN message_template t ON t.id = s.template_id
  ORDER BY t.key, t.version, a.kind
$$;

-- Every number, for the platform admin's console and the template sync job.
CREATE FUNCTION app.whatsapp_accounts()
RETURNS TABLE (id uuid, phone_number_id text, waba_id text, display_phone text, display_name text, kind text,
  company_id uuid, company_name text, status text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.is_platform_admin() OR app.is_platform_system()) THEN
    RAISE EXCEPTION 'WhatsApp numbers are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY
    SELECT a.id, a.phone_number_id, a.waba_id, a.display_phone, a.display_name, a.kind, a.owner_company_id,
           c.display_name, a.status, a.created_at
    FROM whatsapp_account a LEFT JOIN company c ON c.id = a.owner_company_id
    ORDER BY a.kind DESC, c.display_name NULLS FIRST, a.created_at;
END $$;

-- A platform admin registers a number: the shared one, or a company's own.
CREATE FUNCTION app.register_whatsapp_account(p_phone_number_id text, p_waba_id text, p_display_phone text,
  p_display_name text, p_kind text, p_company_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid := uuidv7();
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'WhatsApp numbers are registered by platform admins' USING ERRCODE = 'RA063';
  END IF;
  INSERT INTO whatsapp_account (id, phone_number_id, waba_id, display_phone, display_name, kind, owner_company_id,
    registered_by)
  VALUES (v_id, p_phone_number_id, p_waba_id, p_display_phone, p_display_name, p_kind, p_company_id,
    app.current_person_id());
  RETURN v_id;
END $$;

CREATE FUNCTION app.retire_whatsapp_account(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'WhatsApp numbers are retired by platform admins' USING ERRCODE = 'RA063';
  END IF;
  UPDATE whatsapp_account SET status = 'retired', updated_at = now() WHERE id = p_id AND status = 'active';
  RETURN FOUND;
END $$;

-- The template sync job and Meta's template webhook record a template's status on a number.
CREATE FUNCTION app.record_whatsapp_template_status(p_account_id uuid, p_template_id uuid, p_status text,
  p_category text, p_meta_template_id text, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.is_platform_admin() OR app.is_platform_system()) THEN
    RAISE EXCEPTION 'template statuses are recorded by the platform' USING ERRCODE = 'RA063';
  END IF;
  INSERT INTO whatsapp_template_status (whatsapp_account_id, template_id, status, category, meta_template_id, reason)
  VALUES (p_account_id, p_template_id, p_status, p_category, p_meta_template_id, p_reason)
  ON CONFLICT (whatsapp_account_id, template_id) DO UPDATE
    SET status = excluded.status, category = excluded.category,
        meta_template_id = coalesce(excluded.meta_template_id, whatsapp_template_status.meta_template_id),
        reason = excluded.reason, checked_at = now(), updated_at = now();
END $$;

-- Shared-number routing (decision 4; TL-12). The companies where a phone is a tenant, a tenant's
-- contact or a linked identity: ids and display names only, for the "which landlord?" question.
CREATE FUNCTION app.companies_for_phone(p_phone text)
RETURNS TABLE (company_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.display_name FROM company c
  WHERE c.status = 'active' AND p_phone ~ '^\+[1-9][0-9]{6,14}$' AND (
    EXISTS (SELECT 1 FROM tenant t WHERE t.company_id = c.id AND t.archived_at IS NULL
            AND (t.phone = p_phone OR t.whatsapp_phone = p_phone))
    OR EXISTS (SELECT 1 FROM tenant_contact k JOIN tenant t ON t.company_id = k.company_id AND t.id = k.tenant_id
               WHERE k.company_id = c.id AND k.archived_at IS NULL AND t.archived_at IS NULL AND k.phone = p_phone)
    OR EXISTS (SELECT 1 FROM channel_identity i WHERE i.company_id = c.id AND i.revoked_at IS NULL
               AND i.channel IN ('whatsapp', 'sms') AND i.address = p_phone))
  ORDER BY c.display_name, c.id
$$;

-- The companies that last messaged this phone on this WhatsApp number since a time (rule 1).
CREATE FUNCTION app.recent_whatsapp_companies(p_account_id uuid, p_phone text, p_since timestamptz)
RETURNS TABLE (company_id uuid, last_outbound_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.company_id, max(x.last_outbound_at) FROM conversation_channel x JOIN company c ON c.id = x.company_id
  WHERE x.channel = 'whatsapp' AND x.whatsapp_account_id = p_account_id AND x.address = p_phone
    AND x.last_outbound_at >= p_since AND c.status = 'active'
  GROUP BY x.company_id ORDER BY 2 DESC
$$;

-- Email reply and unsubscribe tokens (CM-10, CM-09): the company and record a token's hash names.
CREATE FUNCTION app.reply_address_company(p_token_hash text)
RETURNS TABLE (company_id uuid, conversation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.company_id, r.conversation_id FROM reply_address r WHERE r.token_hash = p_token_hash
$$;

CREATE FUNCTION app.unsubscribe_token_company(p_token_hash text)
RETURNS TABLE (company_id uuid, token_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.company_id, u.id FROM unsubscribe_token u WHERE u.token_hash = p_token_hash
$$;

-- Push devices (decision 5). A tenant registers a device for their own live session; a token
-- seen again moves to the new session and person, so it is never registered twice.
CREATE FUNCTION app.register_push_device(p_session_id uuid, p_token text, p_platform text, p_device_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_person uuid := app.current_person_id();
  v_id uuid;
BEGIN
  IF app.current_actor_kind() <> 'tenant' OR v_person IS NULL OR NOT EXISTS (
       SELECT 1 FROM session s WHERE s.id = p_session_id AND s.user_id = v_person AND s.expires_at > now()) THEN
    RAISE EXCEPTION 'a push device is registered by its own tenant session' USING ERRCODE = 'RA064';
  END IF;
  INSERT INTO push_device (person_id, session_id, token, platform, device_name)
  VALUES (v_person, p_session_id, p_token, p_platform, nullif(btrim(p_device_name), ''))
  ON CONFLICT (token) DO UPDATE
    SET person_id = excluded.person_id, session_id = excluded.session_id, platform = excluded.platform,
        device_name = excluded.device_name, last_seen_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.unregister_push_device(p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_actor_kind() <> 'tenant' OR app.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'a push device is removed by its own tenant' USING ERRCODE = 'RA064';
  END IF;
  DELETE FROM push_device d WHERE d.token = p_token AND d.person_id = app.current_person_id();
  RETURN FOUND;
END $$;

-- The send job's tokens: only those of the person behind a tenant of the transaction's company,
-- on live sessions (TL-12: a company learns nothing else about the person).
CREATE FUNCTION app.push_tokens_for_tenant(p_tenant_id uuid)
RETURNS TABLE (token text, platform text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.token, d.platform FROM tenant t
  JOIN push_device d ON d.person_id = t.person_id
  JOIN session s ON s.id = d.session_id AND s.expires_at > now()
  WHERE t.company_id = app.current_company_id() AND t.id = p_tenant_id AND t.archived_at IS NULL
  ORDER BY d.last_seen_at DESC
$$;

-- The interim plan (decision 9): a platform admin lists and sets it. The change is audited in the
-- company's own chain, so the function takes that company's context for the update.
CREATE FUNCTION app.company_plans()
RETURNS TABLE (company_id uuid, display_name text, kind text, status text, interim_plan text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'plans are for platform admins' USING ERRCODE = 'RA063';
  END IF;
  RETURN QUERY SELECT c.id, c.display_name, c.kind, c.status, c.interim_plan FROM company c
    WHERE c.kind <> 'platform' ORDER BY c.display_name, c.id;
END $$;

CREATE FUNCTION app.set_company_plan(p_company_id uuid, p_plan text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.company_id', true), '');
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'plans are set by platform admins' USING ERRCODE = 'RA063';
  END IF;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  UPDATE company SET interim_plan = p_plan, updated_at = now()
  WHERE id = p_company_id AND kind <> 'platform' AND interim_plan IS DISTINCT FROM p_plan;
  PERFORM set_config('app.company_id', v_previous, true);
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- 5. The live inbox (plan 4.6): NOTIFY with ids only, delivered on commit --------------------

CREATE FUNCTION app.notify_inbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_conversation uuid;
  v_message uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'conversation' THEN
      v_conversation := NEW.id;
    WHEN 'message' THEN
      v_conversation := NEW.conversation_id;
      v_message := NEW.id;
    ELSE
      -- message_event and message_attachment: the message's conversation.
      v_message := NEW.message_id;
      SELECT m.conversation_id INTO v_conversation FROM message m
      WHERE m.company_id = NEW.company_id AND m.id = NEW.message_id;
  END CASE;
  IF v_conversation IS NOT NULL THEN
    PERFORM pg_notify('inbox', json_build_object('companyId', NEW.company_id, 'conversationId', v_conversation,
      'messageId', v_message, 'kind', TG_TABLE_NAME)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_inbox AFTER INSERT OR UPDATE ON conversation
  FOR EACH ROW EXECUTE FUNCTION app.notify_inbox();
CREATE TRIGGER notify_inbox AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION app.notify_inbox();
CREATE TRIGGER notify_inbox AFTER INSERT ON message_event
  FOR EACH ROW EXECUTE FUNCTION app.notify_inbox();
CREATE TRIGGER notify_inbox AFTER INSERT ON message_attachment
  FOR EACH ROW EXECUTE FUNCTION app.notify_inbox();
--> statement-breakpoint

-- 6. Row-change audit (AD-07). Addresses are recorded only as changed, never by value. A
-- conversation is audited when its state, people, tags or tenant change, not when only its
-- last-message time moves.
CREATE TRIGGER audit_row AFTER INSERT ON conversation
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'triage_address');
CREATE TRIGGER audit_row_change AFTER UPDATE OF tenant_id, merged_into_id, state, assigned_to, tags,
  handover_reason, first_response_due_at, resolved_at, resolved_by, linked_by ON conversation
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'triage_address');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON channel_identity
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'address');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON tenant_group
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR DELETE ON tenant_group_member
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON broadcast
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON maintenance_job
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT ON maintenance_job_attachment
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
--> statement-breakpoint

-- 7. Ownership and grants -----------------------------------------------------------------------

GRANT SELECT ON whatsapp_account, whatsapp_template_status, message_template, conversation_channel,
  conversation, maintenance_job, tenant_contact, channel_identity, reply_address, unsubscribe_token,
  session, message TO rent_system;
GRANT INSERT, UPDATE (status, updated_at) ON whatsapp_account TO rent_system;
GRANT INSERT, UPDATE (status, category, meta_template_id, reason, checked_at, updated_at)
  ON whatsapp_template_status TO rent_system;
GRANT SELECT, INSERT, DELETE, UPDATE (person_id, session_id, platform, device_name, last_seen_at)
  ON push_device TO rent_system;
GRANT UPDATE (interim_plan, updated_at) ON company TO rent_system;

ALTER FUNCTION app.check_message_conversation() OWNER TO rent_system;
ALTER FUNCTION app.assign_maintenance_ticket() OWNER TO rent_system;
ALTER FUNCTION app.is_platform_admin() OWNER TO rent_system;
ALTER FUNCTION app.whatsapp_account_by_number(text) OWNER TO rent_system;
ALTER FUNCTION app.whatsapp_sending_account(uuid) OWNER TO rent_system;
ALTER FUNCTION app.whatsapp_template_statuses(uuid) OWNER TO rent_system;
ALTER FUNCTION app.whatsapp_accounts() OWNER TO rent_system;
ALTER FUNCTION app.register_whatsapp_account(text, text, text, text, text, uuid) OWNER TO rent_system;
ALTER FUNCTION app.retire_whatsapp_account(uuid) OWNER TO rent_system;
ALTER FUNCTION app.record_whatsapp_template_status(uuid, uuid, text, text, text, text) OWNER TO rent_system;
ALTER FUNCTION app.companies_for_phone(text) OWNER TO rent_system;
ALTER FUNCTION app.recent_whatsapp_companies(uuid, text, timestamptz) OWNER TO rent_system;
ALTER FUNCTION app.reply_address_company(text) OWNER TO rent_system;
ALTER FUNCTION app.unsubscribe_token_company(text) OWNER TO rent_system;
ALTER FUNCTION app.register_push_device(uuid, text, text, text) OWNER TO rent_system;
ALTER FUNCTION app.unregister_push_device(text) OWNER TO rent_system;
ALTER FUNCTION app.push_tokens_for_tenant(uuid) OWNER TO rent_system;
ALTER FUNCTION app.company_plans() OWNER TO rent_system;
ALTER FUNCTION app.set_company_plan(uuid, text) OWNER TO rent_system;
ALTER FUNCTION app.notify_inbox() OWNER TO rent_system;

REVOKE ALL ON FUNCTION app.enable_conversation_visibility(regclass), app.check_conversation_update(),
  app.check_message_conversation(), app.check_channel_identity_update(), app.assign_maintenance_ticket(),
  app.is_platform_admin(), app.is_platform_system(), app.whatsapp_account_by_number(text),
  app.whatsapp_sending_account(uuid), app.whatsapp_template_statuses(uuid), app.whatsapp_accounts(),
  app.register_whatsapp_account(text, text, text, text, text, uuid), app.retire_whatsapp_account(uuid),
  app.record_whatsapp_template_status(uuid, uuid, text, text, text, text), app.companies_for_phone(text),
  app.recent_whatsapp_companies(uuid, text, timestamptz), app.reply_address_company(text),
  app.unsubscribe_token_company(text), app.register_push_device(uuid, text, text, text),
  app.unregister_push_device(text), app.push_tokens_for_tenant(uuid), app.company_plans(),
  app.set_company_plan(uuid, text), app.notify_inbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_system() TO rent_system;
GRANT EXECUTE ON FUNCTION app.is_platform_admin(), app.is_platform_system(),
  app.whatsapp_account_by_number(text), app.whatsapp_sending_account(uuid),
  app.whatsapp_template_statuses(uuid), app.whatsapp_accounts(),
  app.register_whatsapp_account(text, text, text, text, text, uuid), app.retire_whatsapp_account(uuid),
  app.record_whatsapp_template_status(uuid, uuid, text, text, text, text), app.companies_for_phone(text),
  app.recent_whatsapp_companies(uuid, text, timestamptz), app.reply_address_company(text),
  app.unsubscribe_token_company(text), app.register_push_device(uuid, text, text, text),
  app.unregister_push_device(text), app.push_tokens_for_tenant(uuid), app.company_plans(),
  app.set_company_plan(uuid, text) TO rent_app;

-- Messages, events and attachments are insert-only for the application (CLAUDE.md section 6).
GRANT SELECT, INSERT ON message_attachment, broadcast_recipient, maintenance_job_attachment, reply_address,
  unsubscribe_token, maintenance_job TO rent_app;
GRANT SELECT ON message_template TO rent_app;
GRANT SELECT, INSERT ON conversation TO rent_app;
GRANT UPDATE (tenant_id, merged_into_id, state, assigned_to, tags, handover_reason, handed_over_at,
  first_response_due_at, last_message_at, last_inbound_at, last_inbound_channel, resolved_at, resolved_by,
  linked_by, linked_at, updated_at) ON conversation TO rent_app;
GRANT SELECT, INSERT ON conversation_channel TO rent_app;
GRANT UPDATE (last_inbound_at, last_outbound_at, updated_at) ON conversation_channel TO rent_app;
GRANT SELECT, INSERT ON channel_identity TO rent_app;
GRANT UPDATE (revoked_at, revoked_by) ON channel_identity TO rent_app;
GRANT SELECT, INSERT ON bot_session TO rent_app;
GRANT UPDATE (state, context, consent_asked_at, last_activity_at, expires_at, updated_at) ON bot_session TO rent_app;
GRANT SELECT, INSERT ON tenant_group TO rent_app;
GRANT UPDATE (name, description, archived_at, updated_at) ON tenant_group TO rent_app;
GRANT SELECT, INSERT, DELETE ON tenant_group_member TO rent_app;
GRANT SELECT, INSERT ON broadcast TO rent_app;
GRANT UPDATE (status, batches_queued, completed_at, updated_at) ON broadcast TO rent_app;
