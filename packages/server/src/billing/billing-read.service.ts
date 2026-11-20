import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  ne,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  AGE_BUCKETS,
  agedLines,
  chargedAfterEnd,
  creditableMinor,
  creditPools,
  forwardWalk,
  invoiceStatusOf,
  isTax,
  lineBalance,
  moneySummary,
  remainingAfterWalk,
  walkLines,
  writeOffableMinor,
  type AgeBucket,
  type InvoiceStatus,
} from '@rent/domain/billing';
import type { Actor } from '@rent/domain/policy';
import { companyRecord, staffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { forbidden, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { leaseLabels } from '../tenancy/billing-facts';
import { BillingEngine, dedupe, lastBillableDay, lineLabel, type LeaseState } from './engine';
import { MONEY_APPROVERS } from './money.service';
import { destinationForOwner } from '../companies/settlement-destinations';
import { DESTINATION_PROBLEM_TEXT } from '@rent/domain/payments';
import { ApprovalsService } from '../approvals/approvals.service';
import { bookOwners, linesOf } from '../ledger/ledger.queries';
import {
  bankableMinor,
  cashKey,
  formatInvoiceNumber,
  formatReceiptNumber,
  isoNow,
  loadAllocations,
  loadLines,
  paymentsByIds,
  pendingBanking,
  raisedOpeningLineIds,
  type AllocationRecord,
  type LineRecord,
  type PaymentRecord,
} from './records';

export interface RuleUsed {
  readonly ruleId: string;
  readonly key: string;
  readonly verificationStatus: 'verified' | 'from_prd' | 'unverified';
}

export interface InvoiceLineView {
  readonly id: string;
  readonly kind: LineRecord['kind'];
  readonly label: string;
  readonly baseLineId: string | null;
  readonly rateBps: number | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly dueDate: string;
  readonly amountMinor: number;
  readonly netMinor: number;
  readonly settledMinor: number;
  readonly creditedMinor: number;
  readonly writtenOffMinor: number;
  readonly outstandingMinor: number;
  /** The most a credit note may take off the line now (P27, the domain's own check). */
  readonly creditableMinor: number;
  /** The most a write-off may take off the line now (P24, the domain's own check). */
  readonly writeOffableMinor: number;
  readonly accrued: boolean;
  readonly rule: RuleUsed | null;
}

export interface AllocationView {
  readonly id: string;
  readonly invoiceLineId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly lineLabel: string;
  readonly source: AllocationRecord['source'];
  readonly paymentId: string | null;
  readonly receiptNumber: string | null;
  readonly amountMinor: number;
  readonly valueDate: string;
  readonly accountingDate: string;
  readonly createdAt: Date;
}

export interface InvoiceRowView {
  readonly id: string;
  readonly number: string;
  /** M11 (P25): `opening` holds the arrears and deposit brought in at the cut-over. */
  readonly kind: 'cycle' | 'deposit' | 'one_off' | 'opening';
  readonly leaseId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly totalMinor: number;
  readonly settledMinor: number;
  readonly outstandingMinor: number;
  readonly status: InvoiceStatus;
  readonly overdue: boolean;
  readonly hasVat: boolean;
  readonly unverifiedRules: boolean;
  readonly paymentReference: string;
}

export interface InvoiceDetailView extends InvoiceRowView {
  readonly lines: InvoiceLineView[];
  readonly allocations: AllocationView[];
  readonly billedTo: { readonly name: string; readonly tin: string | null };
  readonly billedFrom: { readonly name: string; readonly tin: string | null };
  readonly documentId: string | null;
  readonly notes: string[];
  readonly warnings: string[];
  /** M4b (BC-09): the reminder ladder's steps recorded for this invoice. */
  readonly reminders: readonly {
    readonly offsetDays: number;
    readonly status: 'sent' | 'skipped';
    readonly stepDate: string;
    readonly createdAt: Date;
  }[];
}

export interface LeaseBillingView {
  readonly leaseId: string;
  readonly paymentReference: string | null;
  readonly billingStartDate: string | null;
  readonly notBilledReason: 'joint_owners' | 'not_signed' | null;
  readonly dueNowMinor: number;
  readonly overdueMinor: number;
  readonly earnedUnpaidMinor: number;
  readonly paidUntil: string | null;
  readonly partial: { readonly monthStart: string; readonly amountMinor: number } | null;
  readonly unearnedRentMinor: number;
  readonly depositHeldMinor: number;
  readonly creditMinor: number;
  /**
   * Lines charged for periods after the lease's last day (a move-out recorded late). They stay
   * owed until a person asks for a credit note and a second person approves it (P27).
   */
  readonly chargedAfterEnd: readonly ChargedAfterEndView[];
  readonly currency: 'GHS';
  /** M4b (BC-04): whether a pay link can be sent now, and why not. */
  readonly payLink: {
    readonly available: boolean;
    readonly reason:
      | 'no_agreement'
      | 'no_active_account'
      | 'no_subaccount'
      | 'joint_owners'
      | 'not_billed'
      | 'nothing_due'
      | 'no_consent'
      | null;
    readonly text: string | null;
    readonly invoiceId: string | null;
  };
}

export interface ChargedAfterEndView {
  readonly lineId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly netMinor: number;
  readonly outstandingMinor: number;
  readonly creditableMinor: number;
}

const RECEIVED_INTO: Record<string, PaymentRowView['receivedInto']> = {
  '1050': 'provider',
  '1060': 'collector',
  '1010': 'owner_account',
  '1070': 'agency_account',
};

export interface PaymentRowView {
  readonly id: string;
  readonly method: 'cash' | 'cheque' | 'bank_transfer' | 'momo' | 'card' | 'test';
  readonly status: 'confirmed' | 'unmatched' | 'reversed';
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly leaseId: string | null;
  readonly tenantName: string | null;
  readonly unitCode: string | null;
  readonly propertyName: string | null;
  readonly ownerName: string | null;
  /** Whose book it is in: the owner, or null for money waiting in the company book. */
  readonly ownerId: string | null;
  /** Where the money went: with a provider, a collector, the owner's account or the agency's. */
  readonly receivedInto: 'provider' | 'collector' | 'owner_account' | 'agency_account';
  readonly receiptId: string | null;
  readonly receiptNumber: string | null;
  readonly creditMinor: number;
  readonly collectorName: string | null;
  readonly recordedByName: string | null;
  readonly payerName: string | null;
  readonly reference: string | null;
  readonly createdAt: Date;
}

export interface ReceiptView {
  readonly id: string;
  readonly number: string;
  readonly kind: 'receipt' | 'credit_receipt';
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly issuedAt: Date;
  readonly documentId: string | null;
  readonly tenantName: string | null;
  readonly unitCode: string | null;
  /** M4b (BC-06): the receipt on its way to the tenant. */
  readonly delivery: {
    readonly status: 'queued' | 'sent' | 'not_sent' | 'failed';
    readonly channel: 'push' | 'whatsapp' | 'sms' | 'email' | null;
    readonly sentAt: Date | null;
    readonly latencyMs: number | null;
  } | null;
}

export interface PaymentDetailView extends PaymentRowView {
  readonly allocations: AllocationView[];
  readonly receipts: ReceiptView[];
  readonly paidUntilAfter: string | null;
  readonly chequeNumber: string | null;
  readonly chequeBank: string | null;
  readonly note: string | null;
  readonly proofDocumentId: string | null;
  readonly reversalOptions: ('collector' | 'owner_account' | 'agency_account' | 'provider')[];
  readonly openApprovalId: string | null;
  /**
   * M4b: where a provider payment settles, the owner's account or the agency's (as the unmatched
   * queue says), so a match can be narrowed to that owner. Null for other money.
   */
  readonly settlesInto: 'owner_account' | 'agency_account' | null;
  /** M4b: the reversal, once reversed, by a person or by the provider (a chargeback). */
  readonly reversal: {
    readonly reason:
      'bounced_cheque' | 'wrong_entry' | 'wrong_lease' | 'other' | 'chargeback' | 'provider_refund';
    readonly note: string;
    readonly moneyNowIn: 'collector' | 'owner_account' | 'agency_account' | 'provider';
    readonly valueDate: string;
    readonly approvalId: string | null;
    readonly createdAt: Date;
  } | null;
}

export interface CashRecordView {
  readonly id: string;
  readonly status: 'awaiting_approval' | 'approved' | 'rejected' | 'cancelled';
  readonly method: 'cash' | 'cheque';
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly leaseId: string;
  readonly tenantName: string;
  readonly unitCode: string;
  readonly payerName: string;
  readonly collectorPersonId: string;
  readonly collectorName: string;
  readonly chequeNumber: string | null;
  readonly chequeBank: string | null;
  readonly photoDocumentId: string | null;
  readonly approvalId: string | null;
  readonly paymentId: string | null;
  readonly recordedByName: string;
  readonly createdAt: Date;
}

export interface CollectorCashView {
  readonly collectorPersonId: string;
  readonly collectorName: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly heldMinor: number;
  readonly bankingPendingMinor: number;
  /** What a new banking may ask for: held less banking waiting (the request's own check). */
  readonly bankableMinor: number;
  readonly oldestUnbankedOn: string | null;
}

export interface UnmatchedView {
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly receivedInto: 'owner_account' | 'agency_account' | 'provider';
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly senderReference: string | null;
  readonly note: string | null;
  readonly proofDocumentId: string | null;
  readonly createdAt: Date;
  // M4b (BC-12): provider money in the queue.
  readonly method: 'cash' | 'cheque' | 'bank_transfer' | 'momo' | 'card' | 'test';
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly settlesInto: 'owner_account' | 'agency_account' | null;
  readonly payerName: string | null;
  readonly payerPhoneMasked: string | null;
  readonly openRefund: {
    readonly refundId: string;
    readonly approvalId: string;
    readonly status: 'awaiting_approval' | 'approved';
  } | null;
}

export interface ArrearsView {
  readonly asOf: string;
  readonly by: 'tenant' | 'property' | 'owner';
  readonly rows: {
    readonly key: string;
    readonly label: string;
    readonly buckets: Record<AgeBucket, number>;
    readonly totalMinor: number;
    readonly oldestDueDate: string;
    readonly leaseIds: string[];
  }[];
  readonly totals: Record<AgeBucket, number>;
  readonly totalMinor: number;
}

type InvoiceRecord = typeof schema.invoice.$inferSelect;
/** How arrears are grouped (BC-08): by tenant, property or owner, from the invoice's snapshot. */
const GROUP_KEY: Record<ArrearsView['by'], (i: InvoiceRecord) => string> = {
  tenant: (i) => i.tenantId,
  property: (i) => i.propertyId,
  owner: (i) => i.ownerId,
};
const GROUP_LABEL: Record<ArrearsView['by'], (i: InvoiceRecord) => string | null> = {
  tenant: (i) => i.billedToName,
  property: (i) => i.propertyName,
  owner: () => null,
};

const emptyBuckets = (): Record<AgeBucket, number> =>
  Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;

const CASH_STATUS: Record<string, CashRecordView['status']> = {
  pending: 'awaiting_approval',
  cooling_off: 'awaiting_approval',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'cancelled',
};

/**
 * What staff see of the money (plan 4.12, 4.16, 4.18): invoices, the lease's money card, payments,
 * receipts, cash records, collectors' cash, unmatched receipts and arrears. Every figure is
 * derived from the ledger and its sub-ledgers in the reader's scope; none is stored.
 */
@Injectable()
export class BillingReadService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  private async today(tx: Tx, companyId: string): Promise<string> {
    return isoNow(this.clock, (await companyRecord(tx, companyId))!.timeZone);
  }

  // Invoices -------------------------------------------------------------------------------------

  async invoices(
    actor: Actor | null,
    filter: {
      readonly status?: InvoiceStatus;
      readonly overdue?: boolean;
      readonly leaseId?: string;
      readonly tenantId?: string;
      readonly propertyId?: string;
      readonly ownerId?: string;
      readonly dueFrom?: string;
      readonly dueTo?: string;
      readonly limit?: number;
    },
  ): Promise<InvoiceRowView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const i = schema.invoice;
      const conditions = [
        filter.leaseId ? eq(i.leaseId, filter.leaseId) : undefined,
        filter.tenantId ? eq(i.tenantId, filter.tenantId) : undefined,
        filter.propertyId ? eq(i.propertyId, filter.propertyId) : undefined,
        filter.ownerId ? eq(i.ownerId, filter.ownerId) : undefined,
        filter.dueFrom ? gte(i.dueDate, filter.dueFrom) : undefined,
        filter.dueTo ? lte(i.dueDate, filter.dueTo) : undefined,
      ].filter((c) => c !== undefined);
      const rows = await tx
        .select()
        .from(i)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(i.dueDate), desc(i.number))
        .limit(Math.min(filter.limit ?? 100, 500) * (filter.status || filter.overdue ? 5 : 1));
      const views = await this.invoiceRows(tx, staff.companyId, rows);
      return views
        .filter((v) => (filter.status ? v.status === filter.status : true))
        .filter((v) => (filter.overdue === undefined ? true : v.overdue === filter.overdue))
        .slice(0, filter.limit ?? 100)
        .map(({ lines: _lines, allocations: _allocations, ...row }) => row);
    });
  }

  /**
   * M7 (review M2): a lease's invoices with money still owed today (company date), in the caller's
   * transaction, oldest due first: what a rent demand may name, with the amounts the ledger and its
   * sub-ledgers give. `overdue` is past its due date.
   */
  async openInvoicesIn(
    tx: Tx,
    companyId: string,
    leaseId: string,
  ): Promise<
    {
      readonly id: string;
      readonly number: string;
      readonly dueDate: string;
      readonly outstandingMinor: number;
      readonly overdue: boolean;
    }[]
  > {
    const rows = await tx
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.leaseId, leaseId))
      .orderBy(asc(schema.invoice.dueDate), asc(schema.invoice.number));
    return (await this.invoiceRows(tx, companyId, rows))
      .filter((v) => v.outstandingMinor > 0)
      .map((v) => ({
        id: v.id,
        number: v.number,
        dueDate: v.dueDate,
        outstandingMinor: v.outstandingMinor,
        overdue: v.overdue,
      }));
  }

  private async invoiceRows(
    tx: Tx,
    companyId: string,
    rows: (typeof schema.invoice.$inferSelect)[],
  ): Promise<(InvoiceRowView & { lines: LineRecord[]; allocations: AllocationRecord[] })[]> {
    if (rows.length === 0) return [];
    const leaseIds = [...new Set(rows.map((r) => r.leaseId))];
    // M11 (load smoke): every lease's state in a fixed number of queries, not ten a lease.
    const states = await this.engine.loadMany(tx, companyId, leaseIds);
    const lines = [...states.values()].flatMap((st) => st.lines);
    // The allocations on these leases' own lines (what loadAllocations({ leaseIds }) gives).
    const allocations = [
      ...new Map(
        [...states.values()]
          .flatMap((st) => st.allocations)
          .filter((a) => leaseIds.includes(a.leaseId))
          .map((a) => [a.id, a]),
      ).values(),
    ];
    const owners = await ownerFacts(tx, [...new Set(rows.map((r) => r.ownerId))]);
    const ruleIds = [...new Set(lines.flatMap((l) => (l.ruleId ? [l.ruleId] : [])))];
    const rules = ruleIds.length
      ? await tx
          .select({ id: schema.rule.id, status: schema.rule.verificationStatus })
          .from(schema.rule)
          .where(inArray(schema.rule.id, ruleIds))
      : [];
    const unverified = new Set(rules.filter((r) => r.status !== 'verified').map((r) => r.id));
    const today = await this.today(tx, companyId);
    // Credit the lease holds pays periods as they start (P02): what is left to pay after it is
    // what the walk and ageing count, so an invoice paid ahead is never overdue (M4b review F5).
    const walks = new Map<string, ReturnType<BillingEngine['walk']>>();
    for (const [leaseId, state] of states) walks.set(leaseId, this.engine.walk(state));
    // Each line's balance needs only its own lease's allocations.
    const byLease = new Map<string, typeof allocations>();
    for (const a of allocations) byLease.set(a.leaseId, [...(byLease.get(a.leaseId) ?? []), a]);
    const linesOf = new Map<string, LineRecord[]>();
    for (const l of lines) linesOf.set(l.invoiceId, [...(linesOf.get(l.invoiceId) ?? []), l]);
    return rows.map((r) => {
      const mine = linesOf.get(r.id) ?? [];
      const own = byLease.get(r.leaseId) ?? [];
      const balances = mine.map((l) => lineBalance(l, own));
      const walk = walks.get(r.leaseId)!;
      const outstanding = mine.reduce((s, l) => s + remainingAfterWalk(l, own, walk), 0);
      return {
        id: r.id,
        number: formatInvoiceNumber(r.number),
        kind: r.kind as InvoiceRowView['kind'],
        leaseId: r.leaseId,
        tenantId: r.tenantId,
        tenantName: r.billedToName,
        unitId: r.unitId,
        unitCode: r.unitCode,
        propertyId: r.propertyId,
        propertyName: r.propertyName,
        ownerId: r.ownerId,
        ownerName: owners.get(r.ownerId)?.displayName ?? r.billedFromName,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        periodFrom: r.periodFrom,
        periodTo: r.periodTo,
        totalMinor: mine.reduce((s, l) => s + l.amountMinor, 0),
        settledMinor: balances.reduce((s, b) => s + b.settledMinor, 0),
        outstandingMinor: outstanding,
        status: invoiceStatusOf(balances),
        overdue: r.dueDate < today && outstanding > 0,
        hasVat: mine.some((l) => isTax(l.kind)),
        unverifiedRules: mine.some((l) => l.ruleId !== null && unverified.has(l.ruleId)),
        paymentReference: r.paymentReference,
        lines: mine,
        allocations,
      };
    });
  }

  async invoice(actor: Actor | null, invoiceId: string): Promise<InvoiceDetailView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, invoiceId));
      if (!row) throw notFound('Invoice');
      const [view] = await this.invoiceRows(tx, staff.companyId, [row]);
      const lineIds = new Set(view!.lines.map((l) => l.id));
      const mineAllocations = view!.allocations.filter((a) => lineIds.has(a.lineId));
      const rules = await this.rulesUsed(tx, view!.lines);
      const notes = await tx
        .select({ reason: schema.creditNote.reason, kind: schema.creditNote.kind })
        .from(schema.creditNote)
        .where(inArray(schema.creditNote.invoiceLineId, [...lineIds]))
        .orderBy(asc(schema.creditNote.createdAt));
      const documentId = row.renderRequestId
        ? await this.renderedDocument(tx, row.renderRequestId)
        : null;
      const reminders = await tx
        .select({
          offsetDays: schema.reminderSent.offsetDays,
          status: schema.reminderSent.status,
          stepDate: schema.reminderSent.stepDate,
          createdAt: schema.reminderSent.createdAt,
        })
        .from(schema.reminderSent)
        .where(eq(schema.reminderSent.invoiceId, invoiceId))
        .orderBy(asc(schema.reminderSent.offsetDays));
      const warnings = [
        ...new Map(
          [...rules.values()]
            .filter((r) => r.verificationStatus !== 'verified')
            .map((r) => [r.ruleId, r]),
        ).values(),
      ].map(
        (r) =>
          `The VAT and levy rates on this invoice come from a rule that is not verified yet (${r.key}, ${r.verificationStatus === 'from_prd' ? 'taken from the PRD' : 'unverified'}): the tax adviser is to confirm it (OQ-20).`,
      );
      const { lines: _lines, allocations: _allocations, ...base } = view!;
      const raised = await raisedOpeningLineIds(tx, view!.lines);
      return {
        ...base,
        lines: view!.lines.map((l) => {
          const line = this.lineView(l, view!.allocations, rules.get(l.id) ?? null);
          // A month brought in again by an adjustment shows as the raise (founder 2026-11-10).
          return raised.has(l.id)
            ? { ...line, label: `${line.label} (raised by an adjustment)` }
            : line;
        }),
        allocations: await this.allocationViews(tx, mineAllocations, view!.lines),
        billedTo: { name: row.billedToName, tin: row.billedToTin },
        billedFrom: { name: row.billedFromName, tin: row.billedFromTin },
        documentId,
        notes: [...new Set(notes.filter((n) => n.kind === 'system').map((n) => n.reason))],
        warnings,
        reminders: reminders.map((r) => ({ ...r, status: r.status as 'sent' | 'skipped' })),
      };
    });
  }

  private async rulesUsed(tx: Tx, lines: readonly LineRecord[]): Promise<Map<string, RuleUsed>> {
    const ids = [...new Set(lines.flatMap((l) => (l.ruleId ? [l.ruleId] : [])))];
    if (ids.length === 0) return new Map();
    const rows = await tx.select().from(schema.rule).where(inArray(schema.rule.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = new Map<string, RuleUsed>();
    for (const l of lines) {
      const r = l.ruleId ? byId.get(l.ruleId) : undefined;
      if (r)
        out.set(l.id, {
          ruleId: r.id,
          key: r.key,
          verificationStatus: r.verificationStatus as RuleUsed['verificationStatus'],
        });
    }
    return out;
  }

  private lineView(
    l: LineRecord,
    allocations: readonly AllocationRecord[],
    rule: RuleUsed | null,
  ): InvoiceLineView {
    const b = lineBalance(l, allocations);
    return {
      id: l.id,
      kind: l.kind,
      label: lineLabel(l),
      baseLineId: l.baseLineId,
      rateBps: l.rateBps,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      dueDate: l.dueDate,
      amountMinor: l.amountMinor,
      netMinor: b.netMinor,
      settledMinor: b.settledMinor,
      creditedMinor: l.amountMinor - b.netMinor,
      writtenOffMinor: b.writtenOffMinor,
      outstandingMinor: b.outstandingMinor,
      creditableMinor: creditableMinor(l, allocations),
      writeOffableMinor: writeOffableMinor(l, allocations),
      accrued: l.accrued,
      rule,
    };
  }

  private async allocationViews(
    tx: Tx,
    allocations: readonly AllocationRecord[],
    lines: readonly LineRecord[],
  ): Promise<AllocationView[]> {
    const byId = new Map(lines.map((l) => [l.id, l]));
    const missing = [...new Set(allocations.map((a) => a.lineId).filter((id) => !byId.has(id)))];
    if (missing.length) {
      const extra = await tx
        .select({ leaseId: schema.invoiceLine.leaseId })
        .from(schema.invoiceLine)
        .where(inArray(schema.invoiceLine.id, missing));
      for (const l of await loadLines(tx, [...new Set(extra.map((e) => e.leaseId))]))
        byId.set(l.id, l);
    }
    const paymentIds = [...new Set(allocations.flatMap((a) => (a.paymentId ? [a.paymentId] : [])))];
    const receipts = paymentIds.length
      ? await tx
          .select({ paymentId: schema.receipt.paymentId, number: schema.receipt.number })
          .from(schema.receipt)
          .where(
            and(inArray(schema.receipt.paymentId, paymentIds), eq(schema.receipt.kind, 'receipt')),
          )
      : [];
    const receiptOf = new Map(receipts.map((r) => [r.paymentId, formatReceiptNumber(r.number)]));
    return allocations.flatMap((a) => {
      const line = byId.get(a.lineId);
      if (!line) return [];
      return [
        {
          id: a.id,
          invoiceLineId: a.lineId,
          invoiceId: line.invoiceId,
          invoiceNumber: formatInvoiceNumber(line.invoiceNumber),
          lineLabel: lineLabel(line),
          source: a.source,
          paymentId: a.paymentId,
          receiptNumber: a.paymentId ? (receiptOf.get(a.paymentId) ?? null) : null,
          amountMinor: a.amountMinor,
          valueDate: a.valueDate,
          accountingDate: a.accountingDate,
          createdAt: a.createdAt,
        },
      ];
    });
  }

  private async renderedDocument(tx: Tx, renderRequestId: string): Promise<string | null> {
    const [row] = await tx
      .select({ documentId: schema.documentRenderRequest.documentId })
      .from(schema.documentRenderRequest)
      .where(eq(schema.documentRenderRequest.id, renderRequestId));
    return row?.documentId ?? null;
  }

  async invoiceDocumentUrl(actor: Actor | null, invoiceId: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, invoiceId));
      if (!row) throw notFound('Invoice');
      return row.renderRequestId ? this.renderedDocument(tx, row.renderRequestId) : null;
    });
    if (!documentId) throw notFound('Invoice PDF');
    const url = await this.documents.downloadUrl(staff.companyId, documentId);
    if (!url) throw notFound('Invoice PDF');
    return url;
  }

  // The lease's money card (AR-02, AR-03; plan 4.19) -----------------------------------------------

  async leaseBilling(actor: Actor | null, leaseId: string): Promise<LeaseBillingView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) =>
      this.leaseBillingIn(tx, staff.companyId, leaseId),
    );
  }

  /** The money card in the caller's transaction: also what tests and the seed check. */
  async leaseBillingIn(tx: Tx, companyId: string, leaseId: string): Promise<LeaseBillingView> {
    const state = await this.engine.load(tx, companyId, leaseId);
    const today = this.engine.today(state);
    const [reference] = await tx
      .select({ reference: schema.paymentReference.reference })
      .from(schema.paymentReference)
      .where(eq(schema.paymentReference.leaseId, leaseId));
    const walk = this.engine.walk(state);
    const pools = creditPools(state.payments, state.allocations);
    const summary = moneySummary({
      lines: state.lines,
      allocations: state.allocations,
      pools,
      walk,
      today,
    });
    const signed = state.lease.billingStartDate !== null && state.lease.status !== 'cancelled';
    return {
      leaseId,
      paymentReference: reference?.reference ?? null,
      billingStartDate: state.lease.billingStartDate,
      notBilledReason: !signed
        ? 'not_signed'
        : state.book.kind === 'not_billed'
          ? 'joint_owners'
          : null,
      dueNowMinor: summary.dueNowMinor,
      overdueMinor: summary.overdueMinor,
      earnedUnpaidMinor: summary.earnedUnpaidMinor,
      paidUntil: summary.paidUntil,
      partial: summary.partial,
      unearnedRentMinor: summary.unearnedRentMinor,
      depositHeldMinor: await this.engine.depositHeld(tx, leaseId),
      creditMinor: summary.creditMinor,
      chargedAfterEnd: this.chargedAfterEndOf(state),
      currency: 'GHS',
      payLink: await this.payLinkOf(tx, state, signed, today),
    };
  }

  /**
   * M6 decision 11: a tenant account statement for one lease, for the bot's "statement" (CM-03).
   * Invoices, payments received and credit notes from `from` (ISO date), with the balance and
   * paid-until from the money card. Every figure comes from the billing records and the engine.
   */
  async statementIn(
    tx: Tx,
    companyId: string,
    leaseId: string,
    from: string,
  ): Promise<{
    lines: {
      date: string;
      kind: 'invoice' | 'payment' | 'credit';
      reference: string;
      description: string;
      amountMinor: number;
    }[];
    dueNowMinor: number;
    paidUntil: string | null;
    creditMinor: number;
    nextDueDate: string | null;
    today: string;
  }> {
    const money = await this.leaseBillingIn(tx, companyId, leaseId);
    const state = await this.engine.load(tx, companyId, leaseId);
    const today = this.engine.today(state);
    const invoices = await tx.execute<{
      number: number;
      issue_date: string;
      total: string;
      kind: string;
    }>(
      sql`select i.number, i.issue_date::text as issue_date, i.kind, coalesce(sum(l.amount_minor), 0)::text as total
          from invoice i left join invoice_line l on l.company_id = i.company_id and l.invoice_id = i.id
          where i.lease_id = ${leaseId} and i.issue_date >= ${from}::date
          group by i.id order by i.issue_date, i.number`,
    );
    const receipts = await tx.execute<{
      number: number;
      received_on: string;
      amount: string;
      kind: string;
      method: string;
    }>(
      sql`select r.number, p.received_on::text as received_on, p.amount_minor::text as amount, r.kind, p.method
          from receipt r join payment p on p.company_id = r.company_id and p.id = r.payment_id
          where r.lease_id = ${leaseId} and p.received_on >= ${from}::date
          order by p.received_on, r.number`,
    );
    const credits = await tx.execute<{ created: string; amount: string; reason: string }>(
      sql`select created_at::date::text as created, amount_minor::text as amount, reason
          from credit_note where lease_id = ${leaseId} and created_at::date >= ${from}::date
          order by created_at`,
    );
    const [next] = (
      await tx.execute<{ due_date: string }>(
        sql`select due_date::text as due_date from invoice where lease_id = ${leaseId} and due_date > ${today}::date
            order by due_date limit 1`,
      )
    ).rows;
    const lines = [
      ...invoices.rows.map((i) => ({
        date: i.issue_date,
        kind: 'invoice' as const,
        reference: formatInvoiceNumber(i.number),
        description: i.kind === 'deposit' ? 'Deposit invoice' : 'Invoice',
        amountMinor: Number(i.total),
      })),
      ...receipts.rows.map((r) => ({
        date: r.received_on,
        kind: 'payment' as const,
        reference: formatReceiptNumber(r.number),
        description: r.kind === 'credit_receipt' ? 'Payment reversed' : 'Payment received',
        amountMinor: r.kind === 'credit_receipt' ? Number(r.amount) : -Number(r.amount),
      })),
      ...credits.rows.map((c) => ({
        date: c.created,
        kind: 'credit' as const,
        reference: 'Credit note',
        description: c.reason.slice(0, 120),
        amountMinor: -Number(c.amount),
      })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      lines,
      dueNowMinor: money.dueNowMinor,
      paidUntil: money.paidUntil,
      creditMinor: money.creditMinor,
      nextDueDate: next?.due_date ?? null,
      today,
    };
  }

  /**
   * Whether a pay link can be sent for the lease now (BC-04; plan 4.2), for its oldest invoice
   * with something left to pay: the owner's rent needs somewhere to settle, and the tenant a
   * channel with consent.
   */
  private async payLinkOf(
    tx: Tx,
    state: LeaseState,
    signed: boolean,
    today: string,
  ): Promise<LeaseBillingView['payLink']> {
    const no = (
      reason: NonNullable<LeaseBillingView['payLink']['reason']>,
      text: string,
      invoiceId: string | null = null,
    ) => ({
      available: false,
      reason,
      text,
      invoiceId,
    });
    if (!signed) return no('not_billed', 'The lease is not signed, so it is not billed');
    if (state.book.kind !== 'book')
      return no('joint_owners', DESTINATION_PROBLEM_TEXT.joint_owners);
    const walk = this.engine.walk(state);
    const left = new Map<string, number>();
    for (const line of state.lines)
      left.set(
        line.invoiceId,
        (left.get(line.invoiceId) ?? 0) + remainingAfterWalk(line, state.allocations, walk),
      );
    const open = [...new Map(state.lines.map((l) => [l.invoiceId, l])).values()]
      .filter((l) => (left.get(l.invoiceId) ?? 0) > 0)
      .sort((a, b) =>
        a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.invoiceNumber - b.invoiceNumber,
      );
    const invoiceId = open[0]?.invoiceId ?? null;
    const destination = await destinationForOwner(tx, state.company, state.book.ownerId, today);
    if (destination.kind === 'problem') return no(destination.problem, destination.text, invoiceId);
    if (!invoiceId) return no('nothing_due', 'Nothing is left to pay on this lease now');
    // M6 (review C2): any channel the send job can use, push and WhatsApp included.
    const consent = await tx.execute<{ channel: string; action: string }>(
      sql`select distinct on (c.channel) c.channel, c.action from consent_event c
          join tenant t on t.company_id = c.company_id and t.id = c.tenant_id
          where c.tenant_id = ${state.lease.tenantId} and c.tenant_contact_id is null
            and c.channel in ('push', 'whatsapp', 'sms', 'email')
            and ((c.channel = 'sms' and t.phone is not null) or (c.channel = 'email' and t.email is not null)
              or (c.channel = 'whatsapp' and coalesce(t.whatsapp_phone, t.phone) is not null)
              or (c.channel = 'push' and app.tenant_has_app(t.id)))
          order by c.channel, c.recorded_at desc, c.id desc`,
    );
    if (!consent.rows.some((c) => c.action === 'grant'))
      return no(
        'no_consent',
        'The tenant has not agreed to messages on any channel we have for them; hand them the link in person',
        invoiceId,
      );
    return { available: true, reason: null, text: null, invoiceId };
  }

  private chargedAfterEndOf(state: LeaseState): ChargedAfterEndView[] {
    const last = lastBillableDay(state.lease);
    if (!last) return [];
    return chargedAfterEnd(state.lines, last).map((l) => {
      const record = l as LineRecord;
      const b = lineBalance(record, state.allocations);
      return {
        lineId: record.id,
        invoiceId: record.invoiceId,
        invoiceNumber: formatInvoiceNumber(record.invoiceNumber),
        label: lineLabel(record),
        periodStart: record.periodStart!,
        periodEnd: record.periodEnd!,
        netMinor: b.netMinor,
        outstandingMinor: b.outstandingMinor,
        creditableMinor: creditableMinor(record, state.allocations),
      };
    });
  }

  // Payments and receipts ---------------------------------------------------------------------------

  async payments(
    actor: Actor | null,
    filter: {
      readonly leaseId?: string;
      readonly tenantId?: string;
      readonly propertyId?: string;
      readonly ownerId?: string;
      readonly status?: PaymentRowView['status'];
      readonly method?: PaymentRowView['method'];
      readonly from?: string;
      readonly to?: string;
      readonly limit?: number;
    },
  ): Promise<PaymentRowView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const p = schema.payment;
      const conditions = [
        filter.leaseId
          ? sql`(${p.leaseId} = ${filter.leaseId} or exists (select 1 from payment_match m where m.company_id = ${p.companyId} and m.payment_id = ${p.id} and m.lease_id = ${filter.leaseId}))`
          : undefined,
        filter.tenantId
          ? sql`(${p.tenantId} = ${filter.tenantId} or exists (select 1 from payment_match m where m.company_id = ${p.companyId} and m.payment_id = ${p.id} and m.tenant_id = ${filter.tenantId}))`
          : undefined,
        filter.propertyId
          ? sql`(${p.propertyId} = ${filter.propertyId} or exists (select 1 from payment_match m where m.company_id = ${p.companyId} and m.payment_id = ${p.id} and m.property_id = ${filter.propertyId}))`
          : undefined,
        filter.ownerId ? eq(p.ownerId, filter.ownerId) : undefined,
        filter.method ? eq(p.method, filter.method) : undefined,
        // M11 (P25): opening payments are not money received through the platform: no receipt,
        // never reversed. The lease's money card shows what they still hold.
        ne(p.sourceType, 'opening_balance'),
        filter.from ? gte(p.receivedOn, filter.from) : undefined,
        filter.to ? lte(p.receivedOn, filter.to) : undefined,
      ].filter((c) => c !== undefined);
      const rows = await tx
        .select({ id: p.id })
        .from(p)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(p.receivedOn), desc(p.id))
        .limit(Math.min(filter.limit ?? 100, 500) * (filter.status ? 5 : 1));
      const views = await this.paymentRows(
        tx,
        await paymentsByIds(
          tx,
          rows.map((r) => r.id),
        ),
      );
      return views
        .filter((v) => (filter.status ? v.status === filter.status : true))
        .sort((a, b) =>
          a.receivedOn === b.receivedOn
            ? a.id < b.id
              ? 1
              : -1
            : a.receivedOn < b.receivedOn
              ? 1
              : -1,
        )
        .slice(0, filter.limit ?? 100);
    });
  }

  private async paymentRows(tx: Tx, payments: readonly PaymentRecord[]): Promise<PaymentRowView[]> {
    if (payments.length === 0) return [];
    const labels = await leaseLabels(
      tx,
      payments.flatMap((p) => (p.leaseId ? [p.leaseId] : [])),
    );
    const allocations = await loadAllocations(tx, {
      leaseIds: [],
      paymentIds: payments.map((p) => p.id),
    });
    const receipts = await tx
      .select()
      .from(schema.receipt)
      .where(
        and(
          inArray(
            schema.receipt.paymentId,
            payments.map((p) => p.id),
          ),
          eq(schema.receipt.kind, 'receipt'),
        ),
      );
    const ownerIds = payments.flatMap((p) => (p.row.ownerId ? [p.row.ownerId] : []));
    const invoiceOwners = await tx
      .select({ leaseId: schema.invoice.leaseId, ownerId: schema.invoice.ownerId })
      .from(schema.invoice)
      .where(
        inArray(
          schema.invoice.leaseId,
          payments.flatMap((p) =>
            p.leaseId ? [p.leaseId] : ['00000000-0000-0000-0000-000000000000'],
          ),
        ),
      );
    const ownerOfLease = new Map(invoiceOwners.map((o) => [o.leaseId, o.ownerId]));
    const owners = await ownerFacts(tx, [...ownerIds, ...invoiceOwners.map((o) => o.ownerId)]);
    const people = await this.personNames(
      tx,
      payments.flatMap((p) =>
        [p.row.collectorPersonId, p.row.recordedBy].filter((x): x is string => !!x),
      ),
    );
    return payments.map((p) => {
      const label = p.leaseId ? labels.get(p.leaseId) : undefined;
      const receipt = receipts.find((r) => r.paymentId === p.id);
      const ownerId = p.row.ownerId ?? (p.leaseId ? ownerOfLease.get(p.leaseId) : undefined);
      const status: PaymentRowView['status'] = p.reversedAccountingDate
        ? 'reversed'
        : p.leaseId
          ? 'confirmed'
          : 'unmatched';
      return {
        id: p.id,
        method: p.row.method as PaymentRowView['method'],
        status,
        amountMinor: p.row.amountMinor,
        receivedOn: p.row.receivedOn,
        leaseId: p.leaseId,
        tenantName: label?.tenantName ?? null,
        unitCode: label?.unitCode ?? null,
        propertyName: label?.propertyName ?? null,
        ownerName: ownerId ? (owners.get(ownerId)?.displayName ?? null) : null,
        ownerId: ownerId ?? null,
        receivedInto: RECEIVED_INTO[p.row.cashAccount] ?? 'owner_account',
        receiptId: receipt?.id ?? null,
        receiptNumber: receipt ? formatReceiptNumber(receipt.number) : null,
        creditMinor: status === 'confirmed' ? this.engine.creditOf(p, allocations) : 0,
        collectorName: p.row.collectorPersonId
          ? (people.get(p.row.collectorPersonId) ?? null)
          : null,
        recordedByName: p.row.recordedBy ? (people.get(p.row.recordedBy) ?? null) : null,
        payerName: p.row.payerName,
        reference: p.row.senderReference,
        createdAt: p.row.createdAt,
      };
    });
  }

  private async personNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.person.id, name: schema.person.name })
      .from(schema.person)
      .where(inArray(schema.person.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async payment(actor: Actor | null, paymentId: string): Promise<PaymentDetailView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [payment] = await paymentsByIds(tx, [paymentId]);
      // M11 (P25): an opening payment is not a payment received through the platform.
      if (!payment || payment.opening) throw notFound('Payment');
      const [row] = await this.paymentRows(tx, [payment]);
      const allocations = await loadAllocations(tx, { leaseIds: [], paymentIds: [paymentId] });
      const lines = await loadLines(tx, [...new Set(allocations.map((a) => a.leaseId))]);
      const receipts = await this.receiptsWhere(tx, eq(schema.receipt.paymentId, paymentId));
      const [original] = await tx
        .select({ renderRequestId: schema.receipt.renderRequestId })
        .from(schema.receipt)
        .where(and(eq(schema.receipt.paymentId, paymentId), eq(schema.receipt.kind, 'receipt')));
      let paidUntilAfter: string | null = null;
      if (original?.renderRequestId) {
        const [render] = await tx
          .select({ data: schema.documentRenderRequest.data })
          .from(schema.documentRenderRequest)
          .where(eq(schema.documentRenderRequest.id, original.renderRequestId));
        paidUntilAfter = ((render?.data ?? {}) as { paidUntil?: string | null }).paidUntil ?? null;
      }
      const reversalOptions =
        row!.status === 'confirmed'
          ? await this.engine.reversalOptions(tx, payment, staff.companyKind)
          : row!.status === 'unmatched'
            ? [
                payment.row.cashAccount === '1050'
                  ? ('provider' as const)
                  : payment.row.cashAccount === '1070'
                    ? ('agency_account' as const)
                    : ('owner_account' as const),
              ]
            : [];
      const [reversed] = await tx
        .select()
        .from(schema.paymentReversal)
        .where(eq(schema.paymentReversal.paymentId, paymentId));
      const openId = (await this.approvals.openFor(tx, [paymentId], 'payment.reversal')).get(
        paymentId,
      );
      const open = openId ? { id: openId } : undefined;
      const [account] = payment.row.settlementAccountId
        ? await tx
            .select({ holder: schema.settlementAccount.holder })
            .from(schema.settlementAccount)
            .where(eq(schema.settlementAccount.id, payment.row.settlementAccountId))
        : [];
      return {
        ...row!,
        // As the unmatched queue says it (settlesInto there).
        settlesInto: !account
          ? null
          : account.holder !== 'agency' || staff.companyKind !== 'agency'
            ? ('owner_account' as const)
            : ('agency_account' as const),
        allocations: await this.allocationViews(tx, allocations, lines),
        receipts,
        paidUntilAfter,
        chequeNumber: payment.row.chequeNumber,
        chequeBank: payment.row.chequeBank,
        note: payment.row.note,
        proofDocumentId: payment.row.proofDocumentId,
        reversalOptions,
        openApprovalId: open?.id ?? null,
        reversal: reversed
          ? {
              reason: reversed.reason as NonNullable<PaymentDetailView['reversal']>['reason'],
              note: reversed.note,
              moneyNowIn: reversed.moneyNowIn as NonNullable<
                PaymentDetailView['reversal']
              >['moneyNowIn'],
              valueDate: reversed.valueDate,
              approvalId: reversed.approvalRequestId,
              createdAt: reversed.createdAt,
            }
          : null,
      };
    });
  }

  private async receiptsWhere(
    tx: Tx,
    where: ReturnType<typeof eq> | ReturnType<typeof and>,
  ): Promise<ReceiptView[]> {
    const rows = await tx
      .select({
        receipt: schema.receipt,
        documentId: schema.documentRenderRequest.documentId,
        delivery: schema.receiptDelivery,
      })
      .from(schema.receipt)
      .leftJoin(
        schema.documentRenderRequest,
        and(
          eq(schema.documentRenderRequest.companyId, schema.receipt.companyId),
          eq(schema.documentRenderRequest.id, schema.receipt.renderRequestId),
        ),
      )
      .leftJoin(
        schema.receiptDelivery,
        and(
          eq(schema.receiptDelivery.companyId, schema.receipt.companyId),
          eq(schema.receiptDelivery.receiptId, schema.receipt.id),
        ),
      )
      .where(where)
      .orderBy(desc(schema.receipt.number))
      .limit(500);
    const labels = await leaseLabels(
      tx,
      rows.map((r) => r.receipt.leaseId),
    );
    return rows.map(({ receipt, documentId, delivery }) => ({
      id: receipt.id,
      number: formatReceiptNumber(receipt.number),
      kind: receipt.kind as ReceiptView['kind'],
      paymentId: receipt.paymentId,
      amountMinor: receipt.amountMinor,
      issuedAt: receipt.issuedAt,
      documentId: documentId ?? null,
      tenantName: labels.get(receipt.leaseId)?.tenantName ?? null,
      unitCode: labels.get(receipt.leaseId)?.unitCode ?? null,
      delivery: delivery
        ? {
            status: delivery.status as NonNullable<ReceiptView['delivery']>['status'],
            channel: delivery.channel as 'push' | 'whatsapp' | 'sms' | 'email' | null,
            sentAt: delivery.sentAt,
            latencyMs: delivery.latencyMs,
          }
        : null,
    }));
  }

  async receipts(
    actor: Actor | null,
    filter: {
      readonly leaseId?: string;
      readonly from?: string;
      readonly to?: string;
      readonly limit?: number;
    },
  ): Promise<ReceiptView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const r = schema.receipt;
      const conditions = [
        filter.leaseId ? eq(r.leaseId, filter.leaseId) : undefined,
        filter.from ? sql`${r.issuedAt} >= ${filter.from}::date` : undefined,
        filter.to ? sql`${r.issuedAt} < (${filter.to}::date + 1)` : undefined,
      ].filter((c) => c !== undefined);
      const rows = await this.receiptsWhere(
        tx,
        conditions.length ? and(...conditions)! : (sql`true` as never),
      );
      return rows.slice(0, filter.limit ?? 100);
    });
  }

  async receiptDocumentUrl(actor: Actor | null, receiptId: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx.select().from(schema.receipt).where(eq(schema.receipt.id, receiptId));
      if (!row) throw notFound('Receipt');
      return row.renderRequestId ? this.renderedDocument(tx, row.renderRequestId) : null;
    });
    if (!documentId) throw notFound('Receipt PDF');
    const url = await this.documents.downloadUrl(staff.companyId, documentId);
    if (!url) throw notFound('Receipt PDF');
    return url;
  }

  // Evidence (BC-05) -------------------------------------------------------------------------------

  /**
   * A short-lived link to a cash or cheque photo, a transfer proof or a banking slip. For people
   * who see billing (in their scope); for the people who may decide the record's open request,
   * so an approver sees the receipt-book page first; and for a caretaker, their own records.
   */
  async paymentFileUrl(actor: Actor | null, documentId: string): Promise<string> {
    const staff = staffActor(actor);
    const allowed = await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{
        kind: string;
        collector: string | null;
        recorded_by: string | null;
        approval_id: string | null;
      }>(
        sql`select 'cash_record' as kind, collector_person_id as collector, recorded_by, approval_request_id as approval_id
              from cash_record where photo_document_id = ${documentId}
            union all
            select 'direct_receipt', null, recorded_by, approval_request_id
              from direct_receipt where proof_document_id = ${documentId}
            union all
            select 'cash_banking', collector_person_id, recorded_by, approval_request_id
              from cash_banking where slip_document_id = ${documentId}
            union all
            select 'payment', collector_person_id, recorded_by, null
              from payment where proof_document_id = ${documentId}`,
      );
      if (rows.rows.length === 0) return false;
      if (this.policy.can(staff, 'billing.view').allowed) return true;
      for (const row of rows.rows) {
        const own = row.collector === staff.personId || row.recorded_by === staff.personId;
        if (own && this.policy.can(staff, 'cash.view_own').allowed) return true;
        if (!row.approval_id) continue;
        const request = (await this.approvals.requestsIn(tx, [row.approval_id])).get(
          row.approval_id,
        );
        if (
          request &&
          ['pending', 'cooling_off'].includes(request.status) &&
          this.policy.can(staff, 'approval.decide', {
            initiatorPersonId: request.initiatedBy,
            eligibleRoles: MONEY_APPROVERS,
            propertyId: request.propertyId,
            scopeProperties: (
              await tx.execute<{ scope: string[] | null }>(
                sql`select app.property_scope()::text[] as scope`,
              )
            ).rows[0]?.scope,
          }).allowed
        )
          return true;
      }
      return null;
    });
    if (allowed === false) throw notFound('File');
    if (allowed === null) throw forbidden();
    const url = await this.documents.downloadUrl(staff.companyId, documentId, undefined, {
      viewer: staff.personId,
    });
    if (!url) throw notFound('File');
    return url;
  }

  // Cash (BC-05) -------------------------------------------------------------------------------------

  /** Cash and cheques recorded: everything in scope with billing.view; a caretaker sees their own. */
  async cashRecords(
    actor: Actor | null,
    filter: {
      readonly status?: CashRecordView['status'];
      readonly leaseId?: string;
      readonly limit?: number;
      readonly ids?: readonly string[];
    },
  ): Promise<CashRecordView[]> {
    const staff = staffActor(actor);
    const all = this.policy.can(staff, 'billing.view').allowed;
    if (!all) this.policy.assert(staff, 'cash.view_own');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const c = schema.cashRecord;
      const conditions = [
        filter.leaseId ? eq(c.leaseId, filter.leaseId) : undefined,
        filter.ids ? inArray(c.id, [...filter.ids]) : undefined,
        all
          ? undefined
          : sql`(${c.collectorPersonId} = ${staff.personId} or ${c.recordedBy} = ${staff.personId})`,
      ].filter((x) => x !== undefined);
      const records = await tx
        .select()
        .from(c)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(c.createdAt))
        .limit(500);
      const requests = await this.approvals.requestsIn(
        tx,
        records.map((r) => r.approvalRequestId),
      );
      const rows = records.map((record) => ({
        record,
        status: requests.get(record.approvalRequestId)?.status ?? null,
      }));
      const labels = await leaseLabels(
        tx,
        rows.map((r) => r.record.leaseId),
      );
      const people = await this.personNames(
        tx,
        rows.flatMap((r) => [r.record.collectorPersonId, r.record.recordedBy]),
      );
      const payments = rows.length
        ? await tx
            .select({ id: schema.payment.id, sourceId: schema.payment.sourceId })
            .from(schema.payment)
            .where(
              and(
                eq(schema.payment.sourceType, 'cash_record'),
                inArray(
                  schema.payment.sourceId,
                  rows.map((r) => r.record.id),
                ),
              ),
            )
        : [];
      const paymentOf = new Map(payments.map((p) => [p.sourceId, p.id]));
      return rows
        .map(({ record, status }) => ({
          id: record.id,
          status: CASH_STATUS[status ?? 'pending'] ?? 'awaiting_approval',
          method: record.method as 'cash' | 'cheque',
          amountMinor: record.amountMinor,
          receivedOn: record.receivedOn,
          leaseId: record.leaseId,
          tenantName: labels.get(record.leaseId)?.tenantName ?? '',
          unitCode: labels.get(record.leaseId)?.unitCode ?? '',
          payerName: record.payerName,
          collectorPersonId: record.collectorPersonId,
          collectorName: people.get(record.collectorPersonId) ?? '',
          chequeNumber: record.chequeNumber,
          chequeBank: record.chequeBank,
          photoDocumentId: record.photoDocumentId,
          approvalId: record.approvalRequestId,
          paymentId: paymentOf.get(record.id) ?? null,
          recordedByName: people.get(record.recordedBy) ?? '',
          createdAt: record.createdAt,
        }))
        .filter((r) => (filter.status ? r.status === filter.status : true))
        .slice(0, filter.limit ?? 100);
    });
  }

  /**
   * Undeposited cash per collector and owner (BC-05): 1060 for the collector in the owner's book,
   * from the journal. A caretaker sees their own, on the properties they see.
   */
  async collectorsCash(actor: Actor | null): Promise<CollectorCashView[]> {
    const staff = staffActor(actor);
    const all = this.policy.can(staff, 'billing.view').allowed;
    if (!all) this.policy.assert(staff, 'cash.view_own');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const journal = await linesOf(tx, {
        accounts: ['1060'],
        ...(all ? {} : { collectorIds: [staff.personId] }),
      });
      const lines = {
        rows: journal.map((l) => ({
          collector_id: l.collectorId as string,
          book_id: l.bookId,
          property_id: l.propertyId,
          amount_minor: l.amountMinor,
          value_date: l.valueDate,
        })),
      };
      const groups = new Map<string, typeof lines.rows>();
      for (const line of lines.rows) {
        const key = `${line.collector_id}|${line.book_id}`;
        groups.set(key, [...(groups.get(key) ?? []), line]);
      }
      const ownerOfBook = await bookOwners(tx, [...new Set(lines.rows.map((l) => l.book_id))]);
      const books = [...ownerOfBook].map(([id, ownerId]) => ({ id, ownerId }));
      const owners = await ownerFacts(
        tx,
        books.flatMap((b) => (b.ownerId ? [b.ownerId] : [])),
      );
      const people = await this.personNames(
        tx,
        lines.rows.map((l) => l.collector_id),
      );
      const pending = await pendingBanking(
        tx,
        staff.companyId,
        lines.rows.map((l) => l.collector_id),
      );
      const out: CollectorCashView[] = [];
      for (const [key, group] of groups) {
        const [collectorId, bookId] = key.split('|') as [string, string];
        const held = group.reduce((s, l) => s + Number(l.amount_minor), 0);
        if (held === 0) continue;
        const ownerId = ownerOfBook.get(bookId) ?? null;
        if (!ownerId) continue;
        // The oldest cash still in hand: first in, first out against what has left 1060.
        let gone = -group
          .filter((l) => Number(l.amount_minor) < 0)
          .reduce((s, l) => s + Number(l.amount_minor), 0);
        let oldest: string | null = null;
        for (const l of group.filter((x) => Number(x.amount_minor) > 0)) {
          if (gone >= Number(l.amount_minor)) {
            gone -= Number(l.amount_minor);
            continue;
          }
          oldest = l.value_date;
          break;
        }
        let ownerName = owners.get(ownerId)?.displayName ?? null;
        const property = group.find((l) => l.property_id)?.property_id;
        if (!ownerName && property) {
          const name = await tx.execute<{ name: string | null }>(
            sql`select app.property_owner_name(${staff.companyId}::uuid, ${property}::uuid) as name`,
          );
          ownerName = name.rows[0]?.name ?? null;
        }
        out.push({
          collectorPersonId: collectorId,
          collectorName: people.get(collectorId) ?? '',
          ownerId,
          ownerName: ownerName ?? '',
          heldMinor: held,
          bankingPendingMinor: pending.get(cashKey(collectorId, bookId)) ?? 0,
          bankableMinor: bankableMinor(held, pending.get(cashKey(collectorId, bookId)) ?? 0),
          oldestUnbankedOn: oldest,
        });
      }
      return out.sort((a, b) =>
        a.collectorName === b.collectorName
          ? a.ownerName.localeCompare(b.ownerName)
          : a.collectorName.localeCompare(b.collectorName),
      );
    });
  }

  // Unmatched receipts (P23) -------------------------------------------------------------------------

  async unmatched(actor: Actor | null): Promise<UnmatchedView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      // Money refunded to its payer (P31) has left the queue.
      const rows = await tx.execute<{ id: string }>(
        sql`select p.id from payment p where p.lease_id is null
            and not exists (select 1 from payment_match m where m.company_id = p.company_id and m.payment_id = p.id)
            and not exists (select 1 from payment_reversal r where r.company_id = p.company_id and r.payment_id = p.id)
            and not exists (select 1 from unmatched_refund f where f.company_id = p.company_id and f.payment_id = p.id
                            and f.status = 'refunded')
            order by p.received_on, p.id`,
      );
      const payments = await paymentsByIds(
        tx,
        rows.rows.map((r) => r.id),
      );
      const owners = await ownerFacts(
        tx,
        payments.flatMap((p) => (p.row.ownerId ? [p.row.ownerId] : [])),
      );
      const ids = payments.map((p) => p.id);
      const refunds = ids.length
        ? await tx
            .select({
              id: schema.unmatchedRefund.id,
              paymentId: schema.unmatchedRefund.paymentId,
              approvalId: schema.unmatchedRefund.approvalRequestId,
              status: schema.unmatchedRefund.status,
            })
            .from(schema.unmatchedRefund)
            .where(
              and(
                inArray(schema.unmatchedRefund.paymentId, ids),
                // `sent`: the provider is still making it; shown as approved (M4b review item 2).
                inArray(schema.unmatchedRefund.status, ['awaiting_approval', 'approved', 'sent']),
              ),
            )
        : [];
      const accounts = await tx
        .select({ id: schema.settlementAccount.id, holder: schema.settlementAccount.holder })
        .from(schema.settlementAccount);
      const holderOf = new Map(accounts.map((a) => [a.id, a.holder]));
      return payments.map((p) => {
        const refund = refunds.find((r) => r.paymentId === p.id) ?? null;
        const holder = p.row.settlementAccountId
          ? holderOf.get(p.row.settlementAccountId)
          : undefined;
        return {
          paymentId: p.id,
          amountMinor: p.amountMinor,
          receivedOn: p.row.receivedOn,
          receivedInto:
            p.row.cashAccount === '1050'
              ? ('provider' as const)
              : p.row.cashAccount === '1070'
                ? ('agency_account' as const)
                : ('owner_account' as const),
          ownerId: p.row.ownerId,
          ownerName: p.row.ownerId ? (owners.get(p.row.ownerId)?.displayName ?? null) : null,
          senderReference: p.row.senderReference,
          note: p.row.note,
          proofDocumentId: p.row.proofDocumentId,
          createdAt: p.row.createdAt,
          method: p.row.method as UnmatchedView['method'],
          provider: p.row.provider,
          providerReference: p.row.providerReference,
          settlesInto:
            holder === undefined
              ? null
              : holder !== 'agency' || staff.companyKind !== 'agency'
                ? ('owner_account' as const)
                : ('agency_account' as const),
          payerName: p.row.payerName,
          payerPhoneMasked: p.row.payerPhoneMasked,
          openRefund: refund
            ? {
                refundId: refund.id,
                approvalId: refund.approvalId,
                status:
                  refund.status === 'awaiting_approval'
                    ? ('awaiting_approval' as const)
                    : ('approved' as const),
              }
            : null,
        };
      });
    });
  }

  // Arrears (BC-08; plan 4.12) -------------------------------------------------------------------------

  /**
   * Overdue invoice lines aged by days past their due date, as of any date: lines issued by then,
   * with the allocations, payments, matches, reversals and accruals reported by then (their
   * accounting dates), and the credit the forward walk applies to lines not yet charged.
   */
  async arrears(
    actor: Actor | null,
    input: { readonly asOf?: string; readonly by: 'tenant' | 'property' | 'owner' },
  ): Promise<ArrearsView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) =>
      this.arrearsIn(tx, staff.companyId, input),
    );
  }

  async arrearsIn(
    tx: Tx,
    companyId: string,
    input: { readonly asOf?: string; readonly by: 'tenant' | 'property' | 'owner' },
  ): Promise<ArrearsView> {
    const asOf = input.asOf ?? (await this.today(tx, companyId));
    // Lines due before the date, whenever they were invoiced: a lease billed from an earlier
    // period start owed them then, and its accruals carry those dates in the ledger too.
    const invoices = await tx
      .select()
      .from(schema.invoice)
      .where(sql`${schema.invoice.dueDate} < ${asOf}::date`);
    const leaseIds = [...new Set(invoices.map((i) => i.leaseId))];
    const rows = new Map<
      string,
      { label: string; buckets: Record<AgeBucket, number>; oldest: string; leaseIds: Set<string> }
    >();
    const totals = emptyBuckets();
    const owners = await ownerFacts(tx, [...new Set(invoices.map((i) => i.ownerId))]);
    for (const leaseId of leaseIds) {
      const state = await this.asOfState(tx, companyId, leaseId, asOf);
      const walk = forwardWalk(
        walkLines({ lines: state.lines, allocations: state.allocations, scheduled: [] }),
        creditPools(state.payments, state.allocations),
      );
      const aged = agedLines({ lines: state.lines, allocations: state.allocations, walk, asOf });
      const invoice = invoices.find((i) => i.leaseId === leaseId)!;
      const key = GROUP_KEY[input.by](invoice);
      const label =
        GROUP_LABEL[input.by](invoice) ??
        owners.get(invoice.ownerId)?.displayName ??
        invoice.billedFromName;
      for (const line of aged) {
        const row = rows.get(key) ?? {
          label,
          buckets: emptyBuckets(),
          oldest: line.dueDate,
          leaseIds: new Set<string>(),
        };
        row.buckets[line.bucket] += line.amountMinor;
        totals[line.bucket] += line.amountMinor;
        if (line.dueDate < row.oldest) row.oldest = line.dueDate;
        row.leaseIds.add(leaseId);
        rows.set(key, row);
      }
    }
    const out = [...rows.entries()]
      .map(([key, r]) => ({
        key,
        label: r.label,
        buckets: r.buckets,
        totalMinor: AGE_BUCKETS.reduce((s, b) => s + r.buckets[b], 0),
        oldestDueDate: r.oldest,
        leaseIds: [...r.leaseIds].sort(),
      }))
      .sort((a, b) =>
        a.oldestDueDate === b.oldestDueDate
          ? a.label.localeCompare(b.label)
          : a.oldestDueDate < b.oldestDueDate
            ? -1
            : 1,
      );
    return {
      asOf,
      by: input.by,
      rows: out,
      totals,
      totalMinor: AGE_BUCKETS.reduce((s, b) => s + totals[b], 0),
    };
  }

  /** A lease's money as it stood on a date: what had been issued and reported by then. */
  private async asOfState(
    tx: Tx,
    companyId: string,
    leaseId: string,
    asOf: string,
  ): Promise<Pick<LeaseState, 'lines' | 'allocations' | 'payments'>> {
    const state = await this.engine.load(tx, companyId, leaseId);
    const lines = state.lines.map((l) => ({
      ...l,
      accrued: l.accruedAccounting !== null && l.accruedAccounting <= asOf,
    }));
    // The payments whose credit sat on the lease then: pools as of the date, before reversals.
    const candidates = await paymentsByIds(
      tx,
      (
        await tx.execute<{ id: string }>(
          sql`select p.id from payment p
              left join payment_match m on m.company_id = p.company_id and m.payment_id = p.id
              where p.lease_id = ${leaseId} or m.lease_id = ${leaseId}`,
        )
      ).rows.map((r) => r.id),
    );
    const payments = candidates.filter(
      (p) =>
        (p.row.leaseId
          ? p.row.accountingDate <= asOf
          : (p.matchAccountingDate ?? '9999') <= asOf) &&
        (p.reversedAccountingDate === null || p.reversedAccountingDate > asOf),
    );
    const allocations = dedupe([
      ...state.allocations,
      ...(await loadAllocations(tx, { leaseIds: [], paymentIds: payments.map((p) => p.id) })),
    ]).filter((a) => a.accountingDate <= asOf);
    return { lines, allocations, payments };
  }
}
