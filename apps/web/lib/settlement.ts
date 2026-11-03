import { settlementContract, type SettlementAccountView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import {
  DESTINATION_PROBLEM_TEXT,
  RENT_DESTINATIONS,
  type DestinationProblem,
  type RentDestination,
  type SettlementAccountStatus,
} from '@rent/domain/payments';
import { formatTime } from './format';

// Where rent settles (D1, ADR-008; M4b plan 4.2 and decision 6). Rent goes straight from the
// payment provider to the landlord's or the agency's bank account; the platform never holds it.
// Adding or retiring an account is a request: a second person approves it, and an approved
// account takes rent only 24 hours later. Redirecting rent is the likeliest fraud against the
// product, so these screens say plainly what is waiting and from when an account is used.

export type SettlementRequestInput = Parameters<ApiClient['settlement']['request']>[0];
export type AgreementRow = Awaited<ReturnType<ApiClient['settlement']['agreements']>>[number];
export type Bank = Awaited<ReturnType<ApiClient['settlement']['banks']>>[number];
export type AccountHolder = SettlementAccountView['holder'];

export const SETTLEMENT_STATUS_LABELS: Record<SettlementAccountStatus, string> = {
  awaiting_approval: 'Waiting for a second person',
  cooling_off: 'Approved, waiting 24 hours',
  active: 'In use',
  rejected: 'Rejected: never used',
  retired: 'No longer used',
};

/** Where an agency-managed owner's rent goes (decision 6). */
export const DESTINATION_LABELS: Record<RentDestination, string> = {
  owner_account: 'The owner’s own account',
  agency_client_account: 'The agency’s client account',
};

export const DESTINATION_OPTIONS: readonly { value: RentDestination; label: string }[] =
  RENT_DESTINATIONS.map((value) => ({ value, label: DESTINATION_LABELS[value] }));

/**
 * Whether an account holder is one owner (their own account) rather than the company (the
 * agency's client account). A lookup, not a comparison: `owner` here is whose account it is,
 * not a role, and roles are only ever judged by the policy.
 */
const FOR_ONE_OWNER: Record<AccountHolder, boolean> = { owner: true, agency: false };
export const forOneOwner = (holder: AccountHolder | ''): boolean =>
  holder !== '' && FOR_ONE_OWNER[holder];

/** Whose account it is: `Nana Owner-Accra’s account`, or the agency's client account. */
export function holderLabel(
  account: Pick<SettlementAccountView, 'holder' | 'ownerName'>,
  companyKind: 'landlord' | 'agency' | 'platform',
): string {
  if (forOneOwner(account.holder))
    return account.ownerName ? `${account.ownerName}’s account` : 'An owner’s account';
  return companyKind === 'agency' ? 'The agency’s client account' : 'Your company’s account';
}

/**
 * One line under an account's status: from when an approved account takes rent (24 hours after
 * approval, by the server's clock), or why an account in use cannot take rent yet.
 */
export function settlementStatusNote(
  account: Pick<SettlementAccountView, 'status' | 'usableFrom' | 'providerReady'>,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  switch (account.status) {
    case 'awaiting_approval':
      return 'Nothing is paid into it until a second person approves it.';
    case 'cooling_off':
      if (!account.usableFrom) return 'It takes rent 24 hours after it was approved.';
      return new Date(account.usableFrom) > now
        ? `It takes rent from ${formatTime(account.usableFrom, timeZone)}.`
        : 'Its 24 hours have passed; it takes rent within a few minutes.';
    case 'active':
      return account.providerReady
        ? null
        : 'Not set up with the payment provider yet, so pay links for its leases wait until it is.';
    case 'rejected':
      return 'A second person rejected it. Rent was never paid into it.';
    case 'retired':
      return 'Rent is no longer paid into it.';
  }
}

/** Account names as people write them: case, spacing and punctuation do not matter. */
const nameKey = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export type NameCheck =
  | { readonly kind: 'unchecked'; readonly text: string }
  | { readonly kind: 'matches'; readonly text: string }
  | { readonly kind: 'differs'; readonly text: string };

/**
 * The provider's name check (ADR-008): the name the bank holds for the number, against the name
 * the person typed. A difference is shown to whoever approves, never silently accepted.
 */
export function nameCheck(
  account: Pick<SettlementAccountView, 'accountName' | 'accountNameChecked'>,
): NameCheck {
  const checked = account.accountNameChecked?.trim();
  if (!checked)
    return {
      kind: 'unchecked',
      text: 'The bank could not confirm the name on this account. Check it with the owner before approving.',
    };
  if (nameKey(checked) === nameKey(account.accountName))
    return { kind: 'matches', text: `The bank confirmed the name: ${checked}.` };
  return {
    kind: 'differs',
    text: `The bank holds this account in the name “${checked}”, not “${account.accountName}”. Check it with the owner before approving.`,
  };
}

/** Accounts newest first, those still waiting or in use before those no longer used. */
export function sortAccounts(accounts: readonly SettlementAccountView[]): SettlementAccountView[] {
  const rank: Record<SettlementAccountStatus, number> = {
    awaiting_approval: 0,
    cooling_off: 1,
    active: 2,
    rejected: 3,
    retired: 4,
  };
  return [...accounts].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
  );
}

/**
 * Retiring is offered for accounts that take, or are about to take, rent, and have no request
 * waiting already: the account's `openRequest` (adding it, or retiring it). The account's
 * `approvalId` is the request that added it, long since decided.
 */
export const mayRetire = (
  account: Pick<SettlementAccountView, 'status' | 'openRequest'>,
): boolean =>
  (account.status === 'active' || account.status === 'cooling_off') && !account.openRequest;

