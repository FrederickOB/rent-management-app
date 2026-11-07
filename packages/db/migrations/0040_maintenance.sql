CREATE TABLE "artisan" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"trades" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artisan_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "artisan_phone_key" UNIQUE("company_id","phone"),
	CONSTRAINT "artisan_phone_check" CHECK ("artisan"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "artisan_name_check" CHECK (length("artisan"."name") between 2 and 120)
);
--> statement-breakpoint
CREATE TABLE "contact_consent_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"membership_id" uuid,
	"artisan_id" uuid,
	"channel" text NOT NULL,
	"action" text NOT NULL,
	"text_version" text NOT NULL,
	"text_sha256" text NOT NULL,
	"source" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consent_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "contact_consent_event_subject_check" CHECK (("contact_consent_event"."subject_type" = 'staff' and "contact_consent_event"."membership_id" is not null and "contact_consent_event"."artisan_id" is null) or ("contact_consent_event"."subject_type" = 'artisan' and "contact_consent_event"."artisan_id" is not null and "contact_consent_event"."membership_id" is null)),
	CONSTRAINT "contact_consent_event_channel_check" CHECK ("contact_consent_event"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "contact_consent_event_action_check" CHECK ("contact_consent_event"."action" in ('grant', 'withdraw')),
	CONSTRAINT "contact_consent_event_source_check" CHECK ("contact_consent_event"."source" in ('staff', 'self', 'stop_keyword')),
	CONSTRAINT "contact_consent_event_sha_check" CHECK ("contact_consent_event"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"category" text NOT NULL,
	"supplier_name" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'GHS' NOT NULL,
	"expense_date" date NOT NULL,
	"paid_by" text NOT NULL,
	"receipt_document_id" uuid,
	"job_id" uuid,
	"note" text,
	"entry_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "expense_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "expense_category_check" CHECK ("expense"."category" in ('repairs', 'rates', 'insurance', 'utilities', 'cleaning', 'security', 'legal', 'other')),
	CONSTRAINT "expense_paid_by_check" CHECK ("expense"."paid_by" in ('owner', 'agent', 'unpaid')),
	CONSTRAINT "expense_amount_check" CHECK ("expense"."amount_minor" > 0),
	CONSTRAINT "expense_currency_check" CHECK ("expense"."currency" = 'GHS'),
	CONSTRAINT "expense_supplier_check" CHECK (length("expense"."supplier_name") between 2 and 120),
	CONSTRAINT "expense_dates_check" CHECK ("expense"."accounting_date" >= "expense"."expense_date")
);
--> statement-breakpoint
CREATE TABLE "expense_payment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"paid_from" text NOT NULL,
	"reference" text,
	"entry_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_payment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "expense_payment_once" UNIQUE("company_id","expense_id"),
	CONSTRAINT "expense_payment_from_check" CHECK ("expense_payment"."paid_from" in ('owner_account', 'agency_account')),
	CONSTRAINT "expense_payment_dates_check" CHECK ("expense_payment"."accounting_date" >= "expense_payment"."paid_on")
);
--> statement-breakpoint
CREATE TABLE "expense_reversal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"payment_entry_id" uuid,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_reversal_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "expense_reversal_once" UNIQUE("company_id","expense_id"),
	CONSTRAINT "expense_reversal_reason_check" CHECK (length("expense_reversal"."reason") between 3 and 500),
	CONSTRAINT "expense_reversal_dates_check" CHECK ("expense_reversal"."accounting_date" >= "expense_reversal"."value_date")
);
--> statement-breakpoint
CREATE TABLE "inspection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"lease_id" uuid,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"unit_type" text NOT NULL,
	"performed_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"corrects_inspection_id" uuid,
	"move_in_inspection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "inspection_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "inspection_lease_key" UNIQUE("company_id","property_id","lease_id","id"),
	CONSTRAINT "inspection_kind_check" CHECK ("inspection"."kind" in ('routine', 'move_in', 'move_out')),
	CONSTRAINT "inspection_status_check" CHECK ("inspection"."status" in ('in_progress', 'submitted')),
	CONSTRAINT "inspection_lease_check" CHECK (("inspection"."kind" = 'routine' or "inspection"."lease_id" is not null) and ("inspection"."lease_id" is null or "inspection"."tenant_id" is not null) and ("inspection"."kind" = 'move_out' or "inspection"."move_in_inspection_id" is null)),
	CONSTRAINT "inspection_submitted_check" CHECK (("inspection"."status" = 'submitted') = ("inspection"."submitted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "inspection_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"room_key" text NOT NULL,
	"room_label" text NOT NULL,
	"item_key" text NOT NULL,
	"item_label" text NOT NULL,
	"condition" text,
	"note" text,
	"move_in_item_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_item_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "inspection_item_scope_key" UNIQUE("company_id","property_id","inspection_id","id"),
	CONSTRAINT "inspection_item_key" UNIQUE("company_id","inspection_id","room_key","item_key"),
	CONSTRAINT "inspection_item_condition_check" CHECK ("inspection_item"."condition" is null or "inspection_item"."condition" in ('good', 'fair', 'poor', 'damaged', 'missing', 'not_applicable')),
	CONSTRAINT "inspection_item_note_check" CHECK ("inspection_item"."note" is null or length("inspection_item"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "inspection_photo" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"added_by" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_photo_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "inspection_photo_document_key" UNIQUE("company_id","item_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "inspection_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_type" text NOT NULL,
	"rooms" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_template_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "inspection_template_unit_type_key" UNIQUE("company_id","unit_type"),
	CONSTRAINT "inspection_template_rooms_check" CHECK (jsonb_typeof("inspection_template"."rooms") = 'array')
);
--> statement-breakpoint
CREATE TABLE "job_sheet_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"artisan_id" uuid NOT NULL,
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
	CONSTRAINT "job_sheet_code_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "job_sheet_code_channel_check" CHECK ("job_sheet_code"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "job_sheet_code_attempts_check" CHECK ("job_sheet_code"."attempts" between 0 and "job_sheet_code"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "maintenance_job_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_person_id" uuid,
	"actor_artisan_id" uuid,
	"data" jsonb,
	"dedupe_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_job_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "maintenance_job_event_kind_check" CHECK ("maintenance_job_event"."kind" in ('reported', 'triaged', 'priority_changed', 'assigned', 'unassigned', 'accepted', 'declined', 'visit_planned', 'started', 'work_done', 'confirmed', 'disputed', 'closed', 'auto_closed', 'cancelled', 'note', 'media_added', 'alerted', 'sla_warned', 'tenant_updated', 'expense_linked')),
	CONSTRAINT "maintenance_job_event_actor_check" CHECK ("maintenance_job_event"."actor_kind" in ('staff', 'artisan', 'tenant', 'system') and ("maintenance_job_event"."actor_kind" <> 'artisan' or "maintenance_job_event"."actor_artisan_id" is not null) and ("maintenance_job_event"."actor_kind" = 'artisan' or "maintenance_job_event"."actor_artisan_id" is null))
);
--> statement-breakpoint
CREATE TABLE "deposit_application" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"move_out_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"amount_minor" bigint NOT NULL,
	"entry_id" uuid NOT NULL,
	"value_date" date NOT NULL,
	"accounting_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_application_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "deposit_application_once" UNIQUE NULLS NOT DISTINCT("company_id","move_out_id","kind","payment_id"),
	CONSTRAINT "deposit_application_kind_check" CHECK ("deposit_application"."kind" in ('applied', 'retained', 'refund')),
	CONSTRAINT "deposit_application_amount_check" CHECK ("deposit_application"."amount_minor" > 0),
	CONSTRAINT "deposit_application_dates_check" CHECK ("deposit_application"."accounting_date" >= "deposit_application"."value_date")
);
--> statement-breakpoint
CREATE TABLE "deposit_deduction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"move_out_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reason" text NOT NULL,
	"inspection_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"photo_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_deduction_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "deposit_deduction_move_out_key" UNIQUE("company_id","move_out_id","id"),
	CONSTRAINT "deposit_deduction_kind_check" CHECK ("deposit_deduction"."kind" in ('damage', 'cleaning', 'keys', 'missing_items', 'other')),
	CONSTRAINT "deposit_deduction_amount_check" CHECK ("deposit_deduction"."amount_minor" > 0),
	CONSTRAINT "deposit_deduction_reason_check" CHECK (length("deposit_deduction"."reason") between 3 and 500),
	CONSTRAINT "deposit_deduction_evidence_check" CHECK (cardinality("deposit_deduction"."inspection_item_ids") <= 50 and cardinality("deposit_deduction"."photo_ids") <= 50)
);
--> statement-breakpoint
CREATE TABLE "deposit_deduction_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"move_out_id" uuid NOT NULL,
	"deduction_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_deduction_withdrawal_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "deposit_deduction_withdrawal_once" UNIQUE("company_id","deduction_id")
);
--> statement-breakpoint
CREATE TABLE "move_out" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"kind" text DEFAULT 'move_out' NOT NULL,
	"reason" text,
	"planned_date" date NOT NULL,
	"early" boolean DEFAULT false NOT NULL,
	"notice_id" uuid,
	"note" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"prior_lease_status" text,
	"inspection_id" uuid,
	"move_in_inspection_id" uuid,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_request_id" uuid,
	"statement" jsonb,
	"approved_on" date,
	"approved_at" timestamp with time zone,
	"credit_refund_minor" bigint,
	"deposit_refund_minor" bigint,
	"refund_entry_id" uuid,
	"paid_on" date,
	"paid_from" text,
	"paid_reference" text,
	"proof_document_id" uuid,
	"paid_entry_id" uuid,
	"paid_by" uuid,
	"statement_document_id" uuid,
	"statement_sha256" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "move_out_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "move_out_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "move_out_lease_key" UNIQUE("company_id","lease_id","id"),
	CONSTRAINT "move_out_kind_check" CHECK ("move_out"."kind" in ('move_out', 'deposit_settlement')),
	CONSTRAINT "move_out_reason_check" CHECK (("move_out"."kind" = 'deposit_settlement') = ("move_out"."reason" is null) and ("move_out"."reason" is null or "move_out"."reason" in ('end_of_term', 'tenant_notice', 'landlord_notice', 'early_termination'))),
	CONSTRAINT "move_out_status_check" CHECK ("move_out"."status" in ('planned', 'inspected', 'settlement_drafted', 'awaiting_approval', 'approved', 'refund_paid', 'closed', 'cancelled')),
	CONSTRAINT "move_out_approved_check" CHECK (("move_out"."status" in ('approved', 'refund_paid', 'closed')) = ("move_out"."approved_on" is not null and "move_out"."statement" is not null)),
	CONSTRAINT "move_out_awaiting_check" CHECK ("move_out"."status" not in ('awaiting_approval', 'approved', 'refund_paid', 'closed') or "move_out"."approval_request_id" is not null),
	CONSTRAINT "move_out_paid_check" CHECK (("move_out"."status" = 'refund_paid' or ("move_out"."status" = 'closed' and "move_out"."paid_entry_id" is not null)) = ("move_out"."paid_entry_id" is not null)
          and ("move_out"."paid_entry_id" is null or ("move_out"."paid_on" is not null and "move_out"."paid_from" in ('owner_account', 'agency_account')
               and "move_out"."paid_reference" is not null and "move_out"."proof_document_id" is not null))),
	CONSTRAINT "move_out_cancel_check" CHECK (("move_out"."status" = 'cancelled') = ("move_out"."cancelled_at" is not null and "move_out"."cancel_reason" is not null)),
	CONSTRAINT "move_out_refund_check" CHECK (coalesce("move_out"."credit_refund_minor", 0) >= 0 and coalesce("move_out"."deposit_refund_minor", 0) >= 0),
	CONSTRAINT "move_out_charges_check" CHECK (jsonb_typeof("move_out"."charges") = 'array' and jsonb_array_length("move_out"."charges") <= 20),
	CONSTRAINT "move_out_statement_sha_check" CHECK ("move_out"."statement_sha256" is null or "move_out"."statement_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "move_out_refund_part" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"move_out_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "move_out_refund_part_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "move_out_refund_part_key" UNIQUE("company_id","move_out_id","payment_id"),
	CONSTRAINT "move_out_refund_part_amount_check" CHECK ("move_out_refund_part"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "signing_request" DROP CONSTRAINT "signing_request_subject_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_recipient_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_purpose_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_link_check";--> statement-breakpoint
ALTER TABLE "allocation" DROP CONSTRAINT "allocation_record_check";--> statement-breakpoint
ALTER TABLE "rent_tax_item" DROP CONSTRAINT "rent_tax_item_kind_check";--> statement-breakpoint
ALTER TABLE "rent_tax_item" DROP CONSTRAINT "rent_tax_item_source_check";--> statement-breakpoint
ALTER TABLE "maintenance_job" DROP CONSTRAINT "maintenance_job_status_check";--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_kind_check";--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_related_check";--> statement-breakpoint
ALTER TABLE "upload_intent" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "artisan_id" uuid;--> statement-breakpoint
ALTER TABLE "signing_request" ADD COLUMN "inspection_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "artisan_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "emergency_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "assignee_kind" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "assignee_person_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "assignee_artisan_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "artisan_response" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "complete_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "work_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "visit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "before_photo_reason" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "completion_note" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "tenant_response" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "tenant_response_reason" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "tenant_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "tenant_response_via" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD COLUMN "stage" text DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD COLUMN "added_by_kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD COLUMN "added_by_artisan_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "inspection_id" uuid;--> statement-breakpoint
ALTER TABLE "artisan" ADD CONSTRAINT "artisan_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artisan" ADD CONSTRAINT "artisan_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_event" ADD CONSTRAINT "contact_consent_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_event" ADD CONSTRAINT "contact_consent_event_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_event" ADD CONSTRAINT "contact_consent_event_membership_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."membership"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_event" ADD CONSTRAINT "contact_consent_event_artisan_fk" FOREIGN KEY ("company_id","artisan_id") REFERENCES "public"."artisan"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_receipt_fk" FOREIGN KEY ("company_id","receipt_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_job_fk" FOREIGN KEY ("company_id","property_id","job_id") REFERENCES "public"."maintenance_job"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment" ADD CONSTRAINT "expense_payment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment" ADD CONSTRAINT "expense_payment_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment" ADD CONSTRAINT "expense_payment_expense_fk" FOREIGN KEY ("company_id","property_id","expense_id") REFERENCES "public"."expense"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment" ADD CONSTRAINT "expense_payment_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reversal" ADD CONSTRAINT "expense_reversal_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reversal" ADD CONSTRAINT "expense_reversal_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reversal" ADD CONSTRAINT "expense_reversal_expense_fk" FOREIGN KEY ("company_id","property_id","expense_id") REFERENCES "public"."expense"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reversal" ADD CONSTRAINT "expense_reversal_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reversal" ADD CONSTRAINT "expense_reversal_payment_entry_fk" FOREIGN KEY ("company_id","payment_entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_performed_by_person_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_submitted_by_person_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_corrects_fk" FOREIGN KEY ("company_id","property_id","corrects_inspection_id") REFERENCES "public"."inspection"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_move_in_fk" FOREIGN KEY ("company_id","property_id","move_in_inspection_id") REFERENCES "public"."inspection"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_item" ADD CONSTRAINT "inspection_item_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_item" ADD CONSTRAINT "inspection_item_updated_by_person_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_item" ADD CONSTRAINT "inspection_item_inspection_fk" FOREIGN KEY ("company_id","property_id","inspection_id") REFERENCES "public"."inspection"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_item" ADD CONSTRAINT "inspection_item_move_in_fk" FOREIGN KEY ("company_id","move_in_item_id") REFERENCES "public"."inspection_item"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_added_by_person_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_item_fk" FOREIGN KEY ("company_id","property_id","inspection_id","item_id") REFERENCES "public"."inspection_item"("company_id","property_id","inspection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_template" ADD CONSTRAINT "inspection_template_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_template" ADD CONSTRAINT "inspection_template_updated_by_person_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheet_code" ADD CONSTRAINT "job_sheet_code_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheet_code" ADD CONSTRAINT "job_sheet_code_job_fk" FOREIGN KEY ("company_id","property_id","job_id") REFERENCES "public"."maintenance_job"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheet_code" ADD CONSTRAINT "job_sheet_code_artisan_fk" FOREIGN KEY ("company_id","artisan_id") REFERENCES "public"."artisan"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheet_code" ADD CONSTRAINT "job_sheet_code_link_fk" FOREIGN KEY ("company_id","property_id","secure_link_id") REFERENCES "public"."secure_link"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_event" ADD CONSTRAINT "maintenance_job_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_event" ADD CONSTRAINT "maintenance_job_event_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_event" ADD CONSTRAINT "maintenance_job_event_job_fk" FOREIGN KEY ("company_id","property_id","job_id") REFERENCES "public"."maintenance_job"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_event" ADD CONSTRAINT "maintenance_job_event_artisan_fk" FOREIGN KEY ("company_id","actor_artisan_id") REFERENCES "public"."artisan"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_application" ADD CONSTRAINT "deposit_application_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_application" ADD CONSTRAINT "deposit_application_move_out_fk" FOREIGN KEY ("company_id","lease_id","move_out_id") REFERENCES "public"."move_out"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_application" ADD CONSTRAINT "deposit_application_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_application" ADD CONSTRAINT "deposit_application_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_application" ADD CONSTRAINT "deposit_application_entry_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction" ADD CONSTRAINT "deposit_deduction_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction" ADD CONSTRAINT "deposit_deduction_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction" ADD CONSTRAINT "deposit_deduction_move_out_fk" FOREIGN KEY ("company_id","lease_id","move_out_id") REFERENCES "public"."move_out"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction" ADD CONSTRAINT "deposit_deduction_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction_withdrawal" ADD CONSTRAINT "deposit_deduction_withdrawal_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction_withdrawal" ADD CONSTRAINT "deposit_deduction_withdrawal_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deduction_withdrawal" ADD CONSTRAINT "deposit_deduction_withdrawal_deduction_fk" FOREIGN KEY ("company_id","move_out_id","deduction_id") REFERENCES "public"."deposit_deduction"("company_id","move_out_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_paid_by_person_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_owner_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_book_fk" FOREIGN KEY ("company_id","book_id") REFERENCES "public"."book"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_notice_fk" FOREIGN KEY ("company_id","property_id","notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_inspection_fk" FOREIGN KEY ("company_id","property_id","lease_id","inspection_id") REFERENCES "public"."inspection"("company_id","property_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_move_in_fk" FOREIGN KEY ("company_id","property_id","move_in_inspection_id") REFERENCES "public"."inspection"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_approval_fk" FOREIGN KEY ("company_id","approval_request_id") REFERENCES "public"."approval_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_proof_fk" FOREIGN KEY ("company_id","proof_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_statement_fk" FOREIGN KEY ("company_id","statement_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_refund_entry_fk" FOREIGN KEY ("company_id","refund_entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out" ADD CONSTRAINT "move_out_paid_entry_fk" FOREIGN KEY ("company_id","paid_entry_id") REFERENCES "public"."journal_entry"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out_refund_part" ADD CONSTRAINT "move_out_refund_part_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out_refund_part" ADD CONSTRAINT "move_out_refund_part_move_out_fk" FOREIGN KEY ("company_id","lease_id","move_out_id") REFERENCES "public"."move_out"("company_id","lease_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out_refund_part" ADD CONSTRAINT "move_out_refund_part_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out_refund_part" ADD CONSTRAINT "move_out_refund_part_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_consent_event_membership_idx" ON "contact_consent_event" USING btree ("company_id","membership_id","recorded_at");--> statement-breakpoint
CREATE INDEX "contact_consent_event_artisan_idx" ON "contact_consent_event" USING btree ("company_id","artisan_id","recorded_at");--> statement-breakpoint
CREATE INDEX "expense_property_idx" ON "expense" USING btree ("company_id","property_id","expense_date");--> statement-breakpoint
CREATE INDEX "expense_owner_idx" ON "expense" USING btree ("company_id","owner_id","accounting_date");--> statement-breakpoint
CREATE INDEX "expense_job_idx" ON "expense" USING btree ("company_id","job_id") WHERE "expense"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_corrected_once" ON "inspection" USING btree ("company_id","corrects_inspection_id") WHERE "inspection"."corrects_inspection_id" is not null;--> statement-breakpoint
CREATE INDEX "inspection_unit_idx" ON "inspection" USING btree ("company_id","unit_id","started_at");--> statement-breakpoint
CREATE INDEX "inspection_lease_idx" ON "inspection" USING btree ("company_id","lease_id","kind");--> statement-breakpoint
CREATE INDEX "inspection_photo_inspection_idx" ON "inspection_photo" USING btree ("company_id","inspection_id");--> statement-breakpoint
CREATE INDEX "job_sheet_code_link_idx" ON "job_sheet_code" USING btree ("company_id","secure_link_id","created_at");--> statement-breakpoint
CREATE INDEX "job_sheet_code_destination_idx" ON "job_sheet_code" USING btree ("company_id","destination_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_job_event_dedupe_key" ON "maintenance_job_event" USING btree ("company_id","dedupe_key") WHERE "maintenance_job_event"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_job_event_job_idx" ON "maintenance_job_event" USING btree ("company_id","job_id","at");--> statement-breakpoint
CREATE INDEX "deposit_application_lease_idx" ON "deposit_application" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "deposit_deduction_move_out_idx" ON "deposit_deduction" USING btree ("company_id","move_out_id");--> statement-breakpoint
CREATE UNIQUE INDEX "move_out_one_live" ON "move_out" USING btree ("company_id","lease_id") WHERE "move_out"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "move_out_status_idx" ON "move_out" USING btree ("company_id","status","planned_date");--> statement-breakpoint
CREATE INDEX "move_out_refund_part_payment_idx" ON "move_out_refund_part" USING btree ("company_id","payment_id");--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_assignee_person_id_person_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_artisan_fk" FOREIGN KEY ("company_id","assignee_artisan_id") REFERENCES "public"."artisan"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_artisan_fk" FOREIGN KEY ("company_id","added_by_artisan_id") REFERENCES "public"."artisan"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_job_fk" FOREIGN KEY ("company_id","property_id","job_id") REFERENCES "public"."maintenance_job"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_inspection_fk" FOREIGN KEY ("company_id","property_id","inspection_id") REFERENCES "public"."inspection"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secure_link_job_idx" ON "secure_link" USING btree ("company_id","job_id") WHERE "secure_link"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "signing_request_one_move_in_report" ON "signing_request" USING btree ("company_id","inspection_id") WHERE "signing_request"."inspection_id" is not null and "signing_request"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_job_client_key" ON "maintenance_job" USING btree ("company_id","tenant_id","client_id") WHERE "maintenance_job"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_job_board_idx" ON "maintenance_job" USING btree ("company_id","property_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_job_attachment_job_idx" ON "maintenance_job_attachment" USING btree ("company_id","job_id","stage");--> statement-breakpoint
CREATE INDEX "task_job_idx" ON "task" USING btree ("company_id","job_id") WHERE "task"."job_id" is not null;--> statement-breakpoint
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_job_sheet_check" CHECK (("secure_link"."purpose" = 'job_sheet') = ("secure_link"."job_id" is not null and "secure_link"."artisan_id" is not null));--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_move_in_check" CHECK (("signing_request"."subject_type" = 'move_in_report') = ("signing_request"."inspection_id" is not null) and ("signing_request"."subject_type" <> 'move_in_report' or ("signing_request"."lease_id" is not null and "signing_request"."tenant_id" is not null)));--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_subject_check" CHECK ("signing_request"."subject_type" in ('lease', 'notice', 'move_in_report'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_recipient_check" CHECK (("message"."recipient_type" is null or "message"."recipient_type" in ('tenant', 'tenant_contact', 'staff', 'signer', 'owner', 'artisan')) and ("message"."recipient_type" is distinct from 'artisan' or "message"."artisan_id" is not null) and ("message"."recipient_type" is distinct from 'tenant' or "message"."tenant_id" is not null) and ("message"."recipient_type" is distinct from 'tenant_contact' or "message"."tenant_contact_id" is not null) and ("message"."recipient_type" is distinct from 'staff' or "message"."staff_person_id" is not null) and ("message"."recipient_type" is distinct from 'signer' or "message"."signer_id" is not null) and ("message"."recipient_type" is distinct from 'owner' or "message"."owner_id" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert', 'conversation_reply', 'bot_reply', 'broadcast', 'opt_out_confirmation', 'consent_request', 'overdue_alert', 'renewal_reminder', 'paid_until_prompt', 'inbound', 'notice_link', 'notice_reminder', 'notice_in_force', 'maintenance_alert', 'job_sheet_link', 'repair_update', 'final_statement'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_link_check" CHECK (("message"."link_purpose" is null or "message"."link_purpose" in ('sign', 'signed_copy', 'id_capture', 'pay', 'receipt', 'job_sheet')) and ("message"."link_purpose" is null) = ("message"."link_target_id" is null));--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_record_check" CHECK ("allocation"."record_type" in ('payment', 'match', 'accrual', 'reversal', 'credit_note', 'write_off', 'withholding', 'termination', 'move_out'));--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_kind_check" CHECK ("rent_tax_item"."kind" in ('receipt', 'carry_over', 'deposit_applied', 'withholding', 'reversal', 'withholding_offset'));--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_source_check" CHECK (("rent_tax_item"."kind" not in ('withholding', 'withholding_offset') or "rent_tax_item"."withholding_id" is not null)
          and ("rent_tax_item"."kind" not in ('reversal', 'carry_over', 'deposit_applied') or "rent_tax_item"."withholding_id" is null)
          and ("rent_tax_item"."kind" not in ('receipt', 'reversal') or "rent_tax_item"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_priority_check" CHECK ("maintenance_job"."priority" is null or "maintenance_job"."priority" in ('emergency', 'urgent', 'routine'));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_category_check" CHECK ("maintenance_job"."category" is null or "maintenance_job"."category" in ('plumbing', 'electrical', 'roofing', 'carpentry', 'painting', 'pest_control', 'air_conditioning', 'generator', 'borehole', 'septic', 'other'));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_assignee_check" CHECK (("maintenance_job"."assignee_kind" is null or "maintenance_job"."assignee_kind" in ('staff', 'artisan')) and ("maintenance_job"."assignee_kind" = 'staff') = ("maintenance_job"."assignee_person_id" is not null) and ("maintenance_job"."assignee_kind" = 'artisan') = ("maintenance_job"."assignee_artisan_id" is not null) and ("maintenance_job"."artisan_response" is null or ("maintenance_job"."assignee_kind" = 'artisan' and "maintenance_job"."artisan_response" in ('accepted', 'declined'))));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_triaged_check" CHECK ("maintenance_job"."status" in ('reported', 'cancelled') or ("maintenance_job"."priority" is not null and "maintenance_job"."category" is not null));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_tenant_response_check" CHECK (("maintenance_job"."tenant_response" is null or "maintenance_job"."tenant_response" in ('confirmed', 'disputed')) and ("maintenance_job"."tenant_response_via" is null or "maintenance_job"."tenant_response_via" in ('app', 'whatsapp', 'sms', 'staff')));--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_status_check" CHECK ("maintenance_job"."status" in ('reported', 'triaged', 'assigned', 'in_progress', 'work_done', 'closed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_stage_check" CHECK ("maintenance_job_attachment"."stage" in ('report', 'before', 'after', 'other') and "maintenance_job_attachment"."added_by_kind" in ('staff', 'artisan', 'tenant', 'message'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_kind_check" CHECK ("task"."kind" in ('notice_in_person_reminder', 'notice_post_on_premises', 'notice_physical_service', 'maintenance_attend', 'inspection_due'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_related_check" CHECK ("task"."related_type" in ('notice', 'maintenance_job', 'inspection') and ("task"."related_type" = 'notice') = ("task"."notice_id" is not null) and ("task"."related_type" = 'maintenance_job') = ("task"."job_id" is not null) and ("task"."related_type" = 'inspection') = ("task"."inspection_id" is not null));