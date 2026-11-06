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
 * screen warns when it goes past the suggestion; the API refuses what reaches past the agent's
 * cash, the fees due or the rent tax held back (409), in the words below.
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
  let fees = 0;
  if (draft.feesRetained.trim() && draft.feesRetained.trim() !== '0') {
    const parsed = amountMinorOf(draft.feesRetained);
    if (parsed.problem || parsed.value === null)
      errors.feesRetained = parsed.problem ?? 'Enter the fees retained';
    else fees = parsed.value;
  }
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
  return null;
}

const MONEY_MESSAGES: Readonly<Record<string, string>> = {
  OVER_AGENT_CASH:
    'This is more than the agency holds for the owner, so nothing was recorded. Check the amount against the suggestion.',
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
