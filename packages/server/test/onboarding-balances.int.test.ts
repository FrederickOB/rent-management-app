import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallbackAlert } from '@rent/integrations';
import { AgentCashCheckService } from '../src/ledger/agent-cash-check.service';
import { Gate1Service } from '../src/reporting/gate1.service';
import {
  asSuperuser,
  company,
  member,
  person,
  staff,
  startServerTest,
  type ServerTestContext,
} from './support';
import {
  approvedCash,
  billingServices,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import {
  batchRecord,
  committed,
  countOf,
  onboardingServices,
  onboardingWorkbook,
  outboxOf,
  uploadBatch,
  validated,
  type OnboardingServices,
} from './support/onboarding';
import {
  feeTermsFrom,
  reportingMoneyServices,
  type ReportingMoneyServices,
} from './support/reporting-money';
import {
  reportingStatementsServices,
  type ReportingStatementsServices,
} from './support/reporting-statements';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Opening balances (P25; M11 decision 3; plan 4.2 and section 6) against the real database with
 * RLS on: the Balances workbook's dry run and preview, the second person's approval, the posting
 * job, then every nightly check (books, receivables per line, prepayments and deposits per lease,
 * fees, agent cash), no rent tax and no fee on opening money, a receipt after the cut-over that
 * pays opening arrears taxed and charged as any other, posting twice changing nothing, the
 * adjustment workbook and its floors, the single-user cooling-off, and the first statement's
 * opening section. Fictional numbers only.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: ReportingMoneyServices;
let st: ReportingStatementsServices;
let t: TaxServices;
let o: OnboardingServices;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let second: Awaited<ReturnType<typeof staffIn>>;
let today: string;
let cutOver: string;
let start: string;
let ownerId: string;
let homes: string[];
let shops: string[];
let leaseA: string;
let leaseB: string;
let leaseC: string;
let balancesId: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const system = (companyId: string) => ({ companyId, actorKind: 'system' as const });

const PHONE_A = '024 000 0201';
const PHONE_B = '024 000 0202';
const TIN_C = 'C0000000203';

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  // Rent tax registers its hooks with the engine: every receipt after this is taxed.
  t = taxServices(ctx, s, b);
  m = reportingMoneyServices(ctx, s, b);
  st = reportingStatementsServices(ctx, s, b);
  o = onboardingServices(ctx, s, b);
  agency = await moneyCompany(ctx, s, 'agency', 'Opening Balances Agency');
  second = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second admin');
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  cutOver = `${today.slice(0, 7)}-01`;
  start = plusMonths(cutOver, -4);
  ownerId = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Opening Owner',
      reference: 'OWN-B1',
    })
  ).id;
  await feeTermsFrom(
    ctx,
    agency.companyId,
    ownerId,
    { kind: 'percentage', rateBps: 1000 },
    plusMonths(start, -1),
  );
  homes = Object.keys(
    (
      await propertyWithUnits(s, agency.manager, {
        areaCode: 'ACC',
        propertyPart: 'OPB',
        ownerId,
        units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
      })
    ).units,
  ).sort();
  shops = Object.keys(
    (
      await propertyWithUnits(s, agency.manager, {
        areaCode: 'ACC',
        propertyPart: 'OPS',
        ownerId,
        use: 'commercial',
        units: [{ unitType: 'office', count: 1 }],
      })
    ).units,
  ).sort();
  await o.onboarding.setCutOver(agency.admin, cutOver);
  const end = plusDays(plusMonths(start, 12), -1);
  const lease = (unit: string, extra: Record<string, string>) => ({
    unit,
    startDate: start,
    endDate: end,
    cycle: 'Monthly',
    noticeDays: '30',
    signedOn: plusDays(start, -5),
    ...extra,
  });
  const file = await onboardingWorkbook('tenancies', {
    tenants: [
      { kind: 'Individual', name: 'Arrears Tenant', phone: PHONE_A },
      { kind: 'Individual', name: 'Advance Tenant', phone: PHONE_B },
      { kind: 'Company', name: 'Withholding Traders', tin: TIN_C },
    ],
    leases: [
      lease(homes[0]!, { tenantPhone: PHONE_A, monthlyRent: '1500' }),
      lease(homes[1]!, { tenantPhone: PHONE_B, monthlyRent: '1000', deposit: '2000' }),
      lease(shops[0]!, {
        tenantName: 'Withholding Traders',
        tenantTin: TIN_C,
        monthlyRent: '2000',
        use: 'Commercial',
      }),
    ],
  });
  const batch = await validated(
    ctx,
    o,
    agency.admin,
    await uploadBatch(ctx, o, agency.admin, 'tenancies', file),
  );
  expect(batch.report!.issues).toEqual([]);
  expect((await committed(ctx, o, agency.admin, batch.id)).status).toBe('committed');
  await runLeaseEvents(ctx, b, agency.companyId);
  const ids = await withCompany(ctx.database, system(agency.companyId), (tx) =>
    tx.execute<{ id: string; rent: number }>(
      sql`select id, monthly_rent_minor as rent from lease order by monthly_rent_minor`,
    ),
  );
  const byRent = new Map(ids.rows.map((r) => [Number(r.rent), r.id]));
  leaseA = byRent.get(150_000)!;
  leaseB = byRent.get(100_000)!;
  leaseC = byRent.get(200_000)!;
});

