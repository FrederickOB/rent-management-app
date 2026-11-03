-- Provider payments security and integrity (M4b): RLS with property, owner and tenant scope on the
-- new company tables; append-only where a row is a fact; the settlement-account and intent state
-- machines in the database; the foreign keys that point across modules; the narrow system
-- functions the webhook path and reconciliation use (ADR-002: ids and amounts only); the webhook
-- inbox relay's claim; row-level audit; and grants. Applied as rent_owner, after 0018. See
-- docs/plans/M4b.md section 4.
--
-- Error codes: RA051 a settlement account changed other than through its states, RA052 money
-- matched while a refund of it is live (or refunded once matched or reversed), RA053 a payment
-- intent changed other than through its states, RA054 a pay link without its tenant.

-- 1. Row Level Security on every new company-scoped table (ADR-002) ---------------------------

SELECT app.enable_company_rls(t) FROM unnest(ARRAY[
  'settlement_account', 'provider_subaccount', 'management_agreement', 'payment_intent',
  'provider_settlement', 'reconciliation_exception', 'reminder_sent', 'receipt_delivery',
  'unmatched_refund'
]::regclass[]) AS t;

-- Property scope (AD-02) where a row always carries its property.
SELECT app.enable_property_scope(t) FROM unnest(ARRAY[
  'payment_intent', 'reminder_sent', 'receipt_delivery'
]::regclass[]) AS t;

-- A settlement account: the owner's, for people who see that owner; the agency's own client
-- account, for people with the whole company in scope. Subaccounts and settlements follow it.
CREATE POLICY owner_scope ON settlement_account AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR owner_id = ANY(app.owner_scope()));
CREATE POLICY account_visible ON provider_subaccount AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM settlement_account a WHERE a.company_id = provider_subaccount.company_id
          AND a.id = provider_subaccount.settlement_account_id));
CREATE POLICY account_visible ON provider_settlement AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM settlement_account a WHERE a.company_id = provider_settlement.company_id
          AND a.id = provider_settlement.settlement_account_id));
CREATE POLICY owner_scope ON management_agreement AS RESTRICTIVE USING (
  app.property_scope() IS NULL OR owner_id = ANY(app.owner_scope()));
-- What reconciliation could not explain: in scope by its property, or its owner when it has no
-- property yet; company-level ones (no owner) for unscoped people.
CREATE POLICY property_scope ON reconciliation_exception AS RESTRICTIVE USING (
  app.in_money_scope(property_id, owner_id));
-- A refund of unmatched money follows its payment.
CREATE POLICY payment_visible ON unmatched_refund AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM payment p WHERE p.company_id = unmatched_refund.company_id AND p.id = unmatched_refund.payment_id));

-- Tenant sessions read their own payment intents; nothing else here.
SELECT app.enable_tenant_scope('payment_intent');
SELECT app.enable_staff_only(t) FROM unnest(ARRAY[
  'settlement_account', 'provider_subaccount', 'management_agreement', 'provider_settlement',
  'reconciliation_exception', 'reminder_sent', 'receipt_delivery', 'unmatched_refund'
]::regclass[]) AS t;
--> statement-breakpoint

-- 2. Append-only facts (CLAUDE.md section 6) -------------------------------------------------

SELECT app.make_append_only(t) FROM unnest(ARRAY[
  'provider_subaccount', 'management_agreement', 'provider_settlement', 'reminder_sent'
]::regclass[]) AS t;
--> statement-breakpoint

-- 3. State machines the database keeps -------------------------------------------------------

