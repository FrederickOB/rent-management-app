CREATE TABLE "bot_session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"state" text NOT NULL,
	"context" jsonb NOT NULL,
	"consent_asked_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_session_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "bot_session_conversation_key" UNIQUE("company_id","conversation_id"),
	CONSTRAINT "bot_session_state_check" CHECK ("bot_session"."state" in ('menu', 'choose_lease', 'receipts', 'repair', 'handed_over'))
);
--> statement-breakpoint
CREATE TABLE "broadcast" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"audience_kind" text NOT NULL,
	"property_id" uuid,
	"block_ids" uuid[],
	"group_id" uuid,
	"topic" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"audience_count" integer NOT NULL,
	"queued_count" integer NOT NULL,
	"batches" integer NOT NULL,
	"batches_queued" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "broadcast_audience_check" CHECK ("broadcast"."audience_kind" in ('property', 'blocks', 'group')),
	CONSTRAINT "broadcast_audience_fields_check" CHECK (case "broadcast"."audience_kind" when 'property' then "broadcast"."property_id" is not null and "broadcast"."block_ids" is null and "broadcast"."group_id" is null when 'blocks' then "broadcast"."property_id" is not null and cardinality("broadcast"."block_ids") >= 1 and "broadcast"."group_id" is null else "broadcast"."group_id" is not null and "broadcast"."block_ids" is null end),
	CONSTRAINT "broadcast_status_check" CHECK ("broadcast"."status" in ('sending', 'sent')),
	CONSTRAINT "broadcast_counts_check" CHECK ("broadcast"."audience_count" >= 0 and "broadcast"."queued_count" >= 0 and "broadcast"."queued_count" <= "broadcast"."audience_count" and "broadcast"."batches" >= 0 and "broadcast"."batches_queued" >= 0 and "broadcast"."batches_queued" <= "broadcast"."batches")
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipient" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid,
	"planned_channel" text,
	"outcome" text NOT NULL,
	"reason" text,
	"batch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_recipient_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "broadcast_recipient_tenant_key" UNIQUE("company_id","broadcast_id","tenant_id"),
	CONSTRAINT "broadcast_recipient_outcome_check" CHECK ("broadcast_recipient"."outcome" in ('queued', 'not_sent')),
	CONSTRAINT "broadcast_recipient_message_check" CHECK (case when "broadcast_recipient"."outcome" = 'queued' then "broadcast_recipient"."message_id" is not null and "broadcast_recipient"."reason" is null else "broadcast_recipient"."message_id" is null and "broadcast_recipient"."reason" is not null end),
	CONSTRAINT "broadcast_recipient_channel_check" CHECK ("broadcast_recipient"."planned_channel" is null or "broadcast_recipient"."planned_channel" in ('push', 'whatsapp', 'sms', 'email')),
	CONSTRAINT "broadcast_recipient_batch_check" CHECK ("broadcast_recipient"."batch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel_identity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_contact_id" uuid,
	"conversation_id" uuid,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "channel_identity_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "channel_identity_channel_check" CHECK ("channel_identity"."channel" in ('whatsapp', 'sms', 'email')),
	CONSTRAINT "channel_identity_revoke_check" CHECK (("channel_identity"."revoked_at" is null) = ("channel_identity"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid,
	"triage_channel" text,
	"triage_address" text,
	"merged_into_id" uuid,
	"state" text NOT NULL,
	"assigned_to" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"handover_reason" text,
	"handed_over_at" timestamp with time zone,
	"first_response_due_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_inbound_channel" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"linked_by" uuid,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "conversation_state_check" CHECK ("conversation"."state" in ('triage', 'bot', 'open', 'assigned', 'awaiting_tenant', 'resolved')),
	CONSTRAINT "conversation_triage_check" CHECK (("conversation"."tenant_id" is not null or ("conversation"."triage_channel" is not null and "conversation"."triage_address" is not null)) and ("conversation"."state" <> 'triage' or "conversation"."tenant_id" is null)),
	CONSTRAINT "conversation_triage_channel_check" CHECK ("conversation"."triage_channel" is null or "conversation"."triage_channel" in ('whatsapp', 'sms', 'email')),
	CONSTRAINT "conversation_inbound_channel_check" CHECK ("conversation"."last_inbound_channel" is null or "conversation"."last_inbound_channel" in ('push', 'whatsapp', 'sms', 'email', 'in_app')),
	CONSTRAINT "conversation_assigned_check" CHECK ("conversation"."state" <> 'assigned' or "conversation"."assigned_to" is not null),
	CONSTRAINT "conversation_handover_check" CHECK ("conversation"."handover_reason" is null or "conversation"."handover_reason" in ('asked_for_person', 'bot_cannot_help', 'media_received', 'contact_without_account', 'no_lease')),
	CONSTRAINT "conversation_merge_check" CHECK ("conversation"."merged_into_id" is null or "conversation"."merged_into_id" <> "conversation"."id"),
	CONSTRAINT "conversation_tags_check" CHECK (cardinality("conversation"."tags") <= 30)
);
--> statement-breakpoint
CREATE TABLE "conversation_channel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"whatsapp_account_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_channel_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "conversation_channel_key" UNIQUE NULLS NOT DISTINCT("company_id","conversation_id","channel","address","whatsapp_account_id"),
	CONSTRAINT "conversation_channel_channel_check" CHECK ("conversation_channel"."channel" in ('push', 'whatsapp', 'sms', 'email', 'in_app')),
	CONSTRAINT "conversation_channel_account_check" CHECK (("conversation_channel"."channel" = 'whatsapp') = ("conversation_channel"."whatsapp_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "message_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"document_id" uuid,
	"status" text NOT NULL,
	"reject_reason" text,
	"provider" text,
	"provider_media_id" text,
	"filename" text,
	"caption" text,
	"copied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "message_attachment_kind_check" CHECK ("message_attachment"."kind" in ('image', 'video', 'audio', 'document', 'sticker')),
	CONSTRAINT "message_attachment_status_check" CHECK ("message_attachment"."status" in ('stored', 'rejected')),
	CONSTRAINT "message_attachment_stored_check" CHECK (case when "message_attachment"."status" = 'stored' then "message_attachment"."document_id" is not null and "message_attachment"."reject_reason" is null else "message_attachment"."document_id" is null and "message_attachment"."reject_reason" is not null end),
	CONSTRAINT "message_attachment_provider_check" CHECK ("message_attachment"."provider_media_id" is null or "message_attachment"."provider" is not null)
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"whatsapp_name" text NOT NULL,
	"category" text NOT NULL,
	"language" text NOT NULL,
	"body" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_template_version_key" UNIQUE("key","language","version"),
	CONSTRAINT "message_template_whatsapp_name_key" UNIQUE("whatsapp_name","language"),
	CONSTRAINT "message_template_category_check" CHECK ("message_template"."category" in ('utility', 'marketing', 'authentication')),
	CONSTRAINT "message_template_version_check" CHECK ("message_template"."version" >= 1),
	CONSTRAINT "message_template_name_check" CHECK ("message_template"."whatsapp_name" ~ '^[a-z0-9_]+$' and char_length("message_template"."whatsapp_name") <= 512)
);
--> statement-breakpoint
CREATE TABLE "push_device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_device_platform_check" CHECK ("push_device"."platform" in ('ios', 'android', 'web')),
	CONSTRAINT "push_device_token_check" CHECK ("push_device"."token" ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$')
);
--> statement-breakpoint
CREATE TABLE "reply_address" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_address_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "reply_address_token_check" CHECK ("reply_address"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_group" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_group_company_id_id_key" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenant_group_member" (
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_group_member_company_id_group_id_tenant_id_pk" PRIMARY KEY("company_id","group_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "unsubscribe_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_contact_id" uuid,
	"message_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unsubscribe_token_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "unsubscribe_token_hash_check" CHECK ("unsubscribe_token"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "whatsapp_account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"display_phone" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"owner_company_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"registered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_account_kind_check" CHECK ("whatsapp_account"."kind" in ('shared', 'company')),
	CONSTRAINT "whatsapp_account_company_check" CHECK (("whatsapp_account"."kind" = 'company') = ("whatsapp_account"."owner_company_id" is not null)),
	CONSTRAINT "whatsapp_account_status_check" CHECK ("whatsapp_account"."status" in ('active', 'retired')),
	CONSTRAINT "whatsapp_account_phone_check" CHECK ("whatsapp_account"."display_phone" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "whatsapp_template_status" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"status" text NOT NULL,
	"category" text,
	"meta_template_id" text,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_template_status_key" UNIQUE("whatsapp_account_id","template_id"),
	CONSTRAINT "whatsapp_template_status_check" CHECK ("whatsapp_template_status"."status" in ('pending', 'approved', 'rejected', 'paused', 'disabled')),
	CONSTRAINT "whatsapp_template_status_category_check" CHECK ("whatsapp_template_status"."category" is null or "whatsapp_template_status"."category" in ('utility', 'marketing', 'authentication'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_number" integer DEFAULT 0 NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"lease_id" uuid,
	"tenant_id" uuid,
	"status" text DEFAULT 'reported' NOT NULL,
	"source" text NOT NULL,
	"description" text NOT NULL,
	"conversation_id" uuid,
	"source_message_id" uuid,
	"reported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_job_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "maintenance_job_scope_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "maintenance_job_ticket_key" UNIQUE("company_id","ticket_number"),
	CONSTRAINT "maintenance_job_status_check" CHECK ("maintenance_job"."status" in ('reported')),
	CONSTRAINT "maintenance_job_source_check" CHECK ("maintenance_job"."source" in ('whatsapp', 'app', 'sms', 'email', 'staff')),
	CONSTRAINT "maintenance_job_ticket_check" CHECK ("maintenance_job"."ticket_number" >= 1),
	CONSTRAINT "maintenance_job_lease_check" CHECK ("maintenance_job"."lease_id" is null or "maintenance_job"."tenant_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "maintenance_job_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_attachment_id" uuid,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_job_attachment_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "maintenance_job_attachment_document_key" UNIQUE("company_id","job_id","document_id"),
	CONSTRAINT "maintenance_job_attachment_kind_check" CHECK ("maintenance_job_attachment"."kind" in ('image', 'video', 'audio', 'document'))
);
--> statement-breakpoint
ALTER TABLE "consent_event" DROP CONSTRAINT "consent_event_source_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_recipient_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_purpose_check";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_channels_check";--> statement-breakpoint
ALTER TABLE "message_event" DROP CONSTRAINT "message_event_status_check";--> statement-breakpoint
ALTER TABLE "message_event" DROP CONSTRAINT "message_event_channel_check";--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "recipient_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "interim_plan" text DEFAULT 'growth' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "full_body" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "direction" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "author_type" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "author_person_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "attachment_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_event" ADD COLUMN "pricing_category" text;--> statement-breakpoint
ALTER TABLE "message_event" ADD COLUMN "billable" boolean;--> statement-breakpoint
ALTER TABLE "bot_session" ADD CONSTRAINT "bot_session_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_session" ADD CONSTRAINT "bot_session_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_group_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."tenant_group"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_broadcast_fk" FOREIGN KEY ("company_id","broadcast_id") REFERENCES "public"."broadcast"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_linked_by_person_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_revoked_by_person_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity" ADD CONSTRAINT "channel_identity_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_to_person_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_resolved_by_person_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_linked_by_person_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_merged_fk" FOREIGN KEY ("company_id","merged_into_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_channel" ADD CONSTRAINT "conversation_channel_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_channel" ADD CONSTRAINT "conversation_channel_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_channel" ADD CONSTRAINT "conversation_channel_account_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_device" ADD CONSTRAINT "push_device_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_device" ADD CONSTRAINT "push_device_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group" ADD CONSTRAINT "tenant_group_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group" ADD CONSTRAINT "tenant_group_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group_member" ADD CONSTRAINT "tenant_group_member_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group_member" ADD CONSTRAINT "tenant_group_member_added_by_person_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group_member" ADD CONSTRAINT "tenant_group_member_group_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."tenant_group"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_group_member" ADD CONSTRAINT "tenant_group_member_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_token" ADD CONSTRAINT "unsubscribe_token_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_token" ADD CONSTRAINT "unsubscribe_token_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_token" ADD CONSTRAINT "unsubscribe_token_contact_fk" FOREIGN KEY ("company_id","tenant_id","tenant_contact_id") REFERENCES "public"."tenant_contact"("company_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_token" ADD CONSTRAINT "unsubscribe_token_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_account" ADD CONSTRAINT "whatsapp_account_owner_company_id_company_id_fk" FOREIGN KEY ("owner_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_account" ADD CONSTRAINT "whatsapp_account_registered_by_person_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_template_status" ADD CONSTRAINT "whatsapp_template_status_whatsapp_account_id_whatsapp_account_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_template_status" ADD CONSTRAINT "whatsapp_template_status_template_id_message_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_reported_by_person_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_unit_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_lease_fk" FOREIGN KEY ("company_id","property_id","tenant_id","lease_id") REFERENCES "public"."lease"("company_id","property_id","tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."tenant"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_message_fk" FOREIGN KEY ("company_id","source_message_id") REFERENCES "public"."message"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_added_by_person_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_job_fk" FOREIGN KEY ("company_id","property_id","job_id") REFERENCES "public"."maintenance_job"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_job_attachment" ADD CONSTRAINT "maintenance_job_attachment_message_fk" FOREIGN KEY ("company_id","message_attachment_id") REFERENCES "public"."message_attachment"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_list_idx" ON "broadcast" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcast_recipient_batch_idx" ON "broadcast_recipient" USING btree ("company_id","broadcast_id","batch");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identity_active_key" ON "channel_identity" USING btree ("company_id","channel","address") WHERE "channel_identity"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "channel_identity_address_idx" ON "channel_identity" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_one_per_tenant" ON "conversation" USING btree ("company_id","tenant_id") WHERE "conversation"."tenant_id" is not null and "conversation"."merged_into_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_one_triage_per_address" ON "conversation" USING btree ("company_id","triage_channel","triage_address") WHERE "conversation"."tenant_id" is null and "conversation"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "conversation_list_idx" ON "conversation" USING btree ("company_id","state","last_message_at");--> statement-breakpoint
CREATE INDEX "conversation_assignee_idx" ON "conversation" USING btree ("company_id","assigned_to","state");--> statement-breakpoint
CREATE INDEX "conversation_due_idx" ON "conversation" USING btree ("company_id","first_response_due_at") WHERE "conversation"."first_response_due_at" is not null;--> statement-breakpoint
CREATE INDEX "conversation_channel_address_idx" ON "conversation_channel" USING btree ("channel","address","last_outbound_at");--> statement-breakpoint
CREATE INDEX "message_attachment_message_idx" ON "message_attachment" USING btree ("company_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachment_media_key" ON "message_attachment" USING btree ("provider","provider_media_id") WHERE "message_attachment"."provider_media_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_device_token_key" ON "push_device" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_device_person_idx" ON "push_device" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_address_token_key" ON "reply_address" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_group_name_key" ON "tenant_group" USING btree ("company_id",lower("name")) WHERE "tenant_group"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "tenant_group_member_tenant_idx" ON "tenant_group_member" USING btree ("company_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscribe_token_hash_key" ON "unsubscribe_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_account_number_key" ON "whatsapp_account" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_account_one_shared" ON "whatsapp_account" USING btree ("kind") WHERE "whatsapp_account"."kind" = 'shared' and "whatsapp_account"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_account_one_per_company" ON "whatsapp_account" USING btree ("owner_company_id") WHERE "whatsapp_account"."kind" = 'company' and "whatsapp_account"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_job_source_message_key" ON "maintenance_job" USING btree ("company_id","source_message_id") WHERE "maintenance_job"."source_message_id" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_job_list_idx" ON "maintenance_job" USING btree ("company_id","status","created_at");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_person_id_person_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversation"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_conversation_idx" ON "message" USING btree ("company_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_inbound_provider_key" ON "message" USING btree ("provider","provider_message_id") WHERE "message"."direction" = 'inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "message_event_receipt_key" ON "message_event" USING btree ("company_id","message_id","channel","status") WHERE "message_event"."status" in ('delivered', 'read');--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_interim_plan_check" CHECK ("company"."interim_plan" in ('starter', 'growth'));--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_source_check" CHECK ("consent_event"."source" in ('staff', 'reply', 'stop', 'tenant_app', 'tenant_reply', 'stop_keyword', 'start_keyword', 'email_unsubscribe'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_direction_check" CHECK ("message"."direction" in ('outbound', 'inbound'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_check" CHECK ("message"."author_type" in ('staff', 'bot', 'system', 'tenant', 'contact', 'unknown') and ("message"."author_type" <> 'staff' or "message"."author_person_id" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channel_check" CHECK ("message"."channel" is null or "message"."channel" in ('push', 'whatsapp', 'sms', 'email', 'in_app'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_inbound_check" CHECK (case when "message"."direction" = 'inbound' then "message"."recipient_type" is null and "message"."author_type" in ('tenant', 'contact', 'unknown') and "message"."purpose" = 'inbound' and "message"."channel" is not null and "message"."channel" <> 'push' and "message"."conversation_id" is not null and ("message"."channel" = 'in_app' or ("message"."provider" is not null and "message"."provider_message_id" is not null)) else "message"."recipient_type" is not null and "message"."author_type" in ('staff', 'bot', 'system') and "message"."purpose" <> 'inbound' and "message"."provider_message_id" is null end);--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_template_check" CHECK (("message"."template_key" is null) = ("message"."template_version" is null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_attachment_count_check" CHECK ("message"."attachment_count" >= 0 and "message"."attachment_count" <= 20);--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_recipient_check" CHECK (("message"."recipient_type" is null or "message"."recipient_type" in ('tenant', 'tenant_contact', 'staff', 'signer', 'owner')) and ("message"."recipient_type" is distinct from 'tenant' or "message"."tenant_id" is not null) and ("message"."recipient_type" is distinct from 'tenant_contact' or "message"."tenant_contact_id" is not null) and ("message"."recipient_type" is distinct from 'staff' or "message"."staff_person_id" is not null) and ("message"."recipient_type" is distinct from 'signer' or "message"."signer_id" is not null) and ("message"."recipient_type" is distinct from 'owner' or "message"."owner_id" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_purpose_check" CHECK ("message"."purpose" in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert', 'conversation_reply', 'bot_reply', 'broadcast', 'opt_out_confirmation', 'consent_request', 'overdue_alert', 'renewal_reminder', 'paid_until_prompt', 'inbound'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channels_check" CHECK (cardinality("message"."channels") >= 1 and "message"."channels" <@ array['push', 'whatsapp', 'sms', 'email', 'in_app']::text[]);--> statement-breakpoint
ALTER TABLE "message_event" ADD CONSTRAINT "message_event_pricing_check" CHECK ("message_event"."pricing_category" is null or "message_event"."pricing_category" in ('utility', 'marketing', 'authentication', 'service', 'referral_conversion'));--> statement-breakpoint
ALTER TABLE "message_event" ADD CONSTRAINT "message_event_status_check" CHECK ("message_event"."status" in ('queued', 'sent', 'delivered', 'read', 'failed', 'not_sent'));--> statement-breakpoint
ALTER TABLE "message_event" ADD CONSTRAINT "message_event_channel_check" CHECK ("message_event"."channel" is null or "message_event"."channel" in ('push', 'whatsapp', 'sms', 'email', 'in_app'));