DROP INDEX "invoice_line_one_per_period";--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "opening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_one_per_period" ON "invoice_line" USING btree ("company_id","charge_period_id") WHERE "invoice_line"."charge_period_id" is not null and not "invoice_line"."opening";--> statement-breakpoint
-- M11 (P25, founder 2026-11-10): an invoice line's `opening` follows its invoice's kind, set here
-- on insert whatever the insert says, so only opening lines are exempt from one-per-period.
CREATE FUNCTION app.set_invoice_line_opening() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.opening := EXISTS (SELECT 1 FROM invoice i
                         WHERE i.company_id = NEW.company_id AND i.id = NEW.invoice_id AND i.kind = 'opening');
  RETURN NEW;
END $$;
CREATE TRIGGER opening_from_invoice BEFORE INSERT ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION app.set_invoice_line_opening();
REVOKE ALL ON FUNCTION app.set_invoice_line_opening() FROM PUBLIC;
--> statement-breakpoint
-- Existing opening lines (the table is append-only; its guard is lifted for this one backfill).
ALTER TABLE invoice_line NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_line DISABLE TRIGGER append_only_row;
UPDATE invoice_line l SET opening = true
FROM invoice i
WHERE i.company_id = l.company_id AND i.id = l.invoice_id AND i.kind = 'opening' AND NOT l.opening;
ALTER TABLE invoice_line ENABLE TRIGGER append_only_row;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;
