CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"phone_number" text,
	"phone_number_verified" boolean,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_email_unique" UNIQUE("email"),
	CONSTRAINT "person_phoneNumber_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"auth_method" text DEFAULT 'password_totp' NOT NULL,
	"active_company_id" uuid,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"time_zone" text DEFAULT 'Africa/Accra' NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"logo_document_id" uuid,
	"primary_colour" text DEFAULT '#0F766E' NOT NULL,
	"accent_colour" text DEFAULT '#F59E0B' NOT NULL,
	"sender_name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_kind_check" CHECK ("company"."kind" in ('landlord', 'agency', 'platform')),
	CONSTRAINT "company_status_check" CHECK ("company"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "company_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"kms_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_key_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "company_key_version_key" UNIQUE("company_id","purpose","version")
);
--> statement-breakpoint
CREATE TABLE "country" (
	"code" char(2) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"currency_minor_unit" smallint NOT NULL,
	"default_time_zone" text NOT NULL,
	"calling_code" text NOT NULL,
	"id_types" text[] NOT NULL,
	"address_format" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nominated_approver" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "membership_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "membership_role_check" CHECK ("membership"."role" in ('owner', 'agency_admin', 'property_manager', 'accountant', 'caretaker', 'adviser', 'platform_admin')),
	CONSTRAINT "membership_status_check" CHECK ("membership"."status" in ('invited', 'active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_by_membership_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"payload_hash" text NOT NULL,
	"step_up_verified" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decision_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "approval_decision_once_per_person" UNIQUE("request_id","decided_by"),
	CONSTRAINT "approval_decision_kind_check" CHECK ("approval_decision"."kind" in ('approve', 'reject', 'self_confirm'))
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"initiated_by" uuid NOT NULL,
	"initiator_membership_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"cooling_off_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_request_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "approval_request_mode_check" CHECK ("approval_request"."mode" in ('two_person', 'single_user')),
	CONSTRAINT "approval_request_status_check" CHECK ("approval_request"."status" in ('pending', 'cooling_off', 'approved', 'rejected', 'cancelled', 'expired')),
	CONSTRAINT "approval_request_required_check" CHECK ("approval_request"."required_approvals" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_anchor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"anchor_date" date NOT NULL,
	"seq" bigint NOT NULL,
	"hash" "bytea" NOT NULL,
	"storage_key" text NOT NULL,
	"storage_version_id" text,
	"object_sha256" text NOT NULL,
	"anchored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_anchor_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "audit_anchor_per_day" UNIQUE("company_id","anchor_date")
);
--> statement-breakpoint
CREATE TABLE "audit_chain_head" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"company_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp (6) with time zone NOT NULL,
	"actor_person_id" uuid,
	"actor_kind" text NOT NULL,
	"request_id" text,
	"action" text NOT NULL,
	"record_type" text,
	"record_id" text,
	"data" jsonb,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"hash_version" smallint DEFAULT 1 NOT NULL,
	CONSTRAINT "audit_event_company_id_seq_pk" PRIMARY KEY("company_id","seq")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_version_id" text,
	"write_once" boolean NOT NULL,
	"retention_mode" text,
	"retain_until" timestamp with time zone,
	"template_key" text,
	"template_version" integer,
	"data_snapshot" jsonb,
	"data_snapshot_sha256" text,
	"original_filename" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "document_sha256_check" CHECK ("document"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_retention_check" CHECK ("document"."retention_mode" is null or "document"."retention_mode" in ('GOVERNANCE', 'COMPLIANCE'))
);
--> statement-breakpoint
CREATE TABLE "document_render_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_render_request_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "document_render_request_status_check" CHECK ("document_render_request"."status" in ('pending', 'rendered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "outbox_event_idempotency_key" UNIQUE("company_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "processed_job" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"job_name" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_job_company_id_key_pk" PRIMARY KEY("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"country" char(2) NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source" text NOT NULL,
	"verification_status" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_status_check" CHECK ("rule"."verification_status" in ('verified', 'from_prd', 'unverified')),
	CONSTRAINT "rule_verified_by_check" CHECK ("rule"."verification_status" <> 'verified' or "rule"."verified_by" is not null),
	CONSTRAINT "rule_dates_check" CHECK ("rule"."effective_to" is null or "rule"."effective_to" >= "rule"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "upload_intent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"max_bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" uuid,
	"reject_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upload_intent_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "upload_intent_status_check" CHECK ("upload_intent"."status" in ('pending', 'confirmed', 'processed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_person_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_person_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_person_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "public"."country"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_key" ADD CONSTRAINT "company_key_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_invited_by_person_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_decided_by_person_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_company_id_request_id_approval_request_company_id_id_fk" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_company_id_decided_by_membership_id_membership_company_id_id_fk" FOREIGN KEY ("company_id","decided_by_membership_id") REFERENCES "public"."membership"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_initiated_by_person_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_company_id_initiator_membership_id_membership_company_id_id_fk" FOREIGN KEY ("company_id","initiator_membership_id") REFERENCES "public"."membership"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_anchor" ADD CONSTRAINT "audit_anchor_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_head" ADD CONSTRAINT "audit_chain_head_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_render_request" ADD CONSTRAINT "document_render_request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_render_request" ADD CONSTRAINT "document_render_request_company_id_document_id_document_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_job" ADD CONSTRAINT "processed_job_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_country_country_code_fk" FOREIGN KEY ("country") REFERENCES "public"."country"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intent" ADD CONSTRAINT "upload_intent_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intent" ADD CONSTRAINT "upload_intent_company_id_document_id_document_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_index" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_index" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_one_open_per_person" ON "membership" USING btree ("company_id","person_id") WHERE "membership"."status" in ('invited', 'active');--> statement-breakpoint
CREATE INDEX "membership_person_id_index" ON "membership" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "approval_request_open_idx" ON "approval_request" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("company_id","actor_person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_record_idx" ON "audit_event" USING btree ("company_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "audit_event_time_idx" ON "audit_event" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_event_unpublished_idx" ON "outbox_event" USING btree ("created_at") WHERE "outbox_event"."published_at" is null;--> statement-breakpoint
CREATE INDEX "rule_lookup_idx" ON "rule" USING btree ("country","key","effective_from","created_at");