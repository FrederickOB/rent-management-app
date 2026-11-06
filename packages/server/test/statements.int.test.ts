import { sql, withCompany, type Tx } from '@rent/db';
import { renderHtml, templates } from '@rent/documents';
import { ageBucket } from '@rent/domain/billing';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import {
  managementFeeLines,
  ownerFundingLines,
  remittanceLines,
  type JournalLineDraft,
} from '@rent/domain/ledger';
import { flattenStatementFigures } from '@rent/domain/reporting';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffContext } from '../src/policy/policy.service';
import {
  OWNER_STATEMENT_TEMPLATE,
  type OwnerStatementDetailView,
} from '../src/reporting/statements.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, outboxOf, type MaintenanceServices } from './support/maintenance';
import {
  reportingStatementsServices,
  statementRecords,
  type ReportingStatementsServices,
} from './support/reporting-statements';
import { taxServices, uploadEvidence } from './support/tax';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M9 owner statements against the real database with RLS on (plan 4.3; decisions 5 to 7 and 15):
 * a statement regenerated for an issued month gives identical figures after later corrections,
 * which land in the open month (AC-04 ★); its rent tax is the sum of each receipt's tax (★); an
 * owner and their adviser see only their own statements and figures (★); issuing locks the month,
 * and is refused for a month not over, a statement issued already, one that does not add up, and
 * a Starter company; the PDF's hash is recorded and it is emailed only to an owner with an email;
 * expenses carry their receipt flag; times are in the owner's time zone; the monthly job drafts
 * once per owner and month. Months are counted back from the test clock's month and days are
 * fixed within them (the 10th to the 25th), so the file passes on any date.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let r: ReportingStatementsServices;

const monthPlus = (month: string, n: number) =>
  toIsoDate(addMonths(parseBusinessDate(`${month}-01`), n)).slice(0, 7);
const dayOf = (month: string, day: number) =>
  toIsoDate(addDays(parseBusinessDate(`${month}-01`), day - 1));
const lastOf = (month: string) =>
  toIsoDate(addDays(parseBusinessDate(`${monthPlus(month, 1)}-01`), -1));
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

/** This month (M0) and the three before it, by the test clock in Africa/Accra. */
let M0: string;
let M1: string;
let M2: string;
let M3: string;
let today: string;

let tenantCount = 0;
async function tenantIn(actor: Parameters<TenancyServices['tenants']['create']>[0]) {
  tenantCount += 1;
  return (
    await s.tenants.create(actor, { kind: 'individual', displayName: `Tenant ${tenantCount}` })
  ).tenant.id;
}

async function lease(
  actor: Parameters<TenancyServices['leases']['recordPaper']>[0],
  unitId: string,
  input: { start: string; rentMinor: number; depositMinor?: number },
) {
  return billedLease(ctx, s, b, actor, {
    unitId,
    tenantId: await tenantIn(actor),
    startDate: input.start,
    endDate: toIsoDate(addDays(addMonths(parseBusinessDate(input.start), 12), -1)),
    monthlyRentMinor: input.rentMinor,
    cycle: 'monthly',
    depositMinor: input.depositMinor ?? null,
    signedOn: toIsoDate(addDays(parseBusinessDate(input.start), -1)),
    billingStartDate: input.start,
  });
}

/**
 * The properties were registered long ago and their units' history happened as it reads: the
 * ownership is moved back before the first month the file reports, and so is every unit status
 * event once the leases are running, as a register built at go-live would have them (tests create
 * everything today). Below the application, as an earlier record would be.
 */
const backdateOwnership = (companyId: string) =>
  asSuperuser(
    ctx,
    `update property_ownership set effective_from = $2::date where company_id = $1`,
    [companyId, `${monthPlus(M3, -1)}-01`],
  );
const backdateUnitHistory = (companyId: string) =>
  asSuperuser(
    ctx,
    `update unit_status_event set occurred_at = occurred_at - interval '150 days' where company_id = $1`,
    [companyId],
  );

