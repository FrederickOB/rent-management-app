CREATE TABLE "block" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "block_company_property_id_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "block_code_key" UNIQUE("company_id","property_id","code"),
	CONSTRAINT "block_code_check" CHECK ("block"."code" ~ '^[A-Z0-9]{1,3}$')
);
--> statement-breakpoint
CREATE TABLE "meter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"utility" text NOT NULL,
	"supplier" text NOT NULL,
	"meter_number" text NOT NULL,
	"meter_type" text NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "meter_company_property_id_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "meter_number_key" UNIQUE("company_id","utility","supplier","meter_number"),
	CONSTRAINT "meter_utility_check" CHECK ("meter"."utility" in ('electricity', 'water')),
	CONSTRAINT "meter_type_check" CHECK ("meter"."meter_type" in ('prepaid', 'postpaid', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"phone" text,
	"email" text,
	"residence_country" char(2),
	"time_zone" text DEFAULT 'Africa/Accra' NOT NULL,
	"notes" text,
	"is_test_contact" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "owner_reference_key" UNIQUE("company_id","reference"),
	CONSTRAINT "owner_kind_check" CHECK ("owner"."kind" in ('individual', 'company'))
);
--> statement-breakpoint
CREATE TABLE "portfolio" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "portfolio_name_key" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"code" text NOT NULL,
	"area_code" text NOT NULL,
	"name" text NOT NULL,
	"property_type" text NOT NULL,
	"use" text NOT NULL,
	"ghanapost_gps" text,
	"region" text NOT NULL,
	"district" text,
	"mmda" text,
	"town" text,
	"street" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"address_source" text DEFAULT 'manual' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "property_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "property_code_check" CHECK ("property"."code" ~ '^[A-Z]{2,4}-[A-Z0-9]{2,4}$'),
	CONSTRAINT "property_type_check" CHECK ("property"."property_type" in ('apartment_block', 'house', 'compound_house', 'shop', 'office', 'warehouse', 'mixed_use', 'gated_estate')),
	CONSTRAINT "property_use_check" CHECK ("property"."use" in ('residential', 'commercial', 'mixed')),
	CONSTRAINT "property_address_source_check" CHECK ("property"."address_source" in ('lookup', 'manual')),
	CONSTRAINT "property_pin_check" CHECK (("property"."latitude" is null) = ("property"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "property_file" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"upload_intent_id" uuid NOT NULL,
	"document_id" uuid,
	"thumbnail_document_id" uuid,
	"caption" text,
	"original_filename" text,
	"error" text,
	"uploaded_by" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_file_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "property_file_upload_key" UNIQUE("company_id","upload_intent_id"),
	CONSTRAINT "property_file_category_check" CHECK ("property_file"."category" in ('photo', 'title_or_indenture', 'site_plan', 'building_permit', 'other')),
	CONSTRAINT "property_file_status_check" CHECK ("property_file"."status" in ('processing', 'ready', 'failed')),
	CONSTRAINT "property_file_ready_check" CHECK ("property_file"."status" <> 'ready' or "property_file"."document_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "property_ownership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	"effective_from" date NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_ownership_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "property_ownership_owner_date_key" UNIQUE("company_id","property_id","effective_from","owner_id"),
	CONSTRAINT "property_ownership_share_check" CHECK ("property_ownership"."share_bps" > 0 and "property_ownership"."share_bps" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "register_import" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"upload_intent_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"report" jsonb,
	"error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	CONSTRAINT "register_import_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "register_import_upload_key" UNIQUE("company_id","upload_intent_id"),
	CONSTRAINT "register_import_status_check" CHECK ("register_import"."status" in ('uploaded', 'validating', 'validated', 'invalid', 'committing', 'committed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"unit_type" text NOT NULL,
	"bedrooms" smallint,
	"billing_band" text NOT NULL,
	"band_override_reason" text,
	"availability" text DEFAULT 'available' NOT NULL,
	"floor" text,
	"description" text,
	"amenities" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "unit_company_property_id_key" UNIQUE("company_id","property_id","id"),
	CONSTRAINT "unit_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "unit_label_key" UNIQUE("company_id","block_id","label"),
	CONSTRAINT "unit_code_check" CHECK ("unit"."code" ~ '^[A-Z]{2,4}-[A-Z0-9]{2,4}-[A-Z0-9]{1,3}-[A-Z0-9]{1,4}$'),
	CONSTRAINT "unit_type_check" CHECK ("unit"."unit_type" in ('single_room', 'chamber_and_hall', 'single_room_self_contained', 'studio', 'apartment', 'detached_house', 'semi_detached_house', 'townhouse', 'shop', 'store', 'office', 'warehouse', 'kiosk')),
	CONSTRAINT "unit_band_check" CHECK ("unit"."billing_band" in ('single_room', 'self_contained', 'commercial')),
	CONSTRAINT "unit_availability_check" CHECK ("unit"."availability" in ('available', 'reserved', 'under_repair', 'not_lettable')),
	CONSTRAINT "unit_bedrooms_check" CHECK ("unit"."bedrooms" is null or "unit"."bedrooms" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "unit_meter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_meter_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "unit_meter_link_key" UNIQUE("company_id","meter_id","unit_id")
);
--> statement-breakpoint
CREATE TABLE "unit_status_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_value" text,
	"to_value" text NOT NULL,
	"reason" text,
	"source" text NOT NULL,
	"lease_id" uuid,
	"actor_person_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_status_event_company_id_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "unit_status_event_kind_check" CHECK ("unit_status_event"."kind" in ('availability', 'occupancy')),
	CONSTRAINT "unit_status_event_source_check" CHECK ("unit_status_event"."source" in ('created', 'manual', 'import', 'lease'))
);
--> statement-breakpoint
ALTER TABLE "country" ADD COLUMN "regions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "country" ADD COLUMN "meter_suppliers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_company_id_property_id_property_company_id_id_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter" ADD CONSTRAINT "meter_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter" ADD CONSTRAINT "meter_company_id_property_id_property_company_id_id_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner" ADD CONSTRAINT "owner_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_company_id_portfolio_id_portfolio_company_id_id_fk" FOREIGN KEY ("company_id","portfolio_id") REFERENCES "public"."portfolio"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_file" ADD CONSTRAINT "property_file_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_file" ADD CONSTRAINT "property_file_uploaded_by_person_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_file" ADD CONSTRAINT "property_file_company_id_property_id_property_company_id_id_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_file" ADD CONSTRAINT "property_file_company_id_document_id_document_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_file" ADD CONSTRAINT "property_file_company_id_thumbnail_document_id_document_company_id_id_fk" FOREIGN KEY ("company_id","thumbnail_document_id") REFERENCES "public"."document"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ownership" ADD CONSTRAINT "property_ownership_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ownership" ADD CONSTRAINT "property_ownership_recorded_by_person_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ownership" ADD CONSTRAINT "property_ownership_company_id_property_id_property_company_id_id_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."property"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ownership" ADD CONSTRAINT "property_ownership_company_id_owner_id_owner_company_id_id_fk" FOREIGN KEY ("company_id","owner_id") REFERENCES "public"."owner"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_import" ADD CONSTRAINT "register_import_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_import" ADD CONSTRAINT "register_import_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_company_id_property_id_block_id_block_company_id_property_id_id_fk" FOREIGN KEY ("company_id","property_id","block_id") REFERENCES "public"."block"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_meter" ADD CONSTRAINT "unit_meter_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_meter" ADD CONSTRAINT "unit_meter_company_id_property_id_meter_id_meter_company_id_property_id_id_fk" FOREIGN KEY ("company_id","property_id","meter_id") REFERENCES "public"."meter"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_meter" ADD CONSTRAINT "unit_meter_company_id_property_id_unit_id_unit_company_id_property_id_id_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_status_event" ADD CONSTRAINT "unit_status_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_status_event" ADD CONSTRAINT "unit_status_event_company_id_property_id_unit_id_unit_company_id_property_id_id_fk" FOREIGN KEY ("company_id","property_id","unit_id") REFERENCES "public"."unit"("company_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_one_default" ON "portfolio" USING btree ("company_id") WHERE "portfolio"."is_default";--> statement-breakpoint
CREATE INDEX "property_location_idx" ON "property" USING btree ("company_id","region","district");--> statement-breakpoint
CREATE INDEX "property_file_property_idx" ON "property_file" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "property_ownership_owner_idx" ON "property_ownership" USING btree ("company_id","owner_id");--> statement-breakpoint
CREATE INDEX "unit_property_idx" ON "unit" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "unit_filter_idx" ON "unit" USING btree ("company_id","unit_type","availability");--> statement-breakpoint
CREATE INDEX "unit_meter_unit_idx" ON "unit_meter" USING btree ("company_id","unit_id");--> statement-breakpoint
CREATE INDEX "unit_status_event_unit_idx" ON "unit_status_event" USING btree ("company_id","unit_id","occurred_at");