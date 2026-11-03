import type { ApiClient } from '@rent/contracts/client';
import { isOpen, type ApprovalStatus } from '@rent/domain/approvals';
import { humanise } from './format';

// The approvals screen (AD-05; M3 decision 6). What a person may do is decided by the API's
// policy; this only says which controls to offer. The initiator is never offered "Approve".

export type ApprovalRow = Awaited<ReturnType<ApiClient['approvals']['list']>>[number];

const ACTION_LABELS: Record<string, string> = {
  'lease.cancel_signed': 'Cancel a signed lease before it starts',
};

export function approvalActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? humanise(actionType);
}

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Waiting for a decision',
  cooling_off: 'Cooling off',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const CLOSE_REASONS: Record<string, string> = {
  approved: 'Approved by a second person',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn by the person who asked',
  subject_changed: 'Closed: the record changed after the request was made',
  expired: 'Closed: nobody decided in time',
  self_confirmed_after_cooling_off: 'Confirmed by the person who asked, after the cooling-off',
};

export function closeReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return CLOSE_REASONS[reason] ?? humanise(reason);
}

export interface ApprovalMoves {
  /**
   * Approve or reject: anyone but the initiator, once, and only when the API says this person may
   * decide it (`mayDecide`: their role may decide this kind of request). The API checks it all
   * again (AD-05).
   */
  readonly decide: boolean;
  /** The initiator withdraws an open request. */
  readonly withdraw: boolean;
  /** A landlord who works alone confirms after the cooling-off, with an authenticator code. */
  readonly selfConfirm: boolean;
  /** Why the initiator cannot act yet, or null. */
  readonly waiting: string | null;
}

/** What to offer this person on a request, at `now`. */
export function approvalMoves(row: ApprovalRow, personId: string, now: Date): ApprovalMoves {
  const open = isOpen(row.status) && new Date(row.expiresAt) > now;
  const initiator = row.initiatedBy === personId;
  const decided = row.decisions.some((d) => d.decidedBy === personId);
  if (!open) return { decide: false, withdraw: false, selfConfirm: false, waiting: null };
  if (!initiator)
    return {
      decide: row.mode === 'two_person' && !decided && row.mayDecide !== false,
      withdraw: false,
      selfConfirm: false,
      waiting: null,
    };
  if (row.mode === 'single_user') {
    const ready = row.coolingOffUntil !== null && new Date(row.coolingOffUntil) <= now;
    return {
      decide: false,
      withdraw: true,
      selfConfirm: ready,
      waiting: ready ? null : 'cooling_off',
    };
  }
  return { decide: false, withdraw: true, selfConfirm: false, waiting: 'second_person' };
}

/** A reason the payload carries, if it has one (a cancel-signed request does). */
export function payloadReason(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

/** Where the request's record is on screen, when the screen has a page for it. */
export function subjectHref(row: Pick<ApprovalRow, 'subjectType' | 'subjectId'>): string | null {
  return row.subjectType === 'lease' ? `/leases/${row.subjectId}` : null;
}

/** A person's name from the people this session may list, or a neutral fallback. */
export function personName(
  personId: string,
  me: { readonly personId: string },
  names: ReadonlyMap<string, string>,
): string {
  if (personId === me.personId) return 'You';
  return names.get(personId) ?? 'Another person in your company';
}