afterAll(async () => {
  await ctx.close();
});

const balancesFile = () =>
  onboardingWorkbook('balances', {
    arrears: [
      {
        unit: homes[0]!,
        leaseStart: start,
        periodStart: plusMonths(start, 2),
        kind: 'Rent',
        amount: '1500',
        dueDate: plusMonths(start, 2),
      },
      {
        unit: homes[0]!,
        leaseStart: start,
        periodStart: plusMonths(start, 3),
        kind: 'Rent',
        amount: '1000',
        dueDate: plusMonths(start, 3),
      },
    ],
    advances: [
      { unit: homes[1]!, leaseStart: start, paidThrough: plusDays(plusMonths(cutOver, 3), -1) },
    ],
    deposits: [
      { unit: homes[0]!, leaseStart: start, amount: '1500' },
      { unit: homes[1]!, leaseStart: start, amount: '2000' },
    ],
    withholding: [
      {
        unit: shops[0]!,
        leaseStart: start,
        amount: '300',
        withheldOn: plusDays(cutOver, -5),
        periodStart: plusMonths(start, 3),
      },
    ],
    ownerItems: [
      { owner: 'OWN-B1', agentCash: '5000', rentTax: '240', rentTaxDueOn: plusDays(cutOver, 20) },
    ],
  });

async function decideAndPost(requestId: string, approver = second, companyId = agency.companyId) {
  await s.approvals.decide(approver, requestId, { decision: 'approve' });
  const [row] = await withCompany(ctx.database, system(companyId), (tx) =>
    tx
      .select()
      .from(schema.onboardingBatch)
      .where(sql`${schema.onboardingBatch.approvalRequestId} = ${requestId}`),
  );
  return o.onboarding.postBalances(companyId, row!.id);
}

const journal = (where: string) =>
  withCompany(ctx.database, system(agency.companyId), async (tx) =>
    Number(
      (
        await tx.execute<{ total: string }>(
          sql.raw(
            `select coalesce(sum(l.amount_minor), 0)::text as total from journal_line l join journal_entry e on e.id = l.entry_id where ${where}`,
          ),
        )
      ).rows[0]!.total,
    ),
  );

