import { eq, schema, sql, withCompany } from '@rent/db';
import { ONBOARDING_WORKBOOKS, type OnboardingSheetKey } from '@rent/domain/onboarding';
import { XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import type { Actor } from '@rent/domain/policy';
import writeXlsxFile from 'write-excel-file/node';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import { MetersService } from '../../src/portfolio/meters.service';
import { RegisterImportService } from '../../src/portfolio/register-import.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

/**
 * M11 onboarding (decisions 2 and 3; P25) wired as `OnboardingModule` wires it, on the test
 * database (CLAUDE.md section 12), with the register import for step 1. The `opening_balances`
 * approval is registered on `s.approvals`.
 */
export function onboardingServices(ctx: ServerTestContext, s: TenancyServices, b: BillingServices) {
  const registerImports = new RegisterImportService(
    ctx.database,
    s.policy,
    s.documents,
    s.register,
    new MetersService(ctx.database, s.policy),
    s.owners,
    ctx.storage,
    ctx.config,
    ctx.clock,
  );
  const onboarding = new OnboardingService(
    ctx.database,
    s.policy,
    s.approvals,
    s.documents,
    b.engine,
    b.posting,
    s.rules,
    s.tenants,
    s.leases,
    registerImports,
    ctx.storage,
    ctx.config,
    ctx.clock,
  );
  onboarding.registerApprovals();
  return { registerImports, onboarding };
}

export type OnboardingServices = ReturnType<typeof onboardingServices>;

type Cell = string | number | null | undefined;

/**
 * A workbook of the given kind, its sheets built from the domain's column lists: each row an
 * object keyed by column key. Sheets not given are left out.
 */
export function onboardingWorkbook(
  kind: keyof typeof ONBOARDING_WORKBOOKS,
  rows: Partial<Record<OnboardingSheetKey, Record<string, Cell>[]>>,
): Promise<Buffer> {
  const sheets = ONBOARDING_WORKBOOKS[kind]
    .filter((s) => rows[s.key] !== undefined)
    .map((s) => ({
      sheet: s.sheet,
      data: [
        s.columns.map((c) => ({ value: c.header })),
        ...(rows[s.key] ?? []).map((r) =>
          s.columns.map((c) => {
            const v = r[c.key];
            return v === null || v === undefined ? null : { value: v };
          }),
        ),
      ],
    }));
  return writeXlsxFile(sheets).toBuffer();
}

/** Uploads a workbook where a presigned upload would put it, as the browser does. */
export async function uploadBatch(
  ctx: ServerTestContext,
  o: OnboardingServices,
  actor: Actor,
  kind: 'tenancies' | 'balances' | 'adjustment',
  file: Buffer,
): Promise<string> {
  const { batchId, upload } = await o.onboarding.createUpload(actor, {
    kind,
    sizeBytes: file.length,
    fileName: `${kind}.xlsx`,
  });
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: file,
    contentType: XLSX_CONTENT_TYPE,
  });
  return batchId;
}

/** A batch row, in the system context. */
export async function batchRecord(ctx: ServerTestContext, companyId: string, batchId: string) {
  const [row] = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.select().from(schema.onboardingBatch).where(eq(schema.onboardingBatch.id, batchId)),
  );
  return row!;
}

/** Starts the dry run and runs its job, as the worker would. */
export async function validated(
  ctx: ServerTestContext,
  o: OnboardingServices,
  actor: Actor & { companyId: string },
  batchId: string,
) {
  await o.onboarding.startValidation(actor, batchId);
  const row = await batchRecord(ctx, actor.companyId, batchId);
  await o.onboarding.validate(actor.companyId, batchId, row.validationId!);
  return o.onboarding.batch(actor, batchId);
}

/** Commits a tenancies batch and runs the commit job, as the worker would. */
export async function committed(
  ctx: ServerTestContext,
  o: OnboardingServices,
  actor: Actor & { companyId: string },
  batchId: string,
) {
  await o.onboarding.commit(actor, batchId);
  const row = await batchRecord(ctx, actor.companyId, batchId);
  if (row.status === 'committing')
    await o.onboarding.commitTenancies(actor.companyId, batchId, row.validationId!);
  return o.onboarding.batch(actor, batchId);
}

/** The outbox events of a type, in the system context. */
export async function outboxOf(ctx: ServerTestContext, companyId: string, type: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload, key: schema.outboxEvent.idempotencyKey })
      .from(schema.outboxEvent)
      .where(sql`${schema.outboxEvent.type} = ${type}`),
  );
}

/** Counts rows of a table in a company, in the system context. */
export async function countOf(
  ctx: ServerTestContext,
  companyId: string,
  table: string,
  where = 'true',
) {
  const rows = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table} where ${where}`)),
  );
  return rows.rows[0]!.n;
}
