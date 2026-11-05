import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  ne,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  creditPools,
  lineBalance,
  linesAfterEnd,
  postingClassOf,
  unusedDaysCredits,
  withheldOn,
} from '@rent/domain/billing';
import { formatBusinessDate, parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  checkDeduction,
  DEDUCTION_KIND_LABELS,
  finalStatement,
  LIVE_MOVE_OUT_STATUSES,
  MOVE_OUT_STATUS_LABELS,
  nextMoveOutStatus,
  type DeductionKind,
  type MoveOutAction,
  type MoveOutReason,
  type MoveOutStatus,
} from '@rent/domain/moveout';
import type { Actor } from '@rent/domain/policy';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { BillingEngine, creditNoteWithheld, lineLabel, type LeaseState } from '../billing/engine';
import { InvoicingService } from '../billing/invoicing.service';
import { MONEY_APPROVERS } from '../billing/money.service';
import { isoNow, leaseGroup, lockCounters, lockLeases, requireBook } from '../billing/records';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { maintenanceCheckConflict } from '../core/db-errors';
import { AppError, conflict, forbidden, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, REFUND_PROOF_UPLOAD } from '../documents/documents.service';
import { InspectionsService } from '../maintenance/inspections.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RentTaxService } from '../tax/rent-tax.service';
import { billingLeaseOf } from '../tenancy/billing-facts';
import { LeaseLifecycleService } from '../tenancy/lease-lifecycle.service';

/** M8 (plan 4.8): the settlement's two-person approval. */
export const MOVE_OUT_SETTLEMENT_ACTION = 'lease.move_out_settlement';
/** Renders the final statement PDF and sends it to the tenant (plan 4.13). */
export const MOVEOUT_FINAL_STATEMENT_JOB = 'moveout.final-statement';
export const FINAL_STATEMENT_TEMPLATE = { key: 'tenancy.final-statement', version: 1 } as const;

const NAMESPACE = 'a3d0c2f4-6e8b-4b1a-9c7d-5e2f1a0b3c64';
type MoveOutRow = typeof schema.moveOut.$inferSelect;

const amountItem = z.object({
  description: z.string().trim().min(2).max(120),
  amountMinor: z.number().int().positive(),
});

const payload = z
  .object({
    moveOutId: z.string().uuid(),
    leaseId: z.string().uuid(),
    unitCode: z.string(),
    tenantName: z.string().nullable(),
    kind: z.enum(['move_out', 'deposit_settlement']),
    lastDay: z.string(),
    early: z.boolean(),
    charges: z.array(amountItem),
    deductions: z.array(
      z.object({
        id: z.string().uuid(),
        kind: z.string(),
        amountMinor: z.number().int(),
        reason: z.string(),
        photoIds: z.array(z.string().uuid()),
      }),
    ),
    depositHeldMinor: z.number().int(),
    creditMinor: z.number().int(),
    arrearsMinor: z.number().int(),
    chargesMinor: z.number().int(),
    breakCreditMinor: z.number().int(),
    deductionsMinor: z.number().int(),
    retainedMinor: z.number().int(),
    depositAppliedMinor: z.number().int(),
    creditAppliedMinor: z.number().int(),
    creditRefundMinor: z.number().int(),
    depositRefundMinor: z.number().int(),
    refundMinor: z.number().int(),
    stillOwedMinor: z.number().int(),
    /** Decision fact: still waiting (not settled, cancelled or replaced). */
    open: z.boolean(),
  })
  .strict();
type SettlementPayload = z.infer<typeof payload>;

interface LineAmountView {
  readonly lineId: string;
  readonly invoiceNumber: string;
  readonly label: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly amountMinor: number;
}

/** The final statement as the screens show it (contracts' finalStatementSchema). */
export interface FinalStatementView {
  readonly lastDay: string;
  readonly early: boolean;
  readonly depositHeldMinor: number;
  readonly creditMinor: number;
  readonly arrearsMinor: number;
  readonly chargesMinor: number;
  readonly breakCreditMinor: number;
  readonly creditToArrears: readonly LineAmountView[];
  readonly depositToArrears: readonly LineAmountView[];
  readonly deductionsMinor: number;
  readonly retainedMinor: number;
  readonly deductionsChargedMinor: number;
  readonly creditAppliedMinor: number;
  readonly depositAppliedMinor: number;
  readonly creditRefundMinor: number;
  readonly depositRefundMinor: number;
  readonly refundMinor: number;
  readonly stillOwedMinor: number;
}

class Preview extends Error {
  constructor(readonly statement: FinalStatementView) {
    super('preview');
  }
}

const sum = (items: readonly { readonly amountMinor: number }[]) =>
  items.reduce((s, i) => s + i.amountMinor, 0);

const domainOf = (error: unknown): never => {
  if (error instanceof DomainError) {
    const code = error.code.replace(/\./g, '_');
    if (error.code === 'moveout.transition') throw conflict(code, error.message);
    if (error.code === 'moveout.deductions_exceed_deposit')
      throw conflict('deductions_exceed_deposit', error.message);
    throw invalid(code, error.message);
  }
  throw maintenanceCheckConflict(error) ?? error;
};

/**
 * Move-out (TL-11, MI-11; M8 decision 12 and plan 4.8): one flow for every ending, from the planned
 * date to the refund, and the deposit settlement of a lease that ended without one (section 9,
 * Backend). The settlement is approved by a second person (`lease.move_out_settlement`; OQ-29) and
 * posts, in one transaction: the lease's end (Ended, or Terminated when early), the agreed charges
 * (P01) and break-clause credit (P27) when early, the credit applied (P13), the deposit applied to
 * arrears and the deductions retained (P11, with P17 on the rent it settles), and the refunds
 * payable (P13, P12). The drafted statement is that same settlement run in a savepoint and rolled
 * back, so what the approver sees is what is posted. No deposit law value is built in (OQ-59).
 */
