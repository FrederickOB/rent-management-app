import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { CallbackAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentCashCheckService } from '../src/ledger/agent-cash-check.service';
import { openingApprovalSchema } from '../src/onboarding/onboarding.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billingServices,
  leaseAccount,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import {
  batchRecord,
  committed,
  countOf,
  onboardingServices,
  onboardingWorkbook,
  uploadBatch,
  validated,
  type OnboardingServices,
} from './support/onboarding';
import { fundAgentCash } from './support/owner-funding';
import {
  feeTermsFrom,
  reportingMoneyServices,
  type ReportingMoneyServices,
} from './support/reporting-money';
import {
  setLettingBusiness,
  taxItemsOf,
  taxServices,
  uploadEvidence,
  type TaxServices,
} from './support/tax';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * Opening balances (P25), the M11 review round's server fixes against the real database: fees on
 * credit drawn onto opening arrears (M1), the approval's payload (C2) and approvers (C1), arrears
 * raised twice (S1), two batches at once (S2), agent cash lowered (S3), cross-company isolation of
 * the Balances workbook, a move-out that settles an opening deposit (P11, P12), posting the same
 * approved batch twice, an opening withholding certificate (S4) and an imported lease's paid-until
 * (S5, M2). Fictional numbers only.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: ReportingMoneyServices;
let mo: MaintenanceServices;
let o: OnboardingServices;
let today: string;
let cutOver: string;
let start: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const system = (companyId: string) => ({ companyId, actorKind: 'system' as const });

type Company = Awaited<ReturnType<typeof moneyCompany>> & {
  readonly ownerId: string;
  readonly units: string[];
  readonly reference: string;
};

