import type { ApiClient } from '@rent/contracts/client';
import { isOpen, type ApprovalStatus } from '@rent/domain/approvals';
import {
  evidenceOfMethod,
  MONEY_LOCATION_LABELS,
  PAYMENT_METHOD_LABELS,
  RECEIVING_ACCOUNT_LABELS,
  REVERSAL_REASON_LABELS,
  type EvidenceKind,
} from './billing-format';
import { formatBusinessDate } from './business-dates';
import { humanise } from './format';
import { formatMinor } from './tenancy-format';

// The approvals screen (AD-05; M3 decision 6). What a person may do is decided by the API's
// policy; this only says which controls to offer. The initiator is never offered "Approve".

export type ApprovalRow = Awaited<ReturnType<ApiClient['approvals']['list']>>[number];

const ACTION_LABELS: Record<string, string> = {
  'lease.cancel_signed': 'Cancel a signed lease before it starts',
  // M4a (plan 4.8 and 4.9): every money action needs a second person (decision 3).
  'payment.cash_receipt': 'Post cash or a cheque received',
  'payment.direct_receipt': 'Post a transfer received',
  'cash.banking': 'Record cash as banked',
  'payment.reversal': 'Reverse a payment',
  'invoice.credit_note': 'Issue a credit note',
  'invoice.write_off': 'Write off a debt',
};

/** The money actions (M4a), whose payloads are summarised fact by fact. */
export const MONEY_ACTIONS: readonly string[] = [
  'payment.cash_receipt',
  'payment.direct_receipt',
  'cash.banking',
  'payment.reversal',
  'invoice.credit_note',
  'invoice.write_off',
];

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

export interface ApprovalFact {
  readonly label: string;
  readonly value: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function pick<T extends string>(labels: Record<T, string>, value: unknown): string | null {
  return typeof value === 'string' && value in labels ? labels[value as T] : null;
}

/**
 * A money request in plain words (M4a plan 4.8 and 4.9): the amount formatted from pesewas, the
 * unit and tenant, who paid or holds it, and why. It reads only the facts the payload carries,
 * so a field the request lacks is left out rather than guessed. Other requests have no facts.
 */
export function approvalFacts(actionType: string, payload: unknown): ApprovalFact[] {
  const data = asRecord(payload);
  if (!data || !MONEY_ACTIONS.includes(actionType)) return [];
  const str = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const date = (key: string): string | null => {
    const value = str(key);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatBusinessDate(value) : null;
  };
  const facts: ApprovalFact[] = [];
  const add = (label: string, value: string | null) => {
    if (value) facts.push({ label, value });
  };
  const amount = data.amountMinor;
  add('Amount', Number.isSafeInteger(amount) ? formatMinor(amount as number) : null);
  add('How it was paid', pick(PAYMENT_METHOD_LABELS, data.method));
  const cheque = [str('chequeNumber'), str('chequeBank')].filter(Boolean).join(', ');
  add('Cheque', cheque || null);
  add('Received on', date('receivedOn'));
  add('Banked on', date('bankedOn'));
  add('Paid by', str('payerName'));
  add('Unit', str('unitCode'));
  add('Tenant', str('tenantName'));
  add('Held by', str('collectorName'));
  add('Received into', pick(RECEIVING_ACCOUNT_LABELS, data.receivedInto));
  add('Banked into', pick(RECEIVING_ACCOUNT_LABELS, data.bankedInto));
  add('Owner', str('ownerName'));
  add('Sender’s reference', str('senderReference'));
  add('Invoice', str('invoiceNumber'));
  add('Line', str('lineLabel'));
  add('Receipt', str('receiptNumber'));
  // A reversal's reason is a choice from a list; a credit note's or write-off's is written.
  add('Reason', pick(REVERSAL_REASON_LABELS, data.reason) ?? str('reason'));
  add('Where the money is now', pick(MONEY_LOCATION_LABELS, data.moneyNowIn));
  add('Note', str('note'));
  return facts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file each money request is approved on, by its action. */
const EVIDENCE_OF: Record<string, (data: Record<string, unknown>) => EvidenceKind> = {
  'payment.cash_receipt': (data) => evidenceOfMethod(data.method === 'cheque' ? 'cheque' : 'cash'),
  'payment.direct_receipt': () => 'transfer_proof',
  'cash.banking': () => 'banking_slip',
};

/**
 * The photo, proof or slip an approver checks before deciding (BC-05, P07, P28): the payload's
 * `evidenceDocumentId`. A request made before payloads carried it has none, and shows no link.
 */
export function approvalEvidence(
  actionType: string,
  payload: unknown,
): { readonly documentId: string; readonly kind: EvidenceKind } | null {
  const data = asRecord(payload);
  const kindOf = EVIDENCE_OF[actionType];
  const documentId = data?.evidenceDocumentId;
  if (!data || !kindOf || typeof documentId !== 'string' || !UUID.test(documentId)) return null;
  return { documentId, kind: kindOf(data) };
}

/**
 * The lease line of a money request from its own payload (`unitCode`, `tenantName`), so the
 * screen fetches a lease only when the payload does not name it.
 */
export function payloadSubject(row: Pick<ApprovalRow, 'subjectType' | 'payload'>): {
  readonly title: string;
  readonly detail: string | null;
  readonly leaseId: string | null;
} | null {
  if (row.subjectType === 'lease') return null;
  const data = asRecord(row.payload);
  const unitCode = data?.unitCode;
  if (typeof unitCode !== 'string' || !unitCode.trim()) return null;
  const tenantName = data?.tenantName;
  return {
    title: `Lease for ${unitCode.trim()}`,
    detail: typeof tenantName === 'string' && tenantName.trim() ? tenantName.trim() : null,
    leaseId: payloadLeaseId(row),
  };
}

/** The lease a request is about, when its payload names one and it is not the subject itself. */
export function payloadLeaseId(row: Pick<ApprovalRow, 'subjectType' | 'payload'>): string | null {
  if (row.subjectType === 'lease') return null;
  const leaseId = asRecord(row.payload)?.leaseId;
  return typeof leaseId === 'string' && /^[0-9a-f-]{36}$/i.test(leaseId) ? leaseId : null;
}

/** Where the request's record is on screen, when the screen has a page for it. */
export function subjectHref(
  row: Pick<ApprovalRow, 'subjectType' | 'subjectId'> & { readonly payload?: unknown },
): string | null {
  const data = asRecord(row.payload);
  const id = (key: string): string | null => {
    const value = data?.[key];
    return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  };
  switch (row.subjectType) {
    case 'lease':
      return `/leases/${row.subjectId}`;
    case 'payment':
      return `/payments/${row.subjectId}`;
    case 'invoice':
      return `/invoices/${row.subjectId}`;
    case 'cash_record':
    case 'cash_banking':
      return '/cash';
    default: {
      const invoiceId = id('invoiceId');
      if (invoiceId) return `/invoices/${invoiceId}`;
      const paymentId = id('paymentId');
      return paymentId ? `/payments/${paymentId}` : null;
    }
  }
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
