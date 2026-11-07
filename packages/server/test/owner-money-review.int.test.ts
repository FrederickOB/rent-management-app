import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockCounters, lockLeases, leaseGroup, paymentsByIds } from '../src/billing/records';
import { staffContext } from '../src/policy/policy.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import {
  feeTermsFrom,
  reportingMoneyServices,
  type ReportingMoneyServices,
} from './support/reporting-money';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M9 review's owner money and billing findings against the real database with RLS on:
 * - an empty owner scope sees no owner (must-fix 2): in the database and in the services;
 * - a remittance, fees taken or owner funding reversed (P21a, #8);
 * - the remittance suggestion's proposal, fees over-taken flagged, and tax withheld left out of
 *   the hold-back (#9);
 * - F3 for remittances under the owner's lock;
 * - fixed fees: co-owned properties shown and not charged, and no fixed fee in a month that
 *   began under percentage terms;
 * - early money on a renewal that P29 already carried a deposit to, and matched money (#7).
 * Every test makes its own company; dates are counted from the test clock.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let r: ReportingMoneyServices;
let today: string;
const DAY = 86_400_000;
const LONG_AGO = '2024-01-01';

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

type Agency = Awaited<ReturnType<typeof moneyCompany>> & {
  ownerId: string;
  bookId: string;
  propertyId: string;
  units: string[];
  next: number;
};

let partCount = 0;
async function agency(
  name: string,
  terms: Parameters<typeof feeTermsFrom>[3] | null,
  options: { use?: 'commercial' } = {},
): Promise<Agency> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  partCount += 1;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `Q${String(partCount).padStart(2, '0')}`,
    ownerId,
    ...(options.use ? { use: options.use } : {}),
    units: [
      options.use === 'commercial'
        ? { unitType: 'office', count: 4 }
        : { unitType: 'apartment', count: 4, bedrooms: 2 },
    ],
  });
  await asSuperuser(
    ctx,
    `update property_ownership set effective_from = $2::date where company_id = $1`,
    [c.companyId, LONG_AGO],
  );
  if (terms) await feeTermsFrom(ctx, c.companyId, ownerId, terms, LONG_AGO);
  const [book] = await system(c.companyId, (tx) =>
    tx
      .select({ id: schema.book.id })
      .from(schema.book)
      .where(sql`owner_id = ${ownerId}`),
  );
  return {
    ...c,
    ownerId,
    bookId: book!.id,
    propertyId: property.propertyId,
    units: Object.values(property.units),
    next: 0,
  };
}

let tenantCount = 0;
async function lease(
  c: Agency,
  input: { start: string; rent?: number; deposit?: number; company?: boolean },
) {
  tenantCount += 1;
  const tenantId = (
    await s.tenants.create(
      c.manager,
      input.company
        ? {
            kind: 'company',
            displayName: `Review Co ${tenantCount}`,
            legalName: `Review Co ${tenantCount} Limited`,
          }
        : { kind: 'individual', displayName: `Review Tenant ${tenantCount}` },
    )
  ).tenant.id;
  return billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId,
    startDate: input.start,
    endDate: endAfter(input.start, 12),
    monthlyRentMinor: input.rent ?? 100_000,
    depositMinor: input.deposit ?? null,
    cycle: 'monthly',
    ...(input.company ? { use: 'commercial' as const } : {}),
    signedOn: plusDays(input.start, -1),
    billingStartDate: input.start,
  });
}

const intoAgency = (c: Agency, leaseId: string, amountMinor: number) =>
  approvedTransfer(ctx, s, b, c.manager, c.accountant, {
    leaseId,
    receivedInto: 'agency_account',
    amountMinor,
    receivedOn: today,
    senderReference: 'REVIEW',
  });

const proof = (actor: Parameters<ReportingMoneyServices['money']['createUpload']>[0]) =>
  uploadEvidence(ctx, (i) => r.money.createUpload(actor, i));

const bookAccount = (c: Agency, account: string) =>
  journalSum(ctx, c.companyId, `l.book_id = $1 and l.account_code = $2`, [c.bookId, account]);

function chargeback(companyId: string, leaseId: string, paymentId: string) {
  return system(companyId, async (tx) => {
    const leases = await leaseGroup(tx, leaseId);
    await lockLeases(tx, companyId, leases);
    await lockCounters(tx, companyId);
    const [payment] = await paymentsByIds(tx, [paymentId]);
    const states = [];
    for (const id of leases) states.push(await b.engine.load(tx, companyId, id));
    return b.engine.reverse(tx, states, payment!, {
      reason: 'chargeback',
      note: 'Charged back at the provider',
      moneyNowIn: 'provider',
      approvalRequestId: null,
      requestedBy: null,
      today,
    });
  });
}

