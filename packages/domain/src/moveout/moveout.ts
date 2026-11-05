import { DomainError } from '../errors';

/**
 * Move-out (TL-11, MI-11; M8 decision 12 and plan 4.8): one flow for every ending, from the planned
 * date to the refund. The lease becomes Ending when the date is planned, and Ended (or Terminated
 * for an early end) when the settlement is approved. No deposit law value is built in (OQ-59):
 * no cap, no deadline.
 */
export const MOVE_OUT_REASONS = [
  'end_of_term',
  'tenant_notice',
  'landlord_notice',
  'early_termination',
] as const;
export type MoveOutReason = (typeof MOVE_OUT_REASONS)[number];

export const MOVE_OUT_REASON_LABELS: Record<MoveOutReason, string> = {
  end_of_term: 'End of the term',
  tenant_notice: 'The tenant gave notice',
  landlord_notice: 'The landlord gave notice',
  early_termination: 'Early termination',
};

export const MOVE_OUT_STATUSES = [
  'planned',
  'inspected',
  'settlement_drafted',
  'awaiting_approval',
  'approved',
  'refund_paid',
  'closed',
  'cancelled',
] as const;
export type MoveOutStatus = (typeof MOVE_OUT_STATUSES)[number];

export const MOVE_OUT_STATUS_LABELS: Record<MoveOutStatus, string> = {
  planned: 'Planned',
  inspected: 'Inspected',
  settlement_drafted: 'Settlement drafted',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  refund_paid: 'Refund paid',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** A move-out still being worked: one per lease. */
export const LIVE_MOVE_OUT_STATUSES: readonly MoveOutStatus[] = [
  'planned',
  'inspected',
  'settlement_drafted',
  'awaiting_approval',
];

const MOVES: Readonly<Record<string, readonly MoveOutStatus[]>> = {
  inspect: ['planned', 'inspected', 'settlement_drafted'],
  draft: ['planned', 'inspected', 'settlement_drafted'],
  submit: ['settlement_drafted'],
  return: ['awaiting_approval'],
  approve: ['awaiting_approval'],
  pay_refund: ['approved'],
  close: ['approved', 'refund_paid'],
  cancel: ['planned', 'inspected', 'settlement_drafted'],
};

export type MoveOutAction =
  'inspect' | 'draft' | 'submit' | 'return' | 'approve' | 'pay_refund' | 'close' | 'cancel';

const TO: Record<MoveOutAction, MoveOutStatus> = {
  inspect: 'inspected',
  draft: 'settlement_drafted',
  submit: 'awaiting_approval',
  return: 'settlement_drafted',
  approve: 'approved',
  pay_refund: 'refund_paid',
  close: 'closed',
  cancel: 'cancelled',
};

/** The move-out's next status, or `moveout.transition` naming why not. */
export function nextMoveOutStatus(from: MoveOutStatus, action: MoveOutAction): MoveOutStatus {
  if (!MOVES[action]!.includes(from))
    throw new DomainError(
      'moveout.transition',
      `A move-out that is ${MOVE_OUT_STATUS_LABELS[from].toLowerCase()} cannot do that now`,
    );
  // A drafted settlement keeps its inspection: inspecting again does not move it back.
  if (action === 'inspect' && from === 'settlement_drafted') return 'settlement_drafted';
  return TO[action];
}

/**
 * What a deduction is for (MI-11). Unpaid rent and charges are never typed in: the statement takes
 * them from the ledger. Each typed deduction is linked to inspection items and their photos.
 */
export const DEDUCTION_KINDS = ['damage', 'cleaning', 'keys', 'missing_items', 'other'] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];

export const DEDUCTION_KIND_LABELS: Record<DeductionKind, string> = {
  damage: 'Damage',
  cleaning: 'Cleaning',
  keys: 'Keys',
  missing_items: 'Missing items',
  other: 'Other',
};

/** A deduction as entered: an amount above zero and a reason. */
export function checkDeduction(input: {
  readonly amountMinor: number;
  readonly reason: string;
}): void {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('moveout.deduction_amount', 'A deduction is an amount above zero');
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500)
    throw new DomainError('moveout.deduction_reason', 'Give the reason (3 to 500 characters)');
}

/** The deductions never exceed the deposit held (MI-11; domain and database). */
export function checkDeductionsWithinDeposit(
  deductions: readonly { readonly amountMinor: number }[],
  depositHeldMinor: number,
): void {
  const total = deductions.reduce((sum, d) => sum + d.amountMinor, 0);
  if (total > depositHeldMinor)
    throw new DomainError(
      'moveout.deductions_exceed_deposit',
      'The deductions are more than the deposit held. Record damage beyond the deposit as a charge',
    );
}
