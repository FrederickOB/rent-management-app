-- M3 review fixes, schema part (docs/plans/M3.md section 5, "Progress, review fixes"). Generated
-- by drizzle-kit from the schema; the unique keys are moved before the foreign keys that use them.
-- - A lease can end because the next lease on its unit started ('superseded', finding 3).
-- - The e-signing rows that drive tenant-scope RLS name their request's (or signer's) tenant,
--   enforced by foreign keys; a row with no tenant matches nothing, so no tenant session sees it.
ALTER TABLE "lease" DROP CONSTRAINT "lease_end_reason_check";--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_tenant_key" UNIQUE("company_id","property_id","tenant_id","id");--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_tenant_key" UNIQUE("company_id","property_id","tenant_id","id");--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_signer_tenant_fk" FOREIGN KEY ("company_id","property_id","tenant_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_signer_tenant_fk" FOREIGN KEY ("company_id","property_id","tenant_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_request_tenant_fk" FOREIGN KEY ("company_id","property_id","tenant_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_request_tenant_fk" FOREIGN KEY ("company_id","property_id","tenant_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_event" ADD CONSTRAINT "signing_event_request_tenant_fk" FOREIGN KEY ("company_id","property_id","tenant_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_end_reason_check" CHECK ("lease"."end_reason" is null or "lease"."end_reason" in ('moved_out', 'renewed', 'superseded'));
