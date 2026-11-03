ALTER TABLE "provider_settlement" DROP CONSTRAINT "provider_settlement_amounts_check";--> statement-breakpoint
ALTER TABLE "unmatched_refund" DROP CONSTRAINT "unmatched_refund_status_check";--> statement-breakpoint
DROP INDEX "unmatched_refund_one_live";--> statement-breakpoint
ALTER TABLE "webhook_inbox" ALTER COLUMN "raw_body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "management_agreement" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD COLUMN "advance_over_limit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD COLUMN "advance_limit_months" integer;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD COLUMN "advance_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_settlement" ADD COLUMN "charge_references" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "body_sha256" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "body_bytes" integer;--> statement-breakpoint
ALTER TABLE "management_agreement" ADD CONSTRAINT "management_agreement_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "management_agreement_approval_key" ON "management_agreement" USING btree ("company_id","approval_request_id") WHERE "management_agreement"."approval_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_refund_one_live" ON "unmatched_refund" USING btree ("company_id","payment_id") WHERE "unmatched_refund"."status" in ('awaiting_approval', 'approved', 'sent', 'refunded');--> statement-breakpoint
ALTER TABLE "provider_settlement" ADD CONSTRAINT "provider_settlement_amounts_check" CHECK ("provider_settlement"."gross_minor" >= 0 and "provider_settlement"."fees_minor" >= 0 and "provider_settlement"."deductions_minor" >= 0);--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_status_check" CHECK ("unmatched_refund"."status" in ('awaiting_approval', 'approved', 'sent', 'refunded', 'failed', 'rejected'));--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_body_check" CHECK (not "webhook_inbox"."signature_valid" or "webhook_inbox"."raw_body" is not null);