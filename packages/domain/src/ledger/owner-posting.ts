import { DomainError } from '../errors';
import { compactLines, type JournalLineDraft } from './journal';

/**
 * Money between the managing agent and the owner (AC-05; P16 and P30; M9 plan decision 8 and
 * section 4.4). Each is a record of a transfer already made, with proof: no approval step, and a
 * mistake is corrected by a reversal. All in the owner's book, at the owner's level (no lease).
 */

/** How a remittance or owner funding was paid (decision 8). */
export const REMITTANCE_METHODS = ['bank', 'momo', 'cheque', 'cash'] as const;
export type RemittanceMethod = (typeof REMITTANCE_METHODS)[number];

const amountOf = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new DomainError('ledger.bad_amount', `${what} must be zero or more pesewas`);
  return amount;
};

const ownerDims = (propertyId: string | null | undefined) => ({ propertyId: propertyId ?? null });

/**
 * Who pays the owner's rent tax to GRA (P18): the agency, out of the owner's money it holds, or
 * the owner. A setting on the management agreement (founder decision, 2026-11-05).
 */
export const GRA_PAYERS = ['agency', 'owner'] as const;
export type GraPayer = (typeof GRA_PAYERS)[number];

export interface RentTaxHoldBack {
  readonly graPaidBy: GraPayer;
  /** 2200 for the owner, as a positive amount: rent tax accrued and not yet paid or settled. */
  readonly payableMinor: number;
}

/**
 * What the agent holds back for GRA (founder decision, 2026-11-05): the owner's rent tax still
 * payable when the agency pays it; nothing when the owner pays GRA, or when nothing is payable.
 */
export function rentTaxHoldBackMinor(rentTax: RentTaxHoldBack | null | undefined): number {
  if (!rentTax) return 0;
  if (!(GRA_PAYERS as readonly string[]).includes(rentTax.graPaidBy))
    throw new DomainError('ledger.bad_gra_payer', 'The agency or the owner pays GRA');
  if (!Number.isSafeInteger(rentTax.payableMinor))
    throw new DomainError('ledger.bad_amount', 'Balances are whole numbers of pesewas');
  return rentTax.graPaidBy === 'agency' ? Math.max(0, rentTax.payableMinor) : 0;
}

/**
 * P16: the agent pays the owner and keeps its fees in one entry. The owner's money leaves the
 * agent (Cr 1070, the total); the net reaches the owner's own account (Dr 1010) and the fees
 * retained settle what the owner owes the agent (Dr 2300). Net plus fees must equal the total,
 * no amount may be negative, and a remittance pays the owner something.
 */
export function remittanceLines(input: {
  readonly bookId: string;
  readonly totalMinor: number;
  readonly netMinor: number;
  readonly feesRetainedMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const total = amountOf(input.totalMinor, 'The total');
  const net = amountOf(input.netMinor, 'The net amount');
  const fees = amountOf(input.feesRetainedMinor, 'The fees retained');
  if (net + fees !== total)
    throw new DomainError(
      'ledger.remittance_does_not_add_up',
      'The net amount plus the fees retained must equal the total',
    );
  if (net === 0)
    throw new DomainError(
      'ledger.empty_remittance',
      'A remittance pays the owner an amount above zero; record fees taken on their own',
    );
  const dims = { bookId: input.bookId, ...ownerDims(input.propertyId) };
  return compactLines([
    { ...dims, accountCode: '1010', amountMinor: net },
    { ...dims, accountCode: '2300', amountMinor: fees },
    { ...dims, accountCode: '1070', amountMinor: -total },
  ]);
}

/** Fees taken without a remittance (plan 4.4): the agent pays itself from the owner's money. Dr 2300, Cr 1070. */
export function feesTakenLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = amountOf(input.amountMinor, 'The fees taken');
  if (amount === 0)
    throw new DomainError('ledger.empty_fees_taken', 'Take fees of an amount above zero');
  const dims = { bookId: input.bookId, ...ownerDims(input.propertyId) };
  return [
    { ...dims, accountCode: '2300', amountMinor: amount },
    { ...dims, accountCode: '1070', amountMinor: -amount },
  ];
}

