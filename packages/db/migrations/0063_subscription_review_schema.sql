CREATE TABLE "billing_activation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"starts_on" date NOT NULL,
	"turned_on_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_credit_note" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscriber_company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issued_on" date NOT NULL,
	"net_minor" bigint NOT NULL,
	"vat_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"to_credit_minor" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"render_request_id" uuid,
	"document_id" uuid,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_credit_note_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "subscription_credit_note_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "subscription_credit_note_number_check" CHECK ("subscription_credit_note"."number" ~ '^SUBC-[0-9]{4}-[0-9]{6,}$'),
	CONSTRAINT "subscription_credit_note_amounts_check" CHECK ("subscription_credit_note"."net_minor" >= 0 and "subscription_credit_note"."vat_minor" >= 0 and "subscription_credit_note"."amount_minor" = "subscription_credit_note"."net_minor" + "subscription_credit_note"."vat_minor" and "subscription_credit_note"."amount_minor" > 0 and "subscription_credit_note"."to_credit_minor" between 0 and "subscription_credit_note"."amount_minor"),
	CONSTRAINT "subscription_credit_note_sha_check" CHECK ("subscription_credit_note"."sha256" is null or "subscription_credit_note"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_subscriber_key";--> statement-breakpoint
ALTER TABLE "company_counter" DROP CONSTRAINT "company_counter_name_check";--> statement-breakpoint
ALTER TABLE "billing_activation" ADD CONSTRAINT "billing_activation_turned_on_by_person_id_fk" FOREIGN KEY ("turned_on_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_subscriber_company_id_company_id_fk" FOREIGN KEY ("subscriber_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."subscription_invoice"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_credit_note" ADD CONSTRAINT "subscription_credit_note_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_activation_time_idx" ON "billing_activation" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "subscription_credit_note_invoice_idx" ON "subscription_credit_note" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_live_key" ON "subscription" USING btree ("subscriber_company_id") WHERE "subscription"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "subscription_subscriber_idx" ON "subscription" USING btree ("subscriber_company_id","created_at");--> statement-breakpoint
ALTER TABLE "company_counter" ADD CONSTRAINT "company_counter_name_check" CHECK ("company_counter"."name" in ('receipt', 'invoice', 'notice') or "company_counter"."name" ~ '^subscription_(invoice|receipt|credit):[0-9]{4}$');