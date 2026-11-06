ALTER TABLE "broadcast" ADD COLUMN "preview_token_hash" text;--> statement-breakpoint
ALTER TABLE "message_event" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "maintenance_job" ADD COLUMN "source_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_preview_key" ON "broadcast" USING btree ("company_id","preview_token_hash") WHERE "broadcast"."preview_token_hash" is not null;