const OPEN_REQUEST_TEXT: Record<NonNullable<SettlementAccountView['openRequest']>['kind'], string> =
  {
    add: 'Adding it is waiting for a second person.',
    retire:
      'Retiring it is waiting for a second person. Rent still settles into it until the request is approved.',
  };

/** The request about this account still waiting for a decision, in words, with its approval. */
export function openRequestOf(
  account: Pick<SettlementAccountView, 'openRequest'>,
): { readonly approvalId: string; readonly text: string } | null {
  const open = account.openRequest;
  return open ? { approvalId: open.approvalId, text: OPEN_REQUEST_TEXT[open.kind] } : null;
}

/**
 * Whether an agency owner's rent has somewhere to go (decision 6, plan 4.2), as a hint beside
 * the agreement: the agreement's destination, then an account there that is in use and set up
 * with the provider. The API decides for each pay link and says why when it cannot send one.
 */
export function destinationProblem(
  agreement: Pick<AgreementRow, 'ownerId' | 'destination'>,
  accounts: readonly Pick<
    SettlementAccountView,
    'holder' | 'ownerId' | 'status' | 'providerReady'
  >[],
): DestinationProblem | null {
  if (!agreement.destination) return 'no_agreement';
  const toOwner = DESTINATION_IS_OWNER[agreement.destination];
  const candidates = accounts.filter(
    (a) =>
      forOneOwner(a.holder) === toOwner &&
      (!toOwner || a.ownerId === agreement.ownerId) &&
      a.status === 'active',
  );
  if (candidates.length === 0) return 'no_active_account';
  return candidates.some((a) => a.providerReady) ? null : 'no_subaccount';
}

const DESTINATION_IS_OWNER: Record<RentDestination, boolean> = {
  owner_account: true,
  agency_client_account: false,
};

export const destinationProblemText = (problem: DestinationProblem): string =>
  DESTINATION_PROBLEM_TEXT[problem];

// The request form --------------------------------------------------------------------------

export interface SettlementDraft {
  readonly holder: AccountHolder | '';
  readonly ownerId: string;
  readonly bankCode: string;
  readonly branch: string;
  readonly accountNumber: string;
  readonly accountName: string;
}

export type SettlementField = keyof SettlementDraft;

export const emptySettlementDraft = (holder: AccountHolder | '' = ''): SettlementDraft => ({
  holder,
  ownerId: '',
  bankCode: '',
  branch: '',
  accountNumber: '',
  accountName: '',
});

/** The limits `POST /settlement-accounts` takes, read from its contract, which the API checks. */
function requestLimits(): {
  readonly nameMin: number;
  readonly nameMax: number;
  readonly branchMax: number;
} {
  const shape = settlementContract.request['~orpc'].inputSchema?.shape;
  const nameMin = shape?.accountName.minLength;
  const nameMax = shape?.accountName.maxLength;
  const branchMax = shape?.branch.unwrap().unwrap().maxLength;
  if (!nameMin || !nameMax || !branchMax)
    throw new Error('The settlement-account contract has no name or branch limits');
  return { nameMin, nameMax, branchMax };
}

export const SETTLEMENT_LIMITS = requestLimits();

/** The reason limits `POST /settlement-accounts/{id}/reveal` takes, from its contract. */
function revealLimits(): { readonly min: number; readonly max: number } {
  const reason = settlementContract.reveal['~orpc'].inputSchema?.shape.reason;
  const min = reason?.minLength;
  const max = reason?.maxLength;
  if (!min || !max) throw new Error('The reveal contract has no reason limits');
  return { min, max };
}

/** CLAUDE.md section 10: a full account number is shown only with a reason, and audited. */
export const REVEAL_REASON = revealLimits();

/** Digits only, as the contract takes them: spaces and dashes people type are dropped. */
export const accountDigits = (typed: string): string => typed.replace(/[\s-]/g, '');

/** The request to send, or the problems by field. The API checks everything again. */
export function settlementForm(
  draft: SettlementDraft,
  options: { readonly agency: boolean },
): {
  readonly input: SettlementRequestInput | null;
  readonly errors: Partial<Record<SettlementField, string>>;
} {
  const errors: Partial<Record<SettlementField, string>> = {};
  const forOwner = forOneOwner(draft.holder);
  if (draft.holder === '') errors.holder = 'Choose whose account it is';
  else if (!forOwner && !options.agency) errors.holder = 'Choose the owner whose account it is';
  if (forOwner && !draft.ownerId) errors.ownerId = 'Choose the owner';
  if (!draft.bankCode) errors.bankCode = 'Choose the bank';
  const digits = accountDigits(draft.accountNumber);
  if (!digits) errors.accountNumber = 'Enter the account number';
  else if (!/^\d{6,20}$/.test(digits))
    errors.accountNumber = 'Enter the account number: 6 to 20 digits, nothing else';
  const name = draft.accountName.trim();
  if (name.length < SETTLEMENT_LIMITS.nameMin)
    errors.accountName = 'Enter the name on the account, as the bank has it';
  else if (name.length > SETTLEMENT_LIMITS.nameMax)
    errors.accountName = `Use at most ${SETTLEMENT_LIMITS.nameMax} characters`;
  const branch = draft.branch.trim();
  if (branch.length > SETTLEMENT_LIMITS.branchMax)
    errors.branch = `Use at most ${SETTLEMENT_LIMITS.branchMax} characters`;
  if (Object.keys(errors).length > 0 || draft.holder === '') return { input: null, errors };
  return {
    input: {
      holder: draft.holder,
      ownerId: forOwner ? draft.ownerId : null,
      bankCode: draft.bankCode,
      branch: branch || null,
      accountNumber: digits,
      accountName: name,
    },
    errors,
  };
}
