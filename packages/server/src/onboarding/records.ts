import { desc, eq, schema, sql, type Tx } from '@rent/db';
import type { OnboardingBatchKind, OnboardingBatchStatus } from '@rent/domain/onboarding';
import type { ImportIssue } from '@rent/domain/portfolio';
import { AppError, conflict, notFound } from '../core/errors';
import { sqlStateOf } from '../core/db-errors';
import { personContact } from '../identity/person-directory';

/**
 * Onboarding's own records (M11 decisions 2 and 3): batches and their reports, the opening items
 * posted, and the views the API returns. Amounts are integer pesewas.
 */

export type BatchRow = typeof schema.onboardingBatch.$inferSelect;

export interface SheetCounts {
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
}

/** The money a balances or adjustment commit posts, in total (signed in an adjustment). */
export interface BalanceTotals {
  readonly arrearsMinor: number;
  readonly advancesMinor: number;
  readonly depositsMinor: number;
  readonly withholdingMinor: number;
  readonly agentCashMinor: number;
  readonly rentTaxOutstandingMinor: number;
}

/**
 * A validation's report, stored with the batch. It never holds a cell's value: issues say what is
 * wrong, not what was typed, so the report (and the audit log that records the batch) never copies
 * a phone, an ID number or a TIN.
 */
export interface BatchReport {
  readonly sha256: string;
  readonly counts: Record<string, SheetCounts>;
  readonly issues: ImportIssue[];
  readonly issueCount: number;
  readonly totals: BalanceTotals | null;
}

export const MAX_REPORTED_ISSUES = 500;

export const emptyTotals = (): BalanceTotals => ({
  arrearsMinor: 0,
  advancesMinor: 0,
  depositsMinor: 0,
  withholdingMinor: 0,
  agentCashMinor: 0,
  rentTaxOutstandingMinor: 0,
});

/** Issues in sheet and row order, capped as PR-08 caps them. */
export function reportOf(input: {
  readonly sha256: string;
  readonly counts: Record<string, SheetCounts>;
  readonly issues: readonly ImportIssue[];
  readonly totals: BalanceTotals | null;
}): BatchReport {
  const issues = [...input.issues].sort(
    (a, b) => a.sheet.localeCompare(b.sheet) || (a.row ?? 0) - (b.row ?? 0),
  );
  return {
    sha256: input.sha256,
    counts: input.counts,
    issues: issues.slice(0, MAX_REPORTED_ISSUES),
    issueCount: issues.length,
    totals: input.totals,
  };
}

/** Whether a report would write nothing: every row already recorded as it says. */
export function nothingToWrite(report: BatchReport): boolean {
  return Object.values(report.counts).every((c) => c.create === 0 && c.update === 0);
}

export interface BatchView {
  readonly id: string;
  readonly kind: OnboardingBatchKind;
  readonly status: OnboardingBatchStatus;
  readonly fileName: string | null;
  readonly cutOverDate: string | null;
  readonly report: BatchReport | null;
  readonly error: string | null;
  readonly approval: {
    readonly requestId: string;
    readonly status: string;
    readonly selfConfirmFrom: Date | null;
  } | null;
  readonly createdBy: { readonly id: string; readonly name: string } | null;
  readonly createdAt: Date;
  readonly committedAt: Date | null;
  readonly postedAt: Date | null;
}

/** A batch with its approval and who uploaded it, in the caller's transaction. */
export async function batchViews(tx: Tx, rows: readonly BatchRow[]): Promise<BatchView[]> {
  const out: BatchView[] = [];
  for (const row of rows) {
    const [request] = row.approvalRequestId
      ? await tx
          .select({
            id: schema.approvalRequest.id,
            status: schema.approvalRequest.status,
            mode: schema.approvalRequest.mode,
            coolingOffUntil: schema.approvalRequest.coolingOffUntil,
          })
          .from(schema.approvalRequest)
          .where(eq(schema.approvalRequest.id, row.approvalRequestId))
      : [];
    const creator = await personContact(tx, row.createdBy);
    out.push({
      id: row.id,
      kind: row.kind as OnboardingBatchKind,
      status: row.status as OnboardingBatchStatus,
      fileName: row.fileName,
      cutOverDate: row.cutOverDate,
      report: (row.report as BatchReport | null) ?? null,
      error: row.error,
      approval: request
        ? {
            requestId: request.id,
            status: request.status,
            selfConfirmFrom: request.mode === 'single_user' ? request.coolingOffUntil : null,
          }
        : null,
      createdBy: creator ? { id: row.createdBy, name: creator.name } : null,
      createdAt: row.createdAt,
      committedAt: row.committedAt,
      postedAt: row.postedAt,
    });
  }
  return out;
}

