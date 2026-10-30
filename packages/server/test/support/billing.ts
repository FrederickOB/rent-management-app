import { schema, sql, withCompany } from '@rent/db';
import { CallbackAlert, type Alert } from '@rent/integrations';
import { BillingReadService } from '../../src/billing/billing-read.service';
import { BillingEngine } from '../../src/billing/engine';
import { InvoicingService } from '../../src/billing/invoicing.service';
import { MoneyService } from '../../src/billing/money.service';
import { SubledgerCheckService } from '../../src/billing/subledger-check.service';
import { PostingService } from '../../src/ledger/posting.service';
import { company, type ServerTestContext } from './index';
import { SAMPLE_PDF, staffIn, uploadLeaseFile, type TenancyServices } from './tenancy';

/** The M4a services wired as Nest wires them, on the test database (CLAUDE.md section 12). */
export function billingServices(ctx: ServerTestContext, s: TenancyServices) {
  const posting = new PostingService(ctx.audit);
  const engine = new BillingEngine(posting, s.documents, s.rules, ctx.clock);
  const invoicing = new InvoicingService(ctx.database, engine, posting, ctx.clock);
  const money = new MoneyService(
    ctx.database,
    s.policy,
    s.approvals,
    s.documents,
    engine,
    posting,
    ctx.clock,
  );
  money.registerApprovals();
  const alerts: Alert[] = [];
  const read = new BillingReadService(ctx.database, s.policy, engine, s.documents, ctx.clock);
  const subledger = new SubledgerCheckService(
    ctx.database,
    engine,
    new CallbackAlert((alert) => {
      alerts.push(alert);
    }),
  );
  return { posting, engine, invoicing, money, read, subledger, alerts };
}

export type BillingServices = ReturnType<typeof billingServices>;

/** Uploads a proof where a presigned upload would put it, as the browser does. */
export async function uploadMoneyProof(
  ctx: ServerTestContext,
  b: BillingServices,
  actor: Parameters<MoneyService['createUpload']>[0],
  purpose: 'cash_photo' | 'transfer_proof' | 'banking_slip',
): Promise<string> {
  const upload = await b.money.createUpload(actor, {
    purpose,
    contentType: 'application/pdf',
    sizeBytes: SAMPLE_PDF.length,
  });
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: SAMPLE_PDF,
    contentType: 'application/pdf',
  });
  return upload.uploadId;
}

/** The lease events tenancy has emitted and billing has not handled yet, handled as the worker would. */
export async function runLeaseEvents(
  ctx: ServerTestContext,
  b: BillingServices,
  companyId: string,
): Promise<number> {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({
        id: schema.outboxEvent.id,
        type: schema.outboxEvent.type,
        payload: schema.outboxEvent.payload,
      })
      .from(schema.outboxEvent)
      .where(
        sql`${schema.outboxEvent.type} in ('lease.signed', 'lease.activated', 'lease.ended', 'lease.cancelled')`,
      )
      .orderBy(schema.outboxEvent.createdAt, schema.outboxEvent.id),
  );
  for (const e of events) {
    const leaseId = (e.payload as { leaseId: string }).leaseId;
    if (e.type === 'lease.signed') await b.invoicing.onLeaseSigned(companyId, leaseId);
    if (e.type === 'lease.activated') await b.invoicing.onLeaseActivated(companyId, leaseId);
    if (e.type === 'lease.ended') await b.invoicing.onLeaseEnded(companyId, leaseId);
    if (e.type === 'lease.cancelled') await b.invoicing.onLeaseCancelled(companyId, leaseId);
  }
  return events.length;
}

