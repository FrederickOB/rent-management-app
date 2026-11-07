import { oc } from '@orpc/contract';
import { DEDUCTION_KINDS, MOVE_OUT_REASONS, MOVE_OUT_STATUSES } from '@rent/domain/moveout';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * Move-out (TL-11, MI-11; M8 decision 12 and plan 4.8), on every plan: one flow for every ending,
 * from the planned date to the refund. The settlement needs a second person's approval
 * (`lease.move_out_settlement`; OQ-29 for a sole landlord) and then posts, in one transaction: the
 * agreed early charges (P01) and the break-clause credit (P27), the credit applied (P13), the
 * deposit applied to arrears and the deductions retained (P11, with P17 on the rent it settles),
 * and the refunds payable (P13, P12). No deposit law value is built in (OQ-59). M5's early
 * terminations stay readable; new early ends go through this flow.
 *
 * A lease that already ended without one (M3's quick "Record the move-out", or an M5 early
 * termination, both of which leave the deposit in 2100) gets a deposit settlement: the same flow
 * without the plan step, started with POST /leases/{leaseId}/deposit-settlement. The lease keeps
 * its status.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const lineAmount = z.object({
  lineId: uuid,
  invoiceNumber: z.string(),
  label: z.string(),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  amountMinor: minor,
});

/**
 * The final statement (plan 4.8). It always balances, by two identities (`statementBalances` in
 * `@rent/domain/moveout` checks exactly these fields):
 *
 *   depositHeld + credit = creditApplied + depositApplied + retained + creditRefund + depositRefund
 *   arrears + deductionsCharged = creditApplied + depositApplied + stillOwed
 *
 * `credit` and `arrears` are taken after the early steps: the charges (P01) are already in
 * `arrears`, and the break-clause credit (P27) is already in `credit` (on a paid month) or off
 * `arrears` (on an unpaid one). `chargesMinor` and `breakCreditMinor` show those steps; they are
 * not added again.
 */
export const finalStatementSchema = z.object({
  lastDay: isoDate,
  /** An early end (before the lease's end date): M5's early steps apply. */
  early: z.boolean(),
  depositHeldMinor: minor,
  /** The lease's credit (2010) after the early steps, the break-clause credit included. */
  creditMinor: minor,
  /** What is owed after the early steps: open lines, the charges included. */
  arrearsMinor: minor,
  /** P01: charges on any move-out (agreed early charges, damage beyond the deposit). In `arrears`. */
  chargesMinor: minor,
  /** P27: the unused days of the last month, where the break clause allows (early only). In `credit` or off `arrears`. */
  breakCreditMinor: minor,
  /** P13 apply: the credit on each open line, oldest first. */
  creditToArrears: z.array(lineAmount),
  /** P11: the deposit on each open line it settles (rent settled so counts as rent received). */
  depositToArrears: z.array(lineAmount),
  deductionsMinor: minor,
  /** P11: retained to 4300. */
  retainedMinor: minor,
  /** Deductions the deposit could no longer cover after arrears, charged (P01) to the tenant. */
  deductionsChargedMinor: minor,
  creditAppliedMinor: minor,
  depositAppliedMinor: minor,
  /** P13. */
  creditRefundMinor: minor,
  /** P12. */
  depositRefundMinor: minor,
  refundMinor: minor,
  /** Arrears that stay on the lease after everything (collect, or write off with P24). */
  stillOwedMinor: minor,
});
export type FinalStatementView = z.infer<typeof finalStatementSchema>;

export const deductionSchema = z.object({
  id: uuid,
  kind: z.enum(DEDUCTION_KINDS),
  kindLabel: z.string(),
  amountMinor: minor,
  reason: z.string(),
  /** The move-out inspection items behind it, and their photos (MI-11). */
  inspectionItemIds: z.array(uuid),
  photoIds: z.array(uuid),
  createdAt: iso,
  createdByName: z.string().nullable(),
  /** Withdrawn by a later record (deductions are never edited). */
  withdrawnAt: iso.nullable(),
});

