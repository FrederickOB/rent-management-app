-- Messaging reference data and the delivery-report path (M6 phase 2): version 1 of every message
-- template (platform reference data, CM-07: the same rows in every environment; a changed text is
-- a new version, never an edit), and the narrow system functions delivery reports and push
-- receipts need (ADR-002). Applied as rent_owner, after 0032. See docs/plans/M6.md section 4.

-- 1. The template registry (CM-07). The texts are `TEMPLATE_DEFINITIONS` in
-- packages/domain/src/messaging/whatsapp.ts; a test checks the two agree.
INSERT INTO message_template (key, version, whatsapp_name, category, language, body, parameters, created_by)
SELECT v.key, v.version, v.whatsapp_name, v.category, v.language, v.body, v.parameters, 'migration 0033'
FROM (VALUES
  ('rent_reminder', 1, 'rent_reminder_v1', 'utility', 'en',
   'Hello {{2}}, this is a rent reminder from {{1}}. See what is due and pay by MoMo or card at {{3}} whenever you are ready.',
   '["landlord","tenant","link"]'::jsonb),
  ('receipt_ready', 1, 'receipt_ready_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has received your payment. Your receipt is at {{3}} and stays open for 30 days.',
   '["landlord","tenant","link"]'::jsonb),
  ('pay_link', 1, 'pay_link_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has sent you a secure link to pay: {{3}} works for this payment only.',
   '["landlord","tenant","link"]'::jsonb),
  ('renewal_reminder', 1, 'renewal_reminder_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} would like to talk with you about renewing your tenancy. Reply here when you are free.',
   '["landlord","tenant"]'::jsonb),
  ('signing_link', 1, 'signing_link_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has sent you a document to read and sign at {{3}} with a code sent to your phone.',
   '["landlord","tenant","link"]'::jsonb),
  ('signing_reminder', 1, 'signing_reminder_v1', 'utility', 'en',
   'Hello {{2}}, a reminder from {{1}}: a document is waiting for you to sign at {{3}} with a code sent to your phone.',
   '["landlord","tenant","link"]'::jsonb),
  ('signed_copy', 1, 'signed_copy_v1', 'utility', 'en',
   'Hello {{2}}, everyone has signed. Your copy from {{1}} is at {{3}} for you to keep.',
   '["landlord","tenant","link"]'::jsonb),
  ('id_check_link', 1, 'id_check_link_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} asks you to confirm your identity against your Ghana Card at {{3}} using your phone camera.',
   '["landlord","tenant","link"]'::jsonb),
  ('paid_until_prompt', 1, 'paid_until_prompt_v1', 'utility', 'en',
   'Hello {{2}}, your rent with {{1}} is paid until {{3}}. Reply here to talk about the next payment.',
   '["landlord","tenant","paid_until"]'::jsonb),
  ('building_notice', 1, 'building_notice_v1', 'utility', 'en',
   'A notice from {{1}} about {{2}}: {{3}}. Reply here if you have a question.',
   '["landlord","topic","notice"]'::jsonb),
  ('conversation_reopen', 1, 'conversation_reopen_v1', 'utility', 'en',
   'Hello {{2}}, {{1}} has replied to your message. Reply here to read it and carry on.',
   '["landlord","tenant"]'::jsonb)

) AS v(key, version, whatsapp_name, category, language, body, parameters)
ON CONFLICT (key, language, version) DO NOTHING;
--> statement-breakpoint

-- 2. Delivery reports (plan 4.3): the company and message a provider's message id belongs to, from
-- the `sent` event that recorded it. Webhooks arrive before any company is known.
CREATE FUNCTION app.message_by_provider_id(p_provider text, p_provider_message_id text)
RETURNS TABLE (company_id uuid, message_id uuid, channel text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.company_id, e.message_id, e.channel FROM message_event e
  WHERE e.provider = p_provider AND e.provider_message_id = p_provider_message_id AND e.status = 'sent'
  LIMIT 1
$$;

-- Expo says a token no longer reaches a device (DeviceNotRegistered): forget it, for everyone.
CREATE FUNCTION app.drop_push_token(p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM push_device d WHERE d.token = p_token;
  RETURN FOUND;
END $$;

-- The person behind a tenant of the transaction's company (the tenant app's push consent, and the
-- in-app channel), never another company's.
CREATE FUNCTION app.tenant_has_app(p_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant t JOIN push_device d ON d.person_id = t.person_id
    JOIN session s ON s.id = d.session_id AND s.expires_at > now()
    WHERE t.company_id = app.current_company_id() AND t.id = p_tenant_id)
$$;

-- Rule 1 of shared-number routing for SMS too (decision 4): the companies that last messaged an
-- address on a channel since a time, ids only. (WhatsApp also names its number.)
CREATE FUNCTION app.recent_channel_companies(p_channel text, p_address text, p_since timestamptz)
RETURNS TABLE (company_id uuid, last_outbound_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.company_id, max(x.last_outbound_at) FROM conversation_channel x JOIN company c ON c.id = x.company_id
  WHERE x.channel = p_channel AND x.address = p_address AND x.last_outbound_at >= p_since AND c.status = 'active'
  GROUP BY x.company_id ORDER BY 2 DESC
$$;

-- The pending statement a bot session asked for (CM-03), by its render request: the job that
-- hears the PDF is ready finds who to send it to, in the transaction's company only.
CREATE INDEX bot_session_pending_idx ON bot_session USING gin ((context -> 'pendingStatements'));

-- The broadcast fan-out records how many batches it has queued (plan 4.7).
GRANT UPDATE (preview_token_hash) ON broadcast TO rent_app;

GRANT SELECT ON message_event TO rent_system;
ALTER FUNCTION app.message_by_provider_id(text, text) OWNER TO rent_system;
ALTER FUNCTION app.drop_push_token(text) OWNER TO rent_system;
ALTER FUNCTION app.tenant_has_app(uuid) OWNER TO rent_system;
ALTER FUNCTION app.recent_channel_companies(text, text, timestamptz) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.message_by_provider_id(text, text), app.drop_push_token(text),
  app.tenant_has_app(uuid), app.recent_channel_companies(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.message_by_provider_id(text, text), app.drop_push_token(text),
  app.tenant_has_app(uuid), app.recent_channel_companies(text, text, timestamptz) TO rent_app;