/** Sums of the journal, as the owner role sees it (every row, no scope). */
export async function journalSum(
  ctx: ServerTestContext,
  companyId: string,
  where: string,
  values: unknown[] = [],
): Promise<number> {
  const rows = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ total: number }>(
      sql.raw(
        `select coalesce(sum(l.amount_minor), 0)::bigint as total from journal_line l join journal_entry e on e.id = l.entry_id where ${where.replace(
          /\$(\d+)/g,
          (_, i) => {
            const v = values[Number(i) - 1];
            return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
          },
        )}`,
      ),
    ),
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** A company with the people a money test needs, on top of the M3 fixtures. */
export async function moneyCompany(
  ctx: ServerTestContext,
  s: TenancyServices,
  kind: 'agency' | 'landlord',
  name: string,
) {
  const companyId = await company(ctx, kind, name);
  const admin = await staffIn(
    ctx,
    companyId,
    kind,
    kind === 'agency' ? 'agency_admin' : 'owner',
    `${name} admin`,
  );
  const manager = await staffIn(ctx, companyId, kind, 'property_manager', `${name} manager`);
  const accountant = await staffIn(ctx, companyId, kind, 'accountant', `${name} accountant`);
  return { companyId, admin, manager, accountant };
}

/** Records a paper lease and runs billing's reaction to its signing, as the worker would. */
export async function billedLease(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  actor: Parameters<TenancyServices['leases']['recordPaper']>[0],
  input: Omit<
    Parameters<TenancyServices['leases']['recordPaper']>[1],
    'parties' | 'scanUploadId' | 'noticeDays'
  > & { readonly noticeDays?: number },
) {
  const lease = await s.leases.recordPaper(actor, {
    noticeDays: 30,
    parties: [{ role: 'tenant', name: 'Tenant' }],
    scanUploadId: await uploadLeaseFile(ctx, s, actor),
    ...input,
  });
  const companyId = (actor as { companyId: string }).companyId;
  await b.invoicing.onLeaseSigned(companyId, lease.id);
  return lease;
}

/** Records cash with its photo and has a second person approve it (BC-05, P06). */
export async function approvedCash(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  recorder: Parameters<MoneyService['recordCash']>[0],
  approver: Parameters<TenancyServices['approvals']['decide']>[0],
  input: { leaseId: string; amountMinor: number; receivedOn: string; method?: 'cash' | 'cheque' },
) {
  const photo = await uploadMoneyProof(ctx, b, recorder, 'cash_photo');
  const recorded = await b.money.recordCash(recorder, {
    leaseId: input.leaseId,
    method: input.method ?? 'cash',
    amountMinor: input.amountMinor,
    receivedOn: input.receivedOn,
    payerName: 'Payer',
    chequeNumber: input.method === 'cheque' ? '004512' : null,
    chequeBank: input.method === 'cheque' ? 'GCB Bank' : null,
    photoUploadId: photo,
  });
  await s.approvals.decide(approver, recorded.approvalId, { decision: 'approve' });
  return recorded;
}

/** Records a transfer with its proof and has a second person approve it (P28, P23). */
export async function approvedTransfer(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  recorder: Parameters<MoneyService['recordTransfer']>[0],
  approver: Parameters<TenancyServices['approvals']['decide']>[0],
  input: Omit<Parameters<MoneyService['recordTransfer']>[1], 'proofUploadId'>,
) {
  const proof = await uploadMoneyProof(ctx, b, recorder, 'transfer_proof');
  const recorded = await b.money.recordTransfer(recorder, { ...input, proofUploadId: proof });
  await s.approvals.decide(approver, recorded.approvalId, { decision: 'approve' });
  return recorded;
}

/** The lease's money card, in the system context. */
export function moneyCard(
  ctx: ServerTestContext,
  b: BillingServices,
  companyId: string,
  leaseId: string,
) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    b.read.leaseBillingIn(tx, companyId, leaseId),
  );
}

/** A lease's balance in one account, from the journal (credits negative). */
export function leaseAccount(
  ctx: ServerTestContext,
  companyId: string,
  leaseId: string,
  account: string,
): Promise<number> {
  return journalSum(ctx, companyId, `l.lease_id = $1 and l.account_code = $2`, [leaseId, account]);
}
