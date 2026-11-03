import { and, desc, eq, inArray, lte, schema, sql, type Tx } from '@rent/db';
import {
  DESTINATION_PROBLEM_TEXT,
  type DestinationProblem,
  type RentDestination,
} from '@rent/domain/payments';

/**
 * Where rent settles (ADR-008; M4b decisions 2 and 6): lease → property → owner → management
 * agreement → an active settlement account → its subaccount with each provider. A landlord
 * company uses its owner's account (its own); an agency follows the agreement it set for each
 * owner, and has no default.
 */
export interface Destination {
  readonly accountId: string;
  readonly holder: 'owner' | 'agency';
  readonly ownerId: string | null;
  /** Where the money sits once the provider pays it out: the owner's own account or the agency's. */
  readonly cashAccount: '1010' | '1070';
  /** Provider name to subaccount code. */
  readonly subaccounts: ReadonlyMap<string, string>;
}

export type DestinationResult =
  | { readonly kind: 'ok'; readonly destination: Destination }
  | { readonly kind: 'problem'; readonly problem: DestinationProblem; readonly text: string };

const problem = (p: DestinationProblem): DestinationResult => ({
  kind: 'problem',
  problem: p,
  text: DESTINATION_PROBLEM_TEXT[p],
});

/** The agreement for an owner in force on a date: the latest that took effect by then. */
export async function currentAgreement(
  tx: Tx,
  ownerId: string,
  date: string,
): Promise<{ destination: RentDestination; effectiveFrom: string } | null> {
  const [row] = await tx
    .select({
      destination: schema.managementAgreement.destination,
      effectiveFrom: schema.managementAgreement.effectiveFrom,
    })
    .from(schema.managementAgreement)
    .where(
      and(
        eq(schema.managementAgreement.ownerId, ownerId),
        lte(schema.managementAgreement.effectiveFrom, date),
      ),
    )
    .orderBy(
      desc(schema.managementAgreement.effectiveFrom),
      desc(schema.managementAgreement.createdAt),
    )
    .limit(1);
  return row
    ? { destination: row.destination as RentDestination, effectiveFrom: row.effectiveFrom }
    : null;
}

/** The account rent may settle to now: active, past its 24 hours, the latest activated. */
async function activeAccount(
  tx: Tx,
  holder: 'owner' | 'agency',
  ownerId: string | null,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: schema.settlementAccount.id })
    .from(schema.settlementAccount)
    .where(
      and(
        eq(schema.settlementAccount.holder, holder),
        ownerId === null
          ? sql`${schema.settlementAccount.ownerId} is null`
          : eq(schema.settlementAccount.ownerId, ownerId),
        eq(schema.settlementAccount.status, 'active'),
      ),
    )
    .orderBy(desc(schema.settlementAccount.activatedAt))
    .limit(1);
  return row ?? null;
}

export async function subaccountsOf(
  tx: Tx,
  accountIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (accountIds.length === 0) return out;
  const rows = await tx
    .select({
      accountId: schema.providerSubaccount.settlementAccountId,
      provider: schema.providerSubaccount.provider,
      code: schema.providerSubaccount.subaccountCode,
    })
    .from(schema.providerSubaccount)
    .where(inArray(schema.providerSubaccount.settlementAccountId, [...accountIds]));
  for (const r of rows) {
    const map = out.get(r.accountId) ?? new Map<string, string>();
    map.set(r.provider, r.code);
    out.set(r.accountId, map);
  }
  return out;
}

/** The cash account a settlement account's money sits in once paid out (P22). */
export const cashAccountFor = (holder: 'owner' | 'agency', companyKind: string): '1010' | '1070' =>
  holder === 'agency' && companyKind === 'agency' ? '1070' : '1010';

/**
 * The destination for an owner's rent on a date, in the caller's company transaction. Read in a
 * transaction that sees the whole company (the pay page's, a job's or a person's with the owner
 * in scope).
 */
export async function destinationForOwner(
  tx: Tx,
  company: { readonly kind: string },
  ownerId: string,
  date: string,
): Promise<DestinationResult> {
  let account: { id: string } | null;
  let holder: 'owner' | 'agency';
  if (company.kind === 'agency') {
    const agreement = await currentAgreement(tx, ownerId, date);
    if (!agreement) return problem('no_agreement');
    holder = agreement.destination === 'owner_account' ? 'owner' : 'agency';
    account = await activeAccount(tx, holder, holder === 'agency' ? null : ownerId);
  } else {
    holder = 'owner';
    account = await activeAccount(tx, 'owner', ownerId);
    if (!account) {
      holder = 'agency';
      account = await activeAccount(tx, 'agency', null);
    }
  }
  if (!account) return problem('no_active_account');
  const subaccounts = (await subaccountsOf(tx, [account.id])).get(account.id) ?? new Map();
  if (subaccounts.size === 0) return problem('no_subaccount');
  return {
    kind: 'ok',
    destination: {
      accountId: account.id,
      holder,
      ownerId: holder === 'agency' ? null : ownerId,
      cashAccount: cashAccountFor(holder, company.kind),
      subaccounts,
    },
  };
}
