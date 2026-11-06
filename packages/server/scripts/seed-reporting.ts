import { schema, sql, withCompany, type Database } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import type { StoragePort } from '@rent/integrations';
import type { AppConfig } from '../src/core/config';
import type { Clock } from '../src/core/clock';
import type { ApprovalsService } from '../src/approvals';
import type { MoneyService } from '../src/billing';
import type {
  ManagementFeesService,
  OwnerMoneyService,
  OwnerStatementsService,
  ReportingRollupService,
} from '../src/reporting';

/**
 * The M9 demo data (plan 4.10). The agency's two owners have different fee terms: Nana (OWN-02,
 * the Osu building, whose rent the agency collects into its own account) pays 10% of the rent
 * settled; Ama (OWN-01, London) pays GH₵50 per billable unit a month. The agency pays both owners'
 * rent tax to GRA, as the M5 seed's GRA payment from its account does. The terms are in force
 * from before the demo's first lease, as a management agreement signed at go-live would be (the
 * application takes new terms only from today, decision 2), so every receipt the seed records is
 * charged its fee through billing's hooks. A change to Nana's rate waits for a second person.
 *
 * After the rest of the seed: the fixed fees for every month so far (none yet in the demo: the
 * register was recorded today, so Ama's first fixed fees post at this month's end); last month's
 * statements issued for both owners, which locks the month; one later correction, a transfer
 * received last month and recorded late, which lands in the open month; a remittance to Nana with
 * the fees retained (her rent tax held back, as the agency pays GRA), keeping GH₵1,000 of hers to
 * remit later; one owner funding from Ama (less than her rent tax payable, so nothing of Ama's is
 * remittable);
 * the daily rollup for every billing company; and the nightly fee check, which must find nothing.
 * Each step looks for what it would make first, so a second run makes nothing new.
 */
export interface ReportingSeedDeps {
  readonly database: Database;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly storage: StoragePort;
  readonly fees: ManagementFeesService;
  readonly money: OwnerMoneyService;
  readonly statements: OwnerStatementsService;
  readonly rollup: ReportingRollupService;
  readonly billing: MoneyService;
  readonly approvals: ApprovalsService;
  readonly agency: string;
  readonly billingCompanies: readonly string[];
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
}

const PDF = Buffer.from('%PDF-1.4\n% demo transfer proof\n');

const cedis = (minor: number) => format(money(minor));

/** What the agency still holds of Nana's after the seed's remittance, above her rent tax. */
const KEPT_FOR_NANA_MINOR = 100_000;

const todayIn = (clock: Clock) =>
  toIsoDate(businessDateOf(instantFrom(clock.now()), 'Africa/Accra'));

async function agencyOwners(database: Database, agency: string) {
  const rows = await withCompany(database, { companyId: agency, actorKind: 'system' }, (tx) =>
    tx.execute<{ id: string; reference: string }>(
      sql`select id, reference from owner where reference in ('OWN-01', 'OWN-02')`,
    ),
  );
  const by = new Map(rows.rows.map((r) => [r.reference, r.id]));
  return { ama: by.get('OWN-01')!, nana: by.get('OWN-02')! };
}

/**
 * Before any money is seeded: the fee terms in force from three years ago, inserted as the
 * agreement signed at go-live (the service's approval takes terms only from today). Once only.
 */
export async function ensureFeeTerms(deps: {
  readonly database: Database;
  readonly clock: Clock;
  readonly agency: string;
}): Promise<number> {
  const { ama, nana } = await agencyOwners(deps.database, deps.agency);
  const from = `${Number(todayIn(deps.clock).slice(0, 4)) - 3}-01-01`;
  return withCompany(deps.database, { companyId: deps.agency, actorKind: 'system' }, async (tx) => {
    const have = await tx
      .select({ ownerId: schema.managementFeeTerms.ownerId })
      .from(schema.managementFeeTerms);
    const seen = new Set(have.map((h) => h.ownerId));
    let made = 0;
    for (const terms of [
      { ownerId: nana, kind: 'percentage', rateBps: 1000, fixedMinor: null, graPaidBy: 'agency' },
      {
        ownerId: ama,
        kind: 'fixed_per_unit',
        rateBps: null,
        fixedMinor: 5_000,
        graPaidBy: 'agency',
      },
    ] as const) {
      if (seen.has(terms.ownerId)) continue;
      await tx.insert(schema.managementFeeTerms).values({
        companyId: deps.agency,
        ...terms,
        effectiveFrom: from,
      });
      made += 1;
    }
    return made;
  });
}