/** P30: the owner funds the agent so it can pay expenses on the owner's behalf. Dr 1070, Cr 1010. */
export function ownerFundingLines(input: {
  readonly bookId: string;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = amountOf(input.amountMinor, 'The funding');
  if (amount === 0)
    throw new DomainError('ledger.empty_funding', 'Record funding of an amount above zero');
  const dims = { bookId: input.bookId, ...ownerDims(input.propertyId) };
  return [
    { ...dims, accountCode: '1070', amountMinor: amount },
    { ...dims, accountCode: '1010', amountMinor: -amount },
  ];
}

export type RemittanceProblem = 'fees_over_due' | 'over_agent_cash' | 'into_rent_tax';

/**
 * A remittance or fees taken against the ledger as it stands: fees retained beyond the fees due
 * to the agent (2300), a total beyond the owner's cash the agent holds (1070), or, when the agency
 * pays GRA, a total that reaches into the rent tax it must hold back. The caller decides whether a
 * problem refuses the record or warns: a transfer already made is a fact.
 */
export function remittanceProblems(input: {
  readonly totalMinor: number;
  readonly feesRetainedMinor: number;
  /** 1070 for the owner: the owner's money the agent holds. */
  readonly agentHeldMinor: number;
  /** 2300 for the owner, as a positive amount: fees charged and not yet taken. */
  readonly feesDueMinor: number;
  /** Who pays GRA, and the owner's rent tax payable (2200). */
  readonly rentTax?: RentTaxHoldBack | null;
}): RemittanceProblem[] {
  const total = amountOf(input.totalMinor, 'The total');
  const fees = amountOf(input.feesRetainedMinor, 'The fees retained');
  if (!Number.isSafeInteger(input.agentHeldMinor) || !Number.isSafeInteger(input.feesDueMinor))
    throw new DomainError('ledger.bad_amount', 'Balances are whole numbers of pesewas');
  const problems: RemittanceProblem[] = [];
  if (fees > Math.max(0, input.feesDueMinor)) problems.push('fees_over_due');
  if (total > Math.max(0, input.agentHeldMinor)) problems.push('over_agent_cash');
  else if (total > Math.max(0, input.agentHeldMinor - rentTaxHoldBackMinor(input.rentTax)))
    problems.push('into_rent_tax');
  return problems;
}

export interface SuggestedRemittance {
  readonly totalMinor: number;
  readonly feesRetainedMinor: number;
  readonly netMinor: number;
}

/**
 * What the remittance form suggests (decision 8), and the statement's net remittable: everything
 * the agent holds for the owner, less the owner's rent tax still payable when the agency pays GRA
 * (founder decision, 2026-11-05) and any other amount it keeps back for the owner's bills, with
 * the fees due retained out of what is left. Rent tax is held back before fees are retained. Never
 * negative: with nothing to hold, the suggestion is zero.
 */
export function suggestRemittance(input: {
  readonly agentHeldMinor: number;
  readonly feesDueMinor: number;
  /** Held back for other bills the agent will pay for the owner (a supplier); zero by default. */
  readonly reserveMinor?: number;
  /** Who pays GRA, and the owner's rent tax payable (2200): held back when the agency pays. */
  readonly rentTax?: RentTaxHoldBack | null;
}): SuggestedRemittance {
  if (!Number.isSafeInteger(input.agentHeldMinor) || !Number.isSafeInteger(input.feesDueMinor))
    throw new DomainError('ledger.bad_amount', 'Balances are whole numbers of pesewas');
  const reserve = amountOf(input.reserveMinor ?? 0, 'The amount held back');
  const available = Math.max(
    0,
    input.agentHeldMinor - reserve - rentTaxHoldBackMinor(input.rentTax),
  );
  const feesRetainedMinor = Math.min(Math.max(0, input.feesDueMinor), available);
  return {
    totalMinor: available,
    feesRetainedMinor,
    netMinor: available - feesRetainedMinor,
  };
}

/** Idempotency keys: `<rule>:<record id>` (architecture section 5). Fees taken alone are a P16 record. */
export const ownerPostingKeys = {
  remittance: (remittanceId: string): string => `P16:${remittanceId}`,
  feesTaken: (recordId: string): string => `P16:${recordId}`,
  ownerFunding: (fundingId: string): string => `P30:${fundingId}`,
} as const;
