CREATE TABLE "charge_period" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"charge_type" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"prorated" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'schedule' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_period_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "charge_period_sequence_key" UNIQUE("company_id","lease_id","charge_type","sequence"),
	CONSTRAINT "charge_period_type_check" CHECK ("charge_period"."charge_type" in ('rent', 'service_charge')),
	CONSTRAINT "charge_period_dates_check" CHECK ("charge_period"."period_end" >= "charge_period"."period_start"),
	CONSTRAINT "charge_period_amount_check" CHECK ("charge_period"."amount_minor" > 0),
	CONSTRAINT "charge_period_sequence_check" CHECK ("charge_period"."sequence" >= 0),
	CONSTRAINT "charge_period_source_check" CHECK ("charge_period"."source" in ('schedule', 'holding_over')),
	CONSTRAINT "charge_period_currency_check" CHECK ("charge_period"."currency" = 'GHS')
);
--> statement-breakpoint
CREATE TABLE "consent_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_contact_id" uuid,
	"channel" text NOT NULL,
	"action" text NOT NULL,
	"text_version" text NOT NULL,
	"text_sha256" text NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "consent_event_channel_check" CHECK ("consent_event"."channel" in ('sms', 'email', 'whatsapp', 'push')),
	CONSTRAINT "consent_event_action_check" CHECK ("consent_event"."action" in ('grant', 'withdraw')),
	CONSTRAINT "consent_event_source_check" CHECK ("consent_event"."source" in ('staff', 'reply', 'stop', 'tenant_app')),
	CONSTRAINT "consent_event_sha_check" CHECK ("consent_event"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "id_check" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"id_type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_check_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_result" text,
	"polls" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "id_check_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "id_check_type_check" CHECK ("id_check"."id_type" in ('ghana_card', 'passport')),
	CONSTRAINT "id_check_status_check" CHECK ("id_check"."status" in ('pending', 'verified', 'not_matched', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"use" text NOT NULL,
	"template_version_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"monthly_rent_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"rent_cycle" text NOT NULL,
	"initial_advance_months" integer,
	"deposit_minor" bigint,
	"notice_days" integer NOT NULL,
	"break_from_date" date,
	"break_party" text,
	"break_notice_days" integer,
	"break_credit_unused_days" boolean,
	"service_phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"service_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"witness_required" boolean DEFAULT true NOT NULL,
	"renews_lease_id" uuid,
	"advance_months_demanded" integer,
	"advance_rule" text,
	"advance_limit_months" integer,
	"advance_exceeds_limit" boolean,
	"advance_rule_id" uuid,
	"advance_policy" text,
	"advance_flagged" boolean DEFAULT false NOT NULL,
	"advance_checked_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signing_method" text,
	"signed_document_id" uuid,
	"activated_on" date,
	"holding_over_since" date,
	"ending_reason" text,
	"ending_note" text,
	"ending_recorded_at" timestamp with time zone,
	"move_out_date" date,
	"end_reason" text,
	"ended_on" date,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"rent_control_applies" boolean,
	"rent_control_deadline" date,
	"rent_control_rule_id" uuid,
	"rent_control_number" text,
	"rent_control_registered_on" date,
	"stamp_deadline" date,
	"stamp_rule_id" uuid,
	"stamped_on" date,
	"stamped_document_id" uuid,
	"formal_required" boolean,
	"formal_rule_id" uuid,
	"formal_practitioner" text,
	"formal_wet_signed_document_id" uuid,
	"formal_registered_on" date,
	"formal_registration_number" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "lease_scope_key" UNIQUE("company_id","property_id","tenant_id","id"),
	CONSTRAINT "lease_status_check" CHECK ("lease"."status" in ('draft', 'pending_signatures', 'signed', 'active', 'ending', 'holding_over', 'ended', 'terminated', 'cancelled')),
	CONSTRAINT "lease_use_check" CHECK ("lease"."use" in ('residential', 'commercial')),
	CONSTRAINT "lease_cycle_check" CHECK ("lease"."rent_cycle" in ('monthly', 'quarterly', 'six_monthly', 'annual')),
	CONSTRAINT "lease_dates_check" CHECK ("lease"."end_date" > "lease"."start_date"),
	CONSTRAINT "lease_rent_check" CHECK ("lease"."monthly_rent_minor" > 0),
	CONSTRAINT "lease_deposit_check" CHECK ("lease"."deposit_minor" is null or "lease"."deposit_minor" > 0),
	CONSTRAINT "lease_notice_check" CHECK ("lease"."notice_days" between 0 and 3650),
	CONSTRAINT "lease_advance_months_check" CHECK ("lease"."initial_advance_months" is null or "lease"."initial_advance_months" >= 1),
	CONSTRAINT "lease_break_check" CHECK (("lease"."break_from_date" is null) = ("lease"."break_party" is null) and ("lease"."break_from_date" is null) = ("lease"."break_notice_days" is null) and ("lease"."break_from_date" is null) = ("lease"."break_credit_unused_days" is null) and ("lease"."break_party" is null or "lease"."break_party" in ('tenant', 'landlord', 'either'))),
	CONSTRAINT "lease_advance_rule_check" CHECK ("lease"."advance_rule" is null or "lease"."advance_rule" in ('monthly_or_shorter', 'over_six_months')),
	CONSTRAINT "lease_advance_policy_check" CHECK ("lease"."advance_policy" is null or "lease"."advance_policy" in ('off', 'warn', 'block')),
	CONSTRAINT "lease_signing_method_check" CHECK ("lease"."signing_method" is null or "lease"."signing_method" in ('esign', 'paper')),
	CONSTRAINT "lease_ending_reason_check" CHECK ("lease"."ending_reason" is null or "lease"."ending_reason" in ('non_renewal', 'notice')),
	CONSTRAINT "lease_end_reason_check" CHECK ("lease"."end_reason" is null or "lease"."end_reason" in ('moved_out', 'renewed')),
	CONSTRAINT "lease_currency_check" CHECK ("lease"."currency" = 'GHS')
);
--> statement-breakpoint
CREATE TABLE "lease_charge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"charge_type" text NOT NULL,
	"monthly_amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_charge_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "lease_charge_type_key" UNIQUE("company_id","lease_id","charge_type"),
	CONSTRAINT "lease_charge_type_check" CHECK ("lease_charge"."charge_type" in ('service_charge')),
	CONSTRAINT "lease_charge_amount_check" CHECK ("lease_charge"."monthly_amount_minor" > 0),
	CONSTRAINT "lease_charge_currency_check" CHECK ("lease_charge"."currency" = 'GHS')
);
--> statement-breakpoint
CREATE TABLE "lease_party" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"party_role" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"tenant_contact_id" uuid,
	"staff_person_id" uuid,
	"required" boolean DEFAULT true NOT NULL,
	"position" smallint NOT NULL,
	"paper_signed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_party_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "lease_party_position_key" UNIQUE("company_id","lease_id","position"),
	CONSTRAINT "lease_party_role_check" CHECK ("lease_party"."party_role" in ('tenant', 'signatory', 'landlord', 'guarantor', 'witness')),
	CONSTRAINT "lease_party_position_check" CHECK ("lease_party"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "lease_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"starter_kind" text,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_template_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "lease_template_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "lease_template_kind_check" CHECK ("lease_template"."kind" in ('residential', 'commercial', 'short_fixed_term', 'custom')),
	CONSTRAINT "lease_template_starter_check" CHECK ("lease_template"."starter_kind" is null or "lease_template"."starter_kind" in ('residential', 'commercial', 'short_fixed_term'))
);
--> statement-breakpoint
CREATE TABLE "lease_template_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"change_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counsel_reviewed_at" timestamp with time zone,
	"counsel_reviewed_by" uuid,
	"counsel_review_note" text,
	CONSTRAINT "lease_template_version_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "lease_template_version_number_key" UNIQUE("company_id","template_id","version"),
	CONSTRAINT "lease_template_version_number_check" CHECK ("lease_template_version"."version" >= 1),
	CONSTRAINT "lease_template_version_sha_check" CHECK ("lease_template_version"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lease_template_version_review_check" CHECK (("lease_template_version"."counsel_reviewed_at" is null) = ("lease_template_version"."counsel_reviewed_by" is null) and ("lease_template_version"."counsel_reviewed_at" is null) = ("lease_template_version"."counsel_review_note" is null))
);
--> statement-breakpoint
CREATE TABLE "rent_step" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"monthly_rent_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_step_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_step_date_key" UNIQUE("company_id","lease_id","effective_from"),
	CONSTRAINT "rent_step_rent_check" CHECK ("rent_step"."monthly_rent_minor" > 0),
	CONSTRAINT "rent_step_currency_check" CHECK ("rent_step"."currency" = 'GHS')
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"phone" text,
	"whatsapp_phone" text,
	"email" text,
	"occupation" text,
	"business_type" text,
	"registration_number" text,
	"tin_encrypted" "bytea",
	"tin_index" text,
	"tin_masked" text,
	"id_type" text,
	"id_number_encrypted" "bytea",
	"id_number_index" text,
	"id_number_masked" text,
	"id_status" text DEFAULT 'none' NOT NULL,
	"id_verified_at" timestamp with time zone,
	"person_id" uuid,
	"notes" text,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "tenant_kind_check" CHECK ("tenant"."kind" in ('individual', 'company')),
	CONSTRAINT "tenant_id_type_check" CHECK ("tenant"."id_type" is null or ("tenant"."id_type" in ('ghana_card', 'passport') and "tenant"."kind" = 'individual')),
	CONSTRAINT "tenant_id_status_check" CHECK ("tenant"."id_status" in ('none', 'not_started', 'pending', 'verified', 'not_matched', 'recorded') and ("tenant"."id_type" is null) = ("tenant"."id_status" = 'none')),
	CONSTRAINT "tenant_id_number_check" CHECK (("tenant"."id_type" is null) = ("tenant"."id_number_encrypted" is null) and ("tenant"."id_number_encrypted" is null) = ("tenant"."id_number_index" is null) and ("tenant"."id_number_encrypted" is null) = ("tenant"."id_number_masked" is null)),
	CONSTRAINT "tenant_tin_check" CHECK (("tenant"."tin_encrypted" is null) = ("tenant"."tin_index" is null) and ("tenant"."tin_encrypted" is null) = ("tenant"."tin_masked" is null) and ("tenant"."tin_encrypted" is null or "tenant"."kind" = 'company')),
	CONSTRAINT "tenant_person_check" CHECK ("tenant"."kind" = 'individual' or "tenant"."person_id" is null),
	CONSTRAINT "tenant_company_fields_check" CHECK ("tenant"."kind" = 'company' or ("tenant"."registration_number" is null and "tenant"."business_type" is null and "tenant"."legal_name" is null))
);
--> statement-breakpoint
CREATE TABLE "tenant_contact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"relationship" text,
	"organisation" text,
	"position" text,
	"notes" text,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_contact_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "tenant_contact_tenant_key" UNIQUE("company_id","tenant_id","id"),
	CONSTRAINT "tenant_contact_kind_check" CHECK ("tenant_contact"."kind" in ('guarantor', 'next_of_kin', 'employer', 'signatory', 'finance'))
);
--> statement-breakpoint
CREATE TABLE "otp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"signer_id" uuid NOT NULL,
	"secure_link_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"destination_masked" text NOT NULL,
	"destination_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "otp_challenge_channel_check" CHECK ("otp_challenge"."channel" in ('sms', 'email')),
	CONSTRAINT "otp_challenge_attempts_check" CHECK ("otp_challenge"."attempts" between 0 and "otp_challenge"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "secure_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"signer_id" uuid,
	"message_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_link_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "secure_link_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "secure_link_purpose_check" CHECK ("secure_link"."purpose" in ('sign', 'pay', 'job_sheet')),
	CONSTRAINT "secure_link_signer_check" CHECK ("secure_link"."purpose" <> 'sign' or "secure_link"."signer_id" is not null),
	CONSTRAINT "secure_link_token_check" CHECK ("secure_link"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "secure_link_revoke_check" CHECK (("secure_link"."revoked_at" is null) = ("secure_link"."revoke_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "signature" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"signing_request_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"method" text NOT NULL,
	"typed_name" text,
	"drawing_document_id" uuid,
	"consent_version" text NOT NULL,
	"consent_sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_channel" text NOT NULL,
	"verified_destination_masked" text NOT NULL,
	"ip_address" text NOT NULL,
	"user_agent" text NOT NULL,
	"document_sha256" text NOT NULL,
	"otp_challenge_id" uuid,
	CONSTRAINT "signature_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "signature_one_per_signer" UNIQUE("company_id","signer_id"),
	CONSTRAINT "signature_method_check" CHECK ("signature"."method" in ('typed', 'drawn')),
	CONSTRAINT "signature_method_fields_check" CHECK (("signature"."method" = 'typed' and "signature"."typed_name" is not null) or ("signature"."method" = 'drawn' and "signature"."drawing_document_id" is not null)),
	CONSTRAINT "signature_channel_check" CHECK ("signature"."verified_channel" in ('sms', 'email')),
	CONSTRAINT "signature_document_sha_check" CHECK ("signature"."document_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signature_consent_sha_check" CHECK ("signature"."consent_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "signer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"signing_request_id" uuid NOT NULL,
	"lease_party_id" uuid,
	"signer_role" text NOT NULL,
	"subject_type" text NOT NULL,
	"tenant_contact_id" uuid,
	"staff_person_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"required" boolean DEFAULT true NOT NULL,
	"position" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"failed_code_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signer_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "signer_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "signer_position_key" UNIQUE("company_id","signing_request_id","position"),
	CONSTRAINT "signer_role_check" CHECK ("signer"."signer_role" in ('tenant', 'signatory', 'landlord', 'guarantor', 'witness')),
	CONSTRAINT "signer_subject_check" CHECK ("signer"."subject_type" in ('tenant', 'tenant_contact', 'staff', 'other') and ("signer"."subject_type" <> 'tenant_contact' or "signer"."tenant_contact_id" is not null) and ("signer"."subject_type" <> 'staff' or "signer"."staff_person_id" is not null) and ("signer"."subject_type" <> 'tenant' or "signer"."tenant_id" is not null)),
	CONSTRAINT "signer_status_check" CHECK ("signer"."status" in ('pending', 'signed', 'declined')),
	CONSTRAINT "signer_contact_check" CHECK ("signer"."phone" is not null or "signer"."email" is not null),
	CONSTRAINT "signer_position_check" CHECK ("signer"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "signing_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"signing_request_id" uuid NOT NULL,
	"signer_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb,
	"ip_address" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "signing_event_kind_check" CHECK ("signing_event"."kind" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$')
);
--> statement-breakpoint
CREATE TABLE "signing_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid,
	"subject_type" text NOT NULL,
	"lease_id" uuid,
	"status" text DEFAULT 'preparing' NOT NULL,
	"render_request_id" uuid,
	"document_id" uuid,
	"document_sha256" text,
	"html_document_id" uuid,
	"html_sha256" text,
	"final_document_id" uuid,
	"final_sha256" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "signing_request_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "signing_request_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "signing_request_subject_check" CHECK ("signing_request"."subject_type" in ('lease')),
	CONSTRAINT "signing_request_lease_check" CHECK ("signing_request"."subject_type" <> 'lease' or ("signing_request"."lease_id" is not null and "signing_request"."tenant_id" is not null)),
	CONSTRAINT "signing_request_status_check" CHECK ("signing_request"."status" in ('preparing', 'pending', 'completed', 'declined', 'cancelled')),
	CONSTRAINT "signing_request_document_check" CHECK ("signing_request"."status" in ('preparing', 'cancelled') or ("signing_request"."document_id" is not null and "signing_request"."document_sha256" is not null)),
	CONSTRAINT "signing_request_final_check" CHECK ("signing_request"."status" <> 'completed' or ("signing_request"."final_document_id" is not null and "signing_request"."final_sha256" is not null and "signing_request"."completed_at" is not null)),
	CONSTRAINT "signing_request_document_sha_check" CHECK ("signing_request"."document_sha256" is null or "signing_request"."document_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signing_request_html_sha_check" CHECK ("signing_request"."html_sha256" is null or "signing_request"."html_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signing_request_final_sha_check" CHECK ("signing_request"."final_sha256" is null or "signing_request"."final_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid,
	"tenant_id" uuid,
	"recipient_type" text NOT NULL,
	"tenant_contact_id" uuid,
	"staff_person_id" uuid,
	"signer_id" uuid,
	"purpose" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"link_purpose" text,
	"link_target_id" uuid,
	"channels" text[] NOT NULL,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"related_type" text,
	"related_id" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "message_recipient_check" CHECK ("message"."recipient_type" in ('tenant', 'tenant_contact', 'staff', 'signer') and ("message"."recipient_type" <> 'tenant' or "message"."tenant_id" is not null) and ("message"."recipient_type" <> 'tenant_contact' or "message"."tenant_contact_id" is not null) and ("message"."recipient_type" <> 'staff' or "message"."staff_person_id" is not null) and ("message"."recipient_type" <> 'signer' or "message"."signer_id" is not null)),
	CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice')),
	CONSTRAINT "message_link_check" CHECK (("message"."link_purpose" is null or "message"."link_purpose" in ('sign', 'id_capture')) and ("message"."link_purpose" is null) = ("message"."link_target_id" is null)),
	CONSTRAINT "message_channels_check" CHECK (cardinality("message"."channels") >= 1 and "message"."channels" <@ array['sms', 'email']::text[])
);
--> statement-breakpoint
CREATE TABLE "message_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text NOT NULL,
	"channel" text,
	"provider" text,
	"provider_message_id" text,
	"cost_minor" bigint,
	"currency" char(3),
	"destination_masked" text,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "message_event_status_check" CHECK ("message_event"."status" in ('queued', 'sent', 'delivered', 'failed', 'not_sent')),
	CONSTRAINT "message_event_channel_check" CHECK ("message_event"."channel" is null or "message_event"."channel" in ('sms', 'email')),
	CONSTRAINT "message_event_sent_check" CHECK ("message_event"."status" <> 'sent' or ("message_event"."channel" is not null and "message_event"."provider" is not null and "message_event"."provider_message_id" is not null)),
	CONSTRAINT "message_event_cost_check" CHECK (("message_event"."cost_minor" is null) = ("message_event"."currency" is null) and ("message_event"."cost_minor" is null or "message_event"."cost_minor" >= 0))
);
--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "letting_business" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "vat_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "tin_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "tin_index" text;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "tin_masked" text;--> statement-breakpoint
ALTER TABLE "charge_period" ADD CONSTRAINT "charge_period_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_period" ADD CONSTRAINT "charge_period_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "id_check" ADD CONSTRAINT "id_check_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "id_check" ADD CONSTRAINT "id_check_started_by_person_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "id_check" ADD CONSTRAINT "id_check_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_advance_rule_id_rule_id_fk" FOREIGN KEY ("advance_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_rent_control_rule_id_rule_id_fk" FOREIGN KEY ("rent_control_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_stamp_rule_id_rule_id_fk" FOREIGN KEY ("stamp_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_formal_rule_id_rule_id_fk" FOREIGN KEY ("formal_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_template_version_fk" FOREIGN KEY ("company_id","template_version_id") REFERENCES "public"."lease_template_version"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_renews_fk" FOREIGN KEY ("company_id","renews_lease_id") REFERENCES "public"."lease"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_signed_document_fk" FOREIGN KEY ("company_id","signed_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_stamped_document_fk" FOREIGN KEY ("company_id","stamped_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_formal_document_fk" FOREIGN KEY ("company_id","formal_wet_signed_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_charge" ADD CONSTRAINT "lease_charge_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_charge" ADD CONSTRAINT "lease_charge_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_party" ADD CONSTRAINT "lease_party_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_party" ADD CONSTRAINT "lease_party_staff_person_id_person_id_fk" FOREIGN KEY ("staff_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_party" ADD CONSTRAINT "lease_party_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_party" ADD CONSTRAINT "lease_party_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template" ADD CONSTRAINT "lease_template_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template" ADD CONSTRAINT "lease_template_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template_version" ADD CONSTRAINT "lease_template_version_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template_version" ADD CONSTRAINT "lease_template_version_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template_version" ADD CONSTRAINT "lease_template_version_counsel_reviewed_by_person_id_fk" FOREIGN KEY ("counsel_reviewed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_template_version" ADD CONSTRAINT "lease_template_version_template_fk" FOREIGN KEY ("company_id","template_id") REFERENCES "public"."lease_template"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_step" ADD CONSTRAINT "rent_step_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_step" ADD CONSTRAINT "rent_step_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_contact" ADD CONSTRAINT "tenant_contact_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_contact" ADD CONSTRAINT "tenant_contact_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_signer_fk" FOREIGN KEY ("company_id","property_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_link_fk" FOREIGN KEY ("company_id","property_id","secure_link_id") REFERENCES "public"."secure_link"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_signer_fk" FOREIGN KEY ("company_id","property_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_request_fk" FOREIGN KEY ("company_id","property_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_signer_fk" FOREIGN KEY ("company_id","property_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_drawing_fk" FOREIGN KEY ("company_id","drawing_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_otp_fk" FOREIGN KEY ("company_id","otp_challenge_id") REFERENCES "public"."otp_challenge"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_staff_person_id_person_id_fk" FOREIGN KEY ("staff_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_request_fk" FOREIGN KEY ("company_id","property_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_lease_party_fk" FOREIGN KEY ("company_id","lease_party_id") REFERENCES "public"."lease_party"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer" ADD CONSTRAINT "signer_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_event" ADD CONSTRAINT "signing_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_event" ADD CONSTRAINT "signing_event_request_fk" FOREIGN KEY ("company_id","property_id","signing_request_id") REFERENCES "public"."signing_request"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_event" ADD CONSTRAINT "signing_event_signer_fk" FOREIGN KEY ("company_id","property_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_html_fk" FOREIGN KEY ("company_id","html_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_final_fk" FOREIGN KEY ("company_id","final_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_staff_person_id_person_id_fk" FOREIGN KEY ("staff_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_requested_by_person_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_signer_fk" FOREIGN KEY ("company_id","signer_id") REFERENCES "public"."signer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_event" ADD CONSTRAINT "message_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_event" ADD CONSTRAINT "message_event_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_period_lease_idx" ON "charge_period" USING btree ("company_id","lease_id","period_start");--> statement-breakpoint
CREATE INDEX "consent_event_subject_idx" ON "consent_event" USING btree ("company_id","tenant_id","tenant_contact_id","channel","recorded_at");--> statement-breakpoint
CREATE INDEX "id_check_tenant_idx" ON "id_check" USING btree ("company_id","tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "id_check_one_open" ON "id_check" USING btree ("company_id","tenant_id") WHERE "id_check"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "lease_unit_idx" ON "lease" USING btree ("company_id","unit_id","status");--> statement-breakpoint
CREATE INDEX "lease_tenant_idx" ON "lease" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE INDEX "lease_property_idx" ON "lease" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "lease_status_end_idx" ON "lease" USING btree ("company_id","status","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_one_renewal" ON "lease" USING btree ("company_id","renews_lease_id") WHERE "lease"."renews_lease_id" is not null and "lease"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "lease_party_lease_idx" ON "lease_party" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_template_one_starter" ON "lease_template" USING btree ("company_id","starter_kind") WHERE "lease_template"."starter_kind" is not null;--> statement-breakpoint
CREATE INDEX "tenant_name_idx" ON "tenant" USING btree ("company_id","display_name");--> statement-breakpoint
CREATE INDEX "tenant_phone_idx" ON "tenant" USING btree ("company_id","phone");--> statement-breakpoint
CREATE INDEX "tenant_id_number_idx" ON "tenant" USING btree ("company_id","id_number_index");--> statement-breakpoint
CREATE INDEX "tenant_tin_idx" ON "tenant" USING btree ("company_id","tin_index");--> statement-breakpoint
CREATE INDEX "tenant_person_idx" ON "tenant" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tenant_contact_tenant_idx" ON "tenant_contact" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE INDEX "otp_challenge_link_idx" ON "otp_challenge" USING btree ("company_id","secure_link_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenge_destination_idx" ON "otp_challenge" USING btree ("company_id","destination_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secure_link_token_hash_key" ON "secure_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "secure_link_signer_idx" ON "secure_link" USING btree ("company_id","signer_id");--> statement-breakpoint
CREATE INDEX "signer_request_idx" ON "signer" USING btree ("company_id","signing_request_id");--> statement-breakpoint
CREATE INDEX "signing_event_request_idx" ON "signing_event" USING btree ("company_id","signing_request_id","occurred_at");--> statement-breakpoint
CREATE INDEX "signing_request_lease_idx" ON "signing_request" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_request_one_open" ON "signing_request" USING btree ("company_id","lease_id") WHERE "signing_request"."lease_id" is not null and "signing_request"."status" in ('preparing', 'pending');--> statement-breakpoint
CREATE INDEX "message_tenant_idx" ON "message" USING btree ("company_id","tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "message_related_idx" ON "message" USING btree ("company_id","related_type","related_id");--> statement-breakpoint
CREATE INDEX "message_event_message_idx" ON "message_event" USING btree ("company_id","message_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_event_provider_key" ON "message_event" USING btree ("provider","provider_message_id") WHERE "message_event"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "owner_tin_idx" ON "owner" USING btree ("company_id","tin_index");--> statement-breakpoint
ALTER TABLE "owner" ADD CONSTRAINT "owner_tin_check" CHECK (("owner"."tin_encrypted" is null) = ("owner"."tin_index" is null) and ("owner"."tin_encrypted" is null) = ("owner"."tin_masked" is null));