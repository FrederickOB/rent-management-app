import type { FinalStatementView, MoveOutDetail } from '@rent/contracts';
import {
  DEDUCTION_KINDS,
  DEDUCTION_KIND_LABELS,
  LIVE_MOVE_OUT_STATUSES,
  MOVE_OUT_REASONS,
  MOVE_OUT_REASON_LABELS,
  MOVE_OUT_STATUS_LABELS,
  statementBalances,
  statementTotals,
  type DeductionKind,
  type MoveOutReason,
  type MoveOutStatus,
} from '@rent/domain/moveout';
import { money, toDecimal } from '@rent/domain/money';
import { formatBusinessDate } from './business-dates';
import { errorCode } from './errors';
import { amountMinorOf } from './payment-form';
import { formatMinor } from './tenancy-format';

// Move-out (TL-11, MI-11; M8 decision 12 and plan 4.8): plan it, inspect, deductions linked to
// inspection items and photos, the agreed early charges, the final statement, one approval and
// the refund recorded as paid. Every figure comes from the API, worked out from the ledger;
// nothing about the deposit is typed in except the deductions. No deposit law value is built in
// (OQ-59).

export type Deduction = MoveOutDetail['deductions'][number];

export const REASON_OPTIONS = MOVE_OUT_REASONS.map((r) => ({
  value: r,
  label: MOVE_OUT_REASON_LABELS[r],
}));
export const DEDUCTION_OPTIONS = DEDUCTION_KINDS.map((k) => ({
  value: k,
  label: DEDUCTION_KIND_LABELS[k],
}));

export const reasonOf = (value: string): MoveOutReason | null =>
  MOVE_OUT_REASONS.find((r) => r === value) ?? null;
export const deductionKindOf = (value: string): DeductionKind | null =>
  DEDUCTION_KINDS.find((k) => k === value) ?? null;

export const moveOutStatusLabel = (status: MoveOutStatus): string => MOVE_OUT_STATUS_LABELS[status];
export const isLive = (status: MoveOutStatus): boolean => LIVE_MOVE_OUT_STATUSES.includes(status);

/** The lease's move-out to show: the live one, else the newest (the API lists newest first). */
export function currentMoveOut<M extends { readonly status: MoveOutStatus }>(
  moveOuts: readonly M[],
): M | null {
  return (
    moveOuts.find((m) => isLive(m.status)) ?? moveOuts.find((m) => m.status !== 'cancelled') ?? null
  );
}

// Planning ------------------------------------------------------------------------------------