/**
 * The statement agency: owner A (London, with an email) has two flats, A1 from M3 with a deposit
 * and A2 from M2; owner B (no email) one room from M3; owner C one room from M3, for a statement
 * that will not add up. In M2: A1 pays GH₵3,000 (deposit and M3's rent), A2 pays its month in
 * cash, B and C pay their first month, and A records two expenses, one without a receipt.
 */
let agency: Awaited<ReturnType<typeof statementAgency>>;
async function statementAgency() {
  const c = await moneyCompany(ctx, s, 'agency', 'Statement Agency');
  const ownerA = (
    await s.owners.create(c.admin, {
      kind: 'individual',
      displayName: 'Owner A',
      email: 'owner-a@test.invalid',
      timeZone: 'Europe/London',
    })
  ).id;
  const ownerB = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner B' }))
    .id;
  const ownerC = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner C' }))
    .id;
  const propA = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'STA',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const propB = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'STB',
    ownerId: ownerB,
    units: [{ unitType: 'single_room', count: 1 }],
  });
  const propC = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'STC',
    ownerId: ownerC,
    units: [{ unitType: 'single_room', count: 1 }],
  });
  await backdateOwnership(c.companyId);
  const [a1, a2] = Object.values(propA.units) as [string, string];
  const A1 = await lease(c.manager, a1, {
    start: `${M3}-01`,
    rentMinor: 100_000,
    depositMinor: 200_000,
  });
  const A2 = await lease(c.manager, a2, { start: `${M2}-01`, rentMinor: 150_000 });
  const B1 = await lease(c.manager, Object.values(propB.units)[0]!, {
    start: `${M3}-01`,
    rentMinor: 80_000,
  });
  const C1 = await lease(c.manager, Object.values(propC.units)[0]!, {
    start: `${M3}-01`,
    rentMinor: 50_000,
  });
  // The leases start holding their units (tenancy.lease-transitions), then history moves back.
  await s.lifecycle.runTransitions(c.companyId, today);
  await backdateUnitHistory(c.companyId);
  const p1 = await b.money.recordProviderPayment(c.companyId, {
    leaseId: A1.id,
    amountMinor: 300_000,
    receivedOn: dayOf(M2, 10),
  });
  await approvedCash(ctx, s, b, c.manager, c.admin, {
    leaseId: A2.id,
    amountMinor: 150_000,
    receivedOn: dayOf(M2, 12),
  });
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: B1.id,
    amountMinor: 80_000,
    receivedOn: dayOf(M2, 11),
  });
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: C1.id,
    amountMinor: 50_000,
    receivedOn: dayOf(M2, 11),
  });
  const noReceipt = await m.expenses.record(c.accountant, {
    propertyId: propA.propertyId,
    category: 'repairs',
    supplierName: 'Nii Plumbing',
    amountMinor: 5_000,
    expenseDate: dayOf(M2, 15),
    paidBy: 'owner',
  });
  const withReceipt = await m.expenses.record(c.accountant, {
    propertyId: propA.propertyId,
    category: 'insurance',
    supplierName: 'Star Assurance',
    amountMinor: 7_000,
    expenseDate: dayOf(M2, 16),
    paidBy: 'owner',
    receiptUploadId: await uploadEvidence(ctx, (i) => m.expenses.createUpload(c.accountant, i)),
  });
  const books = await system(c.companyId, async (tx) => {
    const rows = await tx.execute<{ owner_id: string; id: string }>(
      sql`select owner_id, id from book where owner_id is not null`,
    );
    return new Map(rows.rows.map((row) => [row.owner_id, row.id]));
  });
  return {
    ...c,
    ownerA,
    ownerB,
    ownerC,
    propA: propA.propertyId,
    propB: propB.propertyId,
    propC: propC.propertyId,
    leases: { A1: A1.id, A2: A2.id, B1: B1.id, C1: C1.id },
    p1: p1.paymentId,
    expenses: { noReceipt: noReceipt.expenseId, withReceipt: withReceipt.expenseId },
    books,
  };
}