export async function ensureReporting(deps: ReportingSeedDeps): Promise<string[]> {
  const { agency } = deps;
  const admin = await deps.actor(agency, 'agency.admin@demo.invalid');
  const manager = await deps.actor(agency, 'manager.one@demo.invalid');
  const accountant = await deps.actor(agency, 'accountant@demo.invalid');
  const { ama, nana } = await agencyOwners(deps.database, agency);
  const today = todayIn(deps.clock);
  const thisMonth = parseBusinessDate(`${today.slice(0, 7)}-01`);
  const lastMonth = toIsoDate(addMonths(thisMonth, -1)).slice(0, 7);
  const out: string[] = [];
  const upload = async (
    create: (input: { contentType: string; sizeBytes: number }) => Promise<{
      uploadId: string;
      fields: Record<string, string>;
    }>,
  ) => {
    const u = await create({ contentType: 'application/pdf', sizeBytes: PDF.length });
    await deps.storage.put({
      bucket: deps.config.S3_BUCKET_FILES,
      key: u.fields.key!,
      body: PDF,
      contentType: 'application/pdf',
    });
    return u.uploadId;
  };

  // Fixed fees for every month of the last three years so far (idempotent by key).
  let fixed = 0;
  for (let n = 36; n >= 1; n -= 1)
    fixed += await deps.fees.runFixedFees(agency, toIsoDate(addMonths(thisMonth, -n)).slice(0, 7));
  out.push(`Fixed fees: ${fixed} new (Ama, GH₵50 per billable unit a month, D8).`);

  // A change to Nana's rate from next month, waiting for a second person.
  const nanaTerms = await deps.money.feeTerms(manager, nana);
  const nextMonth = toIsoDate(addMonths(thisMonth, 1));
  if (!nanaTerms.pending && !nanaTerms.upcoming.some((u) => u.effectiveFrom === nextMonth))
    await deps.money.requestFeeTerms(manager, {
      ownerId: nana,
      kind: 'percentage',
      rateBps: 900,
      graPaidBy: 'agency',
      effectiveFrom: nextMonth,
    });
  out.push(
    `Fee terms: Nana 10% of rent settled (9% from ${nextMonth} waiting for approval); Ama GH₵50 per unit a month; the agency pays both owners' GRA.`,
  );

  // Last month's statements, issued: the month locks.
  const issued: string[] = [];
  for (const [name, ownerId] of [
    ['Ama', ama],
    ['Nana', nana],
  ] as const) {
    const [existing] = await deps.statements.list(admin, { ownerId, month: lastMonth });
    const statement =
      existing ?? (await deps.statements.draft(admin, { ownerId, month: lastMonth }));
    if (statement.status === 'draft') await deps.statements.issue(admin, statement.id);
    issued.push(`${name} ${existing?.status === 'issued' ? 'already issued' : 'issued'}`);
  }
  out.push(`Statements for ${lastMonth}: ${issued.join(', ')}; the month is locked.`);

  // One later correction: a transfer into Ama's account received last month and recorded after
  // the statement, waiting for its lease. It keeps its value date and lands in this month's
  // accounting date, so last month's statement regenerates to the figures issued (AC-04).
  const reference = 'LATE TRANSFER (demo)';
  const [late] = await withCompany(
    deps.database,
    { companyId: agency, actorKind: 'system' },
    (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from direct_receipt where sender_reference = ${reference}`,
      ),
  ).then((r) => r.rows);
  if (!late) {
    const recorded = await deps.billing.recordTransfer(manager, {
      receivedInto: 'owner_account',
      ownerId: ama,
      amountMinor: 25_000,
      receivedOn: toIsoDate(addDays(parseBusinessDate(`${lastMonth}-01`), 19)),
      senderReference: reference,
      proofUploadId: await upload((i) =>
        deps.billing.createUpload(manager, { purpose: 'transfer_proof', ...i }),
      ),
    });
    await deps.approvals.decide(accountant, recorded.approvalId, { decision: 'approve' });
  }
  out.push(
    `Later correction: GH₵250 received in ${lastMonth} into Ama’s account, recorded late, in the open month.`,
  );

  // Money between the agency and its owners (AC-05): the remittance first, so it never sends
  // back the funding.
  const recorded = await deps.money.list(accountant, {});
  let remittance = 'already recorded';
  if (!recorded.some((x) => x.kind === 'remittance' && x.owner.id === nana)) {
    const s = await deps.money.suggestion(accountant, nana);
    // All but GH₵1,000, which the agency keeps for her: what the web e2e remittance spec pays
    // from, a run at a time (owner B).
    const net = s.netMinor - KEPT_FOR_NANA_MINOR;
    if (net > 0) {
      await deps.money.remit(accountant, {
        ownerId: nana,
        on: today,
        method: 'bank',
        reference: 'GCB TRANSFER (demo)',
        proofUploadId: await upload((i) => deps.money.createUpload(accountant, i)),
        netMinor: net,
        feesRetainedMinor: s.feesRetainedMinor,
      });
      remittance = `${cedis(net)} to Nana with ${cedis(s.feesRetainedMinor)} of fees retained, ${cedis(s.rentTaxHeldBackMinor)} of rent tax held back and ${cedis(KEPT_FOR_NANA_MINOR)} kept to remit later`;
    } else remittance = 'none: the agency holds nothing of Nana’s to remit';
  }
  if (!recorded.some((x) => x.kind === 'owner_funding' && x.owner.id === ama))
    await deps.money.fund(accountant, {
      ownerId: ama,
      on: today,
      method: 'bank',
      reference: 'AMA TOPUP (demo)',
      proofUploadId: await upload((i) => deps.money.createUpload(accountant, i)),
      amountMinor: 50_000,
    });
  out.push(`Remittance: ${remittance}; owner funding: GH₵500.00 from Ama for her repairs.`);

  // The dashboards' snapshot, and the nightly fee check.
  for (const companyId of deps.billingCompanies) await deps.rollup.run(companyId);
  const { mismatches } = await deps.fees.check(agency, { alert: false });
  out.push(
    `Rollup: ${deps.billingCompanies.length} companies; the fee check found ${mismatches.length} mismatches.`,
  );
  if (mismatches.length > 0)
    throw new Error(
      `The fee check found ${mismatches.length} mismatches; the demo is not consistent`,
    );
  return out;
}
