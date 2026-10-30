import type { ApiClient } from '@rent/contracts/client';
import { normaliseReference } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { parseAmount } from '@rent/domain/money';
import type { MoneyLocation, ReceivingAccount, ReversalReason } from './billing-format';
import { formatMinor } from './tenancy-format';

// The money forms (BC-05, P07, P21, P23, P24, P27, P28; M4a plan 4.19). Amounts are typed in
// cedis and sent as integer pesewas (CLAUDE.md section 4); the API checks everything again. Each
// form returns the API input, or the problems by field, never both.

export type CashRecordInput = Parameters<ApiClient['payments']['recordCash']>[0];
export type TransferInput = Parameters<ApiClient['payments']['recordTransfer']>[0];
export type BankingInput = Parameters<ApiClient['payments']['recordBanking']>[0];
export type ReversalInput = Parameters<ApiClient['payments']['requestReversal']>[0];
export type CollectorCash = Awaited<ReturnType<ApiClient['payments']['collectorsCash']>>[number];

/** The API's ceiling for one amount (`positiveMinor` in packages/contracts billing). */
export const MAX_AMOUNT_MINOR = 100_000_000_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Errors<F extends string> = Partial<Record<F, string>>;

export interface Parsed<T, F extends string> {
  readonly input: T | null;
  readonly errors: Errors<F>;
}

/** A cedi amount typed by a person, as pesewas above zero; or why it is not one. */
export function amountMinorOf(
  text: string,
  limit?: { readonly maxMinor: number; readonly message: string },
): { readonly value: number | null; readonly problem: string | null } {
  if (!text.trim()) return { value: null, problem: 'Enter the amount' };
  let value: number;
  try {
    value = parseAmount(text.trim().replace(/^GH₵\s*/i, '')).amountMinor;
  } catch {
    return { value: null, problem: 'Enter an amount in cedis, such as 1500 or 1,500.50' };
  }
  if (value <= 0) return { value: null, problem: 'Enter an amount above zero' };
  if (value > MAX_AMOUNT_MINOR) return { value: null, problem: 'That amount is too large' };
  if (limit && value > limit.maxMinor) return { value: null, problem: limit.message };
  return { value, problem: null };
}

/** A business date that has happened: money is recorded on the day it came, never ahead. */
export function pastDateProblem(value: string, today: string, what: string): string | null {
  if (!ISO_DATE.test(value)) return `Choose the date ${what}`;
  try {
    parseBusinessDate(value);
  } catch {
    return `Choose the date ${what}`;
  }
  return value > today ? 'The date cannot be in the future' : null;
}

const text = (value: string): string | null => (value.trim() ? value.trim() : null);

function tooLong(value: string, max: number): boolean {
  return value.trim().length > max;
}

// Cash and cheques (BC-05, P06) --------------------------------------------------------------

export interface CashDraft {
  readonly leaseId: string | null;
  readonly method: 'cash' | 'cheque';
  readonly amount: string;
  readonly receivedOn: string;
  readonly payerName: string;
  /** Who holds the money now; blank for the person recording it. */
  readonly collectorPersonId: string;
  readonly chequeNumber: string;
  readonly chequeBank: string;
  readonly note: string;
}

export type CashField = keyof CashDraft;

export const emptyCash = (today: string, leaseId: string | null = null): CashDraft => ({
  leaseId,
  method: 'cash',
  amount: '',
  receivedOn: today,
  payerName: '',
  collectorPersonId: '',
  chequeNumber: '',
  chequeBank: '',
  note: '',
});

/** Cash or a cheque as `POST /cash-records` takes it, without the photo, which is uploaded first. */
export function cashForm(
  draft: CashDraft,
  today: string,
): Parsed<Omit<CashRecordInput, 'photoUploadId'>, CashField> {
  const errors: Errors<CashField> = {};
  if (!draft.leaseId) errors.leaseId = 'Choose the lease this money is for';
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.receivedOn, today, 'the money was received');
  if (date) errors.receivedOn = date;
  const payer = draft.payerName.trim();
  if (payer.length < 2) errors.payerName = 'Enter the name of the person who paid';
  else if (payer.length > 160) errors.payerName = 'Use at most 160 characters';
  if (draft.method === 'cheque') {
    if (!draft.chequeNumber.trim()) errors.chequeNumber = 'Enter the cheque number';
    else if (tooLong(draft.chequeNumber, 40)) errors.chequeNumber = 'Use at most 40 characters';
    if (!draft.chequeBank.trim()) errors.chequeBank = 'Enter the bank the cheque is drawn on';
    else if (tooLong(draft.chequeBank, 80)) errors.chequeBank = 'Use at most 80 characters';
  }
  if (tooLong(draft.note, 500)) errors.note = 'Use at most 500 characters';
  if (Object.keys(errors).length || !draft.leaseId || amount.value === null)
    return { input: null, errors };
  const cheque = draft.method === 'cheque';
  return {
    input: {
      leaseId: draft.leaseId,
      method: draft.method,
      amountMinor: amount.value,
      receivedOn: draft.receivedOn,
      payerName: payer,
      ...(draft.collectorPersonId ? { collectorPersonId: draft.collectorPersonId } : {}),
      chequeNumber: cheque ? text(draft.chequeNumber) : null,
      chequeBank: cheque ? text(draft.chequeBank) : null,
      note: text(draft.note),
    },
    errors: {},
  };
}

