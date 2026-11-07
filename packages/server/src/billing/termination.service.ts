import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, schema, withCompany, type Database, type Tx } from '@rent/db';
import {
  creditPools,
  lineBalance,
  linesAfterEnd,
  refundDue,
  unusedDaysCredits,
  withheldOn,
} from '@rent/domain/billing';
import { formatBusinessDate, parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import type { Actor } from '@rent/domain/policy';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, REFUND_PROOF_UPLOAD } from '../documents/documents.service';
import { assertAgentCash } from '../ledger/agent-cash';
import { PolicyService, staffContext } from '../policy/policy.service';
import { billingLeaseOf } from '../tenancy/billing-facts';
import { BillingEngine, creditNoteWithheld, lineLabel, type LeaseState } from './engine';
import { MONEY_APPROVERS } from './money.service';
import {
  formatInvoiceNumber,
  isoNow,
  leaseBookOf,
  leaseGroup,
  lockCounters,
  lockLeases,
  requireBook,
  type LineRecord,
} from './records';

export const LEASE_REFUND_ACTION = 'lease.refund';

const amountItem = z
  .object({
    description: z.string().trim().min(2).max(120),
    amountMinor: z.number().int().positive().max(100_000_000_000),
  })
  .strict();

export interface TerminationInput {
  /** Agreed termination charges (P01), raised as one-off lines. */
  readonly charges: readonly { readonly description: string; readonly amountMinor: number }[];
  /** Deductions from the refund, approved on the request and charged as one-off lines. */
  readonly deductions: readonly { readonly description: string; readonly amountMinor: number }[];
  readonly note?: string | null;
}

/** One open line the credit paid at an early end. */
export interface AppliedLine {
  readonly lineId: string;
  readonly invoiceNumber: string;
  readonly label: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly amountMinor: number;
}

/** The settlement, step by step, as staff see it before asking and as the approver decides it. */
export interface TerminationFigures {
  readonly leaseId: string;
  readonly lastDay: string;
  readonly endDate: string;
  readonly breakClauseCreditsUnusedDays: boolean;
  readonly creditBeforeMinor: number;
  readonly chargesMinor: number;
  readonly unusedDays: readonly {
    readonly lineId: string;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly unusedDays: number;
    readonly periodDays: number;
    readonly creditMinor: number;
  }[];
  readonly unusedDaysCreditMinor: number;
  readonly appliedMinor: number;
  /** What the credit paid on each open line, oldest first (P13 apply), deductions included. */
  readonly appliedLines: readonly AppliedLine[];
  readonly creditLeftMinor: number;
  readonly deductionsMinor: number;
  readonly refundMinor: number;
  /** Still owed after the credit is applied: arrears that stay on the lease (P11, collection, P24). */
  readonly arrearsMinor: number;
}

export interface TerminationView extends TerminationFigures {
  readonly id: string;
  readonly status: 'awaiting_approval' | 'settled' | 'refund_paid' | 'rejected';
  readonly approvalId: string;
  readonly charges: readonly { readonly description: string; readonly amountMinor: number }[];
  readonly deductions: readonly { readonly description: string; readonly amountMinor: number }[];
  readonly note: string | null;
  readonly settledOn: string | null;
  readonly paid: {
    readonly paidOn: string;
    readonly paidFrom: 'owner_account' | 'agency_account';
    readonly reference: string;
    readonly proofDocumentId: string;
  } | null;
  readonly createdAt: Date;
}

const payload = z
  .object({
    terminationId: z.string().uuid(),
    leaseId: z.string().uuid(),
    unitCode: z.string(),
    tenantName: z.string().nullable(),
    lastDay: z.string(),
    charges: z.array(amountItem),
    deductions: z.array(amountItem),
    chargesMinor: z.number().int(),
    unusedDaysCreditMinor: z.number().int(),
    appliedMinor: z.number().int(),
    deductionsMinor: z.number().int(),
    refundMinor: z.number().int(),
    arrearsMinor: z.number().int(),
    /** Decision fact: still waiting (not settled, rejected or replaced). */
    open: z.boolean(),
  })
  .strict();

