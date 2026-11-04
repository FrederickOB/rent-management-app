import { DomainError } from '../errors';

/**
 * Payment providers, failover and settlement destinations (BC-02, D1, ADR-008; M4b decisions 1,
 * 2 and 6). Every provider that carries rent settles directly into the landlord's or agency's
 * account: one that cannot is never tried, even when the first provider is down.
 */
export interface ProviderOption {
  readonly provider: string;
  /** Configured with keys for this deployment. */
  readonly configured: boolean;
  /** Settles straight to the landlord's or agency's account (D1), confirmed in writing. */
  readonly settlesDirect: boolean;
  /** The landlord or agency has a subaccount with it. */
  readonly hasSubaccount: boolean;
}

/** The providers to try for a charge, in the company's order. Empty means manual instructions. */
export function providersToTry(
  companyOrder: readonly string[],
  options: readonly ProviderOption[],
): string[] {
  const byName = new Map(options.map((o) => [o.provider, o]));
  return companyOrder.filter((name) => {
    const o = byName.get(name);
    return o !== undefined && o.configured && o.settlesDirect && o.hasSubaccount;
  });
}

/** Settlement accounts (ADR-008): a second person approves, and it is usable 24 hours later. */
export const SETTLEMENT_ACCOUNT_STATUSES = [
  'awaiting_approval',
  'cooling_off',
  'active',
  'rejected',
  'retired',
] as const;
export type SettlementAccountStatus = (typeof SETTLEMENT_ACCOUNT_STATUSES)[number];

export const SETTLEMENT_COOLING_OFF_HOURS = 24;

const TRANSITIONS: Record<SettlementAccountStatus, readonly SettlementAccountStatus[]> = {
  awaiting_approval: ['cooling_off', 'rejected'],
  cooling_off: ['active', 'retired'],
  active: ['retired'],
  rejected: [],
  retired: [],
};

export function checkSettlementTransition(
  from: SettlementAccountStatus,
  to: SettlementAccountStatus,
): void {
  if (!TRANSITIONS[from].includes(to))
    throw new DomainError(
      'settlement_account.transition',
      `A settlement account that is ${from.replace('_', ' ')} cannot become ${to.replace('_', ' ')}`,
    );
}

/** When an approved account may first receive rent: 24 hours after approval, by the server clock. */
export function usableFrom(approvedAt: Date): Date {
  return new Date(approvedAt.getTime() + SETTLEMENT_COOLING_OFF_HOURS * 3_600_000);
}

/** Only the last four digits are ever shown (CLAUDE.md section 10). */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length < 6)
    throw new DomainError('settlement_account.number_invalid', 'Enter the full account number');
  return `•••• ${digits.slice(-4)}`;
}

/** Where an agency-managed owner's rent goes (decision 6); a landlord company uses its own. */
export const RENT_DESTINATIONS = ['owner_account', 'agency_client_account'] as const;
export type RentDestination = (typeof RENT_DESTINATIONS)[number];

export type DestinationProblem =
  'no_agreement' | 'no_active_account' | 'no_subaccount' | 'joint_owners';

export const DESTINATION_PROBLEM_TEXT: Record<DestinationProblem, string> = {
  no_agreement: 'Choose where this owner’s rent goes before sending pay links',
  no_active_account:
    'Add a settlement account, approved and past its 24 hours, before sending pay links',
  no_subaccount: 'The settlement account is not set up with the payment provider yet',
  joint_owners: 'Record joint owners as one owner before this lease can be billed',
};