export const moveOutChargeSchema = z.object({
  description: z.string().trim().min(2).max(120),
  amountMinor: positiveMinor,
});

export const MOVE_OUT_KINDS = ['move_out', 'deposit_settlement'] as const;

export const moveOutSchema = z.object({
  id: uuid,
  leaseId: uuid,
  /**
   * `move_out`: planned on a live lease, which becomes Ending, then Ended or Terminated.
   * `deposit_settlement`: on a lease already ended or terminated with a deposit still held; it
   * starts at `settlement_drafted` and the lease keeps its status.
   */
  kind: z.enum(MOVE_OUT_KINDS),
  status: z.enum(MOVE_OUT_STATUSES),
  statusLabel: z.string(),
  /** Why the tenancy ends; null for a deposit settlement (the lease ended before it). */
  reason: z.enum(MOVE_OUT_REASONS).nullable(),
  /** The planned last day; for a deposit settlement, the day the lease ended. */
  plannedDate: isoDate,
  property: z.object({ id: uuid, name: z.string() }),
  unit: z.object({ id: uuid, code: z.string() }),
  tenant: z.object({ id: uuid, name: z.string() }),
  /** The notice or tenant's intention it came from, if any. */
  noticeId: uuid.nullable(),
  inspectionId: uuid.nullable(),
  moveInInspectionId: uuid.nullable(),
  note: z.string().nullable(),
  createdAt: iso,
});

export const moveOutDetailSchema = moveOutSchema.extend({
  deductions: z.array(deductionSchema),
  /** Charges (P01) on any move-out: agreed early charges and damage beyond the deposit. */
  charges: z.array(moveOutChargeSchema),
  /** The statement as it would be done now; once approved, as it was done. */
  statement: finalStatementSchema.nullable(),
  /** Why no statement can be shown yet (for example the end not yet processed). */
  statementUnavailable: z.object({ code: z.string(), message: z.string() }).nullable(),
  approval: approvalSchema.nullable(),
  /**
   * While the settlement waits for approval: whether the figures asked for still hold, compared
   * live with the statement as it would be done now. False means "The figures no longer hold":
   * the lease's money moved, or the request was replaced; approving it would cancel it. Null when
   * nothing waits for approval.
   */
  approvalFiguresHold: z.boolean().nullable(),
  approvedOn: isoDate.nullable(),
  refundPaid: z
    .object({
      paidOn: isoDate,
      paidFrom: z.enum(['owner_account', 'agency_account']),
      reference: z.string(),
      amountMinor: minor,
    })
    .nullable(),
  /** The final statement PDF, once approved. */
  statementDocument: z.object({ sha256: z.string() }).nullable(),
  /** The lease after the settlement: Ended, or Terminated for an early end. */
  leaseStatus: z.string(),
  actions: z.object({
    inspect: z.boolean(),
    editSettlement: z.boolean(),
    submit: z.boolean(),
    recordRefundPaid: z.boolean(),
    cancel: z.boolean(),
  }),
});
export type MoveOutDetail = z.infer<typeof moveOutDetailSchema>;

