import type { ApiClient } from '@rent/contracts/client';
import { REMITTANCE_METHODS, type RemittanceMethod } from '@rent/domain/ledger';
import { money, toDecimal } from '@rent/domain/money';
import { errorCode } from './errors';
import { amountMinorOf, pastDateProblem } from './payment-form';
import { formatMinor } from './tenancy-format';

// Remittances, fees taken and owner funding (AC-05; M9 decision 8): records of transfers already
// made, with proof (P16, P30). The form starts from the API's suggestion: what the agent holds,
// less the rent tax held back when the agency pays GRA, with the fees due retained.

export type RemittanceSuggestion = Awaited<ReturnType<ApiClient['ownerMoney']['suggestion']>>;
export type OwnerMoneyRow = Awaited<ReturnType<ApiClient['ownerMoney']['list']>>[number];

export const OWNER_MONEY_KIND_LABELS: Record<OwnerMoneyRow['kind'], string> = {
  remittance: 'Paid to the owner',
  fees_taken: 'Fees taken',
  owner_funding: 'Money from the owner',
};

export const methodOf = (value: string): RemittanceMethod | null =>
  REMITTANCE_METHODS.find((m) => m === value) ?? null;

const decimal = (minor: number) => toDecimal(money(minor));

/** An amount that may be zero: blank or any zero ("0", "0.00") is zero; otherwise as typed. */
export function nonNegativeMinorOf(text: string): {
  readonly value: number | null;
  readonly problem: string | null;
} {
  const cleaned = text.trim().replace(/^GH₵\s*/i, '');
  if (!cleaned || /^0+(?:\.0{1,2})?$/.test(cleaned)) return { value: 0, problem: null };
  return amountMinorOf(cleaned);
}

export interface RemittanceDraft {
  readonly net: string;
  readonly feesRetained: string;
  readonly on: string;
  readonly method: RemittanceMethod | '';
  readonly reference: string;
}

/** The form as the suggestion fills it: the net and the fees retained, today. */
export const remittanceDraftOf = (s: RemittanceSuggestion, today: string): RemittanceDraft => ({
  net: s.netMinor > 0 ? decimal(s.netMinor) : '',
  feesRetained: decimal(s.feesRetainedMinor),
  on: today,
  method: '',
  reference: '',
});

export type RemittanceField = keyof RemittanceDraft | 'proof';

/**
 * A remittance as the API takes it (without the proof the page adds), or the problems. The
 * warnings (`remittanceWarning`) are separate: past the fees due, into the rent tax held back,
 * past the cash held, or past the suggestion. The API refuses what reaches past the agent's cash,
 * the fees due or the rent tax held back (409), in the words below.
 */
export function remittanceInput(
  draft: RemittanceDraft,
  today: string,
): {
  readonly input: {
    on: string;
    method: RemittanceMethod;
    reference: string;
    netMinor: number;
    feesRetainedMinor: number;
  } | null;
  readonly errors: Partial<Record<RemittanceField, string>>;
} {
  const errors: Partial<Record<RemittanceField, string>> = {};
  const net = amountMinorOf(draft.net);
  if (net.problem) errors.net = net.problem;
  // Review WEB 1: fees retained may be zero however it is typed ("", "0", "0.00").
  const parsedFees = nonNegativeMinorOf(draft.feesRetained);
  if (parsedFees.problem) errors.feesRetained = parsedFees.problem;
  const fees = parsedFees.value ?? 0;
  const date = pastDateProblem(draft.on, today, 'of the transfer');
  if (date) errors.on = date;
  if (!draft.method) errors.method = 'Choose how it was paid';
  const reference = draft.reference.trim();
  if (reference.length < 2) errors.reference = 'Enter the transfer, MoMo or cheque reference';
  else if (reference.length > 120) errors.reference = 'Use at most 120 characters';
  if (Object.keys(errors).length > 0 || !draft.method || net.value === null)
    return { input: null, errors };
  return {
    input: {
      on: draft.on,
      method: draft.method,
      reference,
      netMinor: net.value,
      feesRetainedMinor: fees,
    },
    errors: {},
  };
}