/** A's M2 statement once issued, shared by the tests that read it. */
let issuedA: OwnerStatementDetailView;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  const t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  r = reportingStatementsServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  M0 = today.slice(0, 7);
  M1 = monthPlus(M0, -1);
  M2 = monthPlus(M0, -2);
  M3 = monthPlus(M0, -3);
  agency = await statementAgency();
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-04 owner statements regenerate identically', () => {
  it('drafts a past month from the ledger and issues it: figures frozen, the month locked', async () => {
    const draft = await r.statements.draft(agency.manager, { ownerId: agency.ownerA, month: M2 });
    expect(draft.status).toBe('draft');
    expect(draft.matchesIssued).toBeNull();
    expect(draft.actions).toEqual({ issue: true, regenerate: true });
    const f = draft.figures;
    expect(f.firstDay).toBe(`${M2}-01`);
    expect(f.lastDay).toBe(lastOf(M2));
    expect(f.properties.map((p) => p.propertyId)).toEqual([agency.propA]);
    const page = f.properties[0]!;
    // Cash: A1's GH₵3,000 by the provider, A2's GH₵1,500 in cash; the two expenses.
    expect(page.cash.collectionsByMethod.test).toBe(300_000);
    expect(page.cash.collectionsByMethod.cash).toBe(150_000);
    expect(page.cash.collectionsMinor).toBe(450_000);
    expect(page.cash.expensesByCategory).toEqual([
      { category: 'insurance', amountMinor: 7_000 },
      { category: 'repairs', amountMinor: 5_000 },
    ]);
    expect(page.cash.rentTaxAccruedMinor).toBe(8_000 + 12_000);
    // Accrual at the month's end: M2's rent earned on both flats; A1's M2 rent still owed.
    expect(page.accrual.rentEarnedMinor).toBe(100_000 + 150_000);
    expect(page.accrual.depositsHeldMinor).toBe(200_000);
    expect(page.accrual.unearnedMinor).toBe(0);
    expect(page.accrual.arrearsMinor).toBe(100_000);
    expect(page.accrual.arrearsByBucket[ageBucket(`${M2}-01`, lastOf(M2))!]).toBe(100_000);
    // Occupancy from the units' history at the month's end.
    expect(page.occupancy).toMatchObject({ units: 2, occupied: 2, vacant: 0 });
    // An agency's owner: the agent's side, and the rent tax payable rolled forward.
    expect(f.agent).not.toBeNull();
    expect(f.agent!.graPaidBy).toBe('owner');
    expect(f.rentTaxPayable).toEqual({
      openingMinor: 0,
      accruedMinor: 20_000,
      paidMinor: 0,
      certifiedMinor: 0,
      closingMinor: 20_000,
    });
    expect(f.checks.every((c) => c.passed)).toBe(true);

    const issued = await r.statements.issue(agency.manager, draft.id);
    expect(issued.status).toBe('issued');
    expect(issued.issuedBy?.personId).toBe(agency.manager.personId);
    expect(issued.matchesIssued).toBe(true);
    expect(issued.actions).toEqual({ issue: false, regenerate: false });
    expect(issued.figures).toEqual(f);
    const stored = await statementRecords(ctx, agency.companyId, draft.id);
    expect(stored.figures).toEqual(flattenStatementFigures(issued.figures));
    expect(stored.locks).toEqual([{ month: `${M2}-01`, source: 'owner_statement' }]);
    expect(stored.row!.render_request_id).not.toBeNull();
    issuedA = issued;
  });

  it('★ gives the issued figures again after later corrections, which land in the open month', async () => {
    // A payment received in the locked month, recorded now: its accounting date is M1's first day.
    const late = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: agency.leases.A1,
      amountMinor: 100_000,
      receivedOn: dayOf(M2, 20),
    });
    // An expense dated in the locked month, recorded now, likewise.
    const lateExpense = await m.expenses.record(agency.accountant, {
      propertyId: agency.propA,
      category: 'cleaning',
      supplierName: 'Bright Cleaners',
      amountMinor: 3_000,
      expenseDate: dayOf(M2, 25),
      paidBy: 'owner',
    });
    // The first payment reversed during M1: approved with the clock moved there, then back.
    const requestId = await b.money.requestReversal(agency.accountant, agency.p1, {
      reason: 'wrong_entry',
      note: 'Recorded against the wrong tenancy',
      moneyNowIn: 'provider',
    });
    const saved = ctx.clock.now();
    try {
      ctx.clock.set(new Date(`${dayOf(M1, 15)}T12:00:00Z`));
      await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
    } finally {
      ctx.clock.set(saved);
    }
    const dates = await system(agency.companyId, async (tx) => ({
      payment: (
        await tx.execute<{ accounting_date: string; value_date: string }>(
          sql`select p.accounting_date::text, e.value_date::text from payment p
              join journal_entry e on e.id = p.entry_id where p.id = ${late.paymentId}::uuid`,
        )
      ).rows[0]!,
      expense: (
        await tx.execute<{ accounting_date: string }>(
          sql`select accounting_date::text from expense where id = ${lateExpense.expenseId}::uuid`,
        )
      ).rows[0]!,
      reversal: (
        await tx.execute<{ accounting_date: string }>(
          sql`select accounting_date::text from payment_reversal where payment_id = ${agency.p1}::uuid`,
        )
      ).rows[0]!,
    }));
    expect(dates.payment).toEqual({ accounting_date: `${M1}-01`, value_date: dayOf(M2, 20) });
    expect(dates.expense.accounting_date).toBe(`${M1}-01`);
    expect(dates.reversal.accounting_date).toBe(dayOf(M1, 15));

    // The issued month, worked out again: identical, figure for figure.
    const again = await r.statements.get(agency.admin, issuedA.id);
    expect(again.matchesIssued).toBe(true);
    expect(again.figures).toEqual(issuedA.figures);
    await expect(
      r.statements.draft(agency.manager, { ownerId: agency.ownerA, month: M2 }),
    ).rejects.toMatchObject({ status: 409, code: 'statement_issued' });

    // The corrections show in the open month's statement instead.
    const next = await r.statements.draft(agency.manager, { ownerId: agency.ownerA, month: M1 });
    const page = next.figures.properties.find((p) => p.propertyId === agency.propA)!;
    expect(page.cash.collectionsByMethod.test).toBe(100_000 - 300_000);
    expect(page.cash.collectionsByMethod.cash).toBe(0);
    expect(page.cash.expensesByCategory).toEqual([{ category: 'cleaning', amountMinor: 3_000 }]);
    expect(page.accrual.depositsHeldMinor).toBe(0);
    expect(next.figures.rentTaxPayable!.openingMinor).toBe(20_000);
    expect(next.expenses.map((e) => e.id)).toEqual([lateExpense.expenseId]);
    expect(next.figures.checks.every((c) => c.passed)).toBe(true);
  });
});