export async function batchRow(
  tx: Tx,
  batchId: string,
  options: { readonly lock?: boolean } = {},
): Promise<BatchRow> {
  const query = tx
    .select()
    .from(schema.onboardingBatch)
    .where(eq(schema.onboardingBatch.id, batchId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Batch');
  return row;
}

export async function latestBatch(tx: Tx, kind: OnboardingBatchKind): Promise<BatchRow | null> {
  const [row] = await tx
    .select()
    .from(schema.onboardingBatch)
    .where(eq(schema.onboardingBatch.kind, kind))
    .orderBy(desc(schema.onboardingBatch.createdAt), desc(schema.onboardingBatch.id))
    .limit(1);
  return row ?? null;
}

/**
 * A batch waiting for its approval whose request closed without approval (rejected, withdrawn or
 * expired) is rejected: it never posts, and a corrected workbook is a new batch. The approvals
 * engine has no hook for a closed request, so this runs whenever batches are read.
 */
export async function settleClosedApprovals(tx: Tx): Promise<void> {
  await tx.execute(
    sql`update onboarding_batch b set status = 'rejected', updated_at = now()
        from approval_request r
        where r.company_id = b.company_id and r.id = b.approval_request_id
          and b.status = 'awaiting_approval'
          and (r.status in ('rejected', 'cancelled', 'expired')
               or (r.status in ('pending', 'cooling_off') and r.expires_at <= now()))`,
  );
}

/** The company's cut-over, and whether opening balances have fixed it. */
export async function cutOverOf(
  tx: Tx,
  companyId: string,
): Promise<{ readonly date: string; readonly fixed: boolean } | null> {
  const [row] = await tx
    .select()
    .from(schema.companyOnboarding)
    .where(eq(schema.companyOnboarding.companyId, companyId));
  return row ? { date: row.cutOverDate, fixed: row.fixedAt !== null } : null;
}

/** An opening item as posted, signed (an adjustment that lowers is negative). */
export interface ItemRecord {
  readonly id: string;
  readonly batchId: string;
  readonly kind: 'arrears' | 'advance' | 'deposit' | 'withholding' | 'agent_cash' | 'rent_tax';
  readonly leaseId: string | null;
  readonly ownerId: string | null;
  readonly amountMinor: number;
  readonly dueOn: string | null;
  readonly periodStart: string | null;
  readonly invoiceLineId: string | null;
  readonly paymentId: string | null;
  readonly entryId: string | null;
  /** For arrears: the opening line's kind. */
  readonly lineKind: string | null;
}

/** Every opening item posted, in the company. */
export async function openingItems(tx: Tx): Promise<ItemRecord[]> {
  const rows = await tx.execute<{
    id: string;
    batch_id: string;
    kind: ItemRecord['kind'];
    lease_id: string | null;
    owner_id: string | null;
    amount_minor: string;
    due_on: string | null;
    period_start: string | null;
    invoice_line_id: string | null;
    payment_id: string | null;
    entry_id: string | null;
    line_kind: string | null;
  }>(
    sql`select o.id, o.batch_id, o.kind, o.lease_id, o.owner_id, o.amount_minor::text as amount_minor,
          o.due_on::text as due_on, o.period_start::text as period_start, o.invoice_line_id,
          o.payment_id, o.entry_id, l.kind as line_kind
        from onboarding_item o
        left join invoice_line l on l.company_id = o.company_id and l.id = o.invoice_line_id
        order by o.created_at, o.id`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    batchId: r.batch_id,
    kind: r.kind,
    leaseId: r.lease_id,
    ownerId: r.owner_id,
    amountMinor: Number(r.amount_minor),
    dueOn: r.due_on,
    periodStart: r.period_start,
    invoiceLineId: r.invoice_line_id,
    paymentId: r.payment_id,
    entryId: r.entry_id,
    lineKind: r.line_kind,
  }));
}

/**
 * The onboarding rules of 0068 and 0070 as named conflicts: the services check first, so these
 * fire only when two writes race or a check was missed. Null for any other failure.
 */
export function onboardingCheckConflict(error: unknown): AppError | null {
  switch (sqlStateOf(error)) {
    case 'RA120':
      return conflict(
        'cut_over_fixed',
        'The cut-over is fixed once opening balances are posted, so it no longer changes.',
      );
    case 'RA122':
      return conflict(
        'scan_present',
        'The scan of this imported lease is attached once, and is already there.',
      );
    case 'RA123':
      return conflict(
        'batch_busy',
        'This workbook cannot move that way now (it is being checked, committed or posted). Reload it.',
      );
    case 'RA124':
      return conflict(
        'approval_required',
        'Opening balances post only once a second person has approved them.',
      );
    case 'RA125':
      return conflict(
        'batch_not_posting',
        'Opening items are written only while their workbook posts. Reload it.',
      );
    default:
      return null;
  }
}

/** Runs `fn`, turning an onboarding database rule into its clear conflict (409). */
export async function withOnboardingChecks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const mapped = onboardingCheckConflict(error);
    if (mapped) throw mapped;
    throw error;
  }
}
