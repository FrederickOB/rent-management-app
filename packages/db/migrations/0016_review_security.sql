-- M4a review fixes (docs/plans/M4a.md section 5): database checks the independent review asked for.
-- Functions marked SECURITY DEFINER are owned by rent_system (ADR-002) and read only what their
-- check needs, whatever the session's scope.

-- 1. Matching and reversing unmatched money (review 5) ------------------------------------------
-- The services take a lock per payment for both, so they run one after the other. The database
-- refuses what would be left wrong if they did not: a match of a reversed payment, and an unmatched
-- (line for line, P21a) reversal of a payment that has been matched to a lease.

CREATE FUNCTION app.check_match_not_reversed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_reversal r
             WHERE r.company_id = NEW.company_id AND r.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % was reversed, so it cannot be matched', NEW.payment_id
      USING ERRCODE = 'RA049';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER match_not_reversed BEFORE INSERT ON payment_match
  FOR EACH ROW EXECUTE FUNCTION app.check_match_not_reversed();

CREATE FUNCTION app.check_reversal_not_matched() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.lease_id IS NULL AND EXISTS (
      SELECT 1 FROM payment_match m
      WHERE m.company_id = NEW.company_id AND m.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % is matched to a lease, so it is reversed from that lease', NEW.payment_id
      USING ERRCODE = 'RA049';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reversal_not_matched BEFORE INSERT ON payment_reversal
  FOR EACH ROW EXECUTE FUNCTION app.check_reversal_not_matched();

GRANT SELECT ON payment_match, payment_reversal TO rent_system;
ALTER FUNCTION app.check_match_not_reversed() OWNER TO rent_system;
ALTER FUNCTION app.check_reversal_not_matched() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.check_match_not_reversed(), app.check_reversal_not_matched() FROM PUBLIC;
--> statement-breakpoint

-- 2. Approval requests scoped by property (AD-02; review 8) ---------------------------------------
-- A request carries its subject's property, or none for a company-level request. A scoped person
-- sees, and so decides, only requests about their properties, and always the ones they started;
-- company-level requests are for people who see the whole company. The policy checks it too.

ALTER TABLE approval_request
  ADD CONSTRAINT approval_request_property_fk FOREIGN KEY (company_id, property_id)
  REFERENCES property (company_id, id);
CREATE INDEX approval_request_property_idx ON approval_request (company_id, property_id);

CREATE POLICY property_scope ON approval_request AS RESTRICTIVE
  USING (app.property_scope() IS NULL
         OR initiated_by = app.current_person_id()
         OR (property_id IS NOT NULL AND property_id = ANY(app.property_scope())))
  WITH CHECK (app.property_scope() IS NULL
              OR initiated_by = app.current_person_id()
              OR (property_id IS NOT NULL AND property_id = ANY(app.property_scope())));

-- Existing requests take their subject's property. Only status may change on a request, so the
-- guard steps aside for this one statement per company; the row audit records each change.
ALTER TABLE approval_request DISABLE TRIGGER check_request_update;
ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE v_company uuid;
BEGIN
  FOR v_company IN SELECT id FROM company ORDER BY id LOOP
    PERFORM set_config('app.company_id', v_company::text, true);
    PERFORM set_config('app.actor_kind', 'system', true);
    UPDATE approval_request r SET property_id = s.property_id
    FROM (
      SELECT 'cash_record' AS subject_type, id::text AS subject_id, property_id FROM cash_record
        WHERE company_id = v_company
      UNION ALL SELECT 'direct_receipt', id::text, property_id FROM direct_receipt
        WHERE company_id = v_company
      UNION ALL SELECT 'invoice_line', id::text, property_id FROM invoice_line
        WHERE company_id = v_company
      UNION ALL SELECT 'lease', id::text, property_id FROM lease WHERE company_id = v_company
      UNION ALL SELECT 'payment', p.id::text, coalesce(p.property_id, m.property_id)
        FROM payment p LEFT JOIN payment_match m ON m.company_id = p.company_id AND m.payment_id = p.id
        WHERE p.company_id = v_company
    ) s
    WHERE r.company_id = v_company AND r.property_id IS NULL
      AND r.subject_type = s.subject_type AND r.subject_id = s.subject_id
      AND s.property_id IS NOT NULL;
  END LOOP;
  -- Nothing later in this migration runs as any company.
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
END $$;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_request ENABLE TRIGGER check_request_update;
--> statement-breakpoint

-- 3. A property's owner against its first invoice (review 20) ---------------------------------
-- A same-day owner correction and the first invoice could each pass their check before the
-- other committed. Both now take one lock per property first, and an invoice must be in the book
-- of the property's owner on its issue date.

CREATE FUNCTION app.lock_property_owner(p_company_id uuid, p_property_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_property_id::text, 23));
END $$;

CREATE OR REPLACE FUNCTION app.check_owner_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.lock_property_owner(NEW.company_id, NEW.property_id);
  IF app.property_has_ledger(NEW.company_id, NEW.property_id) THEN
    RAISE EXCEPTION 'property % has ledger entries, so its owner cannot change', NEW.property_id
      USING ERRCODE = 'RA045';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.check_invoice_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_owner uuid;
BEGIN
  PERFORM app.lock_property_owner(NEW.company_id, NEW.property_id);
  SELECT po.owner_id INTO v_owner
  FROM property_ownership po
  WHERE po.company_id = NEW.company_id AND po.property_id = NEW.property_id
    AND po.effective_from <= NEW.issue_date AND po.share_bps = 10000
    AND NOT EXISTS (SELECT 1 FROM property_ownership_correction c
                    WHERE c.company_id = po.company_id AND c.ownership_id = po.id)
  ORDER BY po.effective_from DESC, po.created_at DESC
  LIMIT 1;
  IF v_owner IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'invoice % is not in the book of its property''s owner', NEW.id
      USING ERRCODE = 'RA050';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoice_owner BEFORE INSERT ON invoice
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_owner();

GRANT SELECT ON property_ownership TO rent_system;
ALTER FUNCTION app.check_invoice_owner() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.lock_property_owner(uuid, uuid), app.check_invoice_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_property_owner(uuid, uuid) TO rent_app, rent_system;
--> statement-breakpoint

-- 4. Banking waiting for a collector's cash (second review C) --------------------------------
-- A scoped collector must see banking someone else asked for on their cash, or the cash-on-hand
-- card and the banking check would let them ask for the same cash twice. Approval requests are
-- scoped (2 above), so this narrow function returns only amounts per book, nothing of the
-- requests themselves, for the transaction's own company.

CREATE FUNCTION app.pending_banking(p_company_id uuid, p_collector_id uuid)
RETURNS TABLE (book_id uuid, amount_minor bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.book_id, sum(b.amount_minor)::bigint
  FROM cash_banking b
  JOIN approval_request r ON r.company_id = b.company_id AND r.id = b.approval_request_id
  WHERE b.company_id = p_company_id AND p_company_id = app.current_company_id()
    AND b.collector_person_id = p_collector_id AND r.status IN ('pending', 'cooling_off')
  GROUP BY b.book_id
$$;

GRANT SELECT ON cash_banking, approval_request TO rent_system;
ALTER FUNCTION app.pending_banking(uuid, uuid) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.pending_banking(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_banking(uuid, uuid) TO rent_app;
