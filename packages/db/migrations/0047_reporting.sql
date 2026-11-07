CREATE TABLE "dashboard_export" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb NOT NULL,
	"status" text NOT NULL,
	"document_id" uuid,
	"render_request_id" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_export_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "dashboard_export_format_check" CHECK ("dashboard_export"."format" in ('pdf', 'xlsx')),
	CONSTRAINT "dashboard_export_status_check" CHECK ("dashboard_export"."status" in ('rendering', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "lease_snapshot" (
	"company_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"lease_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid,
	"lease_status" text NOT NULL,
	"occupying" boolean NOT NULL,
	"end_date" date NOT NULL,
	"renewal_status" text,
	"paid_until" date,
	"months_paid_ahead" integer DEFAULT 0 NOT NULL,
	"arrears0_to30_minor" bigint DEFAULT 0 NOT NULL,
	"arrears31_to60_minor" bigint DEFAULT 0 NOT NULL,
	"arrears61_to90_minor" bigint DEFAULT 0 NOT NULL,
	"arrears90_plus_minor" bigint DEFAULT 0 NOT NULL,
	"unearned_rent_minor" bigint DEFAULT 0 NOT NULL,
	"deposit_held_minor" bigint DEFAULT 0 NOT NULL,
	"rent_minor" bigint DEFAULT 0 NOT NULL,
	"service_charge_minor" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lease_snapshot_pkey" PRIMARY KEY("company_id","snapshot_date","lease_id")
);
--> statement-breakpoint
CREATE TABLE "management_fee_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rate_bps" integer,
	"fixed_minor" bigint,
	"gra_paid_by" text NOT NULL,
	"effective_from" date NOT NULL,
	"approval_request_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_fee_terms_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "management_fee_terms_kind_check" CHECK (("management_fee_terms"."kind" = 'none' and "management_fee_terms"."rate_bps" is null and "management_fee_terms"."fixed_minor" is null) or ("management_fee_terms"."kind" = 'percentage' and "management_fee_terms"."rate_bps" between 1 and 10000 and "management_fee_terms"."fixed_minor" is null) or ("management_fee_terms"."kind" = 'fixed_per_unit' and "management_fee_terms"."rate_bps" is null and "management_fee_terms"."fixed_minor" > 0)),
	CONSTRAINT "management_fee_terms_gra_check" CHECK ("management_fee_terms"."gra_paid_by" in ('agency', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "metric_daily" (
	"company_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"month" text NOT NULL,
	"figures" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "metric_daily_pkey" PRIMARY KEY("company_id","metric_date")
);
--> statement-breakpoint
CREATE TABLE "owner_funding" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text NOT NULL,
	"proof_document_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"entry_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_funding_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "owner_funding_method_check" CHECK ("owner_funding"."method" in ('bank', 'momo', 'cheque', 'cash')),
	CONSTRAINT "owner_funding_amount_check" CHECK ("owner_funding"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "owner_statement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"month" text NOT NULL,
	"first_day" date NOT NULL,
	"last_day" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"render_request_id" uuid,
	"document_id" uuid,
	"sha256" text,
	"delivered_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statement_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "owner_statement_month_key" UNIQUE("company_id","owner_id","month"),
	CONSTRAINT "owner_statement_month_check" CHECK ("owner_statement"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "owner_statement_status_check" CHECK ("owner_statement"."status" in ('draft', 'issued')),
	CONSTRAINT "owner_statement_issued_check" CHECK (("owner_statement"."status" = 'issued') = ("owner_statement"."issued_at" is not null)),
	CONSTRAINT "owner_statement_sha_check" CHECK ("owner_statement"."sha256" is null or "owner_statement"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "owner_statement_figure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_minor" bigint NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statement_figure_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "owner_statement_figure_key" UNIQUE("company_id","statement_id","key")
);
--> statement-breakpoint
CREATE TABLE "remittance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"paid_on" date NOT NULL,
	"method" text,
	"reference" text,
	"proof_document_id" uuid,
	"net_minor" bigint NOT NULL,
	"fees_retained_minor" bigint NOT NULL,
	"entry_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "remittance_kind_check" CHECK ("remittance"."kind" in ('remittance', 'fees_taken')),
	CONSTRAINT "remittance_method_check" CHECK ("remittance"."method" is null or "remittance"."method" in ('bank', 'momo', 'cheque', 'cash')),
	CONSTRAINT "remittance_amounts_check" CHECK ("remittance"."fees_retained_minor" >= 0 and (("remittance"."kind" = 'remittance' and "remittance"."net_minor" > 0 and "remittance"."method" is not null and "remittance"."proof_document_id" is not null) or ("remittance"."kind" = 'fees_taken' and "remittance"."net_minor" = 0 and "remittance"."fees_retained_minor" > 0)))
);
--> statement-breakpoint
ALTER TABLE "dashboard_export" ADD CONSTRAINT "dashboard_export_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_export" ADD CONSTRAINT "dashboard_export_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_snapshot" ADD CONSTRAINT "lease_snapshot_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee_terms" ADD CONSTRAINT "management_fee_terms_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee_terms" ADD CONSTRAINT "management_fee_terms_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee_terms" ADD CONSTRAINT "management_fee_terms_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee_terms" ADD CONSTRAINT "management_fee_terms_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_daily" ADD CONSTRAINT "metric_daily_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_funding" ADD CONSTRAINT "owner_funding_proof_fk" FOREIGN KEY ("company_id","proof_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_issued_by_person_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD CONSTRAINT "owner_statement_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement_figure" ADD CONSTRAINT "owner_statement_figure_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement_figure" ADD CONSTRAINT "owner_statement_figure_statement_fk" FOREIGN KEY ("company_id","statement_id") REFERENCES "public"."owner_statement"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statement_figure" ADD CONSTRAINT "owner_statement_figure_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance" ADD CONSTRAINT "remittance_proof_fk" FOREIGN KEY ("company_id","proof_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_export_render_key" ON "dashboard_export" USING btree ("company_id","render_request_id") WHERE "dashboard_export"."render_request_id" is not null;--> statement-breakpoint
CREATE INDEX "lease_snapshot_property_idx" ON "lease_snapshot" USING btree ("company_id","snapshot_date","property_id");--> statement-breakpoint
CREATE INDEX "management_fee_terms_owner_idx" ON "management_fee_terms" USING btree ("company_id","owner_id","effective_from");--> statement-breakpoint
CREATE INDEX "remittance_owner_idx" ON "remittance" USING btree ("company_id","owner_id","paid_on");