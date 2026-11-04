import type { ApiClient } from '@rent/contracts/client';
import { isOpen, type ApprovalStatus } from '@rent/domain/approvals';
import {
  evidenceOfMethod,
  MONEY_LOCATION_LABELS,
  PAYMENT_METHOD_LABELS,
  RECEIVED_INTO_LABELS,
  RECEIVING_ACCOUNT_LABELS,
  REVERSAL_REASON_LABELS,
  type EvidenceKind,
} from './billing-format';
import { formatBusinessDate } from './business-dates';
import { humanise } from './format';
import { DESTINATION_LABELS, nameCheck } from './settlement';
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
  // M4b (plan 4.2 and 4.5): where rent settles (ADR-008), and refunds of unmatched money (P31).
  'settlement_account.change': 'Add a bank account rent settles into',
  'settlement_account.retire': 'Stop settling rent into a bank account',
  'payment.refund_unmatched': 'Refund unmatched money to its payer',
  // M4b review: where an agency owner's rent goes is changed only with a second person.
  'management_agreement.change': 'Change where an owner’s rent goes',
  // M5 (plan 5.2 and 5.4): withholding whose certificate never came (P24), and an early
  // termination's settlement and refund (P13).
  'withholding.write_off': 'Write off withholding tax whose certificate never came',
  'lease.refund': 'Settle an early termination and refund the tenant',
};

const WITHHOLDING_WRITE_OFF = 'withholding.write_off';
const LEASE_REFUND = 'lease.refund';

const REFUND_ACTION = 'payment.refund_unmatched';

/** Requests about where rent settles (ADR-008): redirecting rent is the likeliest fraud. */
export const SETTLEMENT_ACTIONS: readonly string[] = [
  'settlement_account.change',
  'settlement_account.retire',
  'management_agreement.change',
];

/** The money actions (M4a, M4b), whose payloads are summarised fact by fact. */
export const MONEY_ACTIONS: readonly string[] = [
  'payment.cash_receipt',
  'payment.direct_receipt',
  'cash.banking',
  'payment.reversal',
  'invoice.credit_note',
  'invoice.write_off',
  'payment.refund_unmatched',
  ...SETTLEMENT_ACTIONS,
  WITHHOLDING_WRITE_OFF,
  LEASE_REFUND,
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
  // Withholding (P19) is dated the day the tenant withheld it.
  if (actionType === WITHHOLDING_WRITE_OFF) add('Withheld on', date('valueDate'));
  add('Banked on', date('bankedOn'));
  add('Paid by', str('payerName'));
  // Only ever masked (CLAUDE.md section 10).
  add('Payer’s phone', str('payerPhoneMasked'));
  add('Unit', str('unitCode'));
  add('Tenant', str('tenantName'));
  add('Held by', str('collectorName'));
  add('Received into', pick(RECEIVED_INTO_LABELS, data.receivedInto));
  add('Banked into', pick(RECEIVING_ACCOUNT_LABELS, data.bankedInto));
  add('Owner', str('ownerName'));
  // Where an owner's rent goes (decision 6; M4b review): now, asked for, and from when.
  if (actionType === 'management_agreement.change') {
    add('Rent goes to now', pick(DESTINATION_LABELS, data.currentDestination) ?? 'Not chosen yet');
    add('Rent would go to', pick(DESTINATION_LABELS, data.destination));
    add('From', date('effectiveFrom'));
  }
  // An early termination's settlement (P13; plan 5.4): each step's figure as the API worked it
  // out, refreshed when the approver opens it, so the second person checks the same steps.
  if (actionType === LEASE_REFUND) {
    const minor = (key: string): string | null => {
      const value = data[key];
      return Number.isSafeInteger(value) ? formatMinor(value as number) : null;
    };
    add('Last day of the tenancy', date('lastDay'));
    add('Agreed charges', amountList(data.charges));
    add('Unused days credited', minor('unusedDaysCreditMinor'));
    add('Prepayment applied to open charges', minor('appliedMinor'));
    add('Deductions', amountList(data.deductions));
    add('Refund to the tenant', minor('refundMinor'));
    add('Still owed after it', minor('arrearsMinor'));
  }
  // A settlement account (ADR-008): whose it is, and only ever its masked number.
  add('Whose account', data.holder === 'agency' ? 'The agency’s client account' : null);
  const bank = [str('bankName'), str('branch') ? `${str('branch')} branch` : null]
    .filter(Boolean)
    .join(', ');
  add('Bank', bank || null);
  add('Account number', str('numberMasked'));
  add('Name on the account', str('accountName'));
  add('Name the bank gave', str('accountNameChecked'));
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

/** `Early exit fee, GH₵500.00; Paint, GH₵100.00`, or `None` for an empty list. */
function amountList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map(asRecord)
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null &&
        typeof item.description === 'string' &&
        Number.isSafeInteger(item.amountMinor),
    )
    .map((item) => `${String(item.description)}, ${formatMinor(item.amountMinor as number)}`);
  return items.length ? items.join('; ') : 'None';
}