const tenPercent = { kind: 'percentage' as const, rateBps: 1000 };

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  r = reportingMoneyServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-02 an empty owner scope sees no owner (M9 review, must-fix 2)', () => {
  it('★ an adviser or client owner whose scope is not saved sees nobody’s money, statements or fee terms', async () => {
    const c = await agency('Scope Empty', tenPercent);
    const l = await lease(c, { start: monthStart(today) });
    await intoAgency(c, l.id, 100_000);
    const { id } = await r.money.takeFees(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      amountMinor: 1_000,
    });
    const adviser = await staffIn(ctx, c.companyId, 'agency', 'adviser', 'Scope adviser');
    const client = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Scope client');
    for (const who of [adviser, client]) {
      expect(await r.money.list(who, {})).toEqual([]);
      await expect(r.money.get(who, id)).rejects.toMatchObject({ status: 404 });
      await expect(r.money.suggestion(who, c.ownerId)).rejects.toMatchObject({ status: 404 });
      await expect(r.money.feeTerms(who, c.ownerId)).rejects.toMatchObject({ status: 404 });
      // The database agrees, whatever a query forgets to filter (0054).
      const seen = await withCompany(ctx.database, staffContext(who), async (tx) => ({
        remittances: (await tx.select().from(schema.remittance)).length,
        terms: (await tx.select().from(schema.managementFeeTerms)).length,
        fees: (await tx.select().from(schema.managementFee)).length,
        allocationFees: (await tx.select().from(schema.allocationFee)).length,
      }));
      expect(seen).toEqual({ remittances: 0, terms: 0, fees: 0, allocationFees: 0 });
    }
    // The positive case: with the owner in scope, the adviser sees it.
    const scoped = await staffIn(ctx, c.companyId, 'agency', 'adviser', 'Scoped adviser', {
      owners: [c.ownerId],
    });
    expect((await r.money.list(scoped, {})).map((x) => x.id)).toEqual([id]);
  });

  it('refuses another owner’s proof, even by its id', async () => {
    const c = await agency('Scope Proof', tenPercent);
    const l = await lease(c, { start: monthStart(today) });
    await intoAgency(c, l.id, 100_000);
    const { id } = await r.money.remit(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'bank',
      reference: 'GCB 1',
      proofUploadId: await proof(c.accountant),
      netMinor: 50_000,
      feesRetainedMinor: 0,
    });
    const other = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Scope Proof other' })
    ).id;
    const otherUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Proof other user', {
      owners: [other],
    });
    await expect(r.money.proofUrl(otherUser, id)).rejects.toMatchObject({ status: 404 });
    const ownUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Proof own user', {
      owners: [c.ownerId],
    });
    expect((await r.money.proofUrl(ownUser, id)).url).toBeTruthy();
  });
});