// Transfers straight into an account (P28, P23) ---------------------------------------------

export interface TransferDraft {
  /** Null: nobody knows the lease yet, so it waits as unmatched (P23). */
  readonly leaseId: string | null;
  readonly receivedInto: ReceivingAccount | '';
  /** Whose account, when it went to an owner and no lease is given. */
  readonly ownerId: string;
  readonly amount: string;
  readonly receivedOn: string;
  readonly senderReference: string;
  readonly note: string;
}

export type TransferField = keyof TransferDraft;

export const emptyTransfer = (
  today: string,
  options: { readonly leaseId?: string | null; readonly agency: boolean },
): TransferDraft => ({
  leaseId: options.leaseId ?? null,
  // A landlord's money can only go to the landlord's own account.
  receivedInto: options.agency ? '' : 'owner_account',
  ownerId: '',
  amount: '',
  receivedOn: today,
  senderReference: '',
  note: '',
});

/** A transfer as `POST /direct-receipts` takes it, without the proof, which is uploaded first. */
export function transferForm(
  draft: TransferDraft,
  today: string,
): Parsed<Omit<TransferInput, 'proofUploadId'>, TransferField> {
  const errors: Errors<TransferField> = {};
  if (!draft.receivedInto) errors.receivedInto = 'Choose the account the money went into';
  const needsOwner = !draft.leaseId && draft.receivedInto === 'owner_account';
  if (needsOwner && !draft.ownerId) errors.ownerId = 'Choose whose account it went into';
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.receivedOn, today, 'the money arrived');
  if (date) errors.receivedOn = date;
  if (tooLong(draft.senderReference, 80)) errors.senderReference = 'Use at most 80 characters';
  if (tooLong(draft.note, 500)) errors.note = 'Use at most 500 characters';
  if (Object.keys(errors).length || !draft.receivedInto || amount.value === null)
    return { input: null, errors };
  return {
    input: {
      leaseId: draft.leaseId,
      receivedInto: draft.receivedInto,
      ownerId: needsOwner ? draft.ownerId : null,
      amountMinor: amount.value,
      receivedOn: draft.receivedOn,
      senderReference: text(draft.senderReference),
      note: text(draft.note),
    },
    errors: {},
  };
}

/**
 * What the sender's reference on a transfer says about the lease chosen (BC-03, prd-issues 15):
 * a payment reference typed with a slip (O for 0, a space) is read as the reference it is; one
 * that names another lease is worth checking before the money is posted to this one.
 */
export type ReferenceCheck =
  | { readonly kind: 'none' }
  | { readonly kind: 'matches'; readonly reference: string }
  | { readonly kind: 'other_lease'; readonly reference: string }
  | { readonly kind: 'reference'; readonly reference: string };

export function referenceCheck(typed: string, leaseReference: string | null): ReferenceCheck {
  const reference = normaliseReference(typed);
  if (!reference) return { kind: 'none' };
  if (!leaseReference) return { kind: 'reference', reference };
  return reference === leaseReference
    ? { kind: 'matches', reference }
    : { kind: 'other_lease', reference };
}

// Cash banked (P07) ---------------------------------------------------------------------------

/** One collector's cash for one owner, as a choice in the banking form. */
export const holdingKey = (row: Pick<CollectorCash, 'collectorPersonId' | 'ownerId'>): string =>
  `${row.collectorPersonId}:${row.ownerId}`;

/**
 * What can still be banked from a holding: banking already waiting for approval still counts as
 * held until it is approved, so it is taken off first. Never more than the collector holds.
 */
export function bankable(row: Pick<CollectorCash, 'heldMinor' | 'bankingPendingMinor'>): number {
  return Math.max(0, row.heldMinor - row.bankingPendingMinor);
}

/**
 * The holdings this person may bank: their own (cash.bank), or anyone's with cash.bank_others,
 * where something is left to bank. The API checks both again.
 */
