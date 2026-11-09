CREATE TABLE "alert_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"subject_company_id" uuid,
	"data" jsonb,
	CONSTRAINT "alert_event_severity_check" CHECK ("alert_event"."severity" in ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "billing_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"month" text NOT NULL,
	"single_room_units" integer NOT NULL,
	"self_contained_units" integer NOT NULL,
	"commercial_units" integer NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_snapshot_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "billing_snapshot_month_key" UNIQUE("company_id","subscriber_company_id","month"),
	CONSTRAINT "billing_snapshot_month_check" CHECK ("billing_snapshot"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "billing_snapshot_counts_check" CHECK ("billing_snapshot"."single_room_units" >= 0 and "billing_snapshot"."self_contained_units" >= 0 and "billing_snapshot"."commercial_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_snapshot_unit" (
	"company_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"band" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"days_leased" integer NOT NULL,
	CONSTRAINT "billing_snapshot_unit_company_id_snapshot_id_unit_id_pk" PRIMARY KEY("company_id","snapshot_id","unit_id"),
	CONSTRAINT "billing_snapshot_unit_band_check" CHECK ("billing_snapshot_unit"."band" in ('single_room', 'self_contained', 'commercial')),
	CONSTRAINT "billing_snapshot_unit_days_check" CHECK ("billing_snapshot_unit"."days_leased" between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE "discount_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"percent_bps" integer,
	"amount_minor" bigint,
	"months" integer NOT NULL,
	"expires_on" date,
	"max_uses" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_code_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "discount_code_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "discount_code_code_check" CHECK ("discount_code"."code" ~ '^[A-Z0-9-]{2,40}$'),
	CONSTRAINT "discount_code_kind_check" CHECK (("discount_code"."kind" = 'percentage' and "discount_code"."percent_bps" between 1 and 10000 and "discount_code"."amount_minor" is null) or ("discount_code"."kind" = 'fixed' and "discount_code"."amount_minor" > 0 and "discount_code"."percent_bps" is null)),
	CONSTRAINT "discount_code_months_check" CHECK ("discount_code"."months" >= 1),
	CONSTRAINT "discount_code_max_uses_check" CHECK ("discount_code"."max_uses" is null or "discount_code"."max_uses" >= 1)
);
--> statement-breakpoint
CREATE TABLE "discount_redemption" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"discount_code_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"first_month" text NOT NULL,
	"months" integer NOT NULL,
	"applied_by" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemption_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "discount_redemption_once_key" UNIQUE("company_id","discount_code_id","subscription_id"),
	CONSTRAINT "discount_redemption_month_check" CHECK ("discount_redemption"."first_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "discount_redemption_months_check" CHECK ("discount_redemption"."months" >= 1)
);
--> statement-breakpoint
CREATE TABLE "price_list" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tier" text NOT NULL,
	"rate_single_room_minor" bigint NOT NULL,
	"rate_self_contained_minor" bigint NOT NULL,
	"rate_commercial_minor" bigint NOT NULL,
	"minimum_minor" bigint NOT NULL,
	"annual_discount_bps" integer NOT NULL,
	"effective_from" date NOT NULL,
	"placeholder" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_version_key" UNIQUE("tier","effective_from"),
	CONSTRAINT "price_list_tier_check" CHECK ("price_list"."tier" in ('starter', 'growth', 'portfolio')),
	CONSTRAINT "price_list_amounts_check" CHECK ("price_list"."rate_single_room_minor" >= 0 and "price_list"."rate_self_contained_minor" >= 0 and "price_list"."rate_commercial_minor" >= 0 and "price_list"."minimum_minor" >= 0),
	CONSTRAINT "price_list_discount_check" CHECK ("price_list"."annual_discount_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"started_on" date NOT NULL,
	"trial_ends_on" date,
	"pending_tier" text,
	"pending_tier_from" date,
	"cancels_on" date,
	"cancel_reason" text,
	"cancelled_on" date,
	"read_only_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_subscriber_key" UNIQUE("subscriber_company_id"),
	CONSTRAINT "subscription_tier_check" CHECK ("subscription"."tier" in ('starter', 'growth', 'portfolio')),
	CONSTRAINT "subscription_pending_tier_check" CHECK (("subscription"."pending_tier" is null) = ("subscription"."pending_tier_from" is null) and ("subscription"."pending_tier" is null or "subscription"."pending_tier" in ('starter', 'growth', 'portfolio'))),
	CONSTRAINT "subscription_status_check" CHECK ("subscription"."status" in ('trialing', 'active', 'past_due', 'read_only', 'cancel_scheduled', 'cancelled')),
	CONSTRAINT "subscription_cancelled_check" CHECK (("subscription"."status" = 'cancelled') = ("subscription"."cancelled_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "subscription_allocation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"payment_id" uuid,
	"invoice_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_allocation_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_allocation_source_check" CHECK ("subscription_allocation"."source" in ('payment', 'prepaid')),
	CONSTRAINT "subscription_allocation_payment_check" CHECK (("subscription_allocation"."source" = 'payment') = ("subscription_allocation"."payment_id" is not null)),
	CONSTRAINT "subscription_allocation_amount_check" CHECK ("subscription_allocation"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "subscription_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status_from" text,
	"status_to" text,
	"tier" text,
	"effective_on" date,
	"reason" text,
	"data" jsonb,
	"actor_person_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_event_kind_check" CHECK ("subscription_event"."kind" in ('started', 'status_changed', 'tier_changed', 'downgrade_scheduled', 'downgrade_withdrawn', 'trial_extended', 'discount_applied', 'annual_started', 'cancel_scheduled', 'cancel_withdrawn', 'reminder_sent')),
	CONSTRAINT "subscription_event_tier_check" CHECK ("subscription_event"."tier" is null or "subscription_event"."tier" in ('starter', 'growth', 'portfolio')),
	CONSTRAINT "subscription_event_tier_change_check" CHECK ("subscription_event"."kind" not in ('started', 'tier_changed') or ("subscription_event"."tier" is not null and "subscription_event"."effective_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "subscription_export" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"document_id" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_export_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_export_status_check" CHECK ("subscription_export"."status" in ('preparing', 'ready', 'failed')),
	CONSTRAINT "subscription_export_ready_check" CHECK (("subscription_export"."status" = 'ready') = ("subscription_export"."document_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "subscription_invoice" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"month" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"vat_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"price_list_ids" uuid[] NOT NULL,
	"terms_id" uuid NOT NULL,
	"vat_rule_id" uuid,
	"vat_unverified" boolean DEFAULT false NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"render_request_id" uuid,
	"document_id" uuid,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoice_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_invoice_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "subscription_invoice_month_key" UNIQUE("company_id","subscriber_company_id","month"),
	CONSTRAINT "subscription_invoice_month_check" CHECK ("subscription_invoice"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "subscription_invoice_number_check" CHECK ("subscription_invoice"."number" ~ '^SUB-[0-9]{4}-[0-9]{6,}$'),
	CONSTRAINT "subscription_invoice_status_check" CHECK ("subscription_invoice"."status" in ('open', 'paid', 'void')),
	CONSTRAINT "subscription_invoice_paid_check" CHECK (("subscription_invoice"."status" = 'paid') = ("subscription_invoice"."paid_at" is not null)),
	CONSTRAINT "subscription_invoice_amounts_check" CHECK ("subscription_invoice"."subtotal_minor" >= 0 and "subscription_invoice"."discount_minor" <= 0 and "subscription_invoice"."net_minor" = "subscription_invoice"."subtotal_minor" + "subscription_invoice"."discount_minor" and "subscription_invoice"."net_minor" >= 0 and "subscription_invoice"."vat_minor" >= 0 and "subscription_invoice"."total_minor" = "subscription_invoice"."net_minor" + "subscription_invoice"."vat_minor"),
	CONSTRAINT "subscription_invoice_dates_check" CHECK ("subscription_invoice"."due_on" >= "subscription_invoice"."issued_on"),
	CONSTRAINT "subscription_invoice_sha_check" CHECK ("subscription_invoice"."sha256" is null or "subscription_invoice"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_invoice_line" (
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"tier" text,
	"band" text,
	"units" integer,
	"rate_minor" bigint,
	"days" integer,
	"days_in_month" integer,
	"rate_bps" integer,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "subscription_invoice_line_company_id_invoice_id_line_no_pk" PRIMARY KEY("company_id","invoice_id","line_no"),
	CONSTRAINT "subscription_invoice_line_kind_check" CHECK ("subscription_invoice_line"."kind" in ('units', 'minimum', 'discount', 'vat', 'nhil', 'getfund')),
	CONSTRAINT "subscription_invoice_line_tier_check" CHECK ("subscription_invoice_line"."tier" is null or "subscription_invoice_line"."tier" in ('starter', 'growth', 'portfolio')),
	CONSTRAINT "subscription_invoice_line_band_check" CHECK ("subscription_invoice_line"."band" is null or "subscription_invoice_line"."band" in ('single_room', 'self_contained', 'commercial')),
	CONSTRAINT "subscription_invoice_line_sign_check" CHECK (("subscription_invoice_line"."kind" = 'discount' and "subscription_invoice_line"."amount_minor" < 0) or ("subscription_invoice_line"."kind" <> 'discount' and "subscription_invoice_line"."amount_minor" > 0))
);
--> statement-breakpoint
CREATE TABLE "subscription_payment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"purpose" text NOT NULL,
	"channel" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"checkout_url" text,
	"message" text,
	"annual_first_month" text,
	"annual_last_month" text,
	"annual_discount_bps" integer,
	"idempotency_key" text,
	"initiated_by" uuid,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_payment_reference_key" UNIQUE("company_id","reference"),
	CONSTRAINT "subscription_payment_reference_check" CHECK ("subscription_payment"."reference" like 'SUB-%'),
	CONSTRAINT "subscription_payment_purpose_check" CHECK ("subscription_payment"."purpose" in ('invoices', 'annual')),
	CONSTRAINT "subscription_payment_channel_check" CHECK ("subscription_payment"."channel" in ('card', 'momo')),
	CONSTRAINT "subscription_payment_status_check" CHECK ("subscription_payment"."status" in ('initiated', 'pending', 'succeeded', 'failed', 'reversed')),
	CONSTRAINT "subscription_payment_amount_check" CHECK ("subscription_payment"."amount_minor" > 0),
	CONSTRAINT "subscription_payment_annual_check" CHECK (("subscription_payment"."purpose" = 'annual') = ("subscription_payment"."annual_first_month" is not null and "subscription_payment"."annual_last_month" is not null and "subscription_payment"."annual_discount_bps" is not null)),
	CONSTRAINT "subscription_payment_succeeded_check" CHECK ("subscription_payment"."status" not in ('succeeded', 'reversed') or "subscription_payment"."succeeded_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "subscription_receipt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"paid_on" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"render_request_id" uuid,
	"document_id" uuid,
	"sha256" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_receipt_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_receipt_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "subscription_receipt_payment_key" UNIQUE("company_id","payment_id"),
	CONSTRAINT "subscription_receipt_number_check" CHECK ("subscription_receipt"."number" ~ '^SUBR-[0-9]{4}-[0-9]{6,}$'),
	CONSTRAINT "subscription_receipt_amount_check" CHECK ("subscription_receipt"."amount_minor" > 0),
	CONSTRAINT "subscription_receipt_sha_check" CHECK ("subscription_receipt"."sha256" is null or "subscription_receipt"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"effective_from" date NOT NULL,
	"trial_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"read_only_enabled" boolean NOT NULL,
	"due_days" integer NOT NULL,
	"retention_days_after_cancel" integer NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_terms_version_key" UNIQUE("effective_from"),
	CONSTRAINT "subscription_terms_days_check" CHECK ("subscription_terms"."trial_days" >= 0 and "subscription_terms"."grace_days" >= 0 and "subscription_terms"."due_days" >= 0 and "subscription_terms"."retention_days_after_cancel" >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_grant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_grant_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "support_grant_period_check" CHECK ("support_grant"."ends_at" > "support_grant"."starts_at" and "support_grant"."ends_at" <= "support_grant"."starts_at" + interval '7 days'),
	CONSTRAINT "support_grant_revoked_check" CHECK (("support_grant"."revoked_at" is null) = ("support_grant"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_rate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"category" text NOT NULL,
	"rate_minor" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_rate_version_key" UNIQUE("category","effective_from"),
	CONSTRAINT "whatsapp_rate_category_check" CHECK ("whatsapp_rate"."category" in ('utility', 'marketing', 'authentication', 'service', 'referral_conversion')),
	CONSTRAINT "whatsapp_rate_amount_check" CHECK ("whatsapp_rate"."rate_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "company_counter" DROP CONSTRAINT "company_counter_name_check";--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "plan" text DEFAULT 'growth' NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "access" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_snapshot" ADD CONSTRAINT "billing_snapshot_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_snapshot" ADD CONSTRAINT "billing_snapshot_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_snapshot" ADD CONSTRAINT "billing_snapshot_subscription_fk" FOREIGN KEY ("company_id","subscription_id") REFERENCES "public"."subscription"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_snapshot_unit" ADD CONSTRAINT "billing_snapshot_unit_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_snapshot_unit" ADD CONSTRAINT "billing_snapshot_unit_snapshot_fk" FOREIGN KEY ("company_id","snapshot_id") REFERENCES "public"."billing_snapshot"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code" ADD CONSTRAINT "discount_code_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code" ADD CONSTRAINT "discount_code_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_applied_by_person_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_code_fk" FOREIGN KEY ("company_id","discount_code_id") REFERENCES "public"."discount_code"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_subscription_fk" FOREIGN KEY ("company_id","subscription_id") REFERENCES "public"."subscription"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_allocation" ADD CONSTRAINT "subscription_allocation_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_allocation" ADD CONSTRAINT "subscription_allocation_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_allocation" ADD CONSTRAINT "subscription_allocation_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."subscription_payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_allocation" ADD CONSTRAINT "subscription_allocation_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."subscription_invoice"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_subscription_fk" FOREIGN KEY ("company_id","subscription_id") REFERENCES "public"."subscription"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_export" ADD CONSTRAINT "subscription_export_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_export" ADD CONSTRAINT "subscription_export_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_export" ADD CONSTRAINT "subscription_export_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_subscription_fk" FOREIGN KEY ("company_id","subscription_id") REFERENCES "public"."subscription"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_snapshot_fk" FOREIGN KEY ("company_id","snapshot_id") REFERENCES "public"."billing_snapshot"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_terms_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."subscription_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice_line" ADD CONSTRAINT "subscription_invoice_line_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice_line" ADD CONSTRAINT "subscription_invoice_line_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."subscription_invoice"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_initiated_by_person_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_subscription_fk" FOREIGN KEY ("company_id","subscription_id") REFERENCES "public"."subscription"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipt" ADD CONSTRAINT "subscription_receipt_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipt" ADD CONSTRAINT "subscription_receipt_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipt" ADD CONSTRAINT "subscription_receipt_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."subscription_payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipt" ADD CONSTRAINT "subscription_receipt_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipt" ADD CONSTRAINT "subscription_receipt_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_terms" ADD CONSTRAINT "subscription_terms_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_granted_by_person_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_revoked_by_person_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_rate" ADD CONSTRAINT "whatsapp_rate_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_event_time_idx" ON "alert_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "subscription_allocation_invoice_idx" ON "subscription_allocation" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX "subscription_allocation_payment_idx" ON "subscription_allocation" USING btree ("company_id","payment_id");--> statement-breakpoint
CREATE INDEX "subscription_event_subscription_idx" ON "subscription_event" USING btree ("company_id","subscription_id","occurred_at");--> statement-breakpoint
CREATE INDEX "subscription_invoice_subscriber_idx" ON "subscription_invoice" USING btree ("company_id","subscriber_company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_idempotency_key" ON "subscription_payment" USING btree ("company_id","subscriber_company_id","idempotency_key") WHERE "subscription_payment"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "subscription_payment_subscriber_idx" ON "subscription_payment" USING btree ("company_id","subscriber_company_id","status");--> statement-breakpoint
CREATE INDEX "support_grant_active_idx" ON "support_grant" USING btree ("company_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "book_one_platform_book" ON "book" USING btree ("company_id") WHERE "book"."kind" = 'platform';--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_plan_check" CHECK ("company"."plan" in ('starter', 'growth', 'portfolio'));--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_access_check" CHECK ("company"."access" in ('full', 'read_only'));--> statement-breakpoint
ALTER TABLE "company_counter" ADD CONSTRAINT "company_counter_name_check" CHECK ("company_counter"."name" in ('receipt', 'invoice', 'notice') or "company_counter"."name" ~ '^subscription_(invoice|receipt):[0-9]{4}$');