-- A settlement account never changes its holder, bank or number: a new account is a new row
-- (ADR-008). Its status moves only forward: awaiting approval, then cooling off (approved, usable
-- 24 hours later) or rejected; then active; then retired.
CREATE FUNCTION app.check_settlement_account_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'approved_at', 'usable_from', 'activated_at', 'retire_request_id',
    'retired_at', 'retire_reason', 'account_name_checked', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'settlement account % never changes its holder, bank or number; add another', OLD.id
      USING ERRCODE = 'RA051';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_approval' AND NEW.status IN ('cooling_off', 'rejected'))
    OR (OLD.status = 'cooling_off' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'settlement account % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'RA051';
  END IF;
  IF NEW.status = 'active' AND (NEW.usable_from IS NULL OR NEW.usable_from > now()) THEN
    RAISE EXCEPTION 'settlement account % is not usable before its 24 hours have passed', OLD.id
      USING ERRCODE = 'RA051';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_account_states BEFORE UPDATE ON settlement_account
  FOR EACH ROW EXECUTE FUNCTION app.check_settlement_account_update();
CREATE FUNCTION app.check_settlement_account_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'a settlement account starts waiting for a second person''s approval'
      USING ERRCODE = 'RA051';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_account_starts BEFORE INSERT ON settlement_account
  FOR EACH ROW EXECUTE FUNCTION app.check_settlement_account_insert();

-- A payment intent keeps what was asked (lease, invoice, amount, method, number, reference and
-- destination). Its status moves forward only, and confirmed is final.
CREATE FUNCTION app.check_payment_intent_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'provider', 'provider_reference', 'checkout_url', 'message',
    'failure_reason', 'verified_amount_minor', 'payment_id', 'last_checked_at', 'confirmed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'payment intent % keeps what was asked', OLD.id USING ERRCODE = 'RA053';
  END IF;
  IF OLD.status = 'confirmed' AND (NEW.status <> 'confirmed' OR NEW.payment_id IS DISTINCT FROM OLD.payment_id) THEN
    RAISE EXCEPTION 'payment intent % is confirmed', OLD.id USING ERRCODE = 'RA053';
  END IF;
  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'payment intent % was charged with %', OLD.id, OLD.provider USING ERRCODE = 'RA053';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_intent_states BEFORE UPDATE ON payment_intent
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_intent_update();

-- A refund of unmatched money and a match of the same money never both happen (P23, P31): the
-- services lock the payment for both; the database refuses what would be left wrong otherwise.
CREATE FUNCTION app.check_match_not_refunded() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unmatched_refund r WHERE r.company_id = NEW.company_id
             AND r.payment_id = NEW.payment_id AND r.status IN ('awaiting_approval', 'approved', 'refunded')) THEN
    RAISE EXCEPTION 'payment % is being refunded to its payer, so it cannot be matched', NEW.payment_id
      USING ERRCODE = 'RA052';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER match_not_refunded BEFORE INSERT ON payment_match
  FOR EACH ROW EXECUTE FUNCTION app.check_match_not_refunded();
