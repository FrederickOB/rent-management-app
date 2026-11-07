-- M8 review (2026-11-05): the rules behind the review's fixes. Applied as rent_owner, after 0044.
-- Functions marked SECURITY DEFINER are owned by rent_system (ADR-002): each does one narrow thing.

-- 1. A revoked link stays revoked (job sheets and every other secure link) ------------------------

CREATE FUNCTION app.check_secure_link_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'secure link % was revoked and stays revoked', OLD.id USING ERRCODE = 'RA091';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER secure_link_stays_revoked BEFORE UPDATE ON secure_link
  FOR EACH ROW EXECUTE FUNCTION app.check_secure_link_update();

-- A job sheet's wrong completion codes and the lock they set (as M3's signer lock).
GRANT UPDATE (failed_code_attempts, code_locked_until) ON secure_link TO rent_app;
--> statement-breakpoint

-- 2. Deductions never exceed the deposit held, read whatever the session's scope (RA086) ---------
-- The deposit held and the live deductions come from a definer function, so a caller's property or
-- owner scope never hides part of the lease's 2100 from the check. The move-out row lock stays the
-- caller's, so two deductions added at once are still checked one after the other.

CREATE FUNCTION app.deposit_deduction_room(p_company_id uuid, p_lease_id uuid, p_move_out_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (SELECT 0 - coalesce(sum(l.amount_minor), 0) FROM journal_line l
          WHERE l.company_id = p_company_id AND l.account_code = '2100' AND l.lease_id = p_lease_id)
       - (SELECT coalesce(sum(d.amount_minor), 0) FROM deposit_deduction d
          WHERE d.company_id = p_company_id AND d.move_out_id = p_move_out_id
            AND NOT EXISTS (SELECT 1 FROM deposit_deduction_withdrawal w
                            WHERE w.company_id = d.company_id AND w.deduction_id = d.id))
$$;
ALTER FUNCTION app.deposit_deduction_room(uuid, uuid, uuid) OWNER TO rent_system;
GRANT SELECT ON deposit_deduction, deposit_deduction_withdrawal TO rent_system;
REVOKE ALL ON FUNCTION app.deposit_deduction_room(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deposit_deduction_room(uuid, uuid, uuid) TO rent_app;

CREATE OR REPLACE FUNCTION app.check_deposit_deduction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_move move_out%ROWTYPE;
BEGIN
  SELECT * INTO v_move FROM move_out m WHERE m.company_id = NEW.company_id AND m.id = NEW.move_out_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'move-out % is not found', NEW.move_out_id USING ERRCODE = 'RA085';
  END IF;
  IF v_move.status NOT IN ('planned', 'inspected', 'settlement_drafted') THEN
    RAISE EXCEPTION 'the deductions of move-out % are fixed once it leaves drafting', NEW.move_out_id
      USING ERRCODE = 'RA085';
  END IF;
  IF TG_TABLE_NAME = 'deposit_deduction_withdrawal' THEN
    RETURN NEW;
  END IF;
  IF cardinality(NEW.inspection_item_ids) > 0 AND (
       v_move.inspection_id IS NULL OR EXISTS (
         SELECT 1 FROM unnest(NEW.inspection_item_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM inspection_item i WHERE i.company_id = NEW.company_id
                           AND i.inspection_id = v_move.inspection_id AND i.id = x.id))) THEN
    RAISE EXCEPTION 'a deduction names items of its move-out inspection only' USING ERRCODE = 'RA087';
  END IF;
  IF cardinality(NEW.photo_ids) > 0 AND (
       v_move.inspection_id IS NULL OR EXISTS (
         SELECT 1 FROM unnest(NEW.photo_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM inspection_photo p WHERE p.company_id = NEW.company_id
                           AND p.inspection_id = v_move.inspection_id AND p.id = x.id))) THEN
    RAISE EXCEPTION 'a deduction names photos of its move-out inspection only' USING ERRCODE = 'RA087';
  END IF;
  IF NEW.amount_minor > app.deposit_deduction_room(NEW.company_id, NEW.lease_id, NEW.move_out_id) THEN
    RAISE EXCEPTION 'deductions on move-out % would exceed the deposit held', NEW.move_out_id
      USING ERRCODE = 'RA086';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 3. Owner scope on expenses, move-outs and their children (plan 4.10; decision 9) --------------
-- 0041's owner_scope used app.in_owner_scope, which a session scoped by property alone (an empty
-- owner scope) never passes: a manager or caretaker scoped to properties saw none of their own
-- properties' move-outs and expenses. An owner scope limits rows only when it names owners; the
-- property scope still applies. An agency's client owner and their advisers still see only their
-- own owner's rows, even on a property that changed hands. Children follow their parent.

DROP POLICY owner_scope ON expense;
CREATE POLICY owner_scope ON expense AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR expense.owner_id = ANY(app.owner_scope()));
DROP POLICY owner_scope ON move_out;
CREATE POLICY owner_scope ON move_out AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR cardinality(app.owner_scope()) = 0 OR move_out.owner_id = ANY(app.owner_scope()));

CREATE POLICY owner_scope ON expense_payment AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM expense e WHERE e.company_id = expense_payment.company_id AND e.id = expense_payment.expense_id));
CREATE POLICY owner_scope ON expense_reversal AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM expense e WHERE e.company_id = expense_reversal.company_id AND e.id = expense_reversal.expense_id));
CREATE POLICY owner_scope ON deposit_deduction AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM move_out m WHERE m.company_id = deposit_deduction.company_id AND m.id = deposit_deduction.move_out_id));
CREATE POLICY owner_scope ON deposit_deduction_withdrawal AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM move_out m WHERE m.company_id = deposit_deduction_withdrawal.company_id
      AND m.id = deposit_deduction_withdrawal.move_out_id));
CREATE POLICY owner_scope ON deposit_application AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM move_out m WHERE m.company_id = deposit_application.company_id AND m.id = deposit_application.move_out_id));
CREATE POLICY owner_scope ON move_out_refund_part AS RESTRICTIVE USING (
  app.owner_scope() IS NULL OR EXISTS (
    SELECT 1 FROM move_out m WHERE m.company_id = move_out_refund_part.company_id AND m.id = move_out_refund_part.move_out_id));
