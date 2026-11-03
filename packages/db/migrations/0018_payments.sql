CREATE TABLE "management_agreement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_agreement_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "management_agreement_destination_check" CHECK ("management_agreement"."destination" in ('owner_account', 'agency_client_account'))
);
--> statement-breakpoint
CREATE TABLE "payment_intent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"secure_link_id" uuid NOT NULL,
	"submission_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"method" text NOT NULL,
	"momo_network" text,
	"payer_phone_encrypted" "bytea",
	"payer_phone_index" text,
	"payer_phone_masked" text,
	"reference" text NOT NULL,
	"provider" text,
	"provider_reference" text,
	"settlement_account_id" uuid NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"checkout_url" text,
	"message" text,
	"failure_reason" text,
	"verified_amount_minor" bigint,
	"payment_id" uuid,
	"last_checked_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intent_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "payment_intent_submission_key" UNIQUE("company_id","secure_link_id","submission_id"),
	CONSTRAINT "payment_intent_amount_check" CHECK ("payment_intent"."amount_minor" > 0),
	CONSTRAINT "payment_intent_currency_check" CHECK ("payment_intent"."currency" = 'GHS'),
	CONSTRAINT "payment_intent_method_check" CHECK ("payment_intent"."method" in ('momo', 'card')),
	CONSTRAINT "payment_intent_momo_check" CHECK (("payment_intent"."method" = 'momo') = ("payment_intent"."momo_network" is not null) and ("payment_intent"."method" = 'momo') = ("payment_intent"."payer_phone_encrypted" is not null)),
	CONSTRAINT "payment_intent_momo_network_check" CHECK ("payment_intent"."momo_network" is null or "payment_intent"."momo_network" in ('mtn', 'telecel', 'at')),
	CONSTRAINT "payment_intent_status_check" CHECK ("payment_intent"."status" in ('initiated', 'pending', 'confirmed', 'failed', 'abandoned')),
	CONSTRAINT "payment_intent_confirmed_check" CHECK (("payment_intent"."status" = 'confirmed') = ("payment_intent"."payment_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_settlement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"settlement_ref" text NOT NULL,
	"settlement_account_id" uuid NOT NULL,
	"subaccount_code" text NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"gross_minor" bigint NOT NULL,
	"fees_minor" bigint NOT NULL,
	"deductions_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_settlement_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "provider_settlement_ref_key" UNIQUE("company_id","provider","settlement_ref"),
	CONSTRAINT "provider_settlement_currency_check" CHECK ("provider_settlement"."currency" = 'GHS'),
	CONSTRAINT "provider_settlement_amounts_check" CHECK ("provider_settlement"."gross_minor" >= 0 and "provider_settlement"."fees_minor" >= 0 and "provider_settlement"."deductions_minor" >= 0 and "provider_settlement"."net_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_subaccount" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"settlement_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subaccount_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_subaccount_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "provider_subaccount_account_key" UNIQUE("company_id","settlement_account_id","provider")
);
--> statement-breakpoint
CREATE TABLE "receipt_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"channel" text,
	"sent_at" timestamp with time zone,
	"latency_ms" integer,
	"late_alerted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_delivery_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "receipt_delivery_receipt_key" UNIQUE("company_id","receipt_id"),
	CONSTRAINT "receipt_delivery_status_check" CHECK ("receipt_delivery"."status" in ('queued', 'sent', 'not_sent', 'failed')),
	CONSTRAINT "receipt_delivery_latency_check" CHECK ("receipt_delivery"."latency_ms" is null or "receipt_delivery"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_exception" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"reference" text,
	"settlement_ref" text,
	"payment_id" uuid,
	"property_id" uuid,
	"owner_id" uuid,
	"detail" text NOT NULL,
	"amount_minor" bigint,
	"dedupe_key" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_exception_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "reconciliation_exception_key" UNIQUE("company_id","dedupe_key"),
	CONSTRAINT "reconciliation_exception_kind_check" CHECK ("reconciliation_exception"."kind" in ('missing_here', 'missing_at_provider', 'amount_differs', 'not_successful_at_provider', 'settlement_difference', 'verified_amount_differs', 'receipt_late')),
	CONSTRAINT "reconciliation_exception_resolved_check" CHECK (("reconciliation_exception"."resolved_at" is null) = ("reconciliation_exception"."resolution_note" is null))
);
--> statement-breakpoint
CREATE TABLE "reminder_sent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"status" text NOT NULL,
	"message_id" uuid,
	"step_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_sent_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "reminder_sent_step_key" UNIQUE("company_id","invoice_id","offset_days"),
	CONSTRAINT "reminder_sent_status_check" CHECK ("reminder_sent"."status" in ('sent', 'skipped')),
	CONSTRAINT "reminder_sent_message_check" CHECK (("reminder_sent"."status" = 'sent') = ("reminder_sent"."message_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "settlement_account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"holder" text NOT NULL,
	"owner_id" uuid,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"branch" text,
	"account_name" text NOT NULL,
	"account_name_checked" text,
	"number_encrypted" "bytea" NOT NULL,
	"number_index" text NOT NULL,
	"number_masked" text NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"approval_request_id" uuid,
	"approved_at" timestamp with time zone,
	"usable_from" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"retire_request_id" uuid,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_account_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "settlement_account_holder_check" CHECK ("settlement_account"."holder" in ('owner', 'agency')),
	CONSTRAINT "settlement_account_owner_check" CHECK (("settlement_account"."holder" = 'owner') = ("settlement_account"."owner_id" is not null)),
	CONSTRAINT "settlement_account_status_check" CHECK ("settlement_account"."status" in ('awaiting_approval', 'cooling_off', 'active', 'rejected', 'retired')),
	CONSTRAINT "settlement_account_usable_check" CHECK ("settlement_account"."status" in ('awaiting_approval', 'rejected') or ("settlement_account"."approved_at" is not null and "settlement_account"."usable_from" is not null))
);
--> statement-breakpoint
CREATE TABLE "unmatched_refund" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"owner_id" uuid,
	"amount_minor" bigint NOT NULL,
	"reason" text NOT NULL,
	"proof_document_id" uuid,
	"approval_request_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"provider_refund_ref" text,
	"failure_reason" text,
	"entry_id" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmatched_refund_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "unmatched_refund_amount_check" CHECK ("unmatched_refund"."amount_minor" > 0),
	CONSTRAINT "unmatched_refund_status_check" CHECK ("unmatched_refund"."status" in ('awaiting_approval', 'approved', 'refunded', 'failed', 'rejected')),
	CONSTRAINT "unmatched_refund_posted_check" CHECK (("unmatched_refund"."status" = 'refunded') = ("unmatched_refund"."entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text,
	"reference" text,
	"raw_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_inbox_status_check" CHECK ("webhook_inbox"."status" in ('received', 'rejected', 'processed', 'ignored', 'failed')),
	CONSTRAINT "webhook_inbox_rejected_check" CHECK ("webhook_inbox"."signature_valid" or "webhook_inbox"."status" = 'rejected')
);
--> statement-breakpoint
ALTER TABLE "lease" DROP CONSTRAINT "lease_cycle_check";--> statement-breakpoint
ALTER TABLE "secure_link" DROP CONSTRAINT "secure_link_purpose_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_recipient_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_purpose_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_link_check";--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "payment_source_type_check";--> statement-breakpoint
ALTER TABLE "payment_reversal" DROP CONSTRAINT "payment_reversal_reason_check";--> statement-breakpoint
ALTER TABLE "payment_reversal" ALTER COLUMN "approval_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "settlement_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "payer_phone_index" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "payer_phone_masked" text;--> statement-breakpoint
ALTER TABLE "management_agreement" ADD CONSTRAINT "management_agreement_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_agreement" ADD CONSTRAINT "management_agreement_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_agreement" ADD CONSTRAINT "management_agreement_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoice"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_link_fk" FOREIGN KEY ("company_id","property_id","secure_link_id") REFERENCES "public"."secure_link"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_account_fk" FOREIGN KEY ("company_id","settlement_account_id") REFERENCES "public"."settlement_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_settlement" ADD CONSTRAINT "provider_settlement_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_settlement" ADD CONSTRAINT "provider_settlement_account_fk" FOREIGN KEY ("company_id","settlement_account_id") REFERENCES "public"."settlement_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subaccount" ADD CONSTRAINT "provider_subaccount_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subaccount" ADD CONSTRAINT "provider_subaccount_account_fk" FOREIGN KEY ("company_id","settlement_account_id") REFERENCES "public"."settlement_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_receipt_fk" FOREIGN KEY ("company_id","receipt_id") REFERENCES "public"."receipt"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_resolved_by_person_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sent" ADD CONSTRAINT "reminder_sent_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sent" ADD CONSTRAINT "reminder_sent_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sent" ADD CONSTRAINT "reminder_sent_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoice"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_retire_fk" FOREIGN KEY ("company_id","retire_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_refund" ADD CONSTRAINT "unmatched_refund_proof_fk" FOREIGN KEY ("company_id","proof_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "management_agreement_owner_idx" ON "management_agreement" USING btree ("company_id","owner_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_reference_key" ON "payment_intent" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payment_intent_link_idx" ON "payment_intent" USING btree ("company_id","secure_link_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_intent_status_idx" ON "payment_intent" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "payment_intent_lease_idx" ON "payment_intent" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_subaccount_code_key" ON "provider_subaccount" USING btree ("provider","subaccount_code");--> statement-breakpoint
CREATE INDEX "reconciliation_exception_open_idx" ON "reconciliation_exception" USING btree ("company_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "settlement_account_owner_idx" ON "settlement_account" USING btree ("company_id","owner_id");--> statement-breakpoint
CREATE INDEX "settlement_account_number_idx" ON "settlement_account" USING btree ("company_id","number_index");--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_refund_one_live" ON "unmatched_refund" USING btree ("company_id","payment_id") WHERE "unmatched_refund"."status" in ('awaiting_approval', 'approved', 'refunded');--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_event_key" ON "webhook_inbox" USING btree ("provider","event_id") WHERE "webhook_inbox"."signature_valid";--> statement-breakpoint
CREATE INDEX "webhook_inbox_unpublished_idx" ON "webhook_inbox" USING btree ("received_at") WHERE "webhook_inbox"."published_at" is null and "webhook_inbox"."signature_valid";--> statement-breakpoint
CREATE INDEX "secure_link_invoice_idx" ON "secure_link" USING btree ("company_id","invoice_id") WHERE "secure_link"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_reference_key" ON "payment" USING btree ("provider","provider_reference") WHERE "payment"."provider_reference" is not null;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_cycle_check" CHECK ("lease"."rent_cycle" in ('monthly', 'quarterly', 'six_monthly', 'annual', 'two_yearly'));--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_pay_check" CHECK (("secure_link"."purpose" = 'pay') = ("secure_link"."invoice_id" is not null) and ("secure_link"."purpose" = 'receipt') = ("secure_link"."receipt_id" is not null));--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_purpose_check" CHECK ("secure_link"."purpose" in ('sign', 'signed_copy', 'pay', 'receipt', 'job_sheet'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_recipient_check" CHECK ("message"."recipient_type" in ('tenant', 'tenant_contact', 'staff', 'signer', 'owner') and ("message"."recipient_type" <> 'tenant' or "message"."tenant_id" is not null) and ("message"."recipient_type" <> 'tenant_contact' or "message"."tenant_contact_id" is not null) and ("message"."recipient_type" <> 'staff' or "message"."staff_person_id" is not null) and ("message"."recipient_type" <> 'signer' or "message"."signer_id" is not null) and ("message"."recipient_type" <> 'owner' or "message"."owner_id" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_link_check" CHECK (("message"."link_purpose" is null or "message"."link_purpose" in ('sign', 'signed_copy', 'id_capture', 'pay', 'receipt')) and ("message"."link_purpose" is null) = ("message"."link_target_id" is null));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_source_type_check" CHECK ("payment"."source_type" in ('cash_record', 'direct_receipt', 'provider_test', 'payment_intent', 'provider_charge'));--> statement-breakpoint
ALTER TABLE "payment_reversal" ADD CONSTRAINT "payment_reversal_approval_check" CHECK (("payment_reversal"."approval_request_id" is null) = ("payment_reversal"."reason" in ('chargeback', 'provider_refund')));--> statement-breakpoint
ALTER TABLE "payment_reversal" ADD CONSTRAINT "payment_reversal_reason_check" CHECK ("payment_reversal"."reason" in ('bounced_cheque', 'wrong_entry', 'wrong_lease', 'other', 'chargeback', 'provider_refund'));