@Injectable()
export class MoveOutService {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(InvoicingService) private readonly invoicing: InvoicingService,
    @Inject(LeaseLifecycleService) private readonly lifecycle: LeaseLifecycleService,
    @Inject(RentTaxService) private readonly rentTax: RentTaxService,
    @Inject(InspectionsService) private readonly inspections: InspectionsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Starting --------------------------------------------------------------------------------------

  async plan(
    actor: Actor | null,
    leaseId: string,
    input: {
      plannedDate: string;
      reason: MoveOutReason;
      noticeId?: string | null;
      note?: string | null;
    },
  ) {
    const staff = this.manager(actor);
    parseBusinessDate(input.plannedDate);
    const id = await this.write(staff, async (tx) => {
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, leaseId));
      const lease = await billingLeaseOf(tx, leaseId);
      if (!['active', 'holding_over', 'ending'].includes(lease.status))
        throw conflict('lease_not_current', 'A move-out is planned for a current lease');
      if (input.plannedDate < lease.startDate)
        throw invalid('planned_date', 'The move-out is after the lease starts');
      await this.refuseSecond(tx, leaseId);
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      const book = requireBook(state.book);
      if (input.noticeId) {
        const [notice] = await tx
          .select({ leaseId: schema.notice.leaseId })
          .from(schema.notice)
          .where(eq(schema.notice.id, input.noticeId));
        if (!notice || notice.leaseId !== leaseId) throw notFound('Notice');
      }
      const prior = await this.lifecycle.planEndingIn(tx, leaseId, {
        reason: input.reason === 'end_of_term' ? 'non_renewal' : 'notice',
        note: input.note?.trim() || null,
      });
      const moveIn = await this.inspections.latestMoveIn(tx, leaseId);
      const [row] = await tx
        .insert(schema.moveOut)
        .values({
          companyId: staff.companyId,
          propertyId: lease.propertyId,
          tenantId: lease.tenantId,
          leaseId,
          unitId: lease.unitId,
          ownerId: book.ownerId,
          bookId: book.bookId,
          kind: 'move_out',
          reason: input.reason,
          plannedDate: input.plannedDate,
          early: input.plannedDate < lease.endDate,
          noticeId: input.noticeId ?? null,
          note: input.note?.trim() || null,
          status: 'planned',
          priorLeaseStatus: prior,
          moveInInspectionId: moveIn?.id ?? null,
          createdBy: staff.personId,
        })
        .returning({ id: schema.moveOut.id });
      return row!.id;
    });
    return this.get(actor, id);
  }

  /**
   * The deposit settlement of a lease already Ended or Terminated that still holds a deposit (M3's
   * quick move-out, or an M5 early termination): the flow without the plan step, drafted at once.
   */
  async settleDeposit(actor: Actor | null, leaseId: string, note?: string | null) {
    const staff = this.manager(actor);
    const id = await this.write(staff, async (tx) => {
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, leaseId));
      const lease = await billingLeaseOf(tx, leaseId);
      if (!['ended', 'terminated'].includes(lease.status))
        throw conflict(
          'lease_not_ended',
          'A deposit is settled this way once the lease has ended. Plan a move-out instead.',
        );
      await this.refuseSecond(tx, leaseId);
      const held = await this.engine.depositHeld(tx, leaseId);
      if (held <= 0) throw conflict('no_deposit_held', 'This lease holds no deposit');
      const [live] = await tx
        .select({ id: schema.earlyTermination.id })
        .from(schema.earlyTermination)
        .where(
          and(
            eq(schema.earlyTermination.leaseId, leaseId),
            eq(schema.earlyTermination.status, 'awaiting_approval'),
          ),
        );
      if (live)
        throw conflict(
          'move_out_exists',
          'An early-termination refund is waiting for approval on this lease. Decide it first.',
        );
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      const book = requireBook(state.book);
      const moveIn = await this.inspections.latestMoveIn(tx, leaseId);
      const [row] = await tx
        .insert(schema.moveOut)
        .values({
          companyId: staff.companyId,
          propertyId: lease.propertyId,
          tenantId: lease.tenantId,
          leaseId,
          unitId: lease.unitId,
          ownerId: book.ownerId,
          bookId: book.bookId,
          kind: 'deposit_settlement',
          reason: null,
          plannedDate: lease.moveOutDate ?? lease.endedOn ?? lease.endDate,
          early: false,
          note: note?.trim() || null,
          status: 'settlement_drafted',
          moveInInspectionId: moveIn?.id ?? null,
          createdBy: staff.personId,
        })
        .returning({ id: schema.moveOut.id });
      return row!.id;
    });
    return this.get(actor, id);
  }

  // Reading --------------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filter: { leaseId?: string; propertyId?: string; status?: MoveOutStatus },
  ) {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const m = schema.moveOut;
      const rows = await tx
        .select()
        .from(m)
        .where(
          and(
            filter.leaseId ? eq(m.leaseId, filter.leaseId) : undefined,
            filter.propertyId ? eq(m.propertyId, filter.propertyId) : undefined,
            filter.status ? eq(m.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(m.createdAt))
        .limit(200);
      for (const r of rows) await this.syncApproval(tx, r);
      return this.views(tx, rows);
    });
  }

  async get(actor: Actor | null, moveOutId: string) {
    const staff = this.reader(actor);
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await this.row(tx, moveOutId);
      await this.syncApproval(tx, found);
      return this.row(tx, moveOutId);
    });
    // The statement as it would be done now: a savepoint under the lease's locks, rolled back.
    let statement: FinalStatementView | null = (row.statement as FinalStatementView | null) ?? null;
    let unavailable: { code: string; message: string } | null = null;
    if (!statement && LIVE_MOVE_OUT_STATUSES.includes(row.status as MoveOutStatus)) {
      try {
        statement = await this.preview(staff, row);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        unavailable = { code: error.code.toUpperCase(), message: error.message };
      }
    }
    const approval = row.approvalRequestId
      ? await this.approvals.get(staff, row.approvalRequestId).catch(() => null)
      : null;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [view] = await this.views(tx, [row]);
      return this.detail(tx, staff, row, view!, statement, unavailable, approval);
    });
  }

  async statementUrl(actor: Actor | null, moveOutId: string) {
    const staff = this.reader(actor);
    const row = await withCompany(this.database, staffContext(staff), (tx) =>
      this.row(tx, moveOutId),
    );
    const url = row.statementDocumentId
      ? await this.documents.downloadUrl(staff.companyId, row.statementDocumentId)
      : null;
    if (!url) throw notFound('Final statement');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  // Drafting -------------------------------------------------------------------------------------

  async startInspection(actor: Actor | null, moveOutId: string) {
    const staff = this.manager(actor);
    this.policy.assert(staff, 'inspection.perform');
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      this.move(row, 'inspect');
      if (row.inspectionId) {
        const [current] = await tx
          .select({ status: schema.inspection.status })
          .from(schema.inspection)
          .where(eq(schema.inspection.id, row.inspectionId));
        if (current?.status === 'in_progress') return;
      }
      const inspectionId = await this.inspections.startIn(tx, staff.companyId, staff.personId, {
        unitId: row.unitId,
        kind: 'move_out',
        leaseId: row.leaseId,
      });
      await tx
        .update(schema.moveOut)
        .set({
          inspectionId,
          status: nextMoveOutStatus(row.status as MoveOutStatus, 'inspect'),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.moveOut.id, moveOutId));
    });
    return this.get(actor, moveOutId);
  }

  async addDeduction(
    actor: Actor | null,
    moveOutId: string,
    input: {
      kind: DeductionKind;
      amountMinor: number;
      reason: string;
      inspectionItemIds: readonly string[];
      photoIds: readonly string[];
    },
  ) {
    const staff = this.manager(actor);
    try {
      checkDeduction(input);
    } catch (error) {
      domainOf(error);
    }
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      const next = this.move(row, 'draft');
      await tx.insert(schema.depositDeduction).values({
        companyId: staff.companyId,
        propertyId: row.propertyId,
        tenantId: row.tenantId,
        leaseId: row.leaseId,
        moveOutId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        inspectionItemIds: [...new Set(input.inspectionItemIds)],
        photoIds: [...new Set(input.photoIds)],
        createdBy: staff.personId,
      });
      await this.setStatus(tx, row, next);
    });
    return this.get(actor, moveOutId);
  }

  async withdrawDeduction(actor: Actor | null, moveOutId: string, deductionId: string) {
    const staff = this.manager(actor);
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      this.move(row, 'draft');
      const [deduction] = await tx
        .select({ id: schema.depositDeduction.id })
        .from(schema.depositDeduction)
        .where(
          and(
            eq(schema.depositDeduction.id, deductionId),
            eq(schema.depositDeduction.moveOutId, moveOutId),
          ),
        );
      if (!deduction) throw notFound('Deduction');
      await tx
        .insert(schema.depositDeductionWithdrawal)
        .values({
          companyId: staff.companyId,
          propertyId: row.propertyId,
          moveOutId,
          deductionId,
          createdBy: staff.personId,
        })
        .onConflictDoNothing();
    });
    return this.get(actor, moveOutId);
  }

  async setCharges(
    actor: Actor | null,
    moveOutId: string,
    charges: readonly { description: string; amountMinor: number }[],
  ) {
    const staff = this.manager(actor);
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      const next = this.move(row, 'draft');
      await tx
        .update(schema.moveOut)
        .set({
          charges: charges.map((c) => ({
            description: c.description.trim(),
            amountMinor: c.amountMinor,
          })),
          status: next,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.moveOut.id, moveOutId));
    });
    return this.get(actor, moveOutId);
  }

  async cancel(actor: Actor | null, moveOutId: string, reason: string) {
    const staff = this.manager(actor);
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      this.move(row, 'cancel');
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, row.leaseId));
      const now = this.clock.now();
      await tx
        .update(schema.moveOut)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason.trim(), updatedAt: now })
        .where(eq(schema.moveOut.id, moveOutId));
      if (row.kind === 'move_out' && row.priorLeaseStatus)
        await this.lifecycle.restoreFromEndingIn(
          tx,
          row.leaseId,
          row.priorLeaseStatus as 'active' | 'holding_over',
        );
    });
    return this.get(actor, moveOutId);
  }

  /**
   * Asks for the settlement: a second money approver decides with the statement and every
   * deduction's photos in front of them. A move-out is settled once its last day has passed.
   */
  async submit(actor: Actor | null, moveOutId: string, note?: string | null) {
    const staff = this.manager(actor);
    await this.write(staff, async (tx) => {
      const row = await this.row(tx, moveOutId, true);
      // A move-out with nothing to deduct or charge is drafted as it is asked for.
      if (row.status !== 'settlement_drafted') {
        this.move(row, 'draft');
        await this.setStatus(tx, row, 'settlement_drafted');
      } else this.move(row, 'submit');
      const company = await companyRecord(tx, staff.companyId);
      if (row.kind === 'move_out' && row.plannedDate > isoNow(this.clock, company!.timeZone))
        throw conflict(
          'move_out_not_yet',
          `The settlement is asked for once the tenant has moved out, on or after ${formatBusinessDate(row.plannedDate)}`,
        );
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, row.leaseId));
      await lockCounters(tx, staff.companyId);
      const statement = await this.simulate(tx, row);
      const p = await this.payloadOf(tx, row, statement);
      const approvalId = await this.approvals.createInTx(tx, staff, {
        actionType: MOVE_OUT_SETTLEMENT_ACTION,
        subjectType: 'move_out',
        subjectId: row.id,
        propertyId: row.propertyId,
        payload: p,
      });
      await tx
        .update(schema.moveOut)
        .set({
          status: 'awaiting_approval',
          approvalRequestId: approvalId,
          note: note?.trim() ? note.trim() : row.note,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.moveOut.id, moveOutId));
    });
    return this.get(actor, moveOutId);
  }

  /**
   * The approved refund (P12 and P13) paid outside the platform (D1), with its reference and
   * proof: Dr 2400, Cr 1010 or 1070.
   */
  async recordRefundPaid(
    actor: Actor | null,
    moveOutId: string,
    input: {
      readonly paidOn: string;
      readonly paidFrom: 'owner_account' | 'agency_account';
      readonly reference: string;
      readonly proofUploadId: string;
    },
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'moveout.settle');
    parseBusinessDate(input.paidOn);
    if (input.paidFrom === 'agency_account' && staff.companyKind !== 'agency')
      throw invalid('paid_from', 'Only an agency has an agency account');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.proofUploadId,
      REFUND_PROOF_UPLOAD,
    );
    await this.write(staff, async (tx) => {
      await options.claim?.claim(tx);
      const found = await this.row(tx, moveOutId);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, found.leaseId));
      const row = await this.row(tx, moveOutId, true);
      const refund = (row.creditRefundMinor ?? 0) + (row.depositRefundMinor ?? 0);
      if (row.status !== 'approved' || refund <= 0)
        throw conflict('refund_not_payable', 'There is no approved refund waiting to be paid');
      const company = await companyRecord(tx, staff.companyId);
      if (input.paidOn > isoNow(this.clock, company!.timeZone))
        throw invalid('paid_in_future', 'The day it was paid cannot be in the future');
      if (row.approvedOn && input.paidOn < row.approvedOn)
        throw invalid('paid_before_approval', 'A refund is paid after it is approved');
      const state = await this.engine.load(tx, staff.companyId, row.leaseId);
      const posted = await this.engine.payRefund(tx, state, {
        terminationId: row.id,
        amountMinor: refund,
        from: input.paidFrom === 'owner_account' ? '1010' : '1070',
        valueDate: input.paidOn,
        causedBy: staff.personId,
        subject: 'move_out',
      });
      const proofDocumentId = await this.documents.recordStagedEvidence(tx, staged, 'refund_proof');
      await tx
        .update(schema.moveOut)
        .set({
          status: 'refund_paid',
          paidOn: input.paidOn,
          paidFrom: input.paidFrom,
          paidReference: input.reference.trim().slice(0, 120),
          proofDocumentId,
          paidEntryId: posted.entryId,
          paidBy: staff.personId,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.moveOut.id, moveOutId));
      await options.claim?.done(tx, { moveOutId });
    });
    await this.documents.discardStagedUpload(staged);
    return this.get(actor, moveOutId);
  }

  async createRefundUpload(
    actor: Actor | null,
    input: { readonly contentType: string; readonly sizeBytes: number },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'moveout.settle');
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      REFUND_PROOF_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  // The approval (plan 4.8) ----------------------------------------------------------------------

  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register({
      actionType: MOVE_OUT_SETTLEMENT_ACTION,
      eligibleRoles: MONEY_APPROVERS,
      schema: payload,
      onePerSubject: true,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as SettlementPayload).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
        await lockCounters(tx, request.companyId);
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as SettlementPayload;
        const row = await this.row(tx, proposed.moveOutId);
        let statement: FinalStatementView | null;
        try {
          statement = await this.simulate(tx, row);
        } catch {
          statement = null;
        }
        const current = statement ? await this.payloadOf(tx, row, statement) : proposed;
        return {
          ...current,
          open:
            row.status === 'awaiting_approval' &&
            row.approvalRequestId === request.id &&
            statement !== null,
        };
      },
      execute: async (tx, request, p) => {
        const row = await this.row(tx, p.moveOutId, true);
        if (row.status !== 'awaiting_approval' || row.approvalRequestId !== request.id)
          throw conflict('moveout_transition', 'This settlement is no longer waiting for approval');
        const statement = await this.settle(tx, row, request.id, request.initiatedBy, false);
        const state = await this.engine.load(tx, request.companyId, row.leaseId);
        const now = this.clock.now();
        const today = this.engine.today(state);
        await tx
          .update(schema.moveOut)
          .set({
            status: 'approved',
            statement,
            approvedOn: today,
            approvedAt: now,
            creditRefundMinor: statement.creditRefundMinor,
            depositRefundMinor: statement.depositRefundMinor,
            updatedAt: now,
          })
          .where(eq(schema.moveOut.id, row.id));
        // Nothing to refund: the settlement is done.
        if (statement.refundMinor === 0)
          await tx
            .update(schema.moveOut)
            .set({ status: 'closed', closedAt: now, updatedAt: now })
            .where(eq(schema.moveOut.id, row.id));
        await enqueueOutbox(tx, {
          companyId: request.companyId,
          type: MOVEOUT_FINAL_STATEMENT_JOB,
          payload: { moveOutId: row.id },
          idempotencyKey: `${MOVEOUT_FINAL_STATEMENT_JOB}:${row.id}:approved`,
        });
      },
    });
  }

  // The final statement PDF (plan 4.13) ----------------------------------------------------------

  /**
   * `moveout.final-statement`: renders the approved statement once, then (on the rendered event)
   * records it on the move-out and sends it to the tenant on their channel.
   */
  async renderFinalStatement(companyId: string, moveOutId: string): Promise<string | null> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const row = await this.row(tx, moveOutId);
      if (!row.statement || row.statementDocumentId) return null;
      const [existing] = await tx
        .select({ id: schema.documentRenderRequest.id })
        .from(schema.documentRenderRequest)
        .where(
          and(
            eq(schema.documentRenderRequest.templateKey, FINAL_STATEMENT_TEMPLATE.key),
            sql`${schema.documentRenderRequest.data} ->> 'moveOutId' = ${moveOutId}`,
          ),
        );
      if (existing) return existing.id;
      const s = row.statement as FinalStatementView;
      const company = await companyRecord(tx, companyId);
      const facts = await this.facts(tx, row);
      const deductions = await this.deductions(tx, row.id);
      return this.documents.requestRender(tx, {
        companyId,
        templateKey: FINAL_STATEMENT_TEMPLATE.key,
        templateVersion: FINAL_STATEMENT_TEMPLATE.version,
        data: {
          moveOutId,
          generatedOn: row.approvedOn!,
          timeZone: company?.timeZone ?? 'Africa/Accra',
          landlord: { name: (facts.landlord || company?.displayName) ?? 'Landlord' },
          tenant: { name: facts.tenantName || 'Tenant' },
          unit: { code: facts.unitCode, propertyName: facts.propertyName || facts.unitCode },
          lastDay: s.lastDay,
          early: s.early,
          depositHeldMinor: s.depositHeldMinor,
          creditMinor: s.creditMinor,
          arrearsMinor: s.arrearsMinor,
          chargesMinor: s.chargesMinor,
          breakCreditMinor: s.breakCreditMinor,
          creditToArrears: s.creditToArrears.map((l) => ({
            label: `${l.invoiceNumber} ${l.label}`.trim(),
            amountMinor: l.amountMinor,
          })),
          depositToArrears: s.depositToArrears.map((l) => ({
            label: `${l.invoiceNumber} ${l.label}`.trim(),
            amountMinor: l.amountMinor,
          })),
          deductions: deductions
            .filter((d) => !d.withdrawnAt)
            .map((d) => ({ label: d.kindLabel, reason: d.reason, amountMinor: d.amountMinor })),
          retainedMinor: s.retainedMinor,
          deductionsChargedMinor: s.deductionsChargedMinor,
          creditRefundMinor: s.creditRefundMinor,
          depositRefundMinor: s.depositRefundMinor,
          refundMinor: s.refundMinor,
          stillOwedMinor: s.stillOwedMinor,
        },
        requestedBy: null,
      });
    });
  }

  /** On `documents.rendered`: the final statement recorded once and sent to the tenant. */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== FINAL_STATEMENT_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId ||
        !rendered.sha256
      )
        return false;
      const moveOutId = (rendered.data as { moveOutId?: string }).moveOutId;
      if (!moveOutId) return false;
      const row = await this.row(tx, moveOutId, true);
      if (row.statementDocumentId) return false;
      await tx
        .update(schema.moveOut)
        .set({
          statementDocumentId: rendered.documentId,
          statementSha256: rendered.sha256,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.moveOut.id, moveOutId));
      const facts = await this.facts(tx, row);
      await queueMessage(tx, companyId, {
        messageId: uuidv5(`${moveOutId}:final-statement`, NAMESPACE),
        recipient: { type: 'tenant', tenantId: row.tenantId },
        purpose: 'final_statement',
        subject: `Your final statement for ${facts.unitCode}`,
        body: `${facts.landlord || 'Your landlord'} has settled your tenancy of ${facts.unitCode}. Your final statement is attached, and in the tenant app.`,
        propertyId: row.propertyId,
        related: { type: 'move_out', id: moveOutId },
        document: {
          documentId: rendered.documentId,
          filename: `final-statement-${facts.unitCode}.pdf`,
        },
      });
      return true;
    });
  }

  /** The tenancy's final statement for the tenant app, in the tenant's scoped transaction. */
  async tenantStatements(tx: Tx, leaseId: string) {
    return tx
      .select({
        documentId: schema.moveOut.statementDocumentId,
        createdAt: schema.moveOut.approvedAt,
      })
      .from(schema.moveOut)
      .where(
        and(
          eq(schema.moveOut.leaseId, leaseId),
          sql`${schema.moveOut.statementDocumentId} is not null`,
        ),
      );
  }

  // The settlement --------------------------------------------------------------------------------

  /** The statement as it would be done now, without keeping anything. */
  private async preview(staff: StaffActor, row: MoveOutRow): Promise<FinalStatementView> {
    return withCompany(this.database, this.unscoped(staff), async (tx) => {
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, row.leaseId));
      await lockCounters(tx, staff.companyId);
      return this.simulate(tx, row);
    });
  }

  private async simulate(tx: Tx, row: MoveOutRow): Promise<FinalStatementView> {
    try {
      await tx.transaction(async (sp) => {
        throw new Preview(await this.settle(sp, row, null, null, true));
      });
    } catch (error) {
      if (error instanceof Preview) return error.statement;
      return domainOf(error);
    }
    throw new Error('unreachable');
  }

  /**
   * The settlement's steps, in order, in the caller's transaction (plan 4.8). A preview runs the
   * same steps in a savepoint and is rolled back by its caller.
   */
  private async settle(
    tx: Tx,
    row: MoveOutRow,
    approvalRequestId: string | null,
    causedBy: string | null,
    preview: boolean,
  ): Promise<FinalStatementView> {
    const companyId = row.companyId;
    // 0. The lease ends on the last day (a move-out), and billing credits what lies after it.
    if (row.kind === 'move_out') {
      const lease = await billingLeaseOf(tx, row.leaseId);
      if (!['active', 'holding_over', 'ending'].includes(lease.status))
        throw conflict('lease_not_current', 'The lease is no longer current');
      await this.lifecycle.endForMoveOutIn(tx, row.leaseId, {
        lastDay: row.plannedDate,
        terminated: row.early,
      });
    }
    let state = await this.engine.load(tx, companyId, row.leaseId);
    requireBook(state.book);
    const lease = state.lease;
    const lastDay = lease.moveOutDate ?? lease.endedOn ?? row.plannedDate;
    const today = this.engine.today(state);
    await this.invoicing.creditAfterEndIn(tx, state, today);
    state = await this.engine.load(tx, companyId, row.leaseId);
    const after = linesAfterEnd(state.lines, lastDay);
    if (after.some((l) => withheldOn(l.id, state.allocations) > 0)) throw creditNoteWithheld();
    if (after.some((l) => lineBalance(l, state.allocations).netMinor > 0))
      throw conflict(
        'end_not_processed',
        'The lease’s end is still being processed. Try again in a minute.',
      );
    await this.engine.carryOverIfStarted(tx, state, today);
    await this.engine.accrue(tx, state, today);
    const creditBefore = sum(creditPools(state.payments, state.allocations));
    const arrearsBefore = this.openLines(state).reduce((s, l) => s + l.outstandingMinor, 0);
    // 1. Agreed charges (P01) and, when early and the break clause allows, unused days (P27).
    const charges = (row.charges as { description: string; amountMinor: number }[]) ?? [];
    await this.engine.issueCharges(tx, state, charges, today, causedBy);
    let breakCredit = 0;
    if (row.early && lease.terms.breakClause?.creditUnusedDays === true) {
      for (const credit of unusedDaysCredits(state.lines, state.allocations, lastDay)) {
        await this.engine.credit(tx, state, {
          lineId: credit.lineId,
          amountMinor: credit.creditMinor,
          reason: `Unused days after the tenancy ended on ${formatBusinessDate(lastDay)} (break clause)`,
          kind: approvalRequestId ? 'approved' : 'system',
          approvalRequestId,
          createdBy: causedBy,
          valueDate: today,
        });
        breakCredit += credit.creditMinor;
      }
    }
    // 2. The credit pays open lines, oldest first (P13 apply).
    const creditApplied = await this.engine.applyCreditToOpen(tx, state, {
      terminationId: row.id,
      key: 'apply',
      valueDate: today,
      causedBy,
      subject: 'move_out',
    });
    // 3. The deposit and the deductions, by the domain's statement (balances to zero).
    const depositHeld = await this.engine.depositHeld(tx, row.leaseId);
    const creditLeft = sum(creditPools(state.payments, state.allocations));
    const open = this.openLines(state);
    const deductions = (await this.deductions(tx, row.id)).filter((d) => !d.withdrawnAt);
    const s = finalStatement({
      depositHeldMinor: depositHeld,
      creditMinor: creditLeft,
      openLines: open.map((l) => ({ lineId: l.id, outstandingMinor: l.outstandingMinor })),
      deductions: deductions.map((d) => ({ amountMinor: d.amountMinor })),
    });
    // Deductions the deposit no longer covers after arrears are charged (P01) and stay owed.
    if (s.deductionsChargedMinor > 0)
      await this.engine.issueCharges(
        tx,
        state,
        [{ description: 'Deductions beyond the deposit', amountMinor: s.deductionsChargedMinor }],
        today,
        causedBy,
      );
    // 4. P11: the deposit pays the open lines and keeps the deductions retained.
    if (s.depositAppliedMinor + s.retainedMinor > 0)
      await this.engine.applyDeposit(tx, state, {
        moveOutId: row.id,
        lines: s.depositToArrears.map((l) => ({ lineId: l.lineId, amountMinor: l.amountMinor })),
        retainedMinor: s.retainedMinor,
        valueDate: today,
        causedBy,
      });
    // 5. P17: rent settled from the deposit is rent received (P11).
    if (s.depositAppliedMinor > 0) {
      const kinds = new Map(state.lines.map((l) => [l.id, l.kind]));
      const rent = s.depositToArrears
        .filter((l) => kinds.get(l.lineId) === 'rent')
        .reduce((x, l) => x + l.amountMinor, 0);
      const service = s.depositToArrears
        .filter((l) => kinds.get(l.lineId) === 'service_charge')
        .reduce((x, l) => x + l.amountMinor, 0);
      await this.rentTax.afterDepositApplied(
        tx,
        await this.engine.load(tx, companyId, row.leaseId),
        { moveOutId: row.id, valueDate: today, rentMinor: rent, serviceChargeMinor: service },
      );
    }
    // 6. The refunds payable: credit (P13) and deposit (P12).
    if (s.creditRefundMinor > 0)
      await this.engine.approveRefund(tx, state, {
        terminationId: row.id,
        amountMinor: s.creditRefundMinor,
        valueDate: today,
        causedBy,
        recordParts: !preview,
        subject: 'move_out',
      });
    if (s.depositRefundMinor > 0)
      await this.engine.approveDepositRefund(tx, state, {
        moveOutId: row.id,
        amountMinor: s.depositRefundMinor,
        valueDate: today,
        causedBy,
      });
    const lines = await this.lineFacts(tx, state);
    const view = (l: { lineId: string; amountMinor: number }): LineAmountView => {
      const f = lines.get(l.lineId);
      return {
        lineId: l.lineId,
        invoiceNumber: f?.invoiceNumber ?? '',
        label: f?.label ?? '',
        periodStart: f?.periodStart ?? null,
        periodEnd: f?.periodEnd ?? null,
        amountMinor: l.amountMinor,
      };
    };
    const creditToArrears = [...creditApplied, ...s.creditToArrears].filter(
      (l) => l.amountMinor > 0,
    );
    return {
      lastDay,
      early: row.early,
      depositHeldMinor: depositHeld,
      creditMinor: creditBefore,
      arrearsMinor: arrearsBefore,
      chargesMinor: sum(charges),
      breakCreditMinor: breakCredit,
      creditToArrears: creditToArrears.map(view),
      depositToArrears: s.depositToArrears.map(view),
      deductionsMinor: s.deductionsMinor,
      retainedMinor: s.retainedMinor,
      deductionsChargedMinor: s.deductionsChargedMinor,
      creditAppliedMinor: sum(creditToArrears),
      depositAppliedMinor: s.depositAppliedMinor,
      creditRefundMinor: s.creditRefundMinor,
      depositRefundMinor: s.depositRefundMinor,
      refundMinor: s.refundMinor,
      stillOwedMinor: s.stillOwedMinor,
    };
  }

  /** Charged lines still owed, oldest first: what credit and the deposit pay. */
  private openLines(state: LeaseState) {
    return state.lines
      .filter((l) => l.kind !== 'deposit' && postingClassOf(l) === 'receivable')
      .map((l) => ({ ...l, outstandingMinor: lineBalance(l, state.allocations).outstandingMinor }))
      .filter((l) => l.outstandingMinor > 0)
      .sort((a, b) =>
        a.dueDate === b.dueDate ? (a.id < b.id ? -1 : 1) : a.dueDate < b.dueDate ? -1 : 1,
      );
  }

  private async lineFacts(tx: Tx, state: LeaseState) {
    const ids = state.lines.map((l) => l.id);
    const numbers = ids.length
      ? await tx
          .select({ lineId: schema.invoiceLine.id, number: schema.invoice.number })
          .from(schema.invoiceLine)
          .innerJoin(
            schema.invoice,
            and(
              eq(schema.invoice.companyId, schema.invoiceLine.companyId),
              eq(schema.invoice.id, schema.invoiceLine.invoiceId),
            ),
          )
          .where(inArray(schema.invoiceLine.id, ids))
      : [];
    const byId = new Map(numbers.map((n) => [n.lineId, n.number]));
    return new Map(
      state.lines.map((l) => [
        l.id,
        {
          invoiceNumber: byId.has(l.id) ? `INV-${String(byId.get(l.id)).padStart(6, '0')}` : '',
          label: lineLabel(l),
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
        },
      ]),
    );
  }

  private async payloadOf(
    tx: Tx,
    row: MoveOutRow,
    s: FinalStatementView,
  ): Promise<SettlementPayload> {
    const facts = await this.facts(tx, row);
    const deductions = (await this.deductions(tx, row.id)).filter((d) => !d.withdrawnAt);
    return {
      moveOutId: row.id,
      leaseId: row.leaseId,
      unitCode: facts.unitCode,
      tenantName: facts.tenantName.slice(0, 200) || null,
      kind: row.kind as 'move_out' | 'deposit_settlement',
      lastDay: s.lastDay,
      early: s.early,
      charges: ((row.charges as { description: string; amountMinor: number }[]) ?? []).map((c) => ({
        description: c.description,
        amountMinor: c.amountMinor,
      })),
      deductions: deductions.map((d) => ({
        id: d.id,
        kind: d.kind,
        amountMinor: d.amountMinor,
        reason: d.reason,
        photoIds: d.photoIds,
      })),
      depositHeldMinor: s.depositHeldMinor,
      creditMinor: s.creditMinor,
      arrearsMinor: s.arrearsMinor,
      chargesMinor: s.chargesMinor,
      breakCreditMinor: s.breakCreditMinor,
      deductionsMinor: s.deductionsMinor,
      retainedMinor: s.retainedMinor,
      depositAppliedMinor: s.depositAppliedMinor,
      creditAppliedMinor: s.creditAppliedMinor,
      creditRefundMinor: s.creditRefundMinor,
      depositRefundMinor: s.depositRefundMinor,
      refundMinor: s.refundMinor,
      stillOwedMinor: s.stillOwedMinor,
      open: true,
    };
  }

  // Internals ---------------------------------------------------------------------------------

  /** A request decided against, withdrawn or expired returns the settlement to drafting. */
  private async syncApproval(tx: Tx, row: MoveOutRow): Promise<void> {
    if (row.status !== 'awaiting_approval' || !row.approvalRequestId) return;
    const [request] = await tx
      .select({ status: schema.approvalRequest.status })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, row.approvalRequestId));
    if (!request || !['rejected', 'cancelled', 'expired'].includes(request.status)) return;
    await tx
      .update(schema.moveOut)
      .set({ status: 'settlement_drafted', updatedAt: this.clock.now() })
      .where(and(eq(schema.moveOut.id, row.id), eq(schema.moveOut.status, 'awaiting_approval')));
  }

  private move(row: MoveOutRow, action: MoveOutAction): MoveOutStatus {
    try {
      return nextMoveOutStatus(row.status as MoveOutStatus, action);
    } catch (error) {
      return domainOf(error);
    }
  }

  private async setStatus(tx: Tx, row: MoveOutRow, status: MoveOutStatus) {
    if (status === row.status) return;
    await tx
      .update(schema.moveOut)
      .set({ status, updatedAt: this.clock.now() })
      .where(eq(schema.moveOut.id, row.id));
  }

  private async refuseSecond(tx: Tx, leaseId: string) {
    const [existing] = await tx
      .select({ id: schema.moveOut.id })
      .from(schema.moveOut)
      .where(and(eq(schema.moveOut.leaseId, leaseId), ne(schema.moveOut.status, 'cancelled')));
    if (existing)
      throw conflict('move_out_exists', 'This lease already has a move-out. Open it instead.');
  }

  private manager(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'moveout.manage');
    return staff;
  }

  private reader(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    if (
      !this.policy.can(staff, 'moveout.manage').allowed &&
      !this.policy.can(staff, 'moveout.settle').allowed
    )
      throw forbidden();
    return staff;
  }

  private unscoped(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  private async write<T>(staff: StaffActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withCompany(this.database, this.unscoped(staff), fn);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return domainOf(error);
    }
  }

  private async row(tx: Tx, moveOutId: string, lock = false): Promise<MoveOutRow> {
    const query = tx.select().from(schema.moveOut).where(eq(schema.moveOut.id, moveOutId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound('Move-out');
    return row;
  }

  private async facts(tx: Tx, row: MoveOutRow) {
    const [f] = (
      await tx.execute<{
        unit_code: string;
        property_name: string;
        tenant_name: string;
        landlord: string | null;
      }>(sql`
        select u.code as unit_code, p.name as property_name, t.display_name as tenant_name,
               app.property_owner_name(${row.companyId}::uuid, ${row.propertyId}::uuid) as landlord
        from unit u join property p on p.company_id = u.company_id and p.id = u.property_id
        join tenant t on t.company_id = u.company_id and t.id = ${row.tenantId}
        where u.id = ${row.unitId}`)
    ).rows;
    return {
      unitCode: f?.unit_code ?? '',
      propertyName: f?.property_name ?? '',
      tenantName: f?.tenant_name ?? '',
      landlord: f?.landlord ?? '',
    };
  }

  private async deductions(tx: Tx, moveOutId: string) {
    const rows = await tx
      .select({
        d: schema.depositDeduction,
        withdrawnAt: schema.depositDeductionWithdrawal.createdAt,
        by: schema.person.name,
      })
      .from(schema.depositDeduction)
      .leftJoin(
        schema.depositDeductionWithdrawal,
        and(
          eq(schema.depositDeductionWithdrawal.companyId, schema.depositDeduction.companyId),
          eq(schema.depositDeductionWithdrawal.deductionId, schema.depositDeduction.id),
        ),
      )
      .leftJoin(schema.person, eq(schema.person.id, schema.depositDeduction.createdBy))
      .where(eq(schema.depositDeduction.moveOutId, moveOutId))
      .orderBy(schema.depositDeduction.createdAt);
    return rows.map((r) => ({
      id: r.d.id,
      kind: r.d.kind as DeductionKind,
      kindLabel: DEDUCTION_KIND_LABELS[r.d.kind as DeductionKind],
      amountMinor: r.d.amountMinor,
      reason: r.d.reason,
      inspectionItemIds: r.d.inspectionItemIds,
      photoIds: r.d.photoIds,
      createdAt: r.d.createdAt,
      createdByName: r.by ?? null,
      withdrawnAt: r.withdrawnAt ?? null,
    }));
  }

  private async views(tx: Tx, rows: readonly MoveOutRow[]) {
    const out = [];
    for (const r of rows) {
      const f = await this.facts(tx, r);
      out.push({
        id: r.id,
        leaseId: r.leaseId,
        kind: r.kind as 'move_out' | 'deposit_settlement',
        status: r.status as MoveOutStatus,
        statusLabel: MOVE_OUT_STATUS_LABELS[r.status as MoveOutStatus],
        reason: (r.reason as MoveOutReason | null) ?? null,
        plannedDate: r.plannedDate,
        property: { id: r.propertyId, name: f.propertyName },
        unit: { id: r.unitId, code: f.unitCode },
        tenant: { id: r.tenantId, name: f.tenantName },
        noticeId: r.noticeId,
        inspectionId: r.inspectionId,
        moveInInspectionId: r.moveInInspectionId,
        note: r.note,
        createdAt: r.createdAt,
      });
    }
    return out;
  }

  private async detail(
    tx: Tx,
    staff: StaffActor,
    row: MoveOutRow,
    view: Awaited<ReturnType<MoveOutService['views']>>[number],
    statement: FinalStatementView | null,
    unavailable: { code: string; message: string } | null,
    approval: Awaited<ReturnType<ApprovalsService['get']>> | null,
  ) {
    const [lease] = await tx
      .select({ status: schema.lease.status })
      .from(schema.lease)
      .where(eq(schema.lease.id, row.leaseId));
    const drafting =
      LIVE_MOVE_OUT_STATUSES.includes(row.status as MoveOutStatus) &&
      row.status !== 'awaiting_approval';
    const manage = this.policy.can(staff, 'moveout.manage').allowed;
    return {
      ...view,
      deductions: await this.deductions(tx, row.id),
      charges: (row.charges as { description: string; amountMinor: number }[]) ?? [],
      statement,
      statementUnavailable: unavailable,
      approval,
      approvedOn: row.approvedOn,
      refundPaid:
        row.paidOn && row.paidFrom && row.paidReference
          ? {
              paidOn: row.paidOn,
              paidFrom: row.paidFrom as 'owner_account' | 'agency_account',
              reference: row.paidReference,
              amountMinor: (row.creditRefundMinor ?? 0) + (row.depositRefundMinor ?? 0),
            }
          : null,
      statementDocument: row.statementSha256 ? { sha256: row.statementSha256 } : null,
      leaseStatus: lease?.status ?? '',
      actions: {
        inspect: manage && drafting && this.policy.can(staff, 'inspection.perform').allowed,
        editSettlement: manage && drafting,
        submit: manage && row.status === 'settlement_drafted',
        recordRefundPaid:
          this.policy.can(staff, 'moveout.settle').allowed &&
          row.status === 'approved' &&
          (row.creditRefundMinor ?? 0) + (row.depositRefundMinor ?? 0) > 0,
        cancel: manage && drafting,
      },
    };
  }
}