CREATE FUNCTION app.check_refund_unmatched() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment p WHERE p.company_id = NEW.company_id AND p.id = NEW.payment_id
             AND p.lease_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM payment_match m WHERE m.company_id = NEW.company_id AND m.payment_id = NEW.payment_id)
     OR EXISTS (SELECT 1 FROM payment_reversal r WHERE r.company_id = NEW.company_id AND r.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % belongs to a lease or was reversed; only unmatched money is refunded this way', NEW.payment_id
      USING ERRCODE = 'RA052';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_unmatched_only BEFORE INSERT ON unmatched_refund
  FOR EACH ROW EXECUTE FUNCTION app.check_refund_unmatched();
CREATE FUNCTION app.check_refund_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'provider_refund_ref', 'failure_reason', 'entry_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'refund % keeps what was asked', OLD.id USING ERRCODE = 'RA052';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('refunded', 'failed'))) THEN
    RAISE EXCEPTION 'refund % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'RA052';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_states BEFORE UPDATE ON unmatched_refund
  FOR EACH ROW EXECUTE FUNCTION app.check_refund_update();

-- A pay link is for one tenant and one invoice; a receipt link for one tenant and one receipt.
CREATE FUNCTION app.check_money_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose IN ('pay', 'receipt') AND NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'a % link is for one tenant', NEW.purpose USING ERRCODE = 'RA054';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER money_link_tenant BEFORE INSERT ON secure_link
  FOR EACH ROW EXECUTE FUNCTION app.check_money_link();
--> statement-breakpoint

-- 4. References across modules -----------------------------------------------------------------

ALTER TABLE secure_link ADD CONSTRAINT secure_link_invoice_fk
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoice (company_id, id);
ALTER TABLE secure_link ADD CONSTRAINT secure_link_receipt_fk
  FOREIGN KEY (company_id, receipt_id) REFERENCES receipt (company_id, id);
ALTER TABLE message ADD CONSTRAINT message_owner_fk
  FOREIGN KEY (company_id, owner_id) REFERENCES owner (company_id, id);
ALTER TABLE payment ADD CONSTRAINT payment_settlement_account_fk
  FOREIGN KEY (company_id, settlement_account_id) REFERENCES settlement_account (company_id, id);
ALTER TABLE journal_line ADD CONSTRAINT journal_line_settlement_account_fk
  FOREIGN KEY (company_id, settlement_account_id) REFERENCES settlement_account (company_id, id);
-- P22's lines carry the settlement's id; checked at commit, so the order of the writes is free.
ALTER TABLE journal_line ADD CONSTRAINT journal_line_settlement_fk
  FOREIGN KEY (company_id, settlement_id) REFERENCES provider_settlement (company_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- 5. Narrow system functions (ADR-002): ids and amounts only ----------------------------------

-- The intent a provider's reference belongs to, for the webhook processor and reconciliation.
CREATE FUNCTION app.payment_intent_by_reference(p_reference text)
RETURNS TABLE (company_id uuid, intent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.company_id, i.id FROM payment_intent i WHERE i.reference = p_reference
$$;

-- The settlement account a provider's subaccount settles to: a payment that arrived without an
-- intent belongs to its company, and a settlement report to its account.
CREATE FUNCTION app.settlement_by_subaccount(p_provider text, p_code text)
RETURNS TABLE (company_id uuid, settlement_account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.company_id, s.settlement_account_id FROM provider_subaccount s
  WHERE s.provider = p_provider AND s.subaccount_code = p_code
$$;

-- Our provider payments by reference, for reconciliation against the provider's list.
CREATE FUNCTION app.provider_payment_refs(p_provider text, p_references text[])
RETURNS TABLE (reference text, company_id uuid, payment_id uuid, amount_minor bigint, reversed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.provider_reference, p.company_id, p.id, p.amount_minor,
    EXISTS (SELECT 1 FROM payment_reversal r WHERE r.company_id = p.company_id AND r.payment_id = p.id)
  FROM payment p WHERE p.provider = p_provider AND p.provider_reference = ANY(p_references)
$$;

-- Our provider payments recorded in a window, for "missing at the provider".
CREATE FUNCTION app.provider_payments_between(p_provider text, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (reference text, company_id uuid, payment_id uuid, amount_minor bigint, reversed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.provider_reference, p.company_id, p.id, p.amount_minor,
    EXISTS (SELECT 1 FROM payment_reversal r WHERE r.company_id = p.company_id AND r.payment_id = p.id)
  FROM payment p
  WHERE p.provider = p_provider AND p.provider_reference IS NOT NULL
    AND p.created_at >= p_from AND p.created_at < p_to
$$;

-- Companies with payment intents still pending after a while, for verify-pending's fan-out.
CREATE FUNCTION app.companies_with_pending_intents(p_before timestamptz)
RETURNS TABLE (company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT i.company_id FROM payment_intent i
  WHERE i.status IN ('initiated', 'pending') AND i.created_at < p_before
$$;

-- The webhook inbox relay: claims stored, signed rows not yet published, as the outbox does.
CREATE FUNCTION app.claim_webhook_inbox(p_limit int)
RETURNS TABLE (id uuid, provider text, event_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE webhook_inbox w SET published_at = now()
  WHERE w.id IN (
    SELECT x.id FROM webhook_inbox x WHERE x.published_at IS NULL AND x.signature_valid
    ORDER BY x.received_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.provider, w.event_id
$$;

-- A stored webhook wakes the relay at once; a one-second poll is the fallback.
CREATE FUNCTION app.notify_webhook_inbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('webhook_inbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER notify_webhook_inbox AFTER INSERT ON webhook_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.notify_webhook_inbox();
--> statement-breakpoint

-- 6. Row-change audit (AD-07): settlement accounts and every money record. Account numbers and
-- MoMo numbers are redacted from the events (CLAUDE.md section 10).
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON settlement_account
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'number_encrypted', 'number_index');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON payment_intent
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id', 'payer_phone_encrypted',
    'payer_phone_index', 'checkout_url');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON unmatched_refund
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON reconciliation_exception
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_subaccount', 'management_agreement', 'provider_settlement'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change(%L)',
      t, 'company_id');
  END LOOP;
END $$;
--> statement-breakpoint

-- 7. Ownership and grants ------------------------------------------------------------------------

GRANT SELECT ON payment_intent, provider_subaccount, unmatched_refund TO rent_system;
GRANT SELECT, UPDATE (published_at) ON webhook_inbox TO rent_system;
ALTER FUNCTION app.payment_intent_by_reference(text) OWNER TO rent_system;
ALTER FUNCTION app.settlement_by_subaccount(text, text) OWNER TO rent_system;
ALTER FUNCTION app.provider_payment_refs(text, text[]) OWNER TO rent_system;
ALTER FUNCTION app.provider_payments_between(text, timestamptz, timestamptz) OWNER TO rent_system;
ALTER FUNCTION app.companies_with_pending_intents(timestamptz) OWNER TO rent_system;
ALTER FUNCTION app.claim_webhook_inbox(int) OWNER TO rent_system;
ALTER FUNCTION app.check_match_not_refunded() OWNER TO rent_system;
ALTER FUNCTION app.check_refund_unmatched() OWNER TO rent_system;

REVOKE ALL ON FUNCTION app.check_settlement_account_update(), app.check_settlement_account_insert(),
  app.check_payment_intent_update(), app.check_match_not_refunded(), app.check_refund_unmatched(),
  app.check_refund_update(), app.check_money_link(), app.payment_intent_by_reference(text),
  app.settlement_by_subaccount(text, text), app.provider_payment_refs(text, text[]),
  app.provider_payments_between(text, timestamptz, timestamptz),
  app.companies_with_pending_intents(timestamptz), app.claim_webhook_inbox(int),
  app.notify_webhook_inbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payment_intent_by_reference(text), app.settlement_by_subaccount(text, text),
  app.provider_payment_refs(text, text[]), app.provider_payments_between(text, timestamptz, timestamptz),
  app.companies_with_pending_intents(timestamptz), app.claim_webhook_inbox(int) TO rent_app;

GRANT SELECT, INSERT ON settlement_account, provider_subaccount, management_agreement, payment_intent,
  provider_settlement, reconciliation_exception, reminder_sent, receipt_delivery, unmatched_refund TO rent_app;
GRANT UPDATE (status, approved_at, usable_from, activated_at, retire_request_id, retired_at, retire_reason,
  account_name_checked, updated_at) ON settlement_account TO rent_app;
GRANT UPDATE (status, provider, provider_reference, checkout_url, message, failure_reason,
  verified_amount_minor, payment_id, last_checked_at, confirmed_at, updated_at) ON payment_intent TO rent_app;
GRANT UPDATE (resolved_at, resolved_by, resolution_note) ON reconciliation_exception TO rent_app;
GRANT UPDATE (status, channel, sent_at, latency_ms, late_alerted, updated_at) ON receipt_delivery TO rent_app;
GRANT UPDATE (status, provider_refund_ref, failure_reason, entry_id, updated_at) ON unmatched_refund TO rent_app;
-- The global inbox: the intake stores, the processor records how each went. Nothing deletes it.
GRANT SELECT, INSERT ON webhook_inbox TO rent_app;
GRANT UPDATE (status, outcome, processed_at) ON webhook_inbox TO rent_app;
