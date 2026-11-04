import { schema, sql, withCompany } from '@rent/db';
import { CallbackAlert, type Alert } from '@rent/integrations';
import { AdvanceService } from '../../src/billing/advance.service';
import { TerminationService } from '../../src/billing/termination.service';
import { GraService } from '../../src/tax/gra.service';
import { RentTaxService } from '../../src/tax/rent-tax.service';
import { TaxAlertsService } from '../../src/tax/tax-alerts.service';
import { TaxReportService } from '../../src/tax/tax-report.service';
import { WithholdingService } from '../../src/tax/withholding.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import { SAMPLE_PDF, type TenancyServices } from './tenancy';

/**
 * The M5 services wired as Nest wires them, on the test database (CLAUDE.md section 12): rent tax
 * registers its hooks with the billing engine of `b`, so every receipt, reversal and carry-over
 * after this call is taxed.
 */
export function taxServices(ctx: ServerTestContext, s: TenancyServices, b: BillingServices) {
  const alerts: Alert[] = [];
  const alertPort = new CallbackAlert((alert) => {
    alerts.push(alert);
  });
  const rentTax = new RentTaxService(b.engine, b.posting, s.rules, alertPort);
  const withholding = new WithholdingService(
    ctx.database,
    s.policy,
    s.approvals,
    s.documents,
    b.engine,
    b.posting,
    s.rules,
    rentTax,
    ctx.clock,
  );
  withholding.registerApprovals();
  const gra = new GraService(ctx.database, s.policy, s.documents, b.posting, ctx.clock);
  const reports = new TaxReportService(
    ctx.database,
    s.policy,
    s.documents,
    gra,
    withholding,
    ctx.clock,
  );
  const taxAlerts = new TaxAlertsService(ctx.database, s.policy, reports);
  const termination = new TerminationService(
    ctx.database,
    s.policy,
    s.approvals,
    s.documents,
    b.engine,
    ctx.clock,
  );
  termination.registerApprovals();
  const advance = new AdvanceService(ctx.database, s.policy, b.engine, ctx.clock);
  return { rentTax, withholding, gra, reports, taxAlerts, termination, advance, alerts };
}

export type TaxServices = ReturnType<typeof taxServices>;

/** Uploads an evidence file where a presigned upload would put it, as the browser does. */
export async function uploadEvidence(
  ctx: ServerTestContext,
  create: (input: { contentType: string; sizeBytes: number }) => Promise<{
    uploadId: string;
    fields: Record<string, string>;
  }>,
): Promise<string> {
  const upload = await create({ contentType: 'application/pdf', sizeBytes: SAMPLE_PDF.length });
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: SAMPLE_PDF,
    contentType: 'application/pdf',
  });
  return upload.uploadId;
}

/** A lease's rent tax items, oldest first, in the system context. */
export async function taxItemsOf(ctx: ServerTestContext, companyId: string, leaseId: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select()
      .from(schema.rentTaxItem)
      .where(sql`${schema.rentTaxItem.leaseId} = ${leaseId}`)
      .orderBy(schema.rentTaxItem.createdAt, schema.rentTaxItem.id),
  );
}

/** Marks an owner as being in the business of letting (M3 owner tax fields, decision 2). */
export async function setLettingBusiness(
  ctx: ServerTestContext,
  companyId: string,
  ownerId: string,
  value: boolean,
): Promise<void> {
  await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.owner)
      .set({ lettingBusiness: value })
      .where(sql`${schema.owner.id} = ${ownerId}`),
  );
}

/** Sets the company's advance rent policy (AR-05; OQ-28). */
export async function setAdvancePolicy(
  ctx: ServerTestContext,
  companyId: string,
  policy: 'off' | 'warn' | 'block',
): Promise<void> {
  await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.execute(
      sql`update company set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{advanceRentPolicy}', to_jsonb(${policy}::text)) where id = ${companyId}`,
    ),
  );
}