describe('AC-04 ★ the rent tax on a statement is the tax on each receipt', () => {
  it('equals the sum of the month’s receipt tax items, and the rent tax in the ledger', async () => {
    const items = await system(agency.companyId, (tx) =>
      tx.execute<{ total: string; n: number }>(
        sql`select coalesce(sum(tax_minor), 0)::bigint as total, count(*)::int as n
            from rent_tax_item where owner_id = ${agency.ownerA}::uuid
              and accounting_date between ${`${M2}-01`}::date and ${lastOf(M2)}::date`,
      ),
    );
    expect(items.rows[0]!.n).toBe(2);
    const ledger = await journalSum(
      ctx,
      agency.companyId,
      `l.account_code = '5300' and l.book_id = $1 and e.accounting_date between $2::date and $3::date`,
      [agency.books.get(agency.ownerA)!, `${M2}-01`, lastOf(M2)],
    );
    expect(issuedA.figures.summary.cash.rentTaxAccruedMinor).toBe(Number(items.rows[0]!.total));
    expect(issuedA.figures.summary.cash.rentTaxAccruedMinor).toBe(ledger);
    const checks = issuedA.figures.checks.filter((c) => c.name === 'rent_tax_receipts');
    expect(checks.map((c) => c.scope).sort()).toEqual([agency.propA, 'owner'].sort());
    expect(checks.every((c) => c.passed && c.actualMinor === 20_000)).toBe(true);
  });

  it('nets a receipt’s reversal against it in the month the reversal is reported', async () => {
    const next = (
      await r.statements.list(agency.manager, { ownerId: agency.ownerA, month: M1 })
    )[0]!;
    const detail = await r.statements.get(agency.manager, next.id);
    // The late payment's tax (8,000) and the first payment's tax reversed (−8,000).
    expect(detail.figures.summary.cash.rentTaxAccruedMinor).toBe(0);
    expect(
      detail.figures.checks.filter((c) => c.name === 'rent_tax_receipts').every((c) => c.passed),
    ).toBe(true);
  });
});