export const moveOutsContract = {
  plan: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/move-outs',
      summary:
        'Plan the move-out date and why (end of term, the tenant’s notice, the landlord’s notice or early termination). The lease becomes Ending. One live move-out per lease',
    })
    .input(
      z.object({
        leaseId: uuid,
        plannedDate: isoDate,
        reason: z.enum(MOVE_OUT_REASONS),
        noticeId: uuid.nullable().optional(),
        note: optionalText(1000),
      }),
    )
    .output(moveOutDetailSchema),
  settleDeposit: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/deposit-settlement',
      summary:
        'Settle the deposit of a lease already Ended or Terminated that still holds one (M3’s quick move-out, or an M5 early termination): the move-out flow without the plan step, starting at settlement drafted. Inspection optional; deductions, statement, approval and refund as usual. 409 NO_DEPOSIT_HELD, LEASE_NOT_ENDED or MOVE_OUT_EXISTS',
    })
    .input(z.object({ leaseId: uuid, note: optionalText(1000) }))
    .output(moveOutDetailSchema),
  list: oc
    .route({ method: 'GET', path: '/move-outs', summary: 'Move-outs, newest first' })
    .input(
      z.object({
        leaseId: uuid.optional(),
        propertyId: uuid.optional(),
        status: z.enum(MOVE_OUT_STATUSES).optional(),
      }),
    )
    .output(z.array(moveOutSchema)),
  get: oc
    .route({ method: 'GET', path: '/move-outs/{moveOutId}' })
    .input(z.object({ moveOutId: uuid }))
    .output(moveOutDetailSchema),
  startInspection: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/inspection',
      summary:
        'Start the move-out inspection, compared item by item with the move-in report (plan 4.6)',
    })
    .input(z.object({ moveOutId: uuid }))
    .output(moveOutDetailSchema),
  addDeduction: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/deductions',
      summary:
        'Add a deduction: kind, amount, reason, and the inspection items and photos behind it. A damage or missing-items deduction always cites the move-out inspection’s items or photos (400 DEDUCTION_EVIDENCE_REQUIRED); with no inspection yet, do it first (a deposit settlement’s is optional otherwise). The deductions never exceed the deposit held (409 DEDUCTIONS_EXCEED_DEPOSIT); damage beyond it is a charge. Requires an Idempotency-Key: a retry never records two deductions',
    })
    .input(
      z.object({
        moveOutId: uuid,
        kind: z.enum(DEDUCTION_KINDS),
        amountMinor: positiveMinor,
        reason: z.string().trim().min(3).max(500),
        inspectionItemIds: z.array(uuid).max(50).default([]),
        photoIds: z.array(uuid).max(50).default([]),
      }),
    )
    .output(moveOutDetailSchema),
  withdrawDeduction: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/deductions/{deductionId}/withdraw',
      summary:
        'Withdraw a deduction while the settlement is drafted (recorded, never deleted). Requires an Idempotency-Key',
    })
    .input(z.object({ moveOutId: uuid, deductionId: uuid }))
    .output(moveOutDetailSchema),
  setCharges: oc
    .route({
      method: 'PUT',
      path: '/move-outs/{moveOutId}/charges',
      summary:
        'Charges (P01) on any move-out, while drafting: agreed early-termination charges and damage beyond the deposit. Replaces the list. Requires an Idempotency-Key',
    })
    .input(z.object({ moveOutId: uuid, charges: z.array(moveOutChargeSchema).max(20) }))
    .output(moveOutDetailSchema),
  submit: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/submit',
      summary:
        'Ask for the settlement (lease.move_out_settlement): a second person approves with the statement and every deduction’s photos in front of them, and it is done then',
    })
    .input(z.object({ moveOutId: uuid, note: optionalText(500) }))
    .output(moveOutDetailSchema),
  recordRefundPaid: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/refund-paid',
      summary:
        'Record the approved refund (P12 and P13) as paid outside the platform, with its reference and proof (upload from POST /refund-uploads). 409 INSUFFICIENT_AGENT_CASH when paid from the agency’s account beyond what it holds for the owner (record the owner’s funding first). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        moveOutId: uuid,
        paidOn: isoDate,
        paidFrom: z.enum(['owner_account', 'agency_account']),
        reference: z.string().trim().min(2).max(120),
        proofUploadId: uuid,
      }),
    )
    .output(moveOutDetailSchema),
  cancel: oc
    .route({
      method: 'POST',
      path: '/move-outs/{moveOutId}/cancel',
      summary:
        'Cancel a move-out not yet sent for approval: the lease goes back to Active (a deposit settlement’s lease keeps its status)',
    })
    .input(z.object({ moveOutId: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(moveOutDetailSchema),
  statementDocument: oc
    .route({
      method: 'GET',
      path: '/move-outs/{moveOutId}/statement-document',
      summary: 'A short-lived link to the final statement PDF',
    })
    .input(z.object({ moveOutId: uuid }))
    .output(z.object({ url: z.string(), expiresAt: iso })),
};