describe('P25 opening balances: the Balances workbook', () => {
  it('lists every problem by sheet, row and column, and writes nothing', async () => {
    const entries = await countOf(ctx, agency.companyId, 'journal_entry');
    const file = await onboardingWorkbook('balances', {
      arrears: [
        {
          unit: homes[0]!,
          leaseStart: plusDays(start, 1),
          periodStart: plusMonths(start, 1),
          kind: 'Rent',
          amount: '10',
          dueDate: plusMonths(start, 1),
        },
        {
          unit: homes[0]!,
          leaseStart: start,
          periodStart: plusDays(start, 3),
          kind: 'Rent',
          amount: '10',
          dueDate: plusMonths(start, 1),
        },
        {
          unit: homes[0]!,
          leaseStart: start,
          periodStart: cutOver,
          kind: 'Rent',
          amount: '10',
          dueDate: cutOver,
        },
      ],
      advances: [
        { unit: homes[1]!, leaseStart: start, paidThrough: plusDays(plusMonths(cutOver, 1), 3) },
      ],
      ownerItems: [{ owner: 'OWN-ZZ', agentCash: '10' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'balances', file),
    );
    expect(batch.status).toBe('invalid');
    const at = (sheet: string, row: number) =>
      batch.report!.issues.filter((i) => i.sheet === sheet && i.row === row).map((i) => i.column);
    expect(at('Arrears', 2)).toEqual(['Lease start']);
    expect(at('Arrears', 3)).toEqual(['Period start']);
    expect(at('Arrears', 4)).toEqual(['Period start']);
    expect(at('Advances', 2)).toEqual(['Paid through']);
    expect(at('Owner items', 2)).toEqual(['Owner reference']);
    await expect(o.onboarding.preview(agency.admin, batch.id)).rejects.toMatchObject({
      code: 'not_validated',
    });
    await expect(o.onboarding.commit(agency.admin, batch.id)).rejects.toMatchObject({
      code: 'not_validated',
    });
    expect(await countOf(ctx, agency.companyId, 'journal_entry')).toBe(entries);
  });

  it('previews each lease as it will be, and asks a second person, never the initiator', async () => {
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'balances', await balancesFile()),
    );
    expect(batch.report!.issues).toEqual([]);
    expect(batch.report!.totals).toEqual({
      arrearsMinor: 250_000,
      advancesMinor: 300_000,
      depositsMinor: 350_000,
      withholdingMinor: 30_000,
      agentCashMinor: 500_000,
      rentTaxOutstandingMinor: 24_000,
    });
    balancesId = batch.id;
    const preview = await o.onboarding.preview(agency.admin, batch.id);
    const a = preview.leases.find((l) => l.leaseId === leaseA)!;
    const bb = preview.leases.find((l) => l.leaseId === leaseB)!;
    // The opening arrears, plus what the platform has billed since the cut-over and is due.
    expect(a.after.arrearsMinor).toBe(250_000 + 150_000);
    expect(a.after.depositHeldMinor).toBe(150_000);
    expect(bb.after.paidUntil).toBe(plusDays(plusMonths(cutOver, 3), -1));
    expect(bb.after.depositHeldMinor).toBe(200_000);
    expect(preview.owners).toEqual([
      expect.objectContaining({
        owner: { id: ownerId, name: 'Opening Owner' },
        leases: 3,
        agentCashMinor: 500_000,
        rentTaxOutstandingMinor: 24_000,
        rentTaxDueOn: plusDays(cutOver, 20),
      }),
    ]);

    const asked = await o.onboarding.commit(agency.admin, batch.id);
    expect(asked.status).toBe('awaiting_approval');
    expect(asked.approval).toMatchObject({ status: 'pending', selfConfirmFrom: null });
    await expect(
      s.approvals.decide(agency.admin, asked.approval!.requestId, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 403 });
    // The money approvers decide (founder decision 2, review round); a caretaker is not one.
    const caretaker = await staffIn(ctx, agency.companyId, 'agency', 'caretaker', 'Caretaker');
    const refused = await s.approvals
      .decide(caretaker, asked.approval!.requestId, { decision: 'approve' })
      .then(
        () => null,
        (e: { status?: number }) => e.status,
      );
    // Refused: the request is not even visible to a caretaker (404), or not theirs to decide (403).
    expect([403, 404]).toContain(refused);
    // Nothing posts until the second person approves (RA124 refuses a move without it).
    expect(await countOf(ctx, agency.companyId, 'journal_entry', `rule = 'P25'`)).toBe(0);
    await expect(
      withCompany(ctx.database, system(agency.companyId), (tx) =>
        tx
          .update(schema.onboardingBatch)
          .set({ status: 'posting' })
          .where(sql`${schema.onboardingBatch.id} = ${batch.id}`),
      ),
    ).rejects.toThrow();

    const lease = async (id: string) =>
      withCompany(ctx.database, system(agency.companyId), (tx) =>
        b.read.leaseBillingIn(tx, agency.companyId, id),
      );
    expect(await decideAndPost(asked.approval!.requestId)).toBe('posted');
    const posted = await o.onboarding.batch(agency.admin, batch.id);
    expect(posted.status).toBe('posted');
    expect((await o.onboarding.state(agency.admin)).cutOverFixed).toBe(true);
    // The preview is what the lease pages show after the commit.
    for (const l of preview.leases) {
      const page = await lease(l.leaseId);
      expect(page.dueNowMinor).toBe(l.after.arrearsMinor);
      expect(page.paidUntil).toBe(l.after.paidUntil);
      expect(page.depositHeldMinor).toBe(l.after.depositHeldMinor);
    }
  });

  it('posts dated the cut-over, against 3900, and every nightly check passes', async () => {
    // Opening lines are accrued at commit, owed from the cut-over, and never accrued again.
    const lines = await withCompany(ctx.database, system(agency.companyId), async (tx) =>
      (await import('../src/billing/records')).loadLines(tx, [leaseA]),
    );
    const opening = lines.filter((l) => l.invoiceKind === 'opening');
    expect(opening.map((l) => [l.kind, l.opening, l.accrued, l.chargedOn])).toEqual([
      ['rent', true, true, cutOver],
      ['rent', true, true, cutOver],
      ['deposit', true, false, null],
    ]);
    // One entry per item: two arrears, the advance, two deposits, the withholding, agent cash and
    // rent tax; every one dated the cut-over, none touching income, rent tax expense or fees.
    expect(await countOf(ctx, agency.companyId, 'journal_entry', `rule = 'P25'`)).toBe(8);
    expect(
      await countOf(
        ctx,
        agency.companyId,
        'journal_entry',
        `rule = 'P25' and value_date <> '${cutOver}'`,
      ),
    ).toBe(0);
    expect(
      await countOf(
        ctx,
        agency.companyId,
        'journal_line l join journal_entry e on e.id = l.entry_id',
        `e.rule = 'P25' and l.account_code in ('4000', '4100', '5300', '5100')`,
      ),
    ).toBe(0);
    // Every entry sums to zero in each book.
    const unbalanced = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.execute(
        sql`select entry_id from journal_line group by entry_id, book_id having sum(amount_minor) <> 0`,
      ),
    );
    expect(unbalanced.rows).toEqual([]);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
    const agentCash = new AgentCashCheckService(ctx.database, new CallbackAlert(() => undefined));
    expect((await agentCash.check(agency.companyId, { alert: false })).negative).toEqual([]);
    // No rent tax (P17) and no management fee (P14) on money received before the platform. The
    // one rent tax item is the owner's rent tax still owed at the cut-over (below).
    expect(await countOf(ctx, agency.companyId, 'rent_tax_item', `kind <> 'opening'`)).toBe(0);
    expect(await countOf(ctx, agency.companyId, 'management_fee')).toBe(0);
    expect(await countOf(ctx, agency.companyId, 'receipt')).toBe(0);
    // Opening payments are never in the payments list, never reversed, and have no receipt.
    const payments = await b.read.payments(agency.admin, { leaseId: leaseB });
    expect(payments).toEqual([]);
    // The withholding awaits its certificate as an M5 withholding; the rent tax item its due date.
    const w = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.select().from(schema.withholding),
    );
    expect(w).toEqual([
      expect.objectContaining({ leaseId: leaseC, amountMinor: 30_000, paymentId: null }),
    ]);
    const items = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.execute<{ kind: string; due_on: string | null; amount_minor: string }>(
        sql`select kind, due_on::text, amount_minor::text from onboarding_item order by kind, amount_minor`,
      ),
    );
    expect(items.rows.map((r) => r.kind).sort()).toEqual(
      [
        'advance',
        'agent_cash',
        'arrears',
        'arrears',
        'deposit',
        'deposit',
        'rent_tax',
        'withholding',
      ].sort(),
    );
    expect(items.rows.find((r) => r.kind === 'rent_tax')).toMatchObject({
      due_on: plusDays(cutOver, 20),
      amount_minor: '24000',
    });
    expect(await journal(`l.account_code = '2200'`)).toBe(-24_000);
    expect(await journal(`l.account_code = '1070'`)).toBe(500_000);
    expect(await journal(`l.account_code = '1150'`)).toBe(30_000);
  });

  it('posts nothing twice: the job again, and the same workbook again', async () => {
    const entries = await countOf(ctx, agency.companyId, 'journal_entry');
    expect(await o.onboarding.postBalances(agency.companyId, balancesId)).toBe('skipped');
    const again = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'balances', await balancesFile()),
    );
    expect(again.report!.issues).toEqual([]);
    for (const c of Object.values(again.report!.counts)) expect(c.create + c.update).toBe(0);
    await expect(o.onboarding.commit(agency.admin, again.id)).rejects.toMatchObject({
      code: 'nothing_to_post',
    });
    expect(await countOf(ctx, agency.companyId, 'journal_entry')).toBe(entries);
  });

  it('leaves opening money out of Gate 1’s collection rate: neither due nor collected', async () => {
    const gate1 = new Gate1Service(ctx.database, s.policy, ctx.clock);
    const rate = (month: string) =>
      withCompany(
        ctx.database,
        system(agency.companyId),
        async (tx) =>
          (await gate1.compute(tx, agency.companyId, month, ctx.clock.now(), 'Africa/Accra')).gate1
            .collectionRate,
      );
    // The cut-over's month: A's and C's rent are due; B's was paid ahead before the platform.
    expect(await rate(cutOver.slice(0, 7))).toMatchObject({ dueMinor: 350_000, collectedMinor: 0 });
    // A month before the cut-over has only opening arrears, which are not the platform's to collect.
    expect(await rate(plusMonths(start, 2).slice(0, 7))).toMatchObject({
      dueMinor: 0,
      collectedMinor: 0,
    });
  });

  it('taxes and charges a fee on a receipt after the cut-over that pays opening arrears', async () => {
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: leaseA,
      amountMinor: 150_000,
      receivedOn: today,
    });
    const items = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx
        .select()
        .from(schema.rentTaxItem)
        .where(sql`${schema.rentTaxItem.leaseId} = ${leaseA}`),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: 'receipt', baseMinor: 150_000, taxMinor: 12_000 }),
    ]);
    const fees = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.select().from(schema.managementFee),
    );
    expect(fees).toEqual([expect.objectContaining({ baseMinor: 150_000, feeMinor: 15_000 })]);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('draws opening credit onto later months as on the platform, with no fee and no rent tax', async () => {
    const later = plusMonths(cutOver, 2);
    await b.invoicing.generateAll(agency.companyId, later);
    await b.invoicing.accrueAll(agency.companyId, later);
    const drawn = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from allocation a join payment p on p.company_id = a.company_id and p.id = a.payment_id
            where p.source_type = 'opening_balance' and a.record_type = 'accrual'`,
      ),
    );
    expect(drawn.rows[0]!.n).toBeGreaterThan(0);
    expect(await countOf(ctx, agency.companyId, 'management_fee')).toBe(1);
    expect(await countOf(ctx, agency.companyId, 'rent_tax_item', `kind <> 'opening'`)).toBe(1);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('shows the opening balances in their own section on the first statement, which adds up', async () => {
    // A statement is drafted once its month is over: the clock moves to the next month for it.
    const now = ctx.clock.now();
    ctx.clock.set(new Date(`${plusMonths(cutOver, 1)}T12:00:00Z`));
    const draft = await st.statements
      .draft(agency.admin, { ownerId, month: cutOver.slice(0, 7) })
      .finally(() => ctx.clock.set(now));
    expect(draft.opening).toEqual({
      cutOver,
      arrearsMinor: 250_000,
      advancesMinor: 300_000,
      depositsMinor: 350_000,
      withholdingMinor: 30_000,
      agentCashMinor: 500_000,
      rentTaxOutstandingMinor: 24_000,
    });
    expect(draft.figures.checks.filter((c) => !c.passed)).toEqual([]);
    expect(draft.figures.rentTaxPayable?.openingMinor).toBe(24_000);
    // The month before the cut-over has none.
    const before = await st.statements.draft(agency.admin, {
      ownerId,
      month: plusMonths(cutOver, -1).slice(0, 7),
    });
    expect(before.opening).toBeNull();
  });
});

describe('TX-02 rent tax still owed at the cut-over (P25)', () => {
  const dueOn = () => plusDays(cutOver, 20);
  const openingItem = async () =>
    (await t.reports.items(agency.accountant, { ownerId })).find((i) => i.kind === 'opening')!;

  it('is an owner-level M5 rent tax item with its own due date, which the alerts read', async () => {
    const item = await openingItem();
    expect(item).toMatchObject({
      kind: 'opening',
      status: 'open',
      leaseId: null,
      propertyId: null,
      unitCode: null,
      dueDate: dueOn(),
      valueDate: cutOver,
      taxMinor: 24_000,
      baseMinor: 0,
      outstandingMinor: 24_000,
    });
    // Its alerts come as they would for a receipt due that day: the due days (30) before it,
    // then 21 and 28 days on, from the rules rows as of the cut-over (TX-08).
    const due = await t.reports.dueList(agency.accountant, { ownerId });
    expect(due.find((i) => i.id === item.id)).toBeDefined();
    const alertDay = plusDays(dueOn(), -2);
    await t.taxAlerts.run(agency.companyId, alertDay);
    const alerts = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.execute<{ alert_day: number; property_id: string | null }>(
        sql`select alert_day, property_id from rent_tax_alert where item_id = ${item.id} order by alert_day`,
      ),
    );
    expect(alerts.rows).toEqual([
      { alert_day: 21, property_id: null },
      { alert_day: 28, property_id: null },
    ]);
    // Staff are told (queued through the outbox); never a tenant.
    const told = (await outboxOf(ctx, agency.companyId, 'messaging.send'))
      .map(
        (e) => e.payload as { recipient: { type: string }; subject: string | null; body: string },
      )
      .filter((m) => m.subject?.startsWith('Rent tax due to GRA'));
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((m) => m.recipient.type === 'staff')).toBe(true);
    expect(told[0]!.body).toContain('Rent tax owed at the cut-over');
    // Recorded once: a second run on the day adds nothing.
    expect(await t.taxAlerts.run(agency.companyId, alertDay)).toBe(0);
  });

  it('is settled by a GRA payment, and never lowered below what GRA was paid', async () => {
    const item = await openingItem();
    const upload = await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i));
    await t.gra.recordGraPayment(agency.accountant, {
      ownerId,
      paidOn: today,
      amountMinor: 20_000,
      graReceiptNumber: 'GRA-OPENING-1',
      receiptUploadId: upload,
      paidFrom: 'owner_account',
      items: [{ itemId: item.id, amountMinor: 20_000 }],
    });
    expect(await openingItem()).toMatchObject({
      status: 'part_paid',
      paidMinor: 20_000,
      outstandingMinor: 4_000,
    });
    expect(
      await journal(`l.account_code = '2200' and e.rule = 'P18' and l.property_id is null`),
    ).toBe(20_000);
    // Lowering it by more than is still owed is refused.
    const file = await onboardingWorkbook('adjustment', {
      ownerItems: [{ owner: 'OWN-B1', rentTax: '-50' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'adjustment', file),
    );
    expect(batch.report!.issues.map((i) => [i.sheet, i.column])).toEqual([
      ['Owner items', 'Rent tax outstanding'],
    ]);
    // The month's statement still adds up: what GRA was paid on the owner's own item counts.
    const now = ctx.clock.now();
    ctx.clock.set(new Date(`${plusMonths(cutOver, 1)}T12:00:00Z`));
    const draft = await st.statements
      .draft(agency.admin, { ownerId, month: cutOver.slice(0, 7) })
      .finally(() => ctx.clock.set(now));
    expect(draft.figures.checks.filter((c) => !c.passed)).toEqual([]);
    expect(draft.figures.rentTaxPayable?.paidMinor).toBe(20_000);
  });
});

describe('P25 opening balances: the adjustment workbook', () => {
  it('refuses to lower an item below what has been paid or drawn', async () => {
    const file = await onboardingWorkbook('adjustment', {
      arrears: [
        {
          unit: homes[0]!,
          leaseStart: start,
          periodStart: plusMonths(start, 2),
          kind: 'Rent',
          amount: '-1500',
        },
      ],
      advances: [{ unit: homes[1]!, leaseStart: start, amount: '-3000' }],
      deposits: [{ unit: homes[1]!, leaseStart: start, amount: '-2500' }],
      withholding: [
        { unit: shops[0]!, leaseStart: start, amount: '-100', periodStart: plusMonths(start, 3) },
      ],
      ownerItems: [{ owner: 'OWN-B1', agentCash: '-6000' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'adjustment', file),
    );
    expect(batch.status).toBe('invalid');
    const cols = (sheet: string) =>
      batch.report!.issues.filter((i) => i.sheet === sheet).map((i) => i.column);
    // The receipt paid the first opening month; the later months drew on the advance.
    expect(cols('Arrears')).toEqual(['Amount']);
    expect(cols('Advances')).toEqual(['Amount']);
    expect(cols('Deposits')).toEqual(['Amount held']);
    expect(cols('Withholding')).toEqual(['Amount']);
    expect(cols('Owner items')).toEqual(['Agent-held cash']);
  });

  it('lowers and raises items through the same approval, with the figures before and after', async () => {
    const file = await onboardingWorkbook('adjustment', {
      arrears: [
        {
          unit: homes[0]!,
          leaseStart: start,
          periodStart: plusMonths(start, 3),
          kind: 'Rent',
          amount: '-400',
        },
      ],
      deposits: [{ unit: homes[0]!, leaseStart: start, amount: '-500' }],
      advances: [{ unit: homes[1]!, leaseStart: start, amount: '500' }],
      ownerItems: [{ owner: 'OWN-B1', agentCash: '100', rentTax: '-40' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'adjustment', file),
    );
    expect(batch.report!.issues).toEqual([]);
    const preview = await o.onboarding.preview(agency.admin, batch.id);
    const a = preview.leases.find((l) => l.leaseId === leaseA)!;
    expect(a.before!.depositHeldMinor).toBe(150_000);
    expect(a.after.depositHeldMinor).toBe(100_000);
    expect(a.before!.arrearsMinor - a.after.arrearsMinor).toBe(40_000);
    const asked = await o.onboarding.commit(agency.admin, batch.id);
    expect(await decideAndPost(asked.approval!.requestId)).toBe('posted');
    const page = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      b.read.leaseBillingIn(tx, agency.companyId, leaseA),
    );
    expect(page.depositHeldMinor).toBe(100_000);
    expect(page.dueNowMinor).toBe(a.after.arrearsMinor);
    expect(await journal(`l.account_code = '1070'`)).toBe(510_000);
    expect(await journal(`l.account_code = '2200' and e.rule = 'P25'`)).toBe(-20_000);
    // The lowering is the opening item's one reversal, owner-level; what is left is what GRA was paid.
    const items = await t.reports.items(agency.accountant, { ownerId });
    const opening = items.find((i) => i.kind === 'opening')!;
    expect(items.filter((i) => i.reversesItemId === opening.id)).toEqual([
      expect.objectContaining({ kind: 'reversal', taxMinor: -4_000, leaseId: null }),
    ]);
    expect(opening).toMatchObject({ correctedMinor: -4_000, outstandingMinor: 0, status: 'paid' });
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await m.fees.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('lowers an advance off the opening payment’s amount, never below what is drawn', async () => {
    const file = await onboardingWorkbook('adjustment', {
      advances: [{ unit: homes[1]!, leaseStart: start, amount: '-200' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'adjustment', file),
    );
    expect(batch.report!.issues).toEqual([]);
    const asked = await o.onboarding.commit(agency.admin, batch.id);
    expect(await decideAndPost(asked.approval!.requestId)).toBe('posted');
    const page = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      b.read.leaseBillingIn(tx, agency.companyId, leaseB),
    );
    expect(page.creditMinor).toBe(30_000);
    // Taken off the payment's amount for allocation, as a refund part is (invariant 7 holds).
    const pays = await withCompany(ctx.database, system(agency.companyId), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from payment where lease_id = ${leaseB} order by created_at`,
      ),
    );
    const records = await withCompany(ctx.database, system(agency.companyId), async (tx) =>
      (await import('../src/billing/records')).paymentsByIds(
        tx,
        pays.rows.map((r) => r.id),
      ),
    );
    expect(records.map((r) => [r.opening, r.openingReducedMinor, r.amountMinor])).toEqual([
      [true, 0, 300_000],
      [true, 20_000, 30_000],
    ]);
    // Opening payments come first, first in, first out, before any payment on the platform.
    expect(records.every((r) => r.order.startsWith('!'))).toBe(true);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('is rejected when the second person rejects it, and never posts', async () => {
    const file = await onboardingWorkbook('adjustment', {
      ownerItems: [{ owner: 'OWN-B1', agentCash: '1' }],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'adjustment', file),
    );
    const asked = await o.onboarding.commit(agency.admin, batch.id);
    await s.approvals.decide(second, asked.approval!.requestId, {
      decision: 'reject',
      reason: 'Not agreed with the owner',
    });
    expect((await o.onboarding.batch(agency.admin, batch.id)).status).toBe('rejected');
    expect(await o.onboarding.postBalances(agency.companyId, batch.id)).toBe('skipped');
    expect(await journal(`l.account_code = '1070'`)).toBe(510_000);
  });
});