describe('AC-04 ★ an owner never sees another owner’s statement', () => {
  it('shows an owner’s user and their adviser only their owner’s statements and figures', async () => {
    const issuedB = await r.statements.issue(
      agency.manager,
      (await r.statements.draft(agency.manager, { ownerId: agency.ownerB, month: M2 })).id,
    );
    const ownerUser = await staffIn(ctx, agency.companyId, 'agency', 'owner', 'Owner A user', {
      owners: [agency.ownerA],
    });
    const adviser = await staffIn(ctx, agency.companyId, 'agency', 'adviser', 'A’s adviser', {
      owners: [agency.ownerA],
    });
    for (const reader of [ownerUser, adviser]) {
      const listed = await r.statements.list(reader);
      expect(listed.length).toBeGreaterThanOrEqual(2);
      expect(listed.every((x) => x.owner.id === agency.ownerA)).toBe(true);
      // The positive case: their own issued statement, complete and still matching.
      const own = await r.statements.get(reader, issuedA.id);
      expect(own.figures).toEqual(issuedA.figures);
      expect(own.matchesIssued).toBe(true);
      await expect(r.statements.get(reader, issuedB.id)).rejects.toMatchObject({ status: 404 });
      await expect(r.statements.document(reader, issuedB.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        r.statements.draft(reader, { ownerId: agency.ownerA, month: M2 }),
      ).rejects.toMatchObject({ status: 403 });
      // The database's own owner scope: their session reads their owner's rows only.
      const seen = await withCompany(ctx.database, staffContext(reader), async (tx) => ({
        statements: (
          await tx.execute<{ owner_id: string }>(sql`select owner_id from owner_statement`)
        ).rows,
        figures: (
          await tx.execute<{ owner_id: string }>(sql`select owner_id from owner_statement_figure`)
        ).rows,
      }));
      expect(seen.statements.length).toBeGreaterThan(0);
      expect(seen.figures.length).toBeGreaterThan(0);
      expect([...seen.statements, ...seen.figures].every((x) => x.owner_id === agency.ownerA)).toBe(
        true,
      );
    }
  });

  it('lets a manager scoped to all of owner B’s properties see B’s only, and refuses a caretaker', async () => {
    const managerB = await staffIn(
      ctx,
      agency.companyId,
      'agency',
      'property_manager',
      'Manager B',
      { properties: [agency.propB] },
    );
    const listed = await r.statements.list(managerB);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((x) => x.owner.id === agency.ownerB)).toBe(true);
    await expect(r.statements.get(managerB, issuedA.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      r.statements.draft(managerB, { ownerId: agency.ownerA, month: M1 }),
    ).rejects.toMatchObject({ status: 404 });
    const caretaker = await staffIn(ctx, agency.companyId, 'agency', 'caretaker', 'Caretaker A', {
      properties: [agency.propA],
    });
    await expect(r.statements.list(caretaker)).rejects.toMatchObject({ status: 403 });
    await expect(r.statements.get(caretaker, issuedA.id)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps an issued statement whole for its owner after the property changes hands (decision 15)', async () => {
    const [issuedB] = await r.statements.list(agency.manager, {
      ownerId: agency.ownerB,
      month: M2,
    });
    const ownerUserB = await staffIn(ctx, agency.companyId, 'agency', 'owner', 'Owner B user', {
      owners: [agency.ownerB],
    });
    const before = await r.statements.get(ownerUserB, issuedB!.id);
    expect(before.figures.properties.map((p) => p.propertyId)).toEqual([agency.propB]);
    // B's room passes to owner G from today (no transfer flow yet: below the application).
    const ownerG = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner G' })
    ).id;
    await asSuperuser(
      ctx,
      `insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from)
       values ($1, $2, $3, 10000, $4::date)`,
      [agency.companyId, agency.propB, ownerG, today],
    );
    // B's own session no longer reaches the room's lines; B's statement is still all there.
    const linesSeen = await withCompany(ctx.database, staffContext(ownerUserB), (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from journal_line where property_id = ${agency.propB}::uuid`,
      ),
    );
    expect(linesSeen.rows[0]!.n).toBe(0);
    const after = await r.statements.get(ownerUserB, issuedB!.id);
    expect(after.figures).toEqual(before.figures);
    expect(after.matchesIssued).toBe(true);
  });
});

describe('AC-04 issuing a statement', () => {
  it('refuses a month not over, a second issue, and a statement that does not add up', async () => {
    await expect(
      r.statements.draft(agency.manager, { ownerId: agency.ownerA, month: M0 }),
    ).rejects.toMatchObject({ status: 409, code: 'month_not_over' });
    await expect(r.statements.issue(agency.accountant, issuedA.id)).rejects.toMatchObject({
      status: 409,
      code: 'statement_issued',
    });
    // Owner C's receipt tax no longer matches the ledger's rent tax (changed below the app).
    const draftC = await r.statements.draft(agency.manager, { ownerId: agency.ownerC, month: M2 });
    expect(draftC.figures.checks.every((c) => c.passed)).toBe(true);
    await asSuperuser(
      ctx,
      `update rent_tax_item set tax_minor = tax_minor + 1 where owner_id = $1`,
      [agency.ownerC],
    );
    const broken = await r.statements.get(agency.manager, draftC.id);
    expect(broken.figures.checks.filter((c) => !c.passed).map((c) => c.name)).toContain(
      'rent_tax_receipts',
    );
    await expect(r.statements.issue(agency.manager, draftC.id)).rejects.toMatchObject({
      status: 409,
      code: 'statement_unbalanced',
    });
    const record = await statementRecords(ctx, agency.companyId, draftC.id);
    expect(record.row!.status).toBe('draft');
    expect(record.figures).toEqual([]);
    expect(record.locks).toEqual([]);
  });

  it('is for Growth only: a Starter company is refused', async () => {
    const starter = await moneyCompany(ctx, s, 'agency', 'Starter Statements');
    await asSuperuser(ctx, `update company set interim_plan = 'starter' where id = $1`, [
      starter.companyId,
    ]);
    await expect(r.statements.list(starter.admin)).rejects.toMatchObject({
      status: 403,
      code: 'not_on_plan',
    });
    expect(await r.statements.draftLastMonth(starter.companyId)).toEqual({
      month: null,
      drafted: 0,
    });
  });
});

describe('AC-04 the issued PDF and its delivery', () => {
  it('records the PDF’s hash once rendered, and emails it to an owner with an email only', async () => {
    const [statementB] = await r.statements.list(agency.manager, {
      ownerId: agency.ownerB,
      month: M2,
    });
    for (const id of [issuedA.id, statementB!.id])
      await expect(r.statements.document(agency.manager, id)).rejects.toMatchObject({
        status: 409,
        code: 'statement_rendering',
      });
    const recordA = await statementRecords(ctx, agency.companyId, issuedA.id);
    const recordB = await statementRecords(ctx, agency.companyId, statementB!.id);
    for (const record of [recordA, recordB]) {
      await s.documents.renderRequested(
        agency.companyId,
        record.row!.render_request_id!,
        async () => SAMPLE_PDF,
      );
      expect(
        await r.statements.onDocumentRendered(agency.companyId, record.row!.render_request_id!),
      ).toBe(true);
      // Idempotent: the hook again changes nothing.
      expect(
        await r.statements.onDocumentRendered(agency.companyId, record.row!.render_request_id!),
      ).toBe(false);
    }
    const afterA = await statementRecords(ctx, agency.companyId, issuedA.id);
    const afterB = await statementRecords(ctx, agency.companyId, statementB!.id);
    const rendered = await system(agency.companyId, (tx) =>
      s.documents.renderedDocument(tx, afterA.row!.render_request_id!),
    );
    expect(afterA.row!.document_id).toBe(rendered!.documentId);
    expect(afterA.row!.sha256).toBe(rendered!.sha256);
    expect(afterA.row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(afterA.row!.delivered_at).not.toBeNull();
    expect(afterB.row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(afterB.row!.delivered_at).toBeNull();
    const sends = (await outboxOf(ctx, agency.companyId, 'messaging.send')).map(
      (e) =>
        e.payload as {
          recipient: { type: string; ownerId?: string };
          channels: string[];
          document?: { documentId: string; filename: string };
        },
    );
    // Messages to an owner in the register (the M4b recipient), whatever else the agency sent.
    const toOwners = sends.filter((p) => p.recipient.ownerId !== undefined);
    expect(toOwners).toHaveLength(1);
    expect(toOwners[0]!.recipient.ownerId).toBe(agency.ownerA);
    expect(toOwners[0]!.channels).toEqual(['email']);
    expect(toOwners[0]!.document).toEqual({
      documentId: rendered!.documentId,
      filename: `owner-statement-${M2}.pdf`,
    });
    const viewA = await r.statements.get(agency.manager, issuedA.id);
    expect(viewA.sha256).toBe(rendered!.sha256);
    expect(viewA.deliveredAt).toBeInstanceOf(Date);
    const link = await r.statements.document(agency.manager, issuedA.id);
    expect(link.url).toMatch(/^(memory|https?):\/\//);
  });

  it('shows times in the owner’s time zone, named, and flags expenses with no receipt', async () => {
    const view = await r.statements.get(agency.manager, issuedA.id);
    expect(view.ownerTimeZone).toBe('Europe/London');
    expect(view.companyTimeZone).toBe('Africa/Accra');
    const flags = Object.fromEntries(view.expenses.map((e) => [e.id, e.noReceipt]));
    expect(flags).toEqual({
      [agency.expenses.noReceipt]: true,
      [agency.expenses.withReceipt]: false,
    });
    const record = await statementRecords(ctx, agency.companyId, issuedA.id);
    const rendered = await system(agency.companyId, (tx) =>
      s.documents.renderedDocument(tx, record.row!.render_request_id!),
    );
    expect(rendered!.templateKey).toBe(OWNER_STATEMENT_TEMPLATE.key);
    const html = renderHtml(
      templates.get(OWNER_STATEMENT_TEMPLATE.key, OWNER_STATEMENT_TEMPLATE.version),
      rendered!.data,
      { senderName: 'Statement Agency', primaryColour: '#0F766E', accentColour: '#F59E0B' },
    );
    expect(html).toContain('(Europe/London)');
    expect(html).toContain('(Africa/Accra)');
    expect(html).toContain('No receipt');
    expect(html).toContain('Owner A');
  });
});

describe('AC-04 the agent’s side reads fees, remittances and funding from the ledger', () => {
  it('rolls the agent’s cash and the fees due forward, and holds back rent tax when the agency pays GRA', async () => {
    // Owner F: a room let from M3 and paid to M2 in M2 (rent tax 8,000). Then, as the fee,
    // remittance and funding records will post them (P14, P16, P30): the owner sends GH₵500 for
    // bills, a GH₵100 fee is charged, and the agent pays the owner GH₵200 keeping GH₵60 of fees.
    const ownerF = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner F' })
    ).id;
    const propF = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'STF',
      ownerId: ownerF,
      units: [{ unitType: 'single_room', count: 1 }],
    });
    await backdateOwnership(agency.companyId);
    const leaseF = await lease(agency.manager, Object.values(propF.units)[0]!, {
      start: `${M3}-01`,
      rentMinor: 50_000,
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: leaseF.id,
      amountMinor: 100_000,
      receivedOn: dayOf(M2, 10),
    });
    await system(agency.companyId, async (tx) => {
      const bookId = (
        await tx.execute<{ id: string }>(sql`select id from book where owner_id = ${ownerF}::uuid`)
      ).rows[0]!.id;
      const post = (rule: 'P14' | 'P16' | 'P30', day: number, lines: JournalLineDraft[]) => {
        const id = uuidv7();
        return b.posting.post(tx, {
          companyId: agency.companyId,
          rule,
          key: `${rule}:${id}`,
          valueDate: dayOf(M2, day),
          lines,
          record: { type: 'statement_test', id },
        });
      };
      await post('P30', 5, ownerFundingLines({ bookId, amountMinor: 50_000 }));
      await post(
        'P14',
        11,
        managementFeeLines({ bookId, dims: { propertyId: propF.propertyId }, amountMinor: 10_000 }),
      );
      await post(
        'P16',
        20,
        remittanceLines({ bookId, totalMinor: 26_000, netMinor: 20_000, feesRetainedMinor: 6_000 }),
      );
      await tx.execute(
        sql`insert into management_fee_terms (company_id, owner_id, kind, gra_paid_by, effective_from)
            values (${agency.companyId}::uuid, ${ownerF}::uuid, 'none', 'agency', ${`${M3}-01`}::date)`,
      );
    });
    const draft = await r.statements.draft(agency.manager, { ownerId: ownerF, month: M2 });
    const a = draft.figures.agent!;
    expect(a.openingMinor).toBe(0);
    expect(a.in.owner_funding).toBe(50_000);
    expect(a.out.fees_taken).toBe(6_000);
    expect(a.out.remittances).toBe(20_000);
    expect(a.closingMinor).toBe(24_000);
    expect(a.feesChargedMinor).toBe(10_000);
    expect(a.feesDueClosingMinor).toBe(4_000);
    expect(a.graPaidBy).toBe('agency');
    expect(draft.figures.rentTaxPayable!.closingMinor).toBe(8_000);
    expect(a.rentTaxHeldBackMinor).toBe(8_000);
    expect(a.netRemittableMinor).toBe(24_000 - 8_000 - 4_000);
    expect(a.remittancesMadeMinor).toBe(20_000);
    expect(draft.figures.properties[0]!.cash.feesMinor).toBe(10_000);
    expect(draft.figures.checks.every((c) => c.passed)).toBe(true);
    const issued = await r.statements.issue(agency.accountant, draft.id);
    expect(issued.matchesIssued).toBe(true);
    expect(issued.figures.agent).toEqual(a);
  });
});

describe('AC-04 the monthly drafting job', () => {
  it('drafts last month once for every owner with a book', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Drafting Agency');
    for (const name of ['Owner D', 'Owner E'])
      await s.owners.create(c.admin, { kind: 'individual', displayName: name });
    expect(await r.statements.draftLastMonth(c.companyId)).toEqual({ month: M1, drafted: 2 });
    expect(await r.statements.draftLastMonth(c.companyId)).toEqual({ month: M1, drafted: 0 });
    const listed = await r.statements.list(c.admin);
    expect(listed.map((x) => [x.month, x.status])).toEqual([
      [M1, 'draft'],
      [M1, 'draft'],
    ]);
  });
});