let parts = 0;
/** An agency with one owner, a property of four units, the cut-over set, and a second approver. */
async function agencyWithUnits(name: string, options: { fees?: boolean } = {}): Promise<Company> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  parts += 1;
  const reference = `OWN-R${parts}`;
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner`, reference })
  ).id;
  if (options.fees)
    await feeTermsFrom(
      ctx,
      c.companyId,
      ownerId,
      { kind: 'percentage', rateBps: 1000 },
      plusMonths(start, -1),
    );
  const units = Object.keys(
    (
      await propertyWithUnits(s, c.manager, {
        areaCode: 'ACC',
        propertyPart: `RV${String.fromCharCode(64 + parts)}`,
        ownerId,
        units: [{ unitType: 'apartment', count: 4, bedrooms: 2 }],
      })
    ).units,
  ).sort();
  await o.onboarding.setCutOver(c.admin, cutOver);
  return { ...c, ownerId, units, reference };
}

/** Leases of 1,000 a month from `start` for a year, imported on paper, then billed as the worker would. */
async function importLeases(c: Company, count: number, extra: { deposit?: string } = {}) {
  const tenants = Array.from({ length: count }, (_, i) => ({
    kind: 'Individual',
    name: `Review Tenant ${i + 1}`,
    phone: `024 0${String(parts).padStart(2, '0')} ${String(1000 + i).padStart(4, '0')}`,
  }));
  const file = await onboardingWorkbook('tenancies', {
    tenants,
    leases: tenants.map((tenant, i) => ({
      unit: c.units[i]!,
      tenantPhone: tenant.phone,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRent: '1000',
      cycle: 'Monthly',
      noticeDays: '30',
      signedOn: start,
      ...(extra.deposit ? { deposit: extra.deposit } : {}),
    })),
  });
  const batch = await validated(
    ctx,
    o,
    c.admin,
    await uploadBatch(ctx, o, c.admin, 'tenancies', file),
  );
  expect(batch.report!.issues).toEqual([]);
  await committed(ctx, o, c.admin, batch.id);
  await runLeaseEvents(ctx, b, c.companyId);
  const rows = await withCompany(ctx.database, system(c.companyId), (tx) =>
    tx.execute<{ id: string; code: string }>(
      sql`select l.id, u.code from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id order by u.code`,
    ),
  );
  return new Map(rows.rows.map((r) => [r.code, r.id]));
}

/** Validates a balances or adjustment workbook, and has a second person approve it (no posting yet). */
async function approved(
  c: Company,
  kind: 'balances' | 'adjustment',
  rows: Parameters<typeof onboardingWorkbook>[1],
) {
  const batch = await validated(
    ctx,
    o,
    c.admin,
    await uploadBatch(ctx, o, c.admin, kind, await onboardingWorkbook(kind, rows)),
  );
  expect(batch.report!.issues).toEqual([]);
  const asked = await o.onboarding.commit(c.admin, batch.id);
  // C1 (founder decision 2): the money approvers, here a property manager.
  await s.approvals.decide(c.manager, asked.approval!.requestId, { decision: 'approve' });
  return batch.id;
}

const entries = (companyId: string, where = 'true') =>
  countOf(ctx, companyId, 'journal_entry', where);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = reportingMoneyServices(ctx, s, b);
  mo = maintenanceServices(ctx, s, b, t);
  o = onboardingServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  cutOver = `${today.slice(0, 7)}-01`;
  start = plusMonths(cutOver, -4);
});

afterAll(async () => {
  await ctx.close();
});

describe('P25 review M1: credit drawn onto opening arrears carries its fee (P14)', () => {
  it('charges the fee on a platform overpayment drawn onto opening arrears, and the fee check is clean', async () => {
    const c = await agencyWithUnits('Review Fees Agency', { fees: true });
    const leases = await importLeases(c, 1);
    const leaseId = leases.get(c.units[0]!)!;
    // The cut-over month's 1,000 is owed; 3,000 pays it and leaves 2,000 as credit.
    await approvedCash(ctx, s, b, c.manager, c.admin, {
      leaseId,
      amountMinor: 300_000,
      receivedOn: today,
    });
    const credit = await withCompany(ctx.database, system(c.companyId), (tx) =>
      b.read.leaseBillingIn(tx, c.companyId, leaseId),
    );
    expect(credit.creditMinor).toBeGreaterThan(0);
    const batchId = await approved(c, 'balances', {
      arrears: [
        {
          unit: c.units[0]!,
          leaseStart: start,
          periodStart: plusMonths(start, 3),
          kind: 'Rent',
          amount: '1000',
          dueDate: plusMonths(start, 3),
        },
      ],
    });
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('posted');
    // The credit paid the opening month: money on the platform, so its fee follows (10%).
    const fees = await withCompany(ctx.database, system(c.companyId), (tx) =>
      tx
        .select()
        .from(schema.managementFee)
        .where(sql`${schema.managementFee.source} = 'credit_draw'`),
    );
    expect(fees).toEqual([expect.objectContaining({ baseMinor: 100_000, feeMinor: 10_000 })]);
    expect((await m.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('P25 review C1 and C2: who approves, and what the approval shows', () => {
  it('asks the money approvers, with the batch, its cut-over, each owner’s share and the totals', async () => {
    const c = await agencyWithUnits('Review Approval Agency');
    const leases = await importLeases(c, 2);
    const batch = await validated(
      ctx,
      o,
      c.admin,
      await uploadBatch(
        ctx,
        o,
        c.admin,
        'balances',
        await onboardingWorkbook('balances', {
          arrears: [
            {
              unit: c.units[0]!,
              leaseStart: start,
              periodStart: plusMonths(start, 2),
              kind: 'Rent',
              amount: '700',
              dueDate: plusMonths(start, 2),
            },
          ],
          deposits: [{ unit: c.units[1]!, leaseStart: start, amount: '2000' }],
          ownerItems: [{ owner: c.reference, agentCash: '500' }],
        }),
      ),
    );
    const asked = await o.onboarding.commit(c.admin, batch.id);
    const view = await s.approvals.get(c.admin, asked.approval!.requestId);
    const payload = openingApprovalSchema.parse(view.request.payload);
    expect(payload).toEqual({
      batchId: batch.id,
      kind: 'balances',
      cutOverDate: cutOver,
      fileName: 'balances.xlsx',
      link: '/onboarding',
      leases: 2,
      owners: [
        {
          owner: { id: c.ownerId, name: 'Review Approval Agency owner' },
          arrearsMinor: 70_000,
          advancesMinor: 0,
          depositsMinor: 200_000,
          withholdingMinor: 0,
          agentCashMinor: 50_000,
          rentTaxOutstandingMinor: 0,
        },
      ],
      totals: {
        arrearsMinor: 70_000,
        advancesMinor: 0,
        depositsMinor: 200_000,
        withholdingMinor: 0,
        agentCashMinor: 50_000,
        rentTaxOutstandingMinor: 0,
      },
    });
    // An accountant may approve (founder decision 2); never the initiator.
    expect(view.request.eligibleApprovers).toEqual(
      expect.arrayContaining([c.manager.personId, c.accountant.personId]),
    );
    await expect(
      s.approvals.decide(c.admin, asked.approval!.requestId, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 403 });
    const done = await s.approvals.decide(c.accountant, asked.approval!.requestId, {
      decision: 'approve',
    });
    expect(done.request.status).toBe('approved');
    expect(await o.onboarding.postBalances(c.companyId, batch.id)).toBe('posted');
    expect(leases.size).toBe(2);
  });
});

describe('P25 review S1, S3: what an adjustment may not do', () => {
  let c: Company;
  beforeAll(async () => {
    c = await agencyWithUnits('Review Floors Agency');
    await importLeases(c, 1);
    const batchId = await approved(c, 'balances', {
      arrears: [
        {
          unit: c.units[0]!,
          leaseStart: start,
          periodStart: plusMonths(start, 2),
          kind: 'Rent',
          amount: '1000',
          dueDate: plusMonths(start, 2),
        },
      ],
      ownerItems: [{ owner: c.reference, agentCash: '1000' }],
    });
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('posted');
  });

  it('S1: refuses arrears raised for a period the platform already bills, by sheet, row and column', async () => {
    // Founder 2026-11-10: a month brought in already may be raised (below); one the platform
    // bills never takes opening arrears.
    const batch = await validated(
      ctx,
      o,
      c.admin,
      await uploadBatch(
        ctx,
        o,
        c.admin,
        'adjustment',
        await onboardingWorkbook('adjustment', {
          arrears: [
            {
              unit: c.units[0]!,
              leaseStart: start,
              periodStart: cutOver,
              kind: 'Rent',
              amount: '200',
              dueDate: cutOver,
            },
          ],
        }),
      ),
    );
    expect(batch.status).toBe('invalid');
    expect(batch.report!.issues).toEqual([
      expect.objectContaining({ sheet: 'Arrears', row: 2, column: 'Period start' }),
    ]);
  });

  it('S3: lowers agent cash only by what was brought in, whatever else the agent holds', async () => {
    // The owner funds the agent 5,000 more on the platform (P30): 6,000 held, 1,000 of it opening.
    await fundAgentCash(ctx, s, b, c.accountant, c.ownerId, 500_000);
    const check = async (amount: string) =>
      validated(
        ctx,
        o,
        c.admin,
        await uploadBatch(
          ctx,
          o,
          c.admin,
          'adjustment',
          await onboardingWorkbook('adjustment', {
            ownerItems: [{ owner: c.reference, agentCash: amount }],
          }),
        ),
      );
    const tooMuch = await check('-1500');
    expect(tooMuch.report!.issues).toEqual([
      expect.objectContaining({ sheet: 'Owner items', row: 2, column: 'Agent-held cash' }),
    ]);
    const fine = await check('-1000');
    expect(fine.report!.issues).toEqual([]);
  });
});

describe('P25 review S2: two balances batches at once never bring an item in twice', () => {
  it('posts the advance once when two approved batches post together', async () => {
    const c = await agencyWithUnits('Review Race Agency');
    await importLeases(c, 1);
    const rows = { advances: [{ unit: c.units[0]!, leaseStart: start, amount: '3000' }] };
    // Both are checked before either posts, so neither saw the other's advance.
    const first = await approved(c, 'balances', rows);
    const second = await approved(c, 'balances', rows);
    const outcomes = await Promise.all([
      o.onboarding.postBalances(c.companyId, first),
      o.onboarding.postBalances(c.companyId, second),
    ]);
    expect(outcomes.filter((x) => x === 'posted').length).toBeGreaterThanOrEqual(1);
    expect(await countOf(ctx, c.companyId, 'payment', `source_type = 'opening_balance'`)).toBe(1);
    expect(await countOf(ctx, c.companyId, 'onboarding_item', `kind = 'advance'`)).toBe(1);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('P25 review: posting the same approved batch twice changes nothing', () => {
  it('posts once, whether the job runs again later or twice at the same moment', async () => {
    const c = await agencyWithUnits('Review Replay Agency');
    await importLeases(c, 1);
    const batchId = await approved(c, 'balances', {
      arrears: [
        {
          unit: c.units[0]!,
          leaseStart: start,
          periodStart: plusMonths(start, 3),
          kind: 'Rent',
          amount: '1000',
          dueDate: plusMonths(start, 3),
        },
      ],
      deposits: [{ unit: c.units[0]!, leaseStart: start, amount: '1000' }],
    });
    const before = await entries(c.companyId);
    const both = await Promise.all([
      o.onboarding.postBalances(c.companyId, batchId),
      o.onboarding.postBalances(c.companyId, batchId),
    ]);
    expect([...both].sort()).toEqual(['posted', 'skipped']);
    const after = await entries(c.companyId);
    expect(await entries(c.companyId, `rule = 'P25'`)).toBe(2);
    expect(await countOf(ctx, c.companyId, 'onboarding_item')).toBe(2);
    // The job delivered again later finds the batch posted and does nothing.
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('skipped');
    expect(await entries(c.companyId)).toBe(after);
    expect(after).toBeGreaterThan(before);
    expect((await batchRecord(ctx, c.companyId, batchId)).status).toBe('posted');
  });
});

describe('NFR-SEC opening balances cross-company isolation', () => {
  it('never finds another company’s leases or owners, and never shows or commits its batches', async () => {
    const a = await agencyWithUnits('Review Isolation A');
    await importLeases(a, 1);
    const other = await agencyWithUnits('Review Isolation B');
    await importLeases(other, 1);
    const mine = await validated(
      ctx,
      o,
      a.admin,
      await uploadBatch(
        ctx,
        o,
        a.admin,
        'balances',
        await onboardingWorkbook('balances', {
          deposits: [{ unit: a.units[0]!, leaseStart: start, amount: '1000' }],
        }),
      ),
    );
    expect(mine.report!.issues).toEqual([]);
    // B names A's unit and owner: neither is found.
    const theirs = await validated(
      ctx,
      o,
      other.admin,
      await uploadBatch(
        ctx,
        o,
        other.admin,
        'balances',
        await onboardingWorkbook('balances', {
          deposits: [{ unit: a.units[0]!, leaseStart: start, amount: '1000' }],
          ownerItems: [{ owner: a.reference, agentCash: '10' }],
        }),
      ),
    );
    expect(theirs.report!.issues.map((i) => [i.sheet, i.column])).toEqual([
      ['Deposits', 'Lease start'],
      ['Owner items', 'Owner reference'],
    ]);
    await expect(o.onboarding.preview(other.admin, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(o.onboarding.commit(other.admin, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(o.onboarding.batch(other.admin, mine.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('TL-11 a move-out settles from an opening deposit (P11, P12)', () => {
  it('applies the deposit brought in to rent owed and refunds the rest, leaving 2100 at zero', async () => {
    const c = await agencyWithUnits('Review Move-out Agency');
    const leases = await importLeases(c, 1, { deposit: '2000' });
    const leaseId = leases.get(c.units[0]!)!;
    const batchId = await approved(c, 'balances', {
      deposits: [{ unit: c.units[0]!, leaseStart: start, amount: '2000' }],
    });
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('posted');
    expect(await leaseAccount(ctx, c.companyId, leaseId, '2100')).toBe(-200_000);
    const planned = await mo.moveOuts.plan(c.manager, leaseId, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    const drafted = await mo.moveOuts.get(c.manager, planned.id);
    const st = drafted.statement!;
    expect(st.depositHeldMinor).toBe(200_000);
    // The cut-over month's 1,000 is owed: the deposit pays it (P11) and the rest is refunded (P12).
    expect(st.depositAppliedMinor).toBe(100_000);
    expect(st.depositRefundMinor).toBe(100_000);
    const submitted = await mo.moveOuts.submit(c.manager, planned.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    expect(await leaseAccount(ctx, c.companyId, leaseId, '2100')).toBe(0);
    const proof = await uploadEvidence(ctx, (i) => mo.moveOuts.createRefundUpload(c.accountant, i));
    const paid = await mo.moveOuts.recordRefundPaid(c.accountant, planned.id, {
      paidOn: today,
      paidFrom: 'owner_account',
      reference: 'MOMO-OPENING',
      proofUploadId: proof,
    });
    expect(paid.status).toBe('refund_paid');
    expect(await leaseAccount(ctx, c.companyId, leaseId, '2400')).toBe(0);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('TX-04 P25 review S4: an opening withholding certificate (P20; founder decision 4, OQ-64)', () => {
  /** Withholding of 80 brought in for the month before the cut-over, then its certificate confirmed. */
  async function certifiedOpening(name: string, lettingBusiness: boolean) {
    const c = await agencyWithUnits(name);
    if (lettingBusiness) await setLettingBusiness(ctx, c.companyId, c.ownerId, true);
    const leaseId = (await importLeases(c, 1)).get(c.units[0]!)!;
    const batchId = await approved(c, 'balances', {
      withholding: [
        {
          unit: c.units[0]!,
          leaseStart: start,
          amount: '80',
          withheldOn: plusDays(cutOver, -5),
          periodStart: plusMonths(start, 3),
        },
      ],
    });
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('posted');
    // The flag as recorded with the opening withholding decides, never the owner's flag today.
    await setLettingBusiness(ctx, c.companyId, c.ownerId, !lettingBusiness);
    const [w] = await withCompany(ctx.database, system(c.companyId), (tx) =>
      tx.select({ id: schema.withholding.id }).from(schema.withholding),
    );
    await t.withholding.uploadCertificate(c.manager, w!.id, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(c.manager, i)),
      certificateNumber: `WHT-${name.slice(0, 4)}`,
    });
    const waiting = await t.withholding.get(c.admin, w!.id);
    await t.withholding.confirmCertificate(c.admin, waiting.certificate!.id);
    const done = await t.withholding.get(c.manager, w!.id);
    expect(done.status).toBe('certified');
    expect(await leaseAccount(ctx, c.companyId, leaseId, '1150')).toBe(0);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    return { c, leaseId, debit: done.certificate!.debitAccount };
  }

  it('posts Dr 1160 for an owner in the letting business: a tax credit', async () => {
    const { c, leaseId, debit } = await certifiedOpening('Review WHT Letting Agency', true);
    expect(debit).toBe('1160');
    expect(await leaseAccount(ctx, c.companyId, leaseId, '1160')).toBe(8_000);
    // The opening entry's credit to opening balances stays.
    expect(await leaseAccount(ctx, c.companyId, leaseId, '3900')).toBe(-8_000);
  });

  it('posts Dr 3900 for any other owner: the opening item nets to zero', async () => {
    const { c, leaseId, debit } = await certifiedOpening('Review WHT Other Agency', false);
    expect(debit).toBe('3900');
    expect(await leaseAccount(ctx, c.companyId, leaseId, '1160')).toBe(0);
    expect(await leaseAccount(ctx, c.companyId, leaseId, '3900')).toBe(0);
    expect(await entries(c.companyId, `rule = 'P20'`)).toBe(1);
  });
});

describe('AR-02 P25 review S5 and M2: paid-until for an imported lease (founder decision 3)', () => {
  let c: Company;
  let leases: Map<string, string>;
  const arrears = (periodStart: string, amount: string) => ({
    unit: c.units[1]!,
    leaseStart: start,
    periodStart,
    kind: 'Rent',
    amount,
    dueDate: periodStart,
  });
  const page = async (leaseId: string) => (await b.read.leaseBilling(c.manager, leaseId)).paidUntil;
  const moneyCard = async (leaseId: string) =>
    (
      await withCompany(ctx.database, system(c.companyId), (tx) =>
        b.read.leaseBillingIn(tx, c.companyId, leaseId),
      )
    ).paidUntil;
  beforeAll(async () => {
    c = await agencyWithUnits('Review Paid-until Agency');
    leases = await importLeases(c, 2);
  });

  it('S5: is the day before billing starts when nothing was owed at the cut-over', async () => {
    const leaseId = leases.get(c.units[0]!)!;
    // The cut-over month is owed on the platform; the months before it were settled before.
    expect(await page(leaseId)).toBe(plusDays(cutOver, -1));
    expect(await moneyCard(leaseId)).toBe(plusDays(cutOver, -1));
  });

  it('S5: is the day before the earliest opening month still owed, in the preview and on the lease page', async () => {
    const leaseId = leases.get(c.units[1]!)!;
    const batch = await validated(
      ctx,
      o,
      c.admin,
      await uploadBatch(
        ctx,
        o,
        c.admin,
        'balances',
        await onboardingWorkbook('balances', {
          arrears: [arrears(plusMonths(start, 2), '1000'), arrears(plusMonths(start, 3), '1000')],
        }),
      ),
    );
    expect(batch.report!.issues).toEqual([]);
    const preview = await o.onboarding.preview(c.admin, batch.id);
    const owedFrom = plusDays(plusMonths(start, 2), -1);
    expect(preview.leases.find((l) => l.leaseId === leaseId)!.after.paidUntil).toBe(owedFrom);
    const asked = await o.onboarding.commit(c.admin, batch.id);
    await s.approvals.decide(c.manager, asked.approval!.requestId, { decision: 'approve' });
    expect(await o.onboarding.postBalances(c.companyId, batch.id)).toBe('posted');
    expect(await page(leaseId)).toBe(owedFrom);
    expect(await moneyCard(leaseId)).toBe(owedFrom);
  });

  it('M2: moves on when an opening month is lowered to nothing, and back to the billing start once none is owed', async () => {
    const leaseId = leases.get(c.units[1]!)!;
    const lowered = await approved(c, 'adjustment', {
      arrears: [arrears(plusMonths(start, 2), '-1000')],
    });
    expect(await o.onboarding.postBalances(c.companyId, lowered)).toBe('posted');
    expect(await page(leaseId)).toBe(plusDays(plusMonths(start, 3), -1));
    const preview = await validated(
      ctx,
      o,
      c.admin,
      await uploadBatch(
        ctx,
        o,
        c.admin,
        'adjustment',
        await onboardingWorkbook('adjustment', {
          arrears: [arrears(plusMonths(start, 3), '-1000')],
        }),
      ),
    );
    expect(
      (await o.onboarding.preview(c.admin, preview.id)).leases.find((l) => l.leaseId === leaseId)!
        .after.paidUntil,
    ).toBe(plusDays(cutOver, -1));
    const asked = await o.onboarding.commit(c.admin, preview.id);
    await s.approvals.decide(c.manager, asked.approval!.requestId, { decision: 'approve' });
    expect(await o.onboarding.postBalances(c.companyId, preview.id)).toBe('posted');
    expect(await page(leaseId)).toBe(plusDays(cutOver, -1));
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('P25 arrears raised on a month brought in already (founder 2026-11-10)', () => {
  let c: Company;
  let leases: Map<string, string>;
  const raise = (unit: string, amount: string) => ({
    unit,
    leaseStart: start,
    periodStart: plusMonths(start, 2),
    kind: 'Rent',
    amount,
    dueDate: plusMonths(start, 2),
  });
  /** The lease's opening lines for the month raised, oldest first. */
  const monthLines = (leaseId: string) =>
    withCompany(ctx.database, system(c.companyId), (tx) =>
      tx.execute<{ id: string; charge_period_id: string; amount_minor: string; opening: boolean }>(
        sql`select l.id, l.charge_period_id, l.amount_minor, l.opening from invoice_line l
              join invoice i on i.company_id = l.company_id and i.id = l.invoice_id
            where l.lease_id = ${leaseId} and l.period_start = ${plusMonths(start, 2)}::date
            order by i.number, l.position`,
      ),
    ).then((r) => r.rows);
  const itemLines = (itemId: string) =>
    withCompany(ctx.database, system(c.companyId), (tx) =>
      tx.execute<{ charge_period_id: string; invoice_line_id: string; base: string; tax: string }>(
        sql`select charge_period_id, invoice_line_id, base_minor::text as base, tax_minor::text as tax
            from rent_tax_item_line where item_id = ${itemId}`,
      ),
    ).then((r) => r.rows);

  beforeAll(async () => {
    c = await agencyWithUnits('Review Raise Agency');
    leases = await importLeases(c, 3);
    const batchId = await approved(c, 'balances', {
      arrears: c.units.slice(0, 3).map((u) => raise(u, '1000')),
    });
    expect(await o.onboarding.postBalances(c.companyId, batchId)).toBe('posted');
  });

  it('raises it after the commit with a second opening line on the same charge period, and every nightly check passes', async () => {
    const raised = await approved(c, 'adjustment', {
      arrears: c.units.slice(0, 3).map((u) => raise(u, '200')),
    });
    expect(await o.onboarding.postBalances(c.companyId, raised)).toBe('posted');
    for (const unit of c.units.slice(0, 3)) {
      const leaseId = leases.get(unit)!;
      const lines = await monthLines(leaseId);
      expect(lines.map((l) => [Number(l.amount_minor), l.opening])).toEqual([
        [100_000, true],
        [20_000, true],
      ]);
      expect(lines[1]!.charge_period_id).toBe(lines[0]!.charge_period_id);
      // The month brought in (1,200 now) and the cut-over month the platform billed (1,000).
      const page = await b.read.leaseBilling(c.manager, leaseId);
      expect(page.dueNowMinor).toBe(220_000);
      expect(page.paidUntil).toBe(plusDays(plusMonths(start, 2), -1));
      const invoices = await b.read.invoices(c.manager, { leaseId });
      expect(invoices.filter((i) => i.kind === 'opening').map((i) => i.totalMinor)).toEqual(
        expect.arrayContaining([100_000, 20_000]),
      );
    }
    // The invoice page names the second line of the month as the raise.
    const [first, second] = (
      await b.read.invoices(c.manager, { leaseId: leases.get(c.units[0]!)! })
    )
      .filter((i) => i.kind === 'opening')
      .sort((x, y) => (x.number < y.number ? -1 : 1));
    expect((await b.read.invoice(c.manager, first!.id)).lines.map((l) => l.label)).toEqual([
      'Rent',
    ]);
    expect((await b.read.invoice(c.manager, second!.id)).lines.map((l) => l.label)).toEqual([
      'Rent (raised by an adjustment)',
    ]);
    expect(await entries(c.companyId, `rule = 'P25'`)).toBe(6);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    const agentCash = new AgentCashCheckService(ctx.database, new CallbackAlert(() => undefined));
    expect((await agentCash.check(c.companyId, { alert: false })).negative).toEqual([]);
  });

  it('TX-01 pays the earlier line first, and taxes the month once across both lines and both receipts', async () => {
    const leaseId = leases.get(c.units[0]!)!;
    const lines = await monthLines(leaseId);
    const pay = (amountMinor: number) =>
      b.money.recordProviderPayment(c.companyId, { leaseId, amountMinor, receivedOn: today });
    const opening = async () =>
      (await b.read.invoices(c.manager, { leaseId }))
        .filter((i) => i.kind === 'opening')
        .sort((x, y) => (x.number < y.number ? -1 : 1))
        .map((i) => [i.totalMinor, i.outstandingMinor]);
    const receiptItems = async () =>
      (await taxItemsOf(ctx, c.companyId, leaseId)).filter((i) => i.kind === 'receipt');
    // 1,000 pays the month's earlier line (oldest debt first, then the earlier line).
    await pay(100_000);
    expect(await opening()).toEqual([
      [100_000, 0],
      [20_000, 20_000],
    ]);
    // 200 more pays the raise: taxed on 200, never less for what the month was taxed on before.
    await pay(20_000);
    expect(await opening()).toEqual([
      [100_000, 0],
      [20_000, 0],
    ]);
    const items = await receiptItems();
    // 8% (rent_tax.rate.residential, from_prd) of what each receipt paid of the month.
    expect(items.map((i) => [i.baseMinor, i.taxMinor])).toEqual([
      [100_000, 8_000],
      [20_000, 1_600],
    ]);
    for (const [item, base, tax] of [
      [items[0]!, '100000', '8000'],
      [items[1]!, '20000', '1600'],
    ] as const)
      expect(await itemLines(item.id)).toEqual([
        {
          charge_period_id: lines[0]!.charge_period_id,
          invoice_line_id: lines[0]!.id,
          base,
          tax,
        },
      ]);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('TX-04 takes withholding on both lines of the month as one period of its rent tax item', async () => {
    const leaseId = leases.get(c.units[1]!)!;
    const lines = await monthLines(leaseId);
    await t.withholding.record(c.manager, {
      leaseId,
      valueDate: today,
      lines: [
        { lineId: lines[0]!.id, amountMinor: 8_000 },
        { lineId: lines[1]!.id, amountMinor: 1_600 },
      ],
    });
    const items = (await taxItemsOf(ctx, c.companyId, leaseId)).filter(
      (i) => i.kind === 'withholding',
    );
    expect(items.map((i) => [i.baseMinor, i.taxMinor])).toEqual([[120_000, 9_600]]);
    expect(await itemLines(items[0]!.id)).toEqual([
      {
        charge_period_id: lines[0]!.charge_period_id,
        invoice_line_id: lines[0]!.id,
        base: '120000',
        tax: '9600',
      },
    ]);
    expect(await leaseAccount(ctx, c.companyId, leaseId, '1150')).toBe(9_600);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('lowers the month across its opening lines, latest first, never below what is paid', async () => {
    const leaseId = leases.get(c.units[2]!)!;
    await b.money.recordProviderPayment(c.companyId, {
      leaseId,
      amountMinor: 50_000,
      receivedOn: today,
    });
    // 1,200 owed of the month, 500 of it paid: at most 700 can come off.
    const tooMuch = await validated(
      ctx,
      o,
      c.admin,
      await uploadBatch(
        ctx,
        o,
        c.admin,
        'adjustment',
        await onboardingWorkbook('adjustment', { arrears: [raise(c.units[2]!, '-800')] }),
      ),
    );
    expect(tooMuch.report!.issues).toEqual([
      expect.objectContaining({ sheet: 'Arrears', row: 2, column: 'Amount' }),
    ]);
    const lowered = await approved(c, 'adjustment', { arrears: [raise(c.units[2]!, '-600')] });
    expect(await o.onboarding.postBalances(c.companyId, lowered)).toBe('posted');
    // The raise comes off first (200), then 400 of the earlier line, whose 500 paid stays.
    const opening = (await b.read.invoices(c.manager, { leaseId }))
      .filter((i) => i.kind === 'opening')
      .sort((x, y) => (x.number < y.number ? -1 : 1))
      .map((i) => [i.totalMinor, i.outstandingMinor]);
    expect(opening).toEqual([
      [100_000, 10_000],
      [20_000, 0],
    ]);
    expect((await b.read.leaseBilling(c.manager, leaseId)).dueNowMinor).toBe(110_000);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});
