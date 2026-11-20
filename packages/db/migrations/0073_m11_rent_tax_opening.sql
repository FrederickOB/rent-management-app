ALTER TABLE "rent_tax_item" DROP CONSTRAINT "rent_tax_item_kind_check";--> statement-breakpoint
ALTER TABLE "rent_tax_item" DROP CONSTRAINT "rent_tax_item_source_check";--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "property_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "lease_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "unit_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "lease_use" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "unit_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "tenant_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ALTER COLUMN "rate_rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_lease_check" CHECK (case when "rent_tax_item"."lease_id" is null
            then "rent_tax_item"."kind" in ('opening', 'reversal') and "rent_tax_item"."property_id" is null and "rent_tax_item"."tenant_id" is null
              and "rent_tax_item"."unit_id" is null and "rent_tax_item"."lease_use" is null and "rent_tax_item"."unit_code" is null and "rent_tax_item"."tenant_name" is null
              and "rent_tax_item"."payment_id" is null and "rent_tax_item"."withholding_id" is null and "rent_tax_item"."base_minor" = 0
            else "rent_tax_item"."kind" <> 'opening' and "rent_tax_item"."property_id" is not null and "rent_tax_item"."tenant_id" is not null
              and "rent_tax_item"."unit_id" is not null and "rent_tax_item"."lease_use" is not null and "rent_tax_item"."unit_code" is not null
              and "rent_tax_item"."tenant_name" is not null and "rent_tax_item"."rate_rule_id" is not null end);--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_kind_check" CHECK ("rent_tax_item"."kind" in ('receipt', 'carry_over', 'deposit_applied', 'withholding', 'reversal', 'withholding_offset', 'opening'));--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_source_check" CHECK (("rent_tax_item"."kind" not in ('withholding', 'withholding_offset') or "rent_tax_item"."withholding_id" is not null)
          and ("rent_tax_item"."kind" not in ('reversal', 'carry_over', 'deposit_applied') or "rent_tax_item"."withholding_id" is null)
          and ("rent_tax_item"."kind" <> 'receipt' or "rent_tax_item"."payment_id" is not null)
          and ("rent_tax_item"."kind" <> 'reversal' or "rent_tax_item"."payment_id" is not null or "rent_tax_item"."lease_id" is null));