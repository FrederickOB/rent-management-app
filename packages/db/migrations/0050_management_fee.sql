CREATE TABLE "management_fee" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"lease_id" uuid,
	"payment_id" uuid,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"reverses_fee_id" uuid,
	"rate_bps" integer,
	"base_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"value_date" date NOT NULL,
	"entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_fee_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "management_fee_key" UNIQUE NULLS NOT DISTINCT("company_id","key","payment_id"),
	CONSTRAINT "management_fee_source_check" CHECK ("management_fee"."source" in ('payment', 'deposit', 'withholding', 'credit_draw', 'fixed', 'reversal', 'refund', 'unwind')),
	CONSTRAINT "management_fee_sign_check" CHECK (("management_fee"."source" in ('reversal', 'refund', 'unwind')) = ("management_fee"."fee_minor" < 0) and ("management_fee"."reverses_fee_id" is not null) = ("management_fee"."source" in ('reversal', 'refund', 'unwind')))
);
--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fee" ADD CONSTRAINT "management_fee_reverses_fk" FOREIGN KEY ("company_id","reverses_fee_id") REFERENCES "public"."management_fee"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "management_fee_lease_idx" ON "management_fee" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "management_fee_payment_idx" ON "management_fee" USING btree ("company_id","payment_id");