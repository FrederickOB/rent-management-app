CREATE TABLE "document_scan" (
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"engine" text NOT NULL,
	"finding" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_scan_pkey" PRIMARY KEY("company_id","document_id"),
	CONSTRAINT "document_scan_status_check" CHECK ("document_scan"."status" in ('clean', 'infected')),
	CONSTRAINT "document_scan_engine_check" CHECK ("document_scan"."engine" in ('clamav', 'fake', 'generated', 'pre_m11')),
	CONSTRAINT "document_scan_finding_check" CHECK (("document_scan"."finding" is not null) = ("document_scan"."status" = 'infected'))
);
--> statement-breakpoint
CREATE TABLE "company_onboarding" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"cut_over_date" date NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_batch" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"upload_intent_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"cut_over_date" date,
	"validation_id" uuid,
	"report" jsonb,
	"error" text,
	"approval_request_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	CONSTRAINT "onboarding_batch_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "onboarding_batch_upload_key" UNIQUE("company_id","upload_intent_id"),
	CONSTRAINT "onboarding_batch_kind_check" CHECK ("onboarding_batch"."kind" in ('tenancies', 'balances', 'adjustment')),
	CONSTRAINT "onboarding_batch_status_check" CHECK ("onboarding_batch"."status" in ('uploaded', 'validating', 'validated', 'invalid', 'committing', 'committed', 'awaiting_approval', 'posting', 'posted', 'rejected', 'failed')),
	CONSTRAINT "onboarding_batch_money_check" CHECK ("onboarding_batch"."kind" <> 'tenancies' or ("onboarding_batch"."approval_request_id" is null and "onboarding_batch"."posted_at" is null and "onboarding_batch"."status" not in ('awaiting_approval', 'posting', 'posted', 'rejected'))),
	CONSTRAINT "onboarding_batch_sha_check" CHECK ("onboarding_batch"."file_sha256" is null or "onboarding_batch"."file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "onboarding_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"lease_id" uuid,
	"owner_id" uuid,
	"amount_minor" bigint NOT NULL,
	"due_on" date,
	"period_start" date,
	"invoice_line_id" uuid,
	"payment_id" uuid,
	"entry_id" uuid,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_item_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "onboarding_item_key" UNIQUE("company_id","item_key"),
	CONSTRAINT "onboarding_item_kind_check" CHECK ("onboarding_item"."kind" in ('arrears', 'advance', 'deposit', 'withholding', 'agent_cash', 'rent_tax')),
	CONSTRAINT "onboarding_item_amount_check" CHECK ("onboarding_item"."amount_minor" <> 0),
	CONSTRAINT "onboarding_item_subject_check" CHECK (("onboarding_item"."kind" in ('agent_cash', 'rent_tax') and "onboarding_item"."owner_id" is not null and "onboarding_item"."lease_id" is null) or ("onboarding_item"."kind" not in ('agent_cash', 'rent_tax') and "onboarding_item"."lease_id" is not null)),
	CONSTRAINT "onboarding_item_dates_check" CHECK ("onboarding_item"."accounting_date" >= "onboarding_item"."value_date"),
	CONSTRAINT "onboarding_item_key_check" CHECK ("onboarding_item"."item_key" ~ '^P25:[^:]+:.+$')
);
--> statement-breakpoint
CREATE TABLE "staff_active_day" (
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"day" date NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_active_day_pkey" PRIMARY KEY("company_id","person_id","day")
);
--> statement-breakpoint
CREATE TABLE "data_protection_export" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"document_id" uuid,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "data_protection_export_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "data_protection_export_status_check" CHECK ("data_protection_export"."status" in ('preparing', 'ready', 'failed') and ("data_protection_export"."status" = 'ready') = ("data_protection_export"."document_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "data_protection_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"received_on" date NOT NULL,
	"due_on" date,
	"due_rule_id" uuid,
	"status" text DEFAULT 'received' NOT NULL,
	"notes" text,
	"outcome" text,
	"messaging_stopped_at" timestamp with time zone,
	"result" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_protection_request_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "data_protection_request_kind_check" CHECK ("data_protection_request"."kind" in ('access', 'correction', 'erasure', 'objection')),
	CONSTRAINT "data_protection_request_status_check" CHECK ("data_protection_request"."status" in ('received', 'in_progress', 'completed', 'refused') and ("data_protection_request"."status" in ('completed', 'refused')) = ("data_protection_request"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ops_action" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text,
	"reason" text NOT NULL,
	"person_id" uuid NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_action_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "ops_action_kind_check" CHECK ("ops_action"."kind" in ('webhook_replay', 'job_retry')),
	CONSTRAINT "ops_action_reason_check" CHECK (length(trim("ops_action"."reason")) between 5 and 500)
);
--> statement-breakpoint
CREATE TABLE "retention_review" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"checked_on" date NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"categories" jsonb NOT NULL,
	CONSTRAINT "retention_review_checkedOn_unique" UNIQUE("checked_on")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"instance" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"beats" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_event" DROP CONSTRAINT "consent_event_source_check";--> statement-breakpoint
ALTER TABLE "allocation" DROP CONSTRAINT "allocation_source_check";--> statement-breakpoint
ALTER TABLE "allocation" DROP CONSTRAINT "allocation_record_check";--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT "invoice_kind_check";--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "payment_method_check";--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "payment_cash_account_check";--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "payment_source_type_check";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "client" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "last_totp_step" bigint;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "invited_name" text;--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN "eligible_approvers" uuid[];--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "imported_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_contact" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "replay_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "last_replayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "last_replayed_by" uuid;--> statement-breakpoint
ALTER TABLE "document_scan" ADD CONSTRAINT "document_scan_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_scan" ADD CONSTRAINT "document_scan_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_onboarding" ADD CONSTRAINT "company_onboarding_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_onboarding" ADD CONSTRAINT "company_onboarding_set_by_person_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_batch" ADD CONSTRAINT "onboarding_batch_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_batch" ADD CONSTRAINT "onboarding_batch_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_batch" ADD CONSTRAINT "onboarding_batch_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_batch_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."onboarding_batch"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_lease_fk" FOREIGN KEY ("company_id","lease_id") REFERENCES "public"."lease"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_line_fk" FOREIGN KEY ("company_id","invoice_line_id") REFERENCES "public"."invoice_line"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_active_day" ADD CONSTRAINT "staff_active_day_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_active_day" ADD CONSTRAINT "staff_active_day_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_export" ADD CONSTRAINT "data_protection_export_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_export" ADD CONSTRAINT "data_protection_export_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_export" ADD CONSTRAINT "data_protection_export_request_fk" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."data_protection_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_export" ADD CONSTRAINT "data_protection_export_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_request" ADD CONSTRAINT "data_protection_request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_request" ADD CONSTRAINT "data_protection_request_due_rule_id_rule_id_fk" FOREIGN KEY ("due_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_request" ADD CONSTRAINT "data_protection_request_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_protection_request" ADD CONSTRAINT "data_protection_request_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_action" ADD CONSTRAINT "ops_action_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_action" ADD CONSTRAINT "ops_action_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_batch_kind_idx" ON "onboarding_batch" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "onboarding_item_lease_idx" ON "onboarding_item" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "onboarding_item_owner_idx" ON "onboarding_item" USING btree ("company_id","owner_id");--> statement-breakpoint
CREATE INDEX "onboarding_item_batch_idx" ON "onboarding_item" USING btree ("company_id","batch_id");--> statement-breakpoint
CREATE INDEX "staff_active_day_day_idx" ON "staff_active_day" USING btree ("company_id","day");--> statement-breakpoint
CREATE INDEX "data_protection_export_request_idx" ON "data_protection_export" USING btree ("company_id","request_id","created_at");--> statement-breakpoint
CREATE INDEX "data_protection_request_tenant_idx" ON "data_protection_request" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE INDEX "data_protection_request_status_idx" ON "data_protection_request" USING btree ("company_id","status","received_on");--> statement-breakpoint
CREATE INDEX "ops_action_target_idx" ON "ops_action" USING btree ("company_id","kind","target_id","created_at");--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_last_replayed_by_person_id_fk" FOREIGN KEY ("last_replayed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lease_scan_to_follow_idx" ON "lease" USING btree ("company_id") WHERE "lease"."imported_batch_id" is not null and "lease"."signed_document_id" is null;--> statement-breakpoint
CREATE INDEX "webhook_inbox_failed_idx" ON "webhook_inbox" USING btree ("received_at") WHERE "webhook_inbox"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "webhook_inbox_rejected_idx" ON "webhook_inbox" USING btree ("received_at") WHERE not "webhook_inbox"."signature_valid";--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_client_check" CHECK ("session"."client" in ('web', 'tenant_app'));--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_invited_name_check" CHECK ("membership"."invited_name" is null or length("membership"."invited_name") between 1 and 200);--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_source_check" CHECK ("consent_event"."source" in ('staff', 'reply', 'stop', 'tenant_app', 'tenant_reply', 'stop_keyword', 'start_keyword', 'email_unsubscribe', 'import', 'data_protection'));--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_source_check" CHECK ("allocation"."source" in ('payment', 'deposit', 'withholding', 'credit_note', 'write_off', 'opening_balance'));--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_record_check" CHECK ("allocation"."record_type" in ('payment', 'match', 'accrual', 'reversal', 'credit_note', 'write_off', 'withholding', 'termination', 'move_out', 'opening'));--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_kind_check" CHECK ("invoice"."kind" in ('cycle', 'deposit', 'one_off', 'opening'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_opening_check" CHECK (("payment"."source_type" = 'opening_balance') = ("payment"."cash_account" = '3900') and ("payment"."source_type" = 'opening_balance') = ("payment"."method" = 'opening'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_method_check" CHECK ("payment"."method" in ('cash', 'cheque', 'bank_transfer', 'momo', 'card', 'test', 'opening'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_cash_account_check" CHECK ("payment"."cash_account" in ('1050', '1060', '1010', '1070', '3900'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_source_type_check" CHECK ("payment"."source_type" in ('cash_record', 'direct_receipt', 'provider_test', 'payment_intent', 'provider_charge', 'opening_balance'));