import { DomainError } from '../errors';

/** Approval requests (AD-05; architecture section 7, approval request state machine). */
export type ApprovalStatus =
  'pending' | 'cooling_off' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export type ApprovalMode = 'two_person' | 'single_user';
export type DecisionKind = 'approve' | 'reject' | 'self_confirm';
export type CancelReason = 'withdrawn' | 'subject_changed';

export const OPEN_STATUSES: readonly ApprovalStatus[] = ['pending', 'cooling_off'];

export const isOpen = (status: ApprovalStatus): boolean => OPEN_STATUSES.includes(status);

/**
 * Single-user mode applies when nobody but the initiator could approve, nominated approvers
 * included (OQ-29). The request then waits out the cooling-off period before the initiator
 * may confirm it with a fresh one-time code.
 */
export function chooseMode(eligibleApproversOtherThanInitiator: number): ApprovalMode {
  return eligibleApproversOtherThanInitiator > 0 ? 'two_person' : 'single_user';
}

export const initialStatus = (mode: ApprovalMode): ApprovalStatus =>
  mode === 'single_user' ? 'cooling_off' : 'pending';

export type ApprovalEvent =
  | {
      readonly type: 'decision';
      readonly kind: DecisionKind;
      readonly approvalsAfter: number;
      readonly required: number;
    }
  | { readonly type: 'cancel'; readonly reason: CancelReason }
  | { readonly type: 'expire' };

export interface ApprovalState {
  readonly status: ApprovalStatus;
  readonly mode: ApprovalMode;
  readonly coolingOffUntil: Date | null;
  readonly expiresAt: Date;
}

/** Next status for an event, or a DomainError when the transition is not allowed. */
export function nextStatus(state: ApprovalState, event: ApprovalEvent, now: Date): ApprovalStatus {
  if (!isOpen(state.status)) {
    throw new DomainError('approval.closed', `The request is already ${state.status}`);
  }
  switch (event.type) {
    case 'expire':
      if (now.getTime() < state.expiresAt.getTime())
        throw new DomainError('approval.not_expired', 'The request has not expired');
      return 'expired';
    case 'cancel':
      return 'cancelled';
    case 'decision': {
      if (now.getTime() >= state.expiresAt.getTime())
        throw new DomainError('approval.expired', 'The request has expired');
      if (event.kind === 'reject') return 'rejected';
      if (event.kind === 'self_confirm') {
        if (state.mode !== 'single_user' || state.status !== 'cooling_off') {
          throw new DomainError(
            'approval.self_confirm_not_allowed',
            'Self-confirmation is only for single-user companies',
          );
        }
        if (!state.coolingOffUntil || now.getTime() < state.coolingOffUntil.getTime()) {
          throw new DomainError('approval.cooling_off', 'The cooling-off period has not ended');
        }
        return 'approved';
      }
      if (state.mode !== 'two_person') {
        throw new DomainError(
          'approval.no_second_person',
          'This request can only be self-confirmed after cooling off',
        );
      }
      return event.approvalsAfter >= event.required ? 'approved' : 'pending';
    }
  }
}
