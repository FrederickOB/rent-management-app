CREATE TABLE "allocation_fee" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"management_fee_id" uuid,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"charged_allocation_id" uuid,
	"lease_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"payment_id" uuid,
	"rate_bps" integer NOT NULL,
	"base_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_fee_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "allocation_fee_key" UNIQUE NULLS NOT DISTINCT("company_id","allocation_id","charged_allocation_id"),
	CONSTRAINT "allocation_fee_sign_check" CHECK (("allocation_fee"."charged_allocation_id" is null and "allocation_fee"."base_minor" > 0 and "allocation_fee"."fee_minor" >= 0)
          or ("allocation_fee"."charged_allocation_id" is not null and "allocation_fee"."base_minor" < 0 and "allocation_fee"."fee_minor" <= 0))
);
--> statement-breakpoint
CREATE TABLE "owner_money_reversal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"record_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reversed_on" date NOT NULL,
	"entry_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_money_reversal_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "owner_money_reversal_record_key" UNIQUE("company_id","record_id"),
	CONSTRAINT "owner_money_reversal_kind_check" CHECK ("owner_money_reversal"."record_kind" in ('remittance', 'owner_funding'))
);
--> statement-breakpoint
ALTER TABLE "metric_daily" ADD COLUMN "finalised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD COLUMN "email_message_id" uuid;--> statement-breakpoint
ALTER TABLE "owner_statement" ADD COLUMN "email_not_sent_reason" text;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_management_fee_fk" FOREIGN KEY ("company_id","management_fee_id") REFERENCES "public"."management_fee"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_allocation_fk" FOREIGN KEY ("company_id","allocation_id") REFERENCES "public"."allocation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_charged_fk" FOREIGN KEY ("company_id","charged_allocation_id") REFERENCES "public"."allocation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_lease_fk" FOREIGN KEY ("company_id","lease_id") REFERENCES "public"."lease"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_line_fk" FOREIGN KEY ("company_id","invoice_line_id") REFERENCES "public"."invoice_line"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_fee" ADD CONSTRAINT "allocation_fee_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_reversal" ADD CONSTRAINT "owner_money_reversal_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_reversal" ADD CONSTRAINT "owner_money_reversal_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_reversal" ADD CONSTRAINT "owner_money_reversal_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_reversal" ADD CONSTRAINT "owner_money_reversal_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_reversal" ADD CONSTRAINT "owner_money_reversal_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocation_fee_lease_idx" ON "allocation_fee" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "allocation_fee_charged_idx" ON "allocation_fee" USING btree ("company_id","charged_allocation_id");--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."unit"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_lease_fk" FOREIGN KEY ("company_id","lease_id") REFERENCES "public"."lease"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;