/** Thrown to roll a preview back after its figures are known. */
class Preview extends Error {
  constructor(readonly figures: TerminationFigures) {
    super('preview');
  }
}

const sum = (items: readonly { readonly amountMinor: number }[]) =>
  items.reduce((s, i) => s + i.amountMinor, 0);

/** Each line's application with what the screens show of the line. */
function appliedLinesOf(
  applied: readonly { readonly lineId: string; readonly amountMinor: number }[],
  lines: ReadonlyMap<string, LineRecord>,
): AppliedLine[] {
  const totals = new Map<string, number>();
  for (const a of applied) totals.set(a.lineId, (totals.get(a.lineId) ?? 0) + a.amountMinor);
  return [...totals].map(([lineId, amountMinor]) => {
    const line = lines.get(lineId);
    return {
      lineId,
      invoiceNumber: line ? formatInvoiceNumber(line.invoiceNumber) : '',
      label: line ? lineLabel(line) : '',
      periodStart: line?.periodStart ?? null,
      periodEnd: line?.periodEnd ?? null,
      amountMinor,
    };
  });
}

/**
 * Early termination (AR-04, P13; M5 plan 5.4, decision 6). When a move-out ends a lease before its
 * end date, staff see the settlement step by step and ask for it as `lease.refund`; a second
 * person approves. On approval, in one transaction: agreed termination charges (P01), the unused
 * days of the last month credited where the break clause allows (P27; none otherwise, prd-issues
 * 36), the lease's credit applied to open lines oldest first (P13), deductions charged and paid
 * from the credit, and the positive remainder made a refund payable (P13). The refund is paid
 * outside the platform (D1) and recorded with a reference and proof. Rent tax on refunded money
 * is not reversed (OQ-19); lines still open stay as arrears.
 */
