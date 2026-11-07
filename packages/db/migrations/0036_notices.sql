CREATE TABLE "notice" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer,
	"type" text NOT NULL,
	"subtype" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"lease_id" uuid,
	"tenant_id" uuid,
	"block_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"counsel_reviewed" boolean DEFAULT false NOT NULL,
	"completion" text DEFAULT 'each' NOT NULL,
	"issue_date" date,
	"issued_at" timestamp with time zone,
	"effective_date" date,
	"earliest_lawful_date" date,
	"earliest" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statutory_rule_id" uuid,
	"bar_rule_id" uuid,
	"electronic_service" boolean,
	"ladder" jsonb,
	"ladder_paused" boolean DEFAULT false NOT NULL,
	"ladder_cancelled" boolean DEFAULT false NOT NULL,
	"ladder_reason" text,
	"ladder_changed_at" timestamp with time zone,
	"ladder_changed_by" uuid,
	"link_expires_at" timestamp with time zone,
	"render_request_id" uuid,
	"document_id" uuid,
	"document_sha256" text,
	"service_pack_render_request_id" uuid,
	"service_pack_document_id" uuid,
	"corrects_notice_id" uuid,
	"approval_request_id" uuid,
	"served_too_late" jsonb,
	"outcome" text,
	"close_note" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"returned_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "notice_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "notice_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "notice_type_check" CHECK ("notice"."type" in ('rent_demand', 'rent_review', 'notice_to_quit', 'entry', 'breach', 'non_renewal', 'building_wide', 'tenant_originated')),
	CONSTRAINT "notice_status_check" CHECK ("notice"."status" in ('draft', 'pending_approval', 'approved', 'sent', 'delivered', 'reminded', 'opened', 'escalated', 'served', 'signed', 'closed', 'cancelled', 'received')),
	CONSTRAINT "notice_outcome_check" CHECK (("notice"."outcome" is null or "notice"."outcome" in ('complied', 'paid', 'vacated', 'disputed', 'referred_rent_control', 'referred_court', 'superseded', 'withdrawn')) and ("notice"."status" = 'closed') = ("notice"."outcome" is not null) and ("notice"."outcome" is null) = ("notice"."closed_at" is null)),
	CONSTRAINT "notice_completion_check" CHECK ("notice"."completion" in ('any_one', 'each')),
	CONSTRAINT "notice_target_check" CHECK (case when "notice"."type" = 'building_wide' then "notice"."lease_id" is null and "notice"."tenant_id" is null else "notice"."lease_id" is not null and "notice"."tenant_id" is not null end),
	CONSTRAINT "notice_number_check" CHECK (("notice"."number" is null or "notice"."number" >= 1) and ("notice"."status" not in ('sent', 'delivered', 'reminded', 'opened', 'escalated', 'served', 'signed') or ("notice"."number" is not null and "notice"."issued_at" is not null and "notice"."issue_date" is not null)) and ("notice"."status" not in ('draft', 'pending_approval', 'approved', 'cancelled', 'received') or "notice"."number" is null)),
	CONSTRAINT "notice_document_sha_check" CHECK ("notice"."document_sha256" is null or "notice"."document_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "notice_document_check" CHECK (("notice"."document_id" is null) = ("notice"."document_sha256" is null))
);
--> statement-breakpoint
CREATE TABLE "notice_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"recipient_id" uuid,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"channel" text,
	"message_id" uuid,
	"data" jsonb,
	"actor_person_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	CONSTRAINT "notice_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "notice_event_kind_check" CHECK ("notice_event"."kind" in ('submitted', 'returned_to_draft', 'approved', 'cancelled', 'sent', 'delivered', 'opened', 'reminded', 'escalated', 'served', 'signed', 'closed', 'received', 'ladder_paused', 'ladder_resumed', 'ladder_cancelled', 'channel_withheld', 'step_skipped', 'manager_alerted', 'task_created', 'document_ready', 'service_pack_ready', 'served_too_late', 'link_issued')),
	CONSTRAINT "notice_event_channel_check" CHECK ("notice_event"."channel" is null or "notice_event"."channel" in ('whatsapp', 'sms', 'email'))
);
--> statement-breakpoint
CREATE TABLE "notice_quit_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"action" text NOT NULL,
	"person_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"typed_name" text,
	"statement_version" text NOT NULL,
	"statement_sha256" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_quit_acknowledgement_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "notice_quit_acknowledgement_action_check" CHECK ("notice_quit_acknowledgement"."action" in ('grant', 'withdraw')),
	CONSTRAINT "notice_quit_acknowledgement_fields_check" CHECK (("notice_quit_acknowledgement"."action" = 'grant') = ("notice_quit_acknowledgement"."typed_name" is not null) and ("notice_quit_acknowledgement"."action" = 'withdraw') = ("notice_quit_acknowledgement"."reason" is not null)),
	CONSTRAINT "notice_quit_acknowledgement_sha_check" CHECK ("notice_quit_acknowledgement"."statement_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "notice_recipient" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lease_id" uuid,
	"unit_id" uuid,
	"kind" text NOT NULL,
	"tenant_contact_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"whatsapp_phone" text,
	"email" text,
	"channels" jsonb NOT NULL,
	"physical_service_planned" boolean NOT NULL,
	"signing_request_id" uuid,
	"signer_id" uuid,
	"position" smallint NOT NULL,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_recipient_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "notice_recipient_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "notice_recipient_notice_key" UNIQUE("company_id","notice_id","id"),
	CONSTRAINT "notice_recipient_position_key" UNIQUE("company_id","notice_id","position"),
	CONSTRAINT "notice_recipient_kind_check" CHECK ("notice_recipient"."kind" in ('tenant', 'signatory')),
	CONSTRAINT "notice_recipient_contact_check" CHECK (("notice_recipient"."kind" = 'signatory') = ("notice_recipient"."tenant_contact_id" is not null)),
	CONSTRAINT "notice_recipient_position_check" CHECK ("notice_recipient"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "rent_assessment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"assessed_on" date NOT NULL,
	"reference" text NOT NULL,
	"document_id" uuid,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_assessment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_assessment_reference_check" CHECK (length("rent_assessment"."reference") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "service_record" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"recipient_id" uuid,
	"method" text NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"served_by_person_id" uuid,
	"served_by_name" text NOT NULL,
	"witness_name" text,
	"notes" text,
	"photo_document_id" uuid,
	"affidavit_document_id" uuid,
	"corrects_record_id" uuid,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_record_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "service_record_notice_key" UNIQUE("company_id","notice_id","id"),
	CONSTRAINT "service_record_method_check" CHECK ("service_record"."method" in ('handed_to_tenant', 'posted_on_premises', 'left_with_adult_occupant', 'registered_post', 'courier'))
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"related_type" text NOT NULL,
	"notice_id" uuid,
	"recipient_id" uuid,
	"assignee_person_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"dedupe_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "task_dedupe_key" UNIQUE("company_id","dedupe_key"),
	CONSTRAINT "task_kind_check" CHECK ("task"."kind" in ('notice_in_person_reminder', 'notice_post_on_premises', 'notice_physical_service')),
	CONSTRAINT "task_status_check" CHECK ("task"."status" in ('open', 'done', 'cancelled')),
	CONSTRAINT "task_related_check" CHECK ("task"."related_type" in ('notice') and ("task"."related_type" <> 'notice' or "task"."notice_id" is not null)),
	CONSTRAINT "task_closed_check" CHECK (("task"."status" = 'done') = ("task"."completed_at" is not null) and ("task"."status" = 'cancelled') = ("task"."cancelled_at" is not null)),
	CONSTRAINT "task_title_check" CHECK (length("task"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "signing_request" DROP CONSTRAINT "signing_request_subject_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_purpose_check";--> statement-breakpoint
ALTER TABLE "company_counter" DROP CONSTRAINT "company_counter_name_check";--> statement-breakpoint
DROP INDEX "signing_request_one_open";--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "first_open_ip" text;--> statement-breakpoint
ALTER TABLE "secure_link" ADD COLUMN "first_open_user_agent" text;--> statement-breakpoint
ALTER TABLE "signing_request" ADD COLUMN "notice_id" uuid;--> statement-breakpoint
ALTER TABLE "signing_request" ADD COLUMN "completion_rule" text DEFAULT 'all_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "signing_request" ADD COLUMN "links_expire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_statutory_rule_id_rule_id_fk" FOREIGN KEY ("statutory_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_bar_rule_id_rule_id_fk" FOREIGN KEY ("bar_rule_id") REFERENCES "public"."rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_ladder_changed_by_person_id_fk" FOREIGN KEY ("ladder_changed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_closed_by_person_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_corrects_fk" FOREIGN KEY ("company_id","property_id","corrects_notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_render_fk" FOREIGN KEY ("company_id","render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_service_pack_render_fk" FOREIGN KEY ("company_id","service_pack_render_request_id") REFERENCES "public"."document_render_request"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_service_pack_fk" FOREIGN KEY ("company_id","service_pack_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_notice_fk" FOREIGN KEY ("company_id","property_id","notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_recipient_fk" FOREIGN KEY ("company_id","notice_id","recipient_id") REFERENCES "public"."notice_recipient"("company_id","notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_quit_acknowledgement" ADD CONSTRAINT "notice_quit_acknowledgement_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_quit_acknowledgement" ADD CONSTRAINT "notice_quit_acknowledgement_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_quit_acknowledgement" ADD CONSTRAINT "notice_quit_acknowledgement_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_notice_fk" FOREIGN KEY ("company_id","property_id","notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_signer_fk" FOREIGN KEY ("company_id","property_id","signer_id") REFERENCES "public"."signer"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_served_by_person_id_person_id_fk" FOREIGN KEY ("served_by_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_notice_fk" FOREIGN KEY ("company_id","property_id","notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_recipient_fk" FOREIGN KEY ("company_id","notice_id","recipient_id") REFERENCES "public"."notice_recipient"("company_id","notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_corrects_fk" FOREIGN KEY ("company_id","notice_id","corrects_record_id") REFERENCES "public"."service_record"("company_id","notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_photo_fk" FOREIGN KEY ("company_id","photo_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_affidavit_fk" FOREIGN KEY ("company_id","affidavit_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_person_id_person_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_completed_by_person_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_cancelled_by_person_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_notice_fk" FOREIGN KEY ("company_id","property_id","notice_id") REFERENCES "public"."notice"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_recipient_fk" FOREIGN KEY ("company_id","notice_id","recipient_id") REFERENCES "public"."notice_recipient"("company_id","notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_list_idx" ON "notice" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notice_lease_idx" ON "notice" USING btree ("company_id","lease_id");--> statement-breakpoint
CREATE INDEX "notice_tenant_idx" ON "notice" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE INDEX "notice_render_idx" ON "notice" USING btree ("company_id","render_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notice_event_dedupe_key" ON "notice_event" USING btree ("company_id","dedupe_key") WHERE "notice_event"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notice_event_notice_idx" ON "notice_event" USING btree ("company_id","notice_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notice_event_tenant_idx" ON "notice_event" USING btree ("company_id","tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notice_quit_acknowledgement_idx" ON "notice_quit_acknowledgement" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "notice_recipient_notice_idx" ON "notice_recipient" USING btree ("company_id","notice_id");--> statement-breakpoint
CREATE INDEX "notice_recipient_tenant_idx" ON "notice_recipient" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE INDEX "rent_assessment_unit_idx" ON "rent_assessment" USING btree ("company_id","unit_id","assessed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "service_record_corrects_key" ON "service_record" USING btree ("company_id","corrects_record_id") WHERE "service_record"."corrects_record_id" is not null;--> statement-breakpoint
CREATE INDEX "service_record_notice_idx" ON "service_record" USING btree ("company_id","notice_id","recorded_at");--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" USING btree ("company_id","assignee_person_id","status");--> statement-breakpoint
CREATE INDEX "task_list_idx" ON "task" USING btree ("company_id","status","due_at");--> statement-breakpoint
CREATE INDEX "signing_request_notice_idx" ON "signing_request" USING btree ("company_id","notice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_request_one_open" ON "signing_request" USING btree ("company_id","lease_id") WHERE "signing_request"."lease_id" is not null and "signing_request"."status" in ('preparing', 'pending') and "signing_request"."subject_type" = 'lease';--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_notice_check" CHECK (("signing_request"."subject_type" = 'notice') = ("signing_request"."notice_id" is not null) and ("signing_request"."subject_type" <> 'notice' or "signing_request"."tenant_id" is not null));--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_completion_check" CHECK ("signing_request"."completion_rule" in ('all_required', 'any_one') and ("signing_request"."subject_type" = 'notice' or "signing_request"."completion_rule" = 'all_required'));--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_subject_check" CHECK ("signing_request"."subject_type" in ('lease', 'notice'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert', 'conversation_reply', 'bot_reply', 'broadcast', 'opt_out_confirmation', 'consent_request', 'overdue_alert', 'renewal_reminder', 'paid_until_prompt', 'inbound', 'notice_link', 'notice_reminder', 'notice_in_force'));--> statement-breakpoint
ALTER TABLE "company_counter" ADD CONSTRAINT "company_counter_name_check" CHECK ("company_counter"."name" in ('receipt', 'invoice', 'notice'));