/** What the remittance takes out of the agent's cash, against the suggestion (for the warning). */
export function remittanceWarning(
  input: { readonly netMinor: number; readonly feesRetainedMinor: number },
  s: RemittanceSuggestion,
): string | null {
  const total = input.netMinor + input.feesRetainedMinor;
  if (input.feesRetainedMinor > s.feesDueMinor)
    return `The fees retained are more than the ${formatMinor(s.feesDueMinor)} due.`;
  if (total > s.agentCashMinor - s.rentTaxHeldBackMinor)
    return s.rentTaxHeldBackMinor > 0
      ? `This takes ${formatMinor(total)} out of ${formatMinor(s.agentCashMinor)} held, which reaches into the ${formatMinor(s.rentTaxHeldBackMinor)} of rent tax held back for GRA.`
      : `This takes ${formatMinor(total)}, more than the ${formatMinor(s.agentCashMinor)} held for the owner.`;
  // Review WEB 8: past the suggestion, though within what is held.
  if (input.netMinor > s.netMinor)
    return `This pays the owner ${formatMinor(input.netMinor)}, more than the ${formatMinor(s.netMinor)} suggested from the ledger.`;
  return null;
}

/** When the suggestion leaves nothing to pay the owner (the fees due take it all, or no cash). */
export function nothingToRemitText(s: RemittanceSuggestion): string | null {
  if (s.netMinor > 0 && s.proposal !== 'nothing') return null;
  return s.agentCashMinor > s.rentTaxHeldBackMinor
    ? `Nothing to remit: the fees due take all of the ${formatMinor(s.agentCashMinor - s.rentTaxHeldBackMinor)} that could be paid out.`
    : 'Nothing to remit: the agency holds nothing for this owner beyond the rent tax held back.';
}

const MONEY_MESSAGES: Readonly<Record<string, string>> = {
  // The same check as INSUFFICIENT_AGENT_CASH (F3), under the name remittances kept.
  OVER_AGENT_CASH:
    'This is more than the agency holds for the owner, so nothing was recorded: the agency doesn’t hold enough of this owner’s cash. Record the owner’s funding first, or pay less.',
  OWNER_MONEY_REVERSED: 'This was already reversed, so nothing changed.',
  FEES_OVER_DUE:
    'The fees retained are more than the fees due to the agency, so nothing was recorded.',
  INTO_RENT_TAX:
    'This would pay out the rent tax held back for GRA, which the agency pays for this owner, so nothing was recorded. Leave the rent tax held back.',
};

/** The words for a refusal of a money record the API named, or null for any other answer. */
export const ownerMoneyMessage = (error: unknown): string | null =>
  MONEY_MESSAGES[errorCode(error)] ?? null;

/** Fees taken on their own, or owner funding: an amount, a date and a reference. */
export function simpleTransferInput(
  draft: {
    readonly amount: string;
    readonly on: string;
    readonly reference: string;
    readonly method?: string;
  },
  today: string,
  options: { readonly needsMethod: boolean; readonly needsReference: boolean },
): {
  readonly input: {
    amountMinor: number;
    on: string;
    reference: string | null;
    method: RemittanceMethod | null;
  } | null;
  readonly errors: Partial<Record<'amount' | 'on' | 'reference' | 'method', string>>;
} {
  const errors: Partial<Record<'amount' | 'on' | 'reference' | 'method', string>> = {};
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.on, today, 'of the transfer');
  if (date) errors.on = date;
  const method = methodOf(draft.method ?? '');
  if (options.needsMethod && !method) errors.method = 'Choose how it was paid';
  const reference = draft.reference.trim();
  if (options.needsReference && reference.length < 2) errors.reference = 'Enter the reference';
  else if (reference.length > 120) errors.reference = 'Use at most 120 characters';
  if (Object.keys(errors).length > 0 || amount.value === null) return { input: null, errors };
  return {
    input: { amountMinor: amount.value, on: draft.on, reference: reference || null, method },
    errors: {},
  };
}

/**
 * What the suggestion proposes (M9 review): a remittance; fees taken on their own, when the fees
 * due use up everything remittable; or nothing to record.
 */
export const suggestionProposal = (s: RemittanceSuggestion): 'remit' | 'take_fees' | 'nothing' =>
  s.proposal;

/** More fees taken than were charged (2300 above zero): never clamped, always said. */
export function feesOverTakenText(
  s: Pick<RemittanceSuggestion, 'feesOverTakenMinor'>,
): string | null {
  return s.feesOverTakenMinor > 0
    ? `More fees have been taken than were due: ${formatMinor(s.feesOverTakenMinor)} too much. Check the fees taken before recording more.`
    : null;
}

/** Reversing a record (P21a): a reason of 3 to 500 characters. */
export function reversalReasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (text.length < 3) return 'Give the reason, at least 3 characters';
  if (text.length > 500) return 'Use at most 500 characters';
  return null;
}