export interface PlanDraft {
  readonly plannedDate: string;
  readonly reason: MoveOutReason | '';
  readonly noticeId: string;
  readonly note: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The plan as the API takes it, or the problems. A date before the end date is an early end, so
 * the reason must say so: the early steps (agreed charges, the break clause) apply only then.
 */
export function planInput(
  draft: PlanDraft,
  lease: { readonly startDate: string; readonly endDate: string },
): {
  readonly input: {
    plannedDate: string;
    reason: MoveOutReason;
    noticeId: string | null;
    note: string | null;
  } | null;
  readonly errors: Partial<Record<keyof PlanDraft, string>>;
} {
  const errors: Partial<Record<keyof PlanDraft, string>> = {};
  if (!ISO_DATE.test(draft.plannedDate)) errors.plannedDate = 'Choose the move-out date';
  else if (draft.plannedDate < lease.startDate)
    errors.plannedDate = `The move-out cannot be before the lease starts, on ${formatBusinessDate(lease.startDate)}`;
  if (!draft.reason) errors.reason = 'Choose why the tenancy is ending';
  else if (
    ISO_DATE.test(draft.plannedDate) &&
    draft.plannedDate < lease.endDate &&
    draft.reason === 'end_of_term'
  )
    errors.reason = `The lease runs to ${formatBusinessDate(lease.endDate)}, so this is not the end of the term. Choose the notice or early termination.`;
  if (draft.noticeId && !UUID.test(draft.noticeId))
    errors.noticeId = 'Choose a notice from the list';
  if (draft.note.trim().length > 1000) errors.note = 'Use at most 1,000 characters';
  if (Object.keys(errors).length > 0 || !draft.reason) return { input: null, errors };
  return {
    input: {
      plannedDate: draft.plannedDate,
      reason: draft.reason,
      noticeId: draft.noticeId || null,
      note: draft.note.trim() || null,
    },
    errors: {},
  };
}

/** An early end: before the lease's end date (M5's early steps apply). */
export const isEarly = (plannedDate: string, endDate: string): boolean => plannedDate < endDate;

// Deductions (MI-11) ----------------------------------------------------------------------------

/** Deductions in force: those not withdrawn. */
export const liveDeductions = (deductions: readonly Deduction[]): Deduction[] =>
  deductions.filter((d) => d.withdrawnAt === null);

export const deductionsTotal = (deductions: readonly Pick<Deduction, 'amountMinor'>[]): number =>
  deductions.reduce((sum, d) => sum + d.amountMinor, 0);

/**
 * What is left of the deposit for more deductions: the deposit held less the deductions in force
 * (never below zero). Deductions never exceed the deposit (MI-11, ★); damage beyond it is a charge.
 */
export function depositLeftMinor(
  depositHeldMinor: number,
  deductions: readonly Deduction[],
): number {
  const left = depositHeldMinor - deductionsTotal(liveDeductions(deductions));
  return left > 0 ? left : 0;
}

/**
 * What stands behind a deduction, for the approver (MI-11): photos, inspection items without
 * photos, or nothing. After a quick move-out there may have been no inspection at all.
 */
export function deductionEvidence(
  d: Pick<Deduction, 'photoIds' | 'inspectionItemIds'>,
): 'photos' | 'items' | 'none' {
  if (d.photoIds.length > 0) return 'photos';
  return d.inspectionItemIds.length > 0 ? 'items' : 'none';
}

export const EVIDENCE_TEXT: Record<'items' | 'none', string> = {
  items: 'No photo: only the inspection items below stand behind it.',
  none: 'No photo and no inspection item stand behind this deduction.',
};

/** Founder, 2026-11-06: damage and missing items always need an inspection item or a photo. */
export const needsEvidence = (kind: DeductionKind | ''): boolean =>
  kind === 'damage' || kind === 'missing_items';

/**
 * The guidance on the deduction form when a deduction needs evidence and there is no inspection
 * to take it from (a deposit settlement after M3's quick move-out, or a move-out not yet
 * inspected): do the inspection first. Null when nothing is in the way.
 */
export function evidenceGuidance(kind: DeductionKind | '', hasInspection: boolean): string | null {
  if (!needsEvidence(kind) || hasInspection) return null;
  return 'Damage and missing items need an inspection item or a photo behind them, so do the move-out inspection first. It is optional for other deductions, such as cleaning or keys.';
}

export interface DeductionDraft {
  readonly kind: DeductionKind | '';
  readonly amount: string;
  readonly reason: string;
  readonly itemIds: readonly string[];
  readonly photoIds: readonly string[];
}

export const emptyDeduction: DeductionDraft = {
  kind: '',
  amount: '',
  reason: '',
  itemIds: [],
  photoIds: [],
};

export type DeductionField = 'kind' | 'amount' | 'reason' | 'evidence';

/**
 * A deduction as the API takes it, or the problems. It is refused here when it would take the
 * deductions over the deposit held, with what is left; the API refuses it again (409
 * `DEDUCTIONS_EXCEED_DEPOSIT`). Damage needs the inspection items behind it (MI-11).
 */
export function deductionInput(
  draft: DeductionDraft,
  leftMinor: number,
): {
  readonly input: {
    kind: DeductionKind;
    amountMinor: number;
    reason: string;
    inspectionItemIds: string[];
    photoIds: string[];
  } | null;
  readonly errors: Partial<Record<DeductionField, string>>;
} {
  const errors: Partial<Record<DeductionField, string>> = {};
  if (!draft.kind) errors.kind = 'Choose what the deduction is for';
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  else if (amount.value !== null && amount.value > leftMinor)
    errors.amount =
      leftMinor > 0
        ? `Only ${formatMinor(leftMinor)} of the deposit is left. Record damage beyond the deposit as a charge.`
        : 'Nothing is left of the deposit. Record damage beyond the deposit as a charge.';
  const reason = draft.reason.trim();
  if (reason.length < 3) errors.reason = 'Give the reason, at least 3 characters';
  else if (reason.length > 500) errors.reason = 'Use at most 500 characters';
  if ((draft.kind === 'damage' || draft.kind === 'missing_items') && draft.itemIds.length === 0)
    errors.evidence = 'Choose the inspection items that show it';
  if (draft.itemIds.length > 50 || draft.photoIds.length > 50)
    errors.evidence = 'Choose at most 50 items and 50 photos';
  if (Object.keys(errors).length > 0 || !draft.kind || amount.value === null)
    return { input: null, errors };
  return {
    input: {
      kind: draft.kind,
      amountMinor: amount.value,
      reason,
      inspectionItemIds: [...draft.itemIds],
      photoIds: [...draft.photoIds],
    },
    errors: {},
  };
}

// Charges (P01): damage beyond the deposit on any move-out, and agreed early-end charges ---------

export interface ChargeRow {
  readonly description: string;
  readonly amount: string;
}

export const emptyCharge: ChargeRow = { description: '', amount: '' };

export const rowsOfCharges = (charges: MoveOutDetail['charges']): ChargeRow[] =>
  charges.map((c) => ({
    description: c.description,
    amount: toDecimal(money(c.amountMinor)),
  }));

/** The charges as the API takes them (blank rows ignored), or the problem by row. */
export function chargesInput(rows: readonly ChargeRow[]): {
  readonly charges: { description: string; amountMinor: number }[] | null;
  readonly errors: Readonly<Record<number, string>>;
} {
  const errors: Record<number, string> = {};
  const charges: { description: string; amountMinor: number }[] = [];
  rows.forEach((row, index) => {
    const description = row.description.trim();
    if (!description && !row.amount.trim()) return;
    if (description.length < 2 || description.length > 120) {
      errors[index] = 'Describe the charge in 2 to 120 characters';
      return;
    }
    const amount = amountMinorOf(row.amount);
    if (amount.problem || amount.value === null) {
      errors[index] = amount.problem ?? 'Enter the amount';
      return;
    }
    charges.push({ description, amountMinor: amount.value });
  });
  if (charges.length > 20) return { charges: null, errors: { 0: 'Use at most 20 charges' } };
  return Object.keys(errors).length > 0 ? { charges: null, errors } : { charges, errors: {} };
}

// The final statement (plan 4.8) ------------------------------------------------------------------

export interface StatementCheck {
  readonly balances: boolean;
  /** Deposit held plus credit. */
  readonly inMinor: number;
  /** Applied to arrears, retained and refunded. */
  readonly outMinor: number;
  /** Arrears plus deductions charged. */
  readonly owedMinor: number;
  /** Settled from the credit and deposit, plus still owed. */
  readonly settledMinor: number;
}

/**
 * The statement's identities, so the approver can see it balances (review WEB 7: the domain's
 * check, not a copy): deposit + credit = applied + retained + refunded, and arrears + deductions
 * charged = settled + still owed. Charges sit inside arrears and the break credit inside credit,
 * so neither is added again. The verdict is `statementBalances`, plus refund = credit refund +
 * deposit refund; the totals are the domain's too.
 */
export function checkStatement(s: FinalStatementView): StatementCheck {
  const totals = statementTotals(s);
  return {
    balances: statementBalances(s) && s.refundMinor === s.creditRefundMinor + s.depositRefundMinor,
    inMinor: totals.in,
    outMinor: totals.out,
    owedMinor: totals.owed,
    settledMinor: totals.settled,
  };
}

export interface StatementRow {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: number;
  /** Shown even when zero: the figures every statement has. */
  readonly always?: boolean;
  readonly strong?: boolean;
}

export interface StatementSection {
  readonly key: 'held' | 'owed' | 'applied' | 'result';
  readonly title: string;
  readonly rows: readonly StatementRow[];
}

/**
 * The statement in the order it is worked out: what is held, what is owed, how it is applied, and
 * what is left (refund, still owed). Rows that are zero and not essential are left out.
 */
export function statementSections(s: FinalStatementView): StatementSection[] {
  const keep = (rows: StatementRow[]) => rows.filter((r) => r.always || r.amountMinor !== 0);
  return [
    {
      key: 'held',
      title: 'Held for the tenant',
      rows: keep([
        {
          key: 'deposit',
          label: 'Security deposit held',
          amountMinor: s.depositHeldMinor,
          always: true,
        },
        {
          key: 'credit',
          label: 'Rent paid ahead and credit',
          amountMinor: s.creditMinor,
          always: true,
        },
      ]),
    },
    {
      key: 'owed',
      title: 'Owed by the tenant',
      rows: keep([
        {
          key: 'arrears',
          label: 'Unpaid rent and charges (from the ledger)',
          amountMinor: s.arrearsMinor,
          always: true,
        },
        {
          key: 'charges',
          label: 'Charges: damage beyond the deposit and agreed early-end charges, included above',
          amountMinor: s.chargesMinor,
        },
        {
          key: 'break',
          label: 'Break-clause credit for unused days, already applied',
          amountMinor: s.breakCreditMinor,
        },
        {
          key: 'deductions',
          label: 'Deductions from the deposit',
          amountMinor: s.deductionsMinor,
          always: true,
        },
      ]),
    },
    {
      key: 'applied',
      title: 'How it is settled',
      rows: keep([
        {
          key: 'creditApplied',
          label: 'Credit applied to what is owed',
          amountMinor: s.creditAppliedMinor,
        },
        {
          key: 'depositApplied',
          label: 'Deposit applied to unpaid rent and charges',
          amountMinor: s.depositAppliedMinor,
        },
        { key: 'retained', label: 'Deposit kept for the deductions', amountMinor: s.retainedMinor },
        {
          key: 'charged',
          label: 'Deductions the deposit could not cover, charged to the tenant',
          amountMinor: s.deductionsChargedMinor,
        },
      ]),
    },
    {
      key: 'result',
      title: 'What is left',
      rows: keep([
        { key: 'creditRefund', label: 'Credit refunded', amountMinor: s.creditRefundMinor },
        { key: 'depositRefund', label: 'Deposit refunded', amountMinor: s.depositRefundMinor },
        {
          key: 'refund',
          label: 'Refund to the tenant',
          amountMinor: s.refundMinor,
          always: true,
          strong: true,
        },
        {
          key: 'stillOwed',
          label: 'Still owed by the tenant',
          amountMinor: s.stillOwedMinor,
          always: true,
          strong: true,
        },
      ]),
    },
  ];
}

/**
 * Whether the lease page offers "Settle the deposit" (M8 review of M3's quick move-out): the lease
 * ended (or an M5 early termination ended it, which never touched the deposit), a deposit is still
 * held, and no move-out other than a cancelled one exists. The API checks it all again.
 */
export function mayOfferDepositSettlement(input: {
  readonly leaseStatus: string;
  readonly depositHeldMinor: number | null;
  readonly moveOuts: readonly { readonly status: MoveOutStatus }[];
}): boolean {
  return (
    (input.leaseStatus === 'ended' || input.leaseStatus === 'terminated') &&
    input.depositHeldMinor !== null &&
    input.depositHeldMinor > 0 &&
    input.moveOuts.every((m) => m.status === 'cancelled')
  );
}

/** The lease statuses a move-out can be planned from: a tenancy still running. */
export const PLANNABLE_LEASE_STATUSES: readonly string[] = ['active', 'holding_over', 'ending'];

export const MOVE_OUT_KIND_LABELS: Record<MoveOutDetail['kind'], string> = {
  move_out: 'Move-out',
  deposit_settlement: 'Deposit settlement',
};

/** The reason in words; a deposit settlement has none (the lease ended before it). */
export const moveOutReasonText = (reason: MoveOutReason | null): string =>
  reason ? MOVE_OUT_REASON_LABELS[reason] : 'The lease had already ended';

/** What the person managing the move-out does next, in a line. */
export function moveOutNext(
  detail: Pick<MoveOutDetail, 'status' | 'statement' | 'refundPaid' | 'kind' | 'inspectionId'>,
): string {
  switch (detail.status) {
    case 'planned':
      return 'Next: the move-out inspection, compared item by item with the move-in report.';
    case 'inspected':
    case 'settlement_drafted':
      return detail.kind === 'deposit_settlement' && detail.inspectionId === null
        ? 'Next: inspect the unit if you can, so any deduction has photos behind it; then record deductions, check the final statement and ask for approval.'
        : 'Next: record any deductions and agreed charges, check the final statement, then ask for approval.';
    case 'awaiting_approval':
      return 'Waiting for a second person to approve the settlement. Whoever asked cannot approve it.';
    case 'approved':
      return detail.statement && detail.statement.refundMinor > 0
        ? 'Approved. Pay the refund outside the platform, then record it as paid with its proof.'
        : 'Approved. Nothing is left to refund.';
    case 'refund_paid':
    case 'closed':
      return 'Done. The final statement is on the lease and was sent to the tenant.';
    case 'cancelled':
      return detail.kind === 'deposit_settlement'
        ? 'Cancelled. The deposit is still held.'
        : 'Cancelled. The lease went back to active.';
  }
}

/** The refund recorded as paid, as the API takes it, without the proof the page adds. */
export function refundInput(
  draft: { readonly paidOn: string; readonly reference: string; readonly paidFrom: string },
  approvedOn: string | null,
  today: string,
): {
  readonly input: {
    paidOn: string;
    reference: string;
    paidFrom: 'owner_account' | 'agency_account';
  } | null;
  readonly errors: Partial<Record<'paidOn' | 'reference' | 'paidFrom', string>>;
} {
  const errors: Partial<Record<'paidOn' | 'reference' | 'paidFrom', string>> = {};
  if (!ISO_DATE.test(draft.paidOn)) errors.paidOn = 'Choose the date the refund was paid';
  else if (draft.paidOn > today) errors.paidOn = 'The date cannot be in the future';
  else if (approvedOn && draft.paidOn < approvedOn)
    errors.paidOn = `It cannot be paid before it was approved, on ${formatBusinessDate(approvedOn)}`;
  const reference = draft.reference.trim();
  if (reference.length < 2) errors.reference = 'Enter the transfer or MoMo reference';
  else if (reference.length > 120) errors.reference = 'Use at most 120 characters';
  const paidFrom =
    draft.paidFrom === 'owner_account' || draft.paidFrom === 'agency_account'
      ? draft.paidFrom
      : null;
  if (!paidFrom) errors.paidFrom = 'Choose the account it was paid from';
  if (Object.keys(errors).length > 0 || !paidFrom) return { input: null, errors };
  return { input: { paidOn: draft.paidOn, reference, paidFrom }, errors: {} };
}

// The approval (review WEB 4) ---------------------------------------------------------------------

/** Where the approver's copy of the statement stands. */
export type SettlementVerdict =
  'loading' | 'balances' | 'unbalanced' | 'unavailable' | 'stale' | 'failed';

/**
 * The approver's copy, checked: loaded, still the figures that were asked for (the API's live
 * comparison, `approvalFiguresHold`), and balancing.
 */
export function settlementVerdict(
  detail: Pick<MoveOutDetail, 'statement' | 'approvalFiguresHold'> | null,
  failed = false,
): SettlementVerdict {
  if (failed) return 'failed';
  if (!detail) return 'loading';
  if (detail.approvalFiguresHold === false) return 'stale';
  if (!detail.statement) return 'unavailable';
  return checkStatement(detail.statement).balances ? 'balances' : 'unbalanced';
}

export const FIGURES_NO_LONGER_HOLD =
  'The lease’s money has moved since the settlement was asked for, so these are not the figures that were asked for. Approving it would cancel it: reject it, and ask again with the figures as they are now.';

/**
 * Why Approve is off for a move-out settlement, or null when it may be approved: only once the
 * statement has loaded and balances. Rejecting is always possible.
 */
export function settlementBlock(verdict: SettlementVerdict): string | null {
  switch (verdict) {
    case 'balances':
      return null;
    case 'loading':
      return 'Approve is available once the final statement has loaded.';
    case 'unbalanced':
      return 'The final statement does not balance, so it cannot be approved. Reject it, or report it.';
    case 'unavailable':
      return 'There is no final statement to check yet, so it cannot be approved.';
    case 'stale':
      return 'The figures no longer hold, so it cannot be approved. Reject it, and ask again.';
    case 'failed':
      return 'The final statement could not be loaded, so it cannot be approved. Reload the page.';
  }
}

// The API's named refusals (M8 review round), in plain words for the screen they arrive on -------

export type MoveOutRefusal =
  /** Submit: the lease ended on another day than the move-out's last day. */
  | 'lease_ended_first'
  /** Refund paid: a deposit payment behind the settlement was charged back. */
  | 'deposit_charged_back'
  /** A payment reversal: a move-out already used this payment's deposit. */
  | 'payment_deposit_settled'
  /** M3's quick move-out while an M8 move-out is live. */
  | 'move_out_live';

const REFUSALS: Readonly<Record<string, MoveOutRefusal>> = {
  LEASE_ENDED_FIRST: 'lease_ended_first',
  DEPOSIT_CHARGED_BACK: 'deposit_charged_back',
  PAYMENT_DEPOSIT_SETTLED: 'payment_deposit_settled',
  MOVE_OUT_LIVE: 'move_out_live',
};

export const MOVE_OUT_REFUSAL_TEXT: Record<MoveOutRefusal, string> = {
  lease_ended_first:
    'The lease ended on a different day from this move-out’s last day, so this settlement cannot go ahead. Cancel this move-out, then settle the deposit for the lease as it ended.',
  deposit_charged_back:
    'Nothing was recorded. A deposit payment behind this settlement was charged back by the payment provider, so the refund cannot be recorded until someone has looked at that payment.',
  payment_deposit_settled:
    'This payment cannot be reversed here: a move-out has already used its deposit. Look at the lease’s move-out first.',
  move_out_live:
    'A move-out is already under way for this lease, so it ends through that move-out, with its inspection and the deposit. Open the move-out to carry on.',
};

/** Which of these refusals the API sent, or null for any other answer. */
export function moveOutRefusal(error: unknown): MoveOutRefusal | null {
  return REFUSALS[errorCode(error)] ?? null;
}