export function bankableHoldings(
  rows: readonly CollectorCash[],
  options: { readonly personId: string; readonly others: boolean },
): CollectorCash[] {
  return rows.filter(
    (row) => (options.others || row.collectorPersonId === options.personId) && bankable(row) > 0,
  );
}

export interface BankingDraft {
  /** `holdingKey` of the chosen collector and owner. */
  readonly holding: string;
  readonly bankedInto: ReceivingAccount | '';
  readonly amount: string;
  readonly bankedOn: string;
  readonly note: string;
}

export type BankingField = keyof BankingDraft;

/** Banking as `POST /cash-bankings` takes it, without the slip, which is uploaded first. */
export function bankingForm(
  draft: BankingDraft,
  holdings: readonly CollectorCash[],
  today: string,
): Parsed<Omit<BankingInput, 'slipUploadId'>, BankingField> {
  const errors: Errors<BankingField> = {};
  const holding = holdings.find((row) => holdingKey(row) === draft.holding) ?? null;
  if (!holding) errors.holding = 'Choose whose cash is banked';
  if (!draft.bankedInto) errors.bankedInto = 'Choose where the cash went';
  const most = holding ? bankable(holding) : MAX_AMOUNT_MINOR;
  const amount = amountMinorOf(
    draft.amount,
    holding
      ? {
          maxMinor: most,
          message: `That is more than ${holding.collectorName} holds for ${holding.ownerName} and has not banked yet: ${formatMinor(most)}`,
        }
      : undefined,
  );
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.bankedOn, today, 'the cash was banked');
  if (date) errors.bankedOn = date;
  if (tooLong(draft.note, 500)) errors.note = 'Use at most 500 characters';
  if (Object.keys(errors).length || !holding || !draft.bankedInto || amount.value === null)
    return { input: null, errors };
  return {
    input: {
      collectorPersonId: holding.collectorPersonId,
      ownerId: holding.ownerId,
      bankedInto: draft.bankedInto,
      amountMinor: amount.value,
      bankedOn: draft.bankedOn,
      note: text(draft.note),
    },
    errors: {},
  };
}

// Corrections: reversals (P21), credit notes (P27) and write-offs (P24) --------------------------

export interface ReversalDraft {
  readonly reason: ReversalReason | '';
  readonly note: string;
  readonly moneyNowIn: MoneyLocation | '';
}

export type ReversalField = keyof ReversalDraft;

/** At least this many characters of explanation for a correction (the API's minimum). */
export const CORRECTION_REASON_MIN = 5;

export function reversalForm(
  draft: ReversalDraft,
  paymentId: string,
  options: readonly MoneyLocation[],
): Parsed<ReversalInput, ReversalField> {
  const errors: Errors<ReversalField> = {};
  if (!draft.reason) errors.reason = 'Choose why it is reversed';
  const note = draft.note.trim();
  if (note.length < CORRECTION_REASON_MIN)
    errors.note = `Explain it in at least ${CORRECTION_REASON_MIN} characters`;
  else if (note.length > 500) errors.note = 'Use at most 500 characters';
  if (!draft.moneyNowIn || !options.includes(draft.moneyNowIn))
    errors.moneyNowIn = 'Choose where the money is now';
  if (Object.keys(errors).length || !draft.reason || !draft.moneyNowIn)
    return { input: null, errors };
  return {
    input: { paymentId, reason: draft.reason, note, moneyNowIn: draft.moneyNowIn },
    errors: {},
  };
}

export type CorrectionKind = 'credit_note' | 'write_off';
export type CorrectionField = 'amount' | 'reason';

/** A credit note or a write-off on one line, never more than the line allows. */
export function correctionForm(
  kind: CorrectionKind,
  draft: { readonly amount: string; readonly reason: string },
  maxMinor: number,
): Parsed<{ readonly amountMinor: number; readonly reason: string }, CorrectionField> {
  const errors: Errors<CorrectionField> = {};
  const amount = amountMinorOf(draft.amount, {
    maxMinor,
    message:
      kind === 'credit_note'
        ? `A credit note cannot take off more than the line charges: ${formatMinor(maxMinor)}`
        : `You can write off at most what is still owed: ${formatMinor(maxMinor)}`,
  });
  if (amount.problem) errors.amount = amount.problem;
  const reason = draft.reason.trim();
  if (reason.length < CORRECTION_REASON_MIN)
    errors.reason = `Give a reason of at least ${CORRECTION_REASON_MIN} characters`;
  else if (reason.length > 500) errors.reason = 'Use at most 500 characters';
  if (Object.keys(errors).length || amount.value === null) return { input: null, errors };
  return { input: { amountMinor: amount.value, reason }, errors: {} };
}