describe('P25 opening balances in a single-user company (OQ-29)', () => {
  it('confirms by its only admin after the cooling-off, with a current code', async () => {
    const SECRET = 'onboarding-single-user-totp-secret';
    const base32 = (text: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
      let out = '';
      for (let i = 0; i < bits.length; i += 5)
        out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
      return out;
    };
    const soloCompany = await company(ctx, 'landlord', 'Solo Opening Landlord');
    const soloPerson = await person(ctx, 'Solo landlord', { totpSecret: SECRET });
    const solo = staff(
      soloCompany,
      'landlord',
      soloPerson,
      await member(ctx, soloCompany, soloPerson, 'owner'),
      'owner',
    );
    const units = Object.keys(
      (
        await propertyWithUnits(s, solo, {
          areaCode: 'TEM',
          propertyPart: 'SOL',
          units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
        })
      ).units,
    );
    await o.onboarding.setCutOver(solo, cutOver);
    const end = plusDays(plusMonths(start, 12), -1);
    const tenancies = await validated(
      ctx,
      o,
      solo,
      await uploadBatch(
        ctx,
        o,
        solo,
        'tenancies',
        await onboardingWorkbook('tenancies', {
          tenants: [{ kind: 'Individual', name: 'Solo Tenant', phone: '024 000 0299' }],
          leases: [
            {
              unit: units[0]!,
              tenantPhone: '024 000 0299',
              startDate: start,
              endDate: end,
              monthlyRent: '800',
              cycle: 'Monthly',
              noticeDays: '30',
              signedOn: start,
            },
          ],
        }),
      ),
    );
    expect(tenancies.report!.issues).toEqual([]);
    await committed(ctx, o, solo, tenancies.id);
    await runLeaseEvents(ctx, b, solo.companyId);
    const balances = await validated(
      ctx,
      o,
      solo,
      await uploadBatch(
        ctx,
        o,
        solo,
        'balances',
        await onboardingWorkbook('balances', {
          deposits: [{ unit: units[0]!, leaseStart: start, amount: '800' }],
        }),
      ),
    );
    expect(balances.report!.issues).toEqual([]);
    const asked = await o.onboarding.commit(solo, balances.id);
    expect(asked.approval?.selfConfirmFrom).not.toBeNull();
    const requestId = asked.approval!.requestId;
    await expect(
      s.approvals.decide(solo, requestId, {
        decision: 'self_confirm',
        code: await generate({ secret: base32(SECRET) }),
      }),
    ).rejects.toThrow(/cooling-off/);
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = now() - interval '1 minute' where id = $1",
      [requestId],
    );
    ctx.clock.advance(24 * 3_600_000 + 60_000);
    try {
      await s.approvals.decide(solo, requestId, {
        decision: 'self_confirm',
        code: await generate({ secret: base32(SECRET) }),
      });
      expect(await o.onboarding.postBalances(solo.companyId, balances.id)).toBe('posted');
      expect((await batchRecord(ctx, solo.companyId, balances.id)).status).toBe('posted');
    } finally {
      ctx.clock.advance(-(24 * 3_600_000 + 60_000));
    }
  });
});