export interface ApprovalWarning {
  readonly title: string;
  readonly text: string;
}

/**
 * What an approver must know before deciding an M4b request, from the request's own payload
 * as the API refreshes it: that the record has moved on since it was asked for (`awaiting`,
 * `live`, `refundable` false), that the bank's name for a new account differs from the one typed
 * (ADR-008), or that retiring an account stops rent settling into it. Null for anything else.
 */
export function approvalWarning(actionType: string, payload: unknown): ApprovalWarning | null {
  const data = asRecord(payload);
  if (!data) return null;
  const [add, retire] = SETTLEMENT_ACTIONS;
  if (actionType === add) {
    if (data.awaiting === false)
      return {
        title: 'No longer waiting',
        text: 'The account has been decided since this was asked for, so there is nothing left to approve.',
      };
    const accountName = data.accountName;
    const checked = data.accountNameChecked;
    if (typeof accountName !== 'string' || !accountName.trim()) return null;
    const check = nameCheck({
      accountName,
      accountNameChecked: typeof checked === 'string' ? checked : null,
    });
    return check.kind === 'matches'
      ? null
      : { title: 'Check the name on the account', text: check.text };
  }
  if (actionType === retire)
    return data.live === false
      ? {
          title: 'No longer in use',
          text: 'The account no longer takes rent, so there is nothing to retire.',
        }
      : {
          title: 'Rent stops settling into this account',
          text: 'Once approved, pay links for its leases work only if another account is in use for them.',
        };
  if (actionType === LEASE_REFUND && data.open === false)
    return {
      title: 'The figures no longer hold',
      text: 'The lease’s money has moved since this was asked for, or the request was replaced. Reject it, and ask again with the figures as they are now.',
    };
  if (actionType === WITHHOLDING_WRITE_OFF && data.open === false)
    return {
      title: 'No longer open',
      text: 'A certificate has been confirmed for this withholding, or it has been written off, since this was asked for. There is nothing to write off.',
    };
  if (actionType === REFUND_ACTION && data.refundable === false)
    return {
      title: 'No longer refundable',
      text: 'The money has since been matched to a lease, reversed or refunded, so it cannot be refunded now.',
    };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file each money request is approved on, by its action. */
const EVIDENCE_OF: Record<string, (data: Record<string, unknown>) => EvidenceKind> = {
  'payment.cash_receipt': (data) => evidenceOfMethod(data.method === 'cheque' ? 'cheque' : 'cash'),
  'payment.direct_receipt': () => 'transfer_proof',
  'cash.banking': () => 'banking_slip',
  // A transfer refunded outside the provider is recorded with its proof (P31).
  'payment.refund_unmatched': () => 'transfer_proof',
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
    case 'settlement_account':
      return '/settings/settlement';
    // M5: withholding and an early termination are kept on their lease's page.
    case 'withholding':
    case 'early_termination': {
      const leaseId = id('leaseId');
      return leaseId ? `/leases/${leaseId}` : null;
    }
    case 'owner':
      // Where an owner's rent goes is kept with the settlement accounts.
      return data && 'destination' in data ? '/settings/settlement' : '/owners';
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
