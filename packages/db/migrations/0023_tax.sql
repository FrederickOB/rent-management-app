CREATE TABLE "early_termination" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"last_day" date NOT NULL,
	"charges" jsonb NOT NULL,
	"deductions" jsonb NOT NULL,
	"unused_days_credit_minor" bigint NOT NULL,
	"applied_minor" bigint NOT NULL,
	"refund_minor" bigint NOT NULL,
	"note" text,
	"approval_request_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"settled_on" date,
	"refund_entry_id" uuid,
	"refund_accounting_date" date,
	"paid_on" date,
	"paid_from" text,
	"paid_reference" text,
	"proof_document_id" uuid,
	"paid_entry_id" uuid,
	"paid_accounting_date" date,
	"paid_by" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_termination_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "early_termination_lease_key" UNIQUE("company_id","lease_id","id"),
	CONSTRAINT "early_termination_status_check" CHECK ("early_termination"."status" in ('awaiting_approval', 'settled', 'refund_paid', 'rejected')),
	CONSTRAINT "early_termination_amounts_check" CHECK ("early_termination"."unused_days_credit_minor" >= 0 and "early_termination"."applied_minor" >= 0 and "early_termination"."refund_minor" >= 0),
	CONSTRAINT "early_termination_paid_check" CHECK (("early_termination"."status" = 'refund_paid') = ("early_termination"."paid_entry_id" is not null)
          and ("early_termination"."paid_entry_id" is null or ("early_termination"."paid_on" is not null and "early_termination"."paid_from" in ('owner_account', 'agency_account')
               and "early_termination"."paid_reference" is not null and "early_termination"."proof_document_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "early_termination_refund_part" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"termination_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_termination_refund_part_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "early_termination_refund_part_key" UNIQUE("company_id","termination_id","payment_id"),
	CONSTRAINT "early_termination_refund_part_amount_check" CHECK ("early_termination_refund_part"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "paid_until_prompt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"paid_until" date NOT NULL,
	"prompted_on" date NOT NULL,
	"staff_messages" integer NOT NULL,
	"tenant_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_until_prompt_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "paid_until_prompt_once" UNIQUE("company_id","lease_id","paid_until"),
	CONSTRAINT "paid_until_prompt_staff_check" CHECK ("paid_until_prompt"."staff_messages" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_advance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"value_date" date NOT NULL,
	"months_ahead" integer NOT NULL,
	"policy" text NOT NULL,
	"rule_key" text,
	"rule_id" uuid,
	"limit_months" integer,
	"over_limit" boolean NOT NULL,
	"flagged" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_advance_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "payment_advance_payment_key" UNIQUE("company_id","payment_id"),
	CONSTRAINT "payment_advance_months_check" CHECK ("payment_advance"."months_ahead" >= 0),
	CONSTRAINT "payment_advance_policy_check" CHECK ("payment_advance"."policy" in ('off', 'warn', 'block')),
	CONSTRAINT "payment_advance_flag_check" CHECK ((not "payment_advance"."flagged" or ("payment_advance"."over_limit" and "payment_advance"."policy" <> 'off'))
          and (not "payment_advance"."over_limit" or "payment_advance"."limit_months" is not null))
);
--> statement-breakpoint
CREATE TABLE "gra_payment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"accounting_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"gra_receipt_number" text NOT NULL,
	"receipt_document_id" uuid NOT NULL,
	"paid_from" text NOT NULL,
	"note" text,
	"entry_id" uuid NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gra_payment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "gra_payment_amount_check" CHECK ("gra_payment"."amount_minor" > 0),
	CONSTRAINT "gra_payment_currency_check" CHECK ("gra_payment"."currency" = 'GHS'),
	CONSTRAINT "gra_payment_from_check" CHECK ("gra_payment"."paid_from" in ('owner_account', 'agency_account')),
	CONSTRAINT "gra_payment_dates_check" CHECK ("gra_payment"."accounting_date" >= "gra_payment"."paid_on")
);
--> statement-breakpoint
CREATE TABLE "gra_payment_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"gra_payment_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gra_payment_item_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "gra_payment_item_key" UNIQUE("company_id","gra_payment_id","item_id"),
	CONSTRAINT "gra_payment_item_amount_check" CHECK ("gra_payment_item"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "rent_tax_alert" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"alert_day" integer NOT NULL,
	"alert_date" date NOT NULL,
	"rule_id" uuid,
	"recipients" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_tax_alert_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_tax_alert_once" UNIQUE("company_id","item_id","alert_day"),
	CONSTRAINT "rent_tax_alert_day_check" CHECK ("rent_tax_alert"."alert_day" >= 0),
	CONSTRAINT "rent_tax_alert_recipients_check" CHECK ("rent_tax_alert"."recipients" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rent_tax_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"withholding_id" uuid,
	"reverses_item_id" uuid,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"due_date" date,
	"base_minor" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"tax_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"lease_use" text NOT NULL,
	"unit_code" text NOT NULL,
	"tenant_name" text NOT NULL,
	"receipt_number" bigint,
	"rate_rule_id" uuid NOT NULL,
	"base_rule_id" uuid,
	"rounding_rule_id" uuid,
	"service_charge_rule_id" uuid,
	"due_rule_id" uuid,
	"alert_rule_id" uuid,
	"entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_tax_item_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_tax_item_lease_key" UNIQUE("company_id","lease_id","id"),
	CONSTRAINT "rent_tax_item_kind_check" CHECK ("rent_tax_item"."kind" in ('receipt', 'carry_over', 'withholding', 'reversal', 'withholding_offset')),
	CONSTRAINT "rent_tax_item_use_check" CHECK ("rent_tax_item"."lease_use" in ('residential', 'commercial')),
	CONSTRAINT "rent_tax_item_currency_check" CHECK ("rent_tax_item"."currency" = 'GHS'),
	CONSTRAINT "rent_tax_item_rate_check" CHECK ("rent_tax_item"."rate_bps" >= 0),
	CONSTRAINT "rent_tax_item_sign_check" CHECK (case when "rent_tax_item"."kind" in ('reversal', 'withholding_offset')
            then "rent_tax_item"."tax_minor" <= 0 and "rent_tax_item"."base_minor" <= 0 and "rent_tax_item"."reverses_item_id" is not null and "rent_tax_item"."due_date" is null
            else "rent_tax_item"."tax_minor" >= 0 and "rent_tax_item"."base_minor" >= 0 and "rent_tax_item"."reverses_item_id" is null and "rent_tax_item"."due_date" is not null end),
	CONSTRAINT "rent_tax_item_source_check" CHECK (("rent_tax_item"."kind" in ('withholding', 'withholding_offset')) = ("rent_tax_item"."withholding_id" is not null)
          and ("rent_tax_item"."kind" not in ('receipt', 'reversal') or "rent_tax_item"."payment_id" is not null)),
	CONSTRAINT "rent_tax_item_entry_check" CHECK (("rent_tax_item"."tax_minor" <> 0) = ("rent_tax_item"."entry_id" is not null)),
	CONSTRAINT "rent_tax_item_dates_check" CHECK ("rent_tax_item"."accounting_date" >= "rent_tax_item"."value_date")
);
--> statement-breakpoint
CREATE TABLE "rent_tax_item_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"charge_period_id" uuid NOT NULL,
	"invoice_line_id" uuid,
	"base_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_tax_item_line_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_tax_item_line_period_key" UNIQUE("company_id","item_id","charge_period_id"),
	CONSTRAINT "rent_tax_item_line_amount_check" CHECK ("rent_tax_item_line"."base_minor" <> 0 or "rent_tax_item_line"."tax_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "vat_payment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"paid_on" date NOT NULL,
	"accounting_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"gra_receipt_number" text NOT NULL,
	"receipt_document_id" uuid NOT NULL,
	"paid_from" text NOT NULL,
	"note" text,
	"entry_id" uuid NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_payment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "vat_payment_amount_check" CHECK ("vat_payment"."amount_minor" > 0),
	CONSTRAINT "vat_payment_currency_check" CHECK ("vat_payment"."currency" = 'GHS'),
	CONSTRAINT "vat_payment_month_check" CHECK (extract(day from "vat_payment"."period_month") = 1),
	CONSTRAINT "vat_payment_from_check" CHECK ("vat_payment"."paid_from" in ('owner_account', 'agency_account')),
	CONSTRAINT "vat_payment_dates_check" CHECK ("vat_payment"."accounting_date" >= "vat_payment"."paid_on")
);
--> statement-breakpoint
CREATE TABLE "withholding" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"payment_id" uuid,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"rate_bps" integer NOT NULL,
	"rate_rule_id" uuid NOT NULL,
	"differs_from_rate" boolean NOT NULL,
	"note" text,
	"entry_id" uuid NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "withholding_lease_key" UNIQUE("company_id","lease_id","id"),
	CONSTRAINT "withholding_amount_check" CHECK ("withholding"."amount_minor" > 0),
	CONSTRAINT "withholding_currency_check" CHECK ("withholding"."currency" = 'GHS'),
	CONSTRAINT "withholding_dates_check" CHECK ("withholding"."accounting_date" >= "withholding"."value_date")
);
--> statement-breakpoint
CREATE TABLE "withholding_certificate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"withholding_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"certificate_number" text,
	"issued_on" date,
	"amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'awaiting_confirmation' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"debit_account" text,
	"entry_id" uuid,
	"value_date" date,
	"accounting_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_certificate_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "withholding_certificate_status_check" CHECK ("withholding_certificate"."status" in ('awaiting_confirmation', 'confirmed', 'rejected')),
	CONSTRAINT "withholding_certificate_amount_check" CHECK ("withholding_certificate"."amount_minor" > 0),
	CONSTRAINT "withholding_certificate_two_people_check" CHECK ("withholding_certificate"."decided_by" is null or "withholding_certificate"."decided_by" <> "withholding_certificate"."uploaded_by"),
	CONSTRAINT "withholding_certificate_decided_check" CHECK (("withholding_certificate"."status" = 'awaiting_confirmation') = ("withholding_certificate"."decided_by" is null)),
	CONSTRAINT "withholding_certificate_posted_check" CHECK (("withholding_certificate"."status" = 'confirmed') = ("withholding_certificate"."entry_id" is not null)
          and ("withholding_certificate"."status" = 'confirmed') = ("withholding_certificate"."debit_account" is not null)
          and ("withholding_certificate"."debit_account" is null or "withholding_certificate"."debit_account" in ('2200', '1160')))
);
--> statement-breakpoint
CREATE TABLE "withholding_write_off" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"withholding_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reason" text NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_write_off_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "withholding_write_off_one" UNIQUE("company_id","withholding_id"),
	CONSTRAINT "withholding_write_off_amount_check" CHECK ("withholding_write_off"."amount_minor" > 0),
	CONSTRAINT "withholding_write_off_dates_check" CHECK ("withholding_write_off"."accounting_date" >= "withholding_write_off"."value_date")
);
--> statement-breakpoint
ALTER TABLE "allocation" DROP CONSTRAINT "allocation_record_check";--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_paid_by_person_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_proof_fk" FOREIGN KEY ("company_id","proof_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_refund_entry_fk" FOREIGN KEY ("company_id","refund_entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination" ADD CONSTRAINT "early_termination_paid_entry_fk" FOREIGN KEY ("company_id","paid_entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination_refund_part" ADD CONSTRAINT "early_termination_refund_part_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination_refund_part" ADD CONSTRAINT "early_termination_refund_part_termination_fk" FOREIGN KEY ("company_id","lease_id","termination_id") REFERENCES "public"."early_termination"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination_refund_part" ADD CONSTRAINT "early_termination_refund_part_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_termination_refund_part" ADD CONSTRAINT "early_termination_refund_part_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_until_prompt" ADD CONSTRAINT "paid_until_prompt_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_until_prompt" ADD CONSTRAINT "paid_until_prompt_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advance" ADD CONSTRAINT "payment_advance_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advance" ADD CONSTRAINT "payment_advance_rule_id_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advance" ADD CONSTRAINT "payment_advance_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advance" ADD CONSTRAINT "payment_advance_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_document_fk" FOREIGN KEY ("company_id","receipt_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment" ADD CONSTRAINT "gra_payment_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment_item" ADD CONSTRAINT "gra_payment_item_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment_item" ADD CONSTRAINT "gra_payment_item_payment_fk" FOREIGN KEY ("company_id","gra_payment_id") REFERENCES "public"."gra_payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gra_payment_item" ADD CONSTRAINT "gra_payment_item_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."rent_tax_item"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_alert" ADD CONSTRAINT "rent_tax_alert_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_alert" ADD CONSTRAINT "rent_tax_alert_rule_id_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_alert" ADD CONSTRAINT "rent_tax_alert_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."rent_tax_item"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_rate_rule_id_rule_id_fk" FOREIGN KEY ("rate_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_base_rule_id_rule_id_fk" FOREIGN KEY ("base_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_rounding_rule_id_rule_id_fk" FOREIGN KEY ("rounding_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_service_charge_rule_id_rule_id_fk" FOREIGN KEY ("service_charge_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_due_rule_id_rule_id_fk" FOREIGN KEY ("due_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_alert_rule_id_rule_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_reverses_fk" FOREIGN KEY ("company_id","reverses_item_id") REFERENCES "public"."rent_tax_item"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item_line" ADD CONSTRAINT "rent_tax_item_line_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item_line" ADD CONSTRAINT "rent_tax_item_line_item_fk" FOREIGN KEY ("company_id","lease_id","item_id") REFERENCES "public"."rent_tax_item"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item_line" ADD CONSTRAINT "rent_tax_item_line_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item_line" ADD CONSTRAINT "rent_tax_item_line_period_fk" FOREIGN KEY ("company_id","charge_period_id") REFERENCES "public"."charge_period"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_tax_item_line" ADD CONSTRAINT "rent_tax_item_line_invoice_line_fk" FOREIGN KEY ("company_id","lease_id","invoice_line_id") REFERENCES "public"."invoice_line"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_document_fk" FOREIGN KEY ("company_id","receipt_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_payment" ADD CONSTRAINT "vat_payment_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_rate_rule_id_rule_id_fk" FOREIGN KEY ("rate_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_uploaded_by_person_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_decided_by_person_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_withholding_fk" FOREIGN KEY ("company_id","lease_id","withholding_id") REFERENCES "public"."withholding"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_withholding_fk" FOREIGN KEY ("company_id","lease_id","withholding_id") REFERENCES "public"."withholding"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_write_off" ADD CONSTRAINT "withholding_write_off_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "early_termination_one_live" ON "early_termination" USING btree ("company_id","lease_id") WHERE "early_termination"."status" in ('awaiting_approval', 'settled', 'refund_paid');--> statement-breakpoint
CREATE INDEX "early_termination_refund_part_payment_idx" ON "early_termination_refund_part" USING btree ("company_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_advance_lease_idx" ON "payment_advance" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "gra_payment_owner_idx" ON "gra_payment" USING btree ("company_id","owner_id","accounting_date");--> statement-breakpoint
CREATE INDEX "gra_payment_item_item_idx" ON "gra_payment_item" USING btree ("company_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_per_receipt" ON "rent_tax_item" USING btree ("company_id","payment_id","lease_id") WHERE "rent_tax_item"."kind" = 'receipt';--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_reversal" ON "rent_tax_item" USING btree ("company_id","reverses_item_id") WHERE "rent_tax_item"."kind" = 'reversal';--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_withholding" ON "rent_tax_item" USING btree ("company_id","withholding_id") WHERE "rent_tax_item"."kind" = 'withholding';--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_offset" ON "rent_tax_item" USING btree ("company_id","withholding_id","reverses_item_id") WHERE "rent_tax_item"."kind" = 'withholding_offset';--> statement-breakpoint
CREATE INDEX "rent_tax_item_owner_idx" ON "rent_tax_item" USING btree ("company_id","owner_id","accounting_date");--> statement-breakpoint
CREATE INDEX "rent_tax_item_payment_idx" ON "rent_tax_item" USING btree ("company_id","payment_id");--> statement-breakpoint
CREATE INDEX "rent_tax_item_due_idx" ON "rent_tax_item" USING btree ("company_id","due_date");--> statement-breakpoint
CREATE INDEX "rent_tax_item_line_lease_idx" ON "rent_tax_item_line" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "vat_payment_owner_idx" ON "vat_payment" USING btree ("company_id","owner_id","period_month");--> statement-breakpoint
CREATE INDEX "withholding_lease_idx" ON "withholding" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_certificate_one_live" ON "withholding_certificate" USING btree ("company_id","withholding_id") WHERE "withholding_certificate"."status" in ('awaiting_confirmation', 'confirmed');--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_record_check" CHECK ("allocation"."record_type" in ('payment', 'match', 'accrual', 'reversal', 'credit_note', 'write_off', 'withholding', 'termination'));