@Injectable()
export class TerminationService {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private unscoped(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  /**
   * The settlement for a lease that ended early, as it would be done now (nothing is kept). It
   * runs the real settlement in a savepoint under the same locks, so it is for the people who may
   * ask for the settlement (`billing.manage`; M5 review N3).
   */
  async preview(
    actor: Actor | null,
    leaseId: string,
    input: Pick<TerminationInput, 'charges' | 'deductions'>,
  ): Promise<TerminationFigures> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    await withCompany(this.database, staffContext(staff), (tx) => billingLeaseOf(tx, leaseId));
    return withCompany(this.database, this.unscoped(staff), async (tx) => {
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, leaseId));
      await lockCounters(tx, staff.companyId);
      return this.simulate(tx, staff.companyId, leaseId, input);
    });
  }

  /** Runs the settlement in a savepoint and rolls it back: the same code as the real one. */
  private async simulate(
    tx: Tx,
    companyId: string,
    leaseId: string,
    input: Pick<TerminationInput, 'charges' | 'deductions'>,
  ): Promise<TerminationFigures> {
    try {
      await tx.transaction(async (sp) => {
        const state = await this.engine.load(sp, companyId, leaseId);
        throw new Preview(await this.settle(sp, state, input, uuidv7(), null, null, true));
      });
    } catch (error) {
      if (error instanceof Preview) return error.figures;
      if (error instanceof DomainError) throw invalid(error.code, error.message);
      throw error;
    }
    throw new Error('unreachable');
  }

  /** The steps of plan 5.4, in order, in the caller's transaction. */
  private async settle(
    tx: Tx,
    state: LeaseState,
    input: Pick<TerminationInput, 'charges' | 'deductions'>,
    terminationId: string,
    approvalRequestId: string | null,
    causedBy: string | null,
    /** A preview has no termination row yet: the refund's per-payment shares are not kept. */
    preview = false,
  ): Promise<TerminationFigures> {
    const lease = state.lease;
    const lastDay = lease.moveOutDate ?? lease.endedOn;
    if (!['ended', 'terminated'].includes(lease.status) || !lastDay || lastDay >= lease.endDate)
      throw conflict(
        'not_ended_early',
        'An early-termination settlement is for a lease that ended before its end date',
      );
    requireBook(state.book);
    const after = linesAfterEnd(state.lines, lastDay);
    // Decision 9: tax the tenant withheld on a month after the end cannot be credited back.
    if (after.some((l) => withheldOn(l.id, state.allocations) > 0)) throw creditNoteWithheld();
    if (after.some((l) => lineBalance(l, state.allocations).netMinor > 0))
      throw conflict(
        'end_not_processed',
        'The lease’s end is still being processed. Try again in a minute.',
      );
    const today = this.engine.today(state);
    await this.engine.carryOverIfStarted(tx, state, today);
    await this.engine.accrue(tx, state, today);
    const creditBefore = sum(creditPools(state.payments, state.allocations));
    // 1. Agreed termination charges (P01).
    await this.engine.issueCharges(tx, state, input.charges, today, causedBy);
    // 2. The unused days of the last month, where the break clause allows (P27).
    const allowsCredit = lease.terms.breakClause?.creditUnusedDays === true;
    const unused = allowsCredit ? unusedDaysCredits(state.lines, state.allocations, lastDay) : [];
    for (const credit of unused)
      await this.engine.credit(tx, state, {
        lineId: credit.lineId,
        amountMinor: credit.creditMinor,
        reason: `Unused days after the tenancy ended on ${formatBusinessDate(lastDay)} (break clause)`,
        kind: approvalRequestId ? 'approved' : 'system',
        approvalRequestId,
        createdBy: causedBy,
        valueDate: today,
      });
    // 3. The credit pays open lines, oldest first (P13 apply).
    const applied = await this.engine.applyCreditToOpen(tx, state, {
      terminationId,
      key: 'apply',
      valueDate: today,
      causedBy,
    });
    const creditLeft = sum(creditPools(state.payments, state.allocations));
    // 4. Deductions, never more than what is left; then the refund.
    const deductions = sum(input.deductions);
    const refund = refundDue(creditLeft, deductions);
    if (deductions > 0) {
      await this.engine.issueCharges(
        tx,
        state,
        input.deductions.map((d) => ({ ...d, description: `Deduction: ${d.description}` })),
        today,
        causedBy,
      );
      applied.push(
        ...(await this.engine.applyCreditToOpen(tx, state, {
          terminationId,
          key: 'deductions',
          valueDate: today,
          causedBy,
        })),
      );
    }
    if (refund > 0)
      await this.engine.approveRefund(tx, state, {
        terminationId,
        amountMinor: refund,
        valueDate: today,
        causedBy,
        recordParts: !preview,
      });
    const lines = new Map(state.lines.map((l) => [l.id, l]));
    return {
      leaseId: lease.id,
      lastDay,
      endDate: lease.endDate,
      breakClauseCreditsUnusedDays: allowsCredit,
      creditBeforeMinor: creditBefore,
      chargesMinor: sum(input.charges),
      unusedDays: unused.map((u) => ({
        lineId: u.lineId,
        periodStart: lines.get(u.lineId)?.periodStart ?? null,
        periodEnd: lines.get(u.lineId)?.periodEnd ?? null,
        unusedDays: u.unusedDays,
        periodDays: u.periodDays,
        creditMinor: u.creditMinor,
      })),
      unusedDaysCreditMinor: unused.reduce((s, u) => s + u.creditMinor, 0),
      appliedMinor: sum(applied),
      appliedLines: appliedLinesOf(applied, lines),
      creditLeftMinor: creditLeft,
      deductionsMinor: deductions,
      refundMinor: refund,
      arrearsMinor: state.lines
        .filter((l) => l.kind !== 'deposit')
        .reduce((s, l) => s + lineBalance(l, state.allocations).outstandingMinor, 0),
    };
  }

  /** M8 review: the moveout module (above billing) says whether a lease has a move-out. */
  private readonly moveOutGuards: ((tx: Tx, leaseId: string) => Promise<boolean>)[] = [];

  useMoveOutGuard(exists: (tx: Tx, leaseId: string) => Promise<boolean>): void {
    this.moveOutGuards.push(exists);
  }

  /** Asks for the settlement and its refund (`lease.refund`); a second person approves. */
  async request(
    actor: Actor | null,
    leaseId: string,
    input: TerminationInput,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<{ terminationId: string; approvalId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    for (const item of [...input.charges, ...input.deductions]) amountItem.parse(item);
    await withCompany(this.database, staffContext(staff), (tx) => billingLeaseOf(tx, leaseId));
    return withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, leaseId));
      // M8 review: once a lease has a move-out, its money is settled there; an early-termination
      // refund here would credit the same unused days a second time.
      for (const exists of this.moveOutGuards)
        if (await exists(tx, leaseId))
          throw conflict(
            'move_out_exists',
            'This lease has a move-out. Settle its money on the move-out instead.',
          );
      await lockCounters(tx, staff.companyId);
      await this.closeStale(tx, leaseId);
      const figures = await this.simulate(tx, staff.companyId, leaseId, input);
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      const book = requireBook(state.book);
      const terminationId = uuidv7();
      const approvalId = await this.approvals.createInTx(tx, staff, {
        actionType: LEASE_REFUND_ACTION,
        subjectType: 'early_termination',
        subjectId: terminationId,
        propertyId: state.lease.propertyId,
        payload: {
          terminationId,
          leaseId,
          unitCode: state.lease.unitCode,
          tenantName: state.lease.tenantName.slice(0, 200),
          lastDay: figures.lastDay,
          charges: input.charges.map((c) => ({ ...c, description: c.description.trim() })),
          deductions: input.deductions.map((d) => ({ ...d, description: d.description.trim() })),
          chargesMinor: figures.chargesMinor,
          unusedDaysCreditMinor: figures.unusedDaysCreditMinor,
          appliedMinor: figures.appliedMinor,
          deductionsMinor: figures.deductionsMinor,
          refundMinor: figures.refundMinor,
          arrearsMinor: figures.arrearsMinor,
          open: true,
        },
      });
      try {
        await tx.insert(schema.earlyTermination).values({
          id: terminationId,
          companyId: staff.companyId,
          propertyId: state.lease.propertyId,
          tenantId: state.lease.tenantId,
          leaseId,
          unitId: state.lease.unitId,
          ownerId: book.ownerId,
          bookId: book.bookId,
          lastDay: figures.lastDay,
          charges: input.charges,
          deductions: input.deductions,
          unusedDaysCreditMinor: figures.unusedDaysCreditMinor,
          appliedMinor: figures.appliedMinor,
          refundMinor: figures.refundMinor,
          figures,
          note: input.note?.trim().slice(0, 500) || null,
          approvalRequestId: approvalId,
          requestedBy: staff.personId,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw conflict(
            'termination_exists',
            'This lease’s early termination is already settled or asked for',
          );
        throw error;
      }
      await options.claim?.done(tx, { terminationId, approvalId });
      return { terminationId, approvalId };
    });
  }

  /** Requests rejected, withdrawn or expired are closed when next looked at. */
  private async closeStale(tx: Tx, leaseId: string): Promise<void> {
    const waiting = await tx
      .select()
      .from(schema.earlyTermination)
      .where(
        and(
          eq(schema.earlyTermination.leaseId, leaseId),
          eq(schema.earlyTermination.status, 'awaiting_approval'),
        ),
      );
    if (waiting.length === 0) return;
    const requests = await this.approvals.requestsIn(
      tx,
      waiting.map((w) => w.approvalRequestId),
    );
    for (const w of waiting)
      if (
        ['rejected', 'cancelled', 'expired'].includes(
          requests.get(w.approvalRequestId)?.status ?? '',
        )
      )
        await tx
          .update(schema.earlyTermination)
          .set({ status: 'rejected', updatedAt: this.clock.now() })
          .where(eq(schema.earlyTermination.id, w.id));
  }

  /** Records the refund paid outside the platform, with its reference and proof (P13 paid). */
  async recordPaid(
    actor: Actor | null,
    terminationId: string,
    input: {
      readonly paidOn: string;
      readonly paidFrom: 'owner_account' | 'agency_account';
      readonly reference: string;
      readonly proofUploadId: string;
    },
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    parseBusinessDate(input.paidOn);
    if (input.paidFrom === 'agency_account' && staff.companyKind !== 'agency')
      throw invalid('paid_from', 'Only an agency has an agency account');
    if (input.reference.trim().length < 2)
      throw invalid('reference', 'Enter the payment reference');
    const found = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [t] = await tx
        .select()
        .from(schema.earlyTermination)
        .where(eq(schema.earlyTermination.id, terminationId));
      if (!t) throw notFound('Early termination');
      return t;
    });
    // F3 before the proof is staged (staged files are kept write-once): paid from the agency's
    // account, never more than it holds for the owner. Checked again in the write, under the lock.
    if (input.paidFrom === 'agency_account' && found.status === 'settled' && found.refundMinor > 0)
      await withCompany(this.database, this.unscoped(staff), async (tx) => {
        const company = await companyRecord(tx, staff.companyId);
        const lease = await billingLeaseOf(tx, found.leaseId);
        const book = requireBook(
          await leaseBookOf(tx, lease, isoNow(this.clock, company!.timeZone)),
        );
        await assertAgentCash(tx, {
          ownerId: book.ownerId,
          bookId: book.bookId,
          outMinor: found.refundMinor,
        });
      });
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.proofUploadId,
      REFUND_PROOF_UPLOAD,
    );
    await withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, found.leaseId));
      const [t] = await tx
        .select()
        .from(schema.earlyTermination)
        .where(eq(schema.earlyTermination.id, terminationId));
      if (!t || t.status !== 'settled' || t.refundMinor <= 0)
        throw conflict('refund_not_payable', 'There is no approved refund waiting to be paid');
      const company = await companyRecord(tx, staff.companyId);
      if (input.paidOn > isoNow(this.clock, company!.timeZone))
        throw invalid('paid_in_future', 'The day it was paid cannot be in the future');
      if (t.settledOn && input.paidOn < t.settledOn)
        throw invalid('paid_before_approval', 'A refund is paid after it is approved');
      const state = await this.engine.load(tx, staff.companyId, t.leaseId);
      // F3: the owner's lock (after the lease locks), then the agent's cash, before anything posts.
      if (input.paidFrom === 'agency_account') {
        const book = requireBook(state.book);
        await assertAgentCash(tx, {
          ownerId: book.ownerId,
          bookId: book.bookId,
          outMinor: t.refundMinor,
        });
      }
      const posted = await this.engine.payRefund(tx, state, {
        terminationId,
        amountMinor: t.refundMinor,
        from: input.paidFrom === 'owner_account' ? '1010' : '1070',
        valueDate: input.paidOn,
        causedBy: staff.personId,
      });
      const proofDocumentId = await this.documents.recordStagedEvidence(tx, staged, 'refund_proof');
      await tx
        .update(schema.earlyTermination)
        .set({
          status: 'refund_paid',
          paidOn: input.paidOn,
          paidFrom: input.paidFrom,
          paidReference: input.reference.trim().slice(0, 120),
          proofDocumentId,
          paidEntryId: posted.entryId,
          paidAccountingDate: posted.accountingDate,
          paidBy: staff.personId,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.earlyTermination.id, terminationId));
      await options.claim?.done(tx, { terminationId });
    });
    await this.documents.discardStagedUpload(staged);
  }

  /** A presigned upload for the proof a refund was paid. */
  async createUpload(
    actor: Actor | null,
    input: { readonly contentType: string; readonly sizeBytes: number },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      REFUND_PROOF_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  /** Early terminations on a lease, or all the person sees, newest first. */
  async list(
    actor: Actor | null,
    filter: { readonly leaseId?: string; readonly ids?: readonly string[] },
  ): Promise<TerminationView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const conditions = [];
      if (filter.leaseId) conditions.push(eq(schema.earlyTermination.leaseId, filter.leaseId));
      if (filter.ids) conditions.push(inArray(schema.earlyTermination.id, [...filter.ids]));
      const rows = await tx
        .select()
        .from(schema.earlyTermination)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.earlyTermination.createdAt))
        .limit(200);
      const requests = await this.approvals.requestsIn(
        tx,
        rows.map((r) => r.approvalRequestId),
      );
      return rows.map((r) => {
        const closed =
          r.status === 'awaiting_approval' &&
          ['rejected', 'cancelled', 'expired'].includes(
            requests.get(r.approvalRequestId)?.status ?? '',
          );
        const charges = r.charges as { description: string; amountMinor: number }[];
        const deductions = r.deductions as { description: string; amountMinor: number }[];
        // The settlement step by step as it was asked for (and decided on).
        const asked = r.figures as Partial<TerminationFigures>;
        return {
          id: r.id,
          status: closed ? 'rejected' : (r.status as TerminationView['status']),
          approvalId: r.approvalRequestId,
          leaseId: r.leaseId,
          lastDay: r.lastDay,
          endDate: asked.endDate ?? r.lastDay,
          breakClauseCreditsUnusedDays:
            asked.breakClauseCreditsUnusedDays ?? r.unusedDaysCreditMinor > 0,
          creditBeforeMinor: asked.creditBeforeMinor ?? 0,
          charges,
          deductions,
          chargesMinor: sum(charges),
          unusedDays: asked.unusedDays ?? [],
          unusedDaysCreditMinor: r.unusedDaysCreditMinor,
          appliedMinor: r.appliedMinor,
          appliedLines: asked.appliedLines ?? [],
          creditLeftMinor: asked.creditLeftMinor ?? r.refundMinor + sum(deductions),
          deductionsMinor: sum(deductions),
          refundMinor: r.refundMinor,
          arrearsMinor: asked.arrearsMinor ?? 0,
          note: r.note,
          settledOn: r.settledOn,
          paid:
            r.paidOn && r.paidFrom && r.paidReference && r.proofDocumentId
              ? {
                  paidOn: r.paidOn,
                  paidFrom: r.paidFrom as 'owner_account' | 'agency_account',
                  reference: r.paidReference,
                  proofDocumentId: r.proofDocumentId,
                }
              : null,
          createdAt: r.createdAt,
        };
      });
    });
  }

  /** Registers `lease.refund` with the approvals engine (two-person). Once per process. */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register({
      actionType: LEASE_REFUND_ACTION,
      eligibleRoles: MONEY_APPROVERS,
      schema: payload,
      onePerSubject: true,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string }).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
        await lockCounters(tx, request.companyId);
      },
      // The figures as they would be now: if anything moved since, the request no longer holds.
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof payload>;
        const [t] = await tx
          .select({ status: schema.earlyTermination.status })
          .from(schema.earlyTermination)
          .where(eq(schema.earlyTermination.id, proposed.terminationId));
        let figures: TerminationFigures | null;
        try {
          figures = await this.simulate(tx, request.companyId, proposed.leaseId, proposed);
        } catch {
          figures = null;
        }
        return {
          ...proposed,
          ...(figures
            ? {
                chargesMinor: figures.chargesMinor,
                unusedDaysCreditMinor: figures.unusedDaysCreditMinor,
                appliedMinor: figures.appliedMinor,
                deductionsMinor: figures.deductionsMinor,
                refundMinor: figures.refundMinor,
                arrearsMinor: figures.arrearsMinor,
              }
            : {}),
          open: t?.status === 'awaiting_approval' && figures !== null,
        };
      },
      execute: async (tx, request, p) => {
        const state = await this.engine.load(tx, request.companyId, p.leaseId);
        const figures = await this.settle(
          tx,
          state,
          p,
          p.terminationId,
          request.id,
          request.initiatedBy,
        );
        const refund =
          figures.refundMinor > 0
            ? await tx
                .select({
                  id: schema.journalEntry.id,
                  accountingDate: schema.journalEntry.accountingDate,
                })
                .from(schema.journalEntry)
                .where(
                  and(
                    eq(schema.journalEntry.companyId, request.companyId),
                    eq(schema.journalEntry.idempotencyKey, `P13:${p.terminationId}:refund`),
                  ),
                )
            : [];
        await tx
          .update(schema.earlyTermination)
          .set({
            status: 'settled',
            settledOn: this.engine.today(state),
            refundEntryId: refund[0]?.id ?? null,
            refundAccountingDate: refund[0]?.accountingDate ?? null,
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.earlyTermination.id, p.terminationId));
      },
    });
  }
}
