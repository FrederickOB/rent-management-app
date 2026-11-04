ALTER TABLE "rent_tax_item" DROP CONSTRAINT "rent_tax_item_source_check";--> statement-breakpoint
DROP INDEX "rent_tax_item_one_per_receipt";--> statement-breakpoint
ALTER TABLE "withholding" ADD COLUMN "rent_tax_treatment" text;--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_per_release" ON "rent_tax_item" USING btree ("company_id","withholding_id","payment_id","lease_id") WHERE "rent_tax_item"."kind" = 'receipt' and "rent_tax_item"."withholding_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rent_tax_item_one_per_receipt" ON "rent_tax_item" USING btree ("company_id","payment_id","lease_id") WHERE "rent_tax_item"."kind" = 'receipt' and "rent_tax_item"."withholding_id" is null;--> statement-breakpoint
ALTER TABLE "rent_tax_item" ADD CONSTRAINT "rent_tax_item_source_check" CHECK (("rent_tax_item"."kind" not in ('withholding', 'withholding_offset') or "rent_tax_item"."withholding_id" is not null)
          and ("rent_tax_item"."kind" not in ('reversal', 'carry_over') or "rent_tax_item"."withholding_id" is null)
          and ("rent_tax_item"."kind" not in ('receipt', 'reversal') or "rent_tax_item"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "withholding" ADD CONSTRAINT "withholding_rent_tax_treatment_check" CHECK ("withholding"."rent_tax_treatment" is null or "withholding"."rent_tax_treatment" in ('accrued', 'letting_business', 'not_assessed'));