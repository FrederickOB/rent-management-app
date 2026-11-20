ALTER TABLE "withholding_certificate" DROP CONSTRAINT "withholding_certificate_posted_check";--> statement-breakpoint
ALTER TABLE "withholding_certificate" ADD CONSTRAINT "withholding_certificate_posted_check" CHECK (("withholding_certificate"."status" = 'confirmed') = ("withholding_certificate"."entry_id" is not null)
          and ("withholding_certificate"."status" = 'confirmed') = ("withholding_certificate"."debit_account" is not null)
          and ("withholding_certificate"."debit_account" is null or "withholding_certificate"."debit_account" in ('2200', '1160', '3900')));