describe('AC-05 owner money corrections and the suggestion (M9 review #8, #9, F3)', () => {
  it('★ reverses a remittance (P21a): the money and the fees go back, the record shows it, once', async () => {
    const c = await agency('Reverse Remit', tenPercent);
    const l = await lease(c, { start: monthStart(today) });
    await intoAgency(c, l.id, 100_000);
    const { id } = await r.money.remit(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'bank',
      reference: 'GCB 2',
      proofUploadId: await proof(c.accountant),
      netMinor: 90_000,
      feesRetainedMinor: 10_000,
    });
    expect(await bookAccount(c, '1070')).toBe(0);
    await r.money.reverse(c.manager, { id, reason: 'Recorded against the wrong owner' });
    expect(await bookAccount(c, '1070')).toBe(100_000);
    expect(await bookAccount(c, '2300')).toBe(-10_000);
    expect(await journalSum(ctx, c.companyId, `e.idempotency_key = $1`, [`P21:${id}`])).toBe(0);
    expect((await r.money.get(c.manager, id)).reversed).toMatchObject({
      on: today,
      reason: 'Recorded against the wrong owner',
      byName: 'Reverse Remit manager',
    });
    await expect(r.money.reverse(c.manager, { id, reason: 'Again' })).rejects.toMatchObject({
      status: 409,
      code: 'owner_money_reversed',
    });
    // Owners read but never reverse.
    const ownUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Reverse own user', {
      owners: [c.ownerId],
    });
    await expect(r.money.reverse(ownUser, { id, reason: 'No' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses to reverse owner funding the agent has already spent (F3)', async () => {
    const c = await agency('Reverse Funding', null);
    const { id } = await r.money.fund(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'momo',
      reference: 'TOPUP',
      proofUploadId: await proof(c.accountant),
      amountMinor: 50_000,
    });
    const l = await lease(c, { start: monthStart(today) });
    void l;
    // The agent pays GH₵300 of it out on the owner's behalf.
    await r.money.remit(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'bank',
      reference: 'BACK',
      proofUploadId: await proof(c.accountant),
      netMinor: 30_000,
      feesRetainedMinor: 0,
    });
    await expect(r.money.reverse(c.manager, { id, reason: 'Never arrived' })).rejects.toMatchObject(
      { status: 409, code: 'insufficient_agent_cash' },
    );
    expect(await bookAccount(c, '1070')).toBe(20_000);
  });

  it('proposes a remittance, fees taken on their own, or nothing to remit; flags fees over-taken', async () => {
    const c = await agency('Suggest Proposal', tenPercent);
    expect(await r.money.suggestion(c.manager, c.ownerId)).toMatchObject({
      proposal: 'nothing',
      netMinor: 0,
      feesOverTakenMinor: 0,
    });
    const l = await lease(c, { start: monthStart(today) });
    const paid = await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    // The rent went to the owner's account: the agent holds none of it, but the fee is due.
    expect(await r.money.suggestion(c.manager, c.ownerId)).toMatchObject({
      proposal: 'nothing',
      feesDueMinor: 10_000,
    });
    // GH₵50 of the owner's money with the agent: fees due take all of it.
    await r.money.fund(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'momo',
      reference: 'TOPUP',
      proofUploadId: await proof(c.accountant),
      amountMinor: 5_000,
    });
    expect(await r.money.suggestion(c.manager, c.ownerId)).toMatchObject({
      proposal: 'take_fees',
      totalMinor: 5_000,
      feesRetainedMinor: 5_000,
      netMinor: 0,
    });
    await r.money.takeFees(c.accountant, { ownerId: c.ownerId, on: today, amountMinor: 5_000 });
    // The payment is charged back: its fee comes back, so more was taken than is now due.
    await chargeback(c.companyId, l.id, paid.paymentId);
    expect(await r.money.suggestion(c.manager, c.ownerId)).toMatchObject({
      feesDueMinor: 0,
      feesOverTakenMinor: 5_000,
      proposal: 'nothing',
    });
  });

  it('★ leaves tax the tenant withheld out of the hold-back when the agency pays GRA (#9)', async () => {
    const c = await agency(
      'Suggest Withheld',
      { ...tenPercent, graPaidBy: 'agency' },
      { use: 'commercial' },
    );
    const start = monthStart(today);
    const l = await lease(c, { start, rent: 1_000_000, company: true });
    await b.invoicing.accrueAll(c.companyId, today);
    const [line] = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${l.id} and kind = 'rent' and period_start = ${start}`),
    );
    await t.withholding.record(c.manager, {
      leaseId: l.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await intoAgency(c, l.id, 850_000);
    const payable = -(await bookAccount(c, '2200'));
    const withheld = await bookAccount(c, '1150');
    expect(withheld).toBe(150_000);
    const suggestion = await r.money.suggestion(c.manager, c.ownerId);
    expect(suggestion).toMatchObject({
      rentTaxWithheldMinor: 150_000,
      rentTaxHeldBackMinor: payable - withheld,
      totalMinor: 850_000 - (payable - withheld),
    });
  });

  it('F3: two remittances at once never take more than the agent holds', async () => {
    const c = await agency('Remit Race', null);
    const l = await lease(c, { start: monthStart(today) });
    await intoAgency(c, l.id, 100_000);
    const remit = async () =>
      r.money.remit(c.accountant, {
        ownerId: c.ownerId,
        on: today,
        method: 'bank',
        reference: 'RACE',
        proofUploadId: await proof(c.accountant),
        netMinor: 70_000,
        feesRetainedMinor: 0,
      });
    const results = await Promise.allSettled([remit(), remit()]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ status: 409, code: 'over_agent_cash' }),
    });
    expect(await bookAccount(c, '1070')).toBe(30_000);
  });
});

describe('AC-02 fixed fees: co-owned properties and a switch of terms (M9 review)', () => {
  it('shows co-owned properties with no fixed fee, and charges no fixed fee in a month that began under percentage terms', async () => {
    const c = await agency('Fixed Gaps', tenPercent);
    // Half of the property passes to another owner (below the application: the register records
    // whole properties only).
    const other = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Fixed Gaps co-owner' })
    ).id;
    await asSuperuser(
      ctx,
      `update property_ownership set share_bps = 5000 where company_id = $1 and property_id = $2`,
      [c.companyId, c.propertyId],
    );
    await asSuperuser(
      ctx,
      `insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from)
       values ($1, $2, $3, 5000, $4::date)`,
      [c.companyId, c.propertyId, other, LONG_AGO],
    );
    expect(await r.money.coOwnedProperties(c.manager, c.ownerId)).toEqual([
      expect.objectContaining({ id: c.propertyId }),
    ]);
    const solo = await agency('Fixed Switch', tenPercent);
    await lease(solo, { start: plusMonths(monthStart(today), -3) });
    await s.lifecycle.runTransitions(solo.companyId, today);
    // Fixed terms from the middle of last month: last month began under percentage terms.
    const lastMonth = plusMonths(monthStart(today), -1);
    await feeTermsFrom(
      ctx,
      solo.companyId,
      solo.ownerId,
      { kind: 'fixed_per_unit', fixedMinor: 5_000 },
      plusDays(lastMonth, 14),
    );
    expect(await r.fees.runFixedFees(solo.companyId, lastMonth.slice(0, 7))).toBe(0);
    // The month after is wholly fixed: charged.
    const thisMonth = today.slice(0, 7);
    const end = plusDays(plusMonths(monthStart(today), 1), -1);
    expect(await on(end, () => r.fees.runFixedFees(solo.companyId, thisMonth))).toBe(1);
  });
});

describe('BC-07 money before billing handles a signing, on a renewal and when matched (M9 review #7)', () => {
  it('★ asks no second deposit of a renewal P29 already carried it to', async () => {
    const c = await agency('Renewal Early Money', null);
    const start = plusMonths(today, -11);
    const end = endAfter(start, 12);
    const old = await lease(c, { start, deposit: 100_000 });
    await intoAgency(c, old.id, 100_000 + 12 * 100_000);
    const renewal = await s.leases.offerRenewal(c.manager, old.id);
    const scan = await uploadLeaseFile(ctx, s, c.manager);
    const staged = await s.documents.stageEvidenceUpload(
      { companyId: c.companyId, personId: c.manager.personId },
      scan,
      { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
    );
    await withCompany(
      ctx.database,
      { companyId: c.companyId, personId: c.manager.personId, actorKind: 'staff' },
      async (tx) => {
        const documentId = await s.documents.recordStagedEvidence(tx, staged, 'lease_scan');
        await s.lifecycle.markSigned(tx, {
          leaseId: renewal.id,
          signedAt: ctx.clock.now(),
          source: 'paper',
          signedDocumentId: documentId,
        });
      },
    );
    // The renewal starts and money arrives before billing has handled its signing.
    const renewalStart = plusDays(end, 1);
    await on(renewalStart, async () => {
      await s.lifecycle.runTransitions(c.companyId, renewalStart);
      await b.money.recordProviderPayment(c.companyId, {
        leaseId: renewal.id,
        amountMinor: 100_000,
        receivedOn: renewalStart,
      });
      await runLeaseEvents(ctx, b, c.companyId);
    });
    const kinds = await system(c.companyId, async (tx) =>
      (await b.engine.load(tx, c.companyId, renewal.id)).lines.map((x) => x.kind),
    );
    expect(kinds).not.toContain('deposit');
    expect(
      -(await journalSum(ctx, c.companyId, `l.lease_id = $1 and l.account_code = '2100'`, [
        renewal.id,
      ])),
    ).toBe(100_000);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('matched money pays the deposit and first month of a lease billing has not handled yet', async () => {
    const c = await agency('Matched Early Money', null);
    const start = plusDays(today, -1);
    const recorded = await s.leases.recordPaper(c.manager, {
      unitId: c.units[c.next++]!,
      tenantId: (
        await s.tenants.create(c.manager, { kind: 'individual', displayName: 'Matched Early' })
      ).tenant.id,
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 50_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Matched Early' }],
      scanUploadId: await uploadLeaseFile(ctx, s, c.manager),
      signedOn: plusDays(today, -3),
      billingStartDate: start,
    });
    await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
      receivedInto: 'agency_account',
      amountMinor: 150_000,
      receivedOn: today,
      senderReference: 'MATCH EARLY',
    });
    const waiting = (await b.read.unmatched(c.manager)).find(
      (u) => u.senderReference === 'MATCH EARLY',
    )!;
    await b.money.match(c.manager, waiting.paymentId, recorded.id);
    expect(
      -(await journalSum(ctx, c.companyId, `l.lease_id = $1 and l.account_code = '2100'`, [
        recorded.id,
      ])),
    ).toBe(100_000);
    expect(
      await journalSum(ctx, c.companyId, `l.lease_id = $1 and l.account_code = '2010'`, [
        recorded.id,
      ]),
    ).toBe(0);
  });
});
