CREATE TABLE "rent_assessment_void" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"voided_by" uuid NOT NULL,
	"voided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_assessment_void_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "rent_assessment_void_once_key" UNIQUE("company_id","assessment_id"),
	CONSTRAINT "rent_assessment_void_reason_check" CHECK (length("rent_assessment_void"."reason") between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "notice_recipient" DROP CONSTRAINT "notice_recipient_kind_check";--> statement-breakpoint
ALTER TABLE "notice_recipient" DROP CONSTRAINT "notice_recipient_contact_check";--> statement-breakpoint
ALTER TABLE "notice_quit_acknowledgement" DROP CONSTRAINT "notice_quit_acknowledgement_membership_id_membership_id_fk";
--> statement-breakpoint
ALTER TABLE "notice" ADD COLUMN "ladder_shift_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_scope_key" UNIQUE("company_id","unit_id","id");--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "rent_assessment_void" ADD CONSTRAINT "rent_assessment_void_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment_void" ADD CONSTRAINT "rent_assessment_void_voided_by_person_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment_void" ADD CONSTRAINT "rent_assessment_void_assessment_fk" FOREIGN KEY ("company_id","unit_id","assessment_id") REFERENCES "public"."rent_assessment"("company_id","unit_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment_void" ADD CONSTRAINT "rent_assessment_void_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_quit_acknowledgement" ADD CONSTRAINT "notice_quit_acknowledgement_membership_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."membership"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_replaces_fk" FOREIGN KEY ("company_id","unit_id","replaces_id") REFERENCES "public"."rent_assessment"("company_id","unit_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notice_one_live_correction_key" ON "notice" USING btree ("company_id","corrects_notice_id") WHERE "notice"."corrects_notice_id" is not null and "notice"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_replaces_key" UNIQUE("company_id","replaces_id");--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_kind_check" CHECK ("notice_recipient"."kind" in ('tenant', 'co_tenant', 'signatory'));--> statement-breakpoint
ALTER TABLE "notice_recipient" ADD CONSTRAINT "notice_recipient_contact_check" CHECK (("notice_recipient"."kind" in ('signatory', 'co_tenant')) = ("notice_recipient"."tenant_contact_id" is not null));--> statement-breakpoint
ALTER TABLE "rent_assessment" ADD CONSTRAINT "rent_assessment_reason_check" CHECK (("rent_assessment"."replaces_id" is null) = ("rent_assessment"."reason" is null) and ("rent_assessment"."reason" is null or length("rent_assessment"."reason") between 3 and 500));;--> statement-breakpoint
ALTER TABLE "notice_event" DROP CONSTRAINT "notice_event_kind_check";--> statement-breakpoint
ALTER TABLE "notice_event" ADD CONSTRAINT "notice_event_kind_check" CHECK ("notice_event"."kind" in ('submitted', 'returned_to_draft', 'approved', 'cancelled', 'sent', 'delivered', 'opened', 'reminded', 'escalated', 'served', 'signed', 'closed', 'received', 'ladder_paused', 'ladder_resumed', 'ladder_cancelled', 'channel_withheld', 'step_skipped', 'manager_alerted', 'task_created', 'document_ready', 'service_pack_ready', 'served_too_late', 'link_issued', 'reminder_not_sent', 'escalation_requested'));
