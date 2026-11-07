import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { CallbackAlert, type Alert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockCounters, lockLeases, leaseGroup, paymentsByIds } from '../src/billing/records';
import { agentCashHeld } from '../src/ledger/agent-cash';
import { AgentCashCheckService } from '../src/ledger/agent-cash-check.service';
import { staffContext } from '../src/policy/policy.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import { reportingMoneyServices, type ReportingMoneyServices } from './support/reporting-money';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Founder decision F3 (2026-11-06) against the real database with RLS on: a payment out of an
 * owner's agent-held cash (1070 in the owner's book) never exceeds what the agency holds for the
 * owner. Each path is refused beyond it with the named 409 (INSUFFICIENT_AGENT_CASH), before
 * anything posts and before its file is staged, and accepted once the owner's funding is recorded
 * or within what is held: GRA rent tax (P18), VAT (P33), the early-termination refund (P13), the
 * move-out refund (P12 and P13) and expenses the agent pays (P15, recorded paid or paid later).
 * Two payments at once take turns under the `owner-money:<owner>` lock, so one is refused; a
 * property-limited manager is checked against the owner's whole 1070; and the nightly check
 * alerts when a chargeback, which cannot be refused, leaves 1070 below zero. Every test makes its
 * own company; dates are counted from the test clock, so the file passes on any day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let r: ReportingMoneyServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

const REFUSED = { status: 409, code: 'insufficient_agent_cash' } as const;
const refusedHolding = (heldMinor: number) => ({
  ...REFUSED,
  message: expect.stringMatching(/Record the owner’s funding first/) as unknown as string,
  details: { heldMinor: String(heldMinor) },
});

const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

type Agency = Awaited<ReturnType<typeof moneyCompany>> & {
  ownerId: string;
  bookId: string;
  propertyId: string;
  units: string[];
  next: number;
};

let partCount = 0;
async function agencyWithOwner(
  name: string,
  options: { commercial?: boolean } = {},
): Promise<Agency> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(
      c.admin,
      options.commercial
        ? {
            kind: 'company',
            displayName: `${name} owner`,
            legalName: `${name} owner Limited`,
            vatRegistered: true,
            tin: 'C0098765432',
          }
        : { kind: 'individual', displayName: `${name} owner` },
    )
  ).id;
  partCount += 1;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `K${String(partCount).padStart(2, '0')}`,
    ownerId,
    ...(options.commercial ? { use: 'commercial' as const } : {}),
    units: [
      options.commercial
        ? { unitType: 'shop', count: 4 }
        : { unitType: 'apartment', count: 6, bedrooms: 2 },
    ],
  });
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
  input: {
    start: string;
    rent?: number;
    deposit?: number;
    cycle?: 'monthly' | 'quarterly';
    commercial?: boolean;
    breakCredit?: boolean;
    unitId?: string;
  },
) {
  tenantCount += 1;
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `F3 Tenant ${tenantCount}`,
  });
  return billedLease(ctx, s, b, c.manager, {
    unitId: input.unitId ?? c.units[c.next++]!,
    tenantId: tenant.id,
    startDate: input.start,
    endDate: endAfter(input.start, 12),
    monthlyRentMinor: input.rent ?? 100_000,
    depositMinor: input.deposit ?? null,
    cycle: input.cycle ?? 'monthly',
    ...(input.commercial ? { use: 'commercial' as const } : {}),
    signedOn: input.start <= today ? plusDays(input.start, -1) : today,
    ...(input.start <= today ? { billingStartDate: input.start } : {}),
    ...(input.breakCredit !== undefined
      ? {
          breakClause: {
            fromDate: plusMonths(input.start, 1),
            party: 'tenant' as const,
            noticeDays: 30,
            creditUnusedDays: input.breakCredit,
          },
        }
      : {}),
  });
}

const transfer = (
  c: Agency,
  leaseId: string,
  amountMinor: number,
  receivedOn: string,
  receivedInto: 'owner_account' | 'agency_account',
) =>
  approvedTransfer(ctx, s, b, c.manager, c.accountant, {
    leaseId,
    receivedInto,
    amountMinor,
    receivedOn,
    senderReference: 'F3 TEST',
  });

/** The owner's funding (P30: Dr 1070, Cr 1010), recorded with its proof. */
async function fund(c: Agency, amountMinor: number) {
  return r.money.fund(c.accountant, {
    ownerId: c.ownerId,
    on: today,
    method: 'bank',
    reference: 'OWNER TOPUP',
    proofUploadId: await uploadEvidence(ctx, (i) => r.money.createUpload(c.accountant, i)),
    amountMinor,
  });
}

const agentCash = (c: Agency) =>
  journalSum(ctx, c.companyId, `l.book_id = $1 and l.account_code = '1070'`, [c.bookId]);

const bookAccount = (c: Agency, account: string) =>
  journalSum(ctx, c.companyId, `l.book_id = $1 and l.account_code = $2`, [c.bookId, account]);

/** Entries of a rule with a line in the owner's book. */
async function entriesOf(c: Agency, rule: string): Promise<number> {
  const rows = await system(c.companyId, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from journal_entry e where e.rule = ${rule}
          and exists (select 1 from journal_line l where l.entry_id = e.id and l.book_id = ${c.bookId}::uuid)`,
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function entryKeyed(c: Agency, key: string): Promise<number> {
  const rows = await system(c.companyId, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from journal_entry where idempotency_key = ${key}`,
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function rowsIn(c: Agency, table: string): Promise<number> {
  const rows = await system(c.companyId, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/** The write-once copy a file gets once staged: none on a refusal (M8 review). */
const staged = (companyId: string, purpose: string, uploadId: string) =>
  ctx.storage.head({
    bucket: ctx.config.S3_BUCKET_EVIDENCE,
    key: `evidence/${companyId}/${purpose}/${uploadId}`,
  });

/** A chargeback, as the provider reconciliation records it: it cannot be refused (P21b). */
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
      note: 'Pulled back by the bank',
      moneyNowIn: 'agency_account',
      approvalRequestId: null,
      requestedBy: null,
      today,
    });
  });
}

async function paymentOf(companyId: string, leaseId: string): Promise<string> {
  const [row] = await system(companyId, (tx) =>
    tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(sql`lease_id = ${leaseId}`)
      .orderBy(schema.payment.createdAt),
  );
  return row!.id;
}

/** A quarterly lease from tomorrow, its quarter paid into the owner's account: GH₵240 rent tax. */
async function rentTaxOwed(c: Agency): Promise<number> {
  const l = await lease(c, { start: plusDays(today, 1), cycle: 'quarterly' });
  await transfer(c, l.id, 300_000, today, 'owner_account');
  const due = await t.reports.dueList(c.accountant, { ownerId: c.ownerId });
  return due.reduce((sum, i) => sum + i.outstandingMinor, 0);
}

const graUpload = (c: Agency) => uploadEvidence(ctx, (i) => t.gra.createUpload(c.accountant, i));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  r = reportingMoneyServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('TX-03 F3 rent tax paid to GRA from the agency’s account (P18)', () => {
  it('is refused beyond what the agency holds for the owner, with nothing posted or staged, and accepted once the owner’s funding covers it', async () => {
    const c = await agencyWithOwner('F3 GRA');
    const owed = await rentTaxOwed(c);
    expect(owed).toBe(24_000);
    expect(await agentCash(c)).toBe(0);
    const upload = await graUpload(c);
    const pay = () =>
      t.gra.recordGraPayment(c.accountant, {
        ownerId: c.ownerId,
        paidOn: today,
        amountMinor: owed,
        graReceiptNumber: 'GRA-F3-1',
        receiptUploadId: upload,
        paidFrom: 'agency_account',
      });
    await expect(pay()).rejects.toMatchObject(refusedHolding(0));
    // Funded in part: still refused, and the refusal says how much is held.
    await fund(c, 10_000);
    await expect(pay()).rejects.toMatchObject(refusedHolding(10_000));
    expect(await entriesOf(c, 'P18')).toBe(0);
    expect(await rowsIn(c, 'gra_payment')).toBe(0);
    expect(await staged(c.companyId, 'gra_receipt', upload)).toBeNull();
    expect(await bookAccount(c, '2200')).toBe(-owed);

    // The rest of the funding recorded: the same upload pays, and 1070 comes back to zero.
    await fund(c, owed - 10_000);
    await pay();
    expect(await agentCash(c)).toBe(0);
    expect(await entriesOf(c, 'P18')).toBe(1);
    expect(await bookAccount(c, '2200')).toBe(0);
    expect(await staged(c.companyId, 'gra_receipt', upload)).not.toBeNull();
    expect(await t.reports.dueList(c.accountant, { ownerId: c.ownerId })).toEqual([]);
  });

  it('checks only the agency’s account: paid from the owner’s account, nothing is held back', async () => {
    const c = await agencyWithOwner('F3 GRA Owner Account');
    const owed = await rentTaxOwed(c);
    await t.gra.recordGraPayment(c.accountant, {
      ownerId: c.ownerId,
      paidOn: today,
      amountMinor: owed,
      graReceiptNumber: 'GRA-F3-OWNER',
      receiptUploadId: await graUpload(c),
      paidFrom: 'owner_account',
    });
    expect(await agentCash(c)).toBe(0);
    expect(await bookAccount(c, '2200')).toBe(0);
  });
});

describe('P33 F3 VAT and levies paid to GRA from the agency’s account', () => {
  it('is refused beyond what is held, with nothing posted or staged; accepted within it, the rest from the owner’s account', async () => {
    const c = await agencyWithOwner('F3 VAT', { commercial: true });
    const start = monthStart(today);
    const l = await lease(c, { start, rent: 1_000_000, commercial: true });
    await transfer(c, l.id, 1_200_000, today, 'owner_account');
    const month = today.slice(0, 7);
    const report = await t.gra.vatReport(c.accountant, { ownerId: c.ownerId, month });
    expect(report.totals.outstandingMinor).toBe(200_000);
    const upload = await graUpload(c);
    const pay = (
      amountMinor: number,
      paidFrom: 'agency_account' | 'owner_account',
      uploadId = upload,
    ) =>
      t.gra.recordVatPayment(c.accountant, {
        ownerId: c.ownerId,
        periodMonth: month,
        paidOn: today,
        amountMinor,
        graReceiptNumber: `GRA-F3-VAT-${paidFrom}`,
        receiptUploadId: uploadId,
        paidFrom,
      });
    await expect(pay(200_000, 'agency_account')).rejects.toMatchObject(refusedHolding(0));
    expect(await entriesOf(c, 'P33')).toBe(0);
    expect(await rowsIn(c, 'vat_payment')).toBe(0);
    expect(await staged(c.companyId, 'gra_receipt', upload)).toBeNull();

    await fund(c, 150_000);
    await expect(pay(150_001, 'agency_account')).rejects.toMatchObject(refusedHolding(150_000));
    await pay(150_000, 'agency_account');
    expect(await agentCash(c)).toBe(0);
    await pay(50_000, 'owner_account', await graUpload(c));
    expect(await bookAccount(c, '2210')).toBe(0);
    expect(await entriesOf(c, 'P33')).toBe(2);
  });
});

describe('AR-04 F3 an early-termination refund paid from the agency’s account (P13)', () => {
  it('is refused beyond what is held, the refund still payable and nothing staged; paid once the owner’s funding is recorded', async () => {
    const c = await agencyWithOwner('F3 Termination');
    const start = plusMonths(monthStart(today), -3);
    const l = await lease(c, { start, breakCredit: false });
    await transfer(c, l.id, 600_000, start, 'owner_account');
    // Five days ago, never a rent period's last day (as termination-advance's endedEarly).
    const fiveDaysAgo = plusDays(today, -5);
    const lastDay =
      monthStart(plusDays(fiveDaysAgo, 1)) === plusDays(fiveDaysAgo, 1)
        ? plusDays(today, -6)
        : fiveDaysAgo;
    await s.lifecycle.recordMoveOut(c.manager, l.id, { moveOutDate: lastDay });
    await runLeaseEvents(ctx, b, c.companyId);
    const { terminationId, approvalId } = await t.termination.request(c.manager, l.id, {
      charges: [],
      deductions: [],
    });
    await s.approvals.decide(c.accountant, approvalId, { decision: 'approve' });
    const [settled] = await t.termination.list(c.manager, { ids: [terminationId] });
    const refund = settled!.refundMinor;
    expect(settled!.status).toBe('settled');
    expect(refund).toBeGreaterThan(0);
    expect(await agentCash(c)).toBe(0);

    const proof = await uploadEvidence(ctx, (i) => t.termination.createUpload(c.manager, i));
    const pay = () =>
      t.termination.recordPaid(c.manager, terminationId, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO F3 REFUND',
        proofUploadId: proof,
      });
    await expect(pay()).rejects.toMatchObject(refusedHolding(0));
    expect(await entryKeyed(c, `P13:${terminationId}:paid`)).toBe(0);
    expect(await bookAccount(c, '2400')).toBe(-refund);
    expect((await t.termination.list(c.manager, { ids: [terminationId] }))[0]!.status).toBe(
      'settled',
    );
    expect(await staged(c.companyId, 'refund_proof', proof)).toBeNull();

    await fund(c, refund);
    await pay();
    expect(await entryKeyed(c, `P13:${terminationId}:paid`)).toBe(1);
    expect(await bookAccount(c, '2400')).toBe(0);
    expect(await agentCash(c)).toBe(0);
    expect((await t.termination.list(c.manager, { ids: [terminationId] }))[0]!.status).toBe(
      'refund_paid',
    );
  });
});

describe('TL-11 F3 a move-out refund paid from the agency’s account (P12 and P13)', () => {
  it('is refused a pesewa short, with nothing posted or staged; paid when what is held equals it', async () => {
    const c = await agencyWithOwner('F3 Move-out');
    const start = plusMonths(today, -3);
    const l = await lease(c, { start, deposit: 50_000 });
    await transfer(c, l.id, 450_000, start, 'owner_account');
    const planned = await m.moveOuts.plan(c.manager, l.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, {
      decision: 'approve',
    });
    const approved = await m.moveOuts.get(c.manager, planned.id);
    expect(approved.status).toBe('approved');
    const refund = approved.statement!.refundMinor;
    expect(refund).toBeGreaterThan(0);

    const proof = await uploadEvidence(ctx, (i) => m.moveOuts.createRefundUpload(c.accountant, i));
    const pay = () =>
      m.moveOuts.recordRefundPaid(c.accountant, planned.id, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO F3 MOVE-OUT',
        proofUploadId: proof,
      });
    await expect(pay()).rejects.toMatchObject(refusedHolding(0));
    await fund(c, refund - 1);
    await expect(pay()).rejects.toMatchObject(refusedHolding(refund - 1));
    expect(await entryKeyed(c, `P12:${planned.id}:paid`)).toBe(0);
    expect(await bookAccount(c, '2400')).toBe(-refund);
    expect((await m.moveOuts.get(c.manager, planned.id)).status).toBe('approved');
    expect(await staged(c.companyId, 'refund_proof', proof)).toBeNull();

    await fund(c, 1);
    expect((await pay()).status).toBe('refund_paid');
    expect(await entryKeyed(c, `P12:${planned.id}:paid`)).toBe(1);
    expect(await bookAccount(c, '2400')).toBe(0);
    expect(await agentCash(c)).toBe(0);
  });
});

describe('AC-03 F3 expenses the agent pays (P15)', () => {
  const expense = (
    c: Agency,
    actor: Agency['accountant'],
    input: {
      amountMinor: number;
      paidBy: 'agent' | 'owner' | 'unpaid';
      supplier: string;
      receiptUploadId?: string;
      propertyId?: string;
    },
  ) =>
    m.expenses.record(actor, {
      propertyId: input.propertyId ?? c.propertyId,
      category: 'repairs',
      supplierName: input.supplier,
      amountMinor: input.amountMinor,
      expenseDate: today,
      paidBy: input.paidBy,
      ...(input.receiptUploadId ? { receiptUploadId: input.receiptUploadId } : {}),
    });

  it('refuses an agent-paid expense beyond what is held, with nothing posted or staged; records it within what is held', async () => {
    const c = await agencyWithOwner('F3 Expense');
    const receipt = await uploadEvidence(ctx, (i) => m.expenses.createUpload(c.accountant, i));
    const record = () =>
      expense(c, c.accountant, {
        amountMinor: 12_000,
        paidBy: 'agent',
        supplier: 'Plumber',
        receiptUploadId: receipt,
      });
    await expect(record()).rejects.toMatchObject(refusedHolding(0));
    expect(await entriesOf(c, 'P15')).toBe(0);
    expect(await rowsIn(c, 'expense')).toBe(0);
    expect(await staged(c.companyId, 'expense_receipt', receipt)).toBeNull();
    // Paid by the owner, or unpaid: not the agent's cash, so not checked.
    await expense(c, c.accountant, {
      amountMinor: 12_000,
      paidBy: 'owner',
      supplier: 'Owner paid',
    });

    // Rent received into the agency's account is the owner's money the agent holds.
    const l = await lease(c, { start: monthStart(today) });
    await transfer(c, l.id, 20_000, today, 'agency_account');
    expect(await agentCash(c)).toBe(20_000);
    const { expenseId } = await record();
    expect(await agentCash(c)).toBe(8_000);
    expect(await staged(c.companyId, 'expense_receipt', receipt)).not.toBeNull();
    expect((await m.expenses.get(c.accountant, expenseId)).paidBy).toBe('agent');
  });

  it('refuses paying an unpaid expense from the agency’s account beyond what is held; pays it after the owner’s funding', async () => {
    const c = await agencyWithOwner('F3 Expense Paid Later');
    const { expenseId } = await expense(c, c.accountant, {
      amountMinor: 10_000,
      paidBy: 'unpaid',
      supplier: 'Electrician',
    });
    await fund(c, 8_000);
    const pay = () =>
      m.expenses.pay(c.accountant, expenseId, { paidOn: today, paidFrom: 'agency_account' });
    await expect(pay()).rejects.toMatchObject(refusedHolding(8_000));
    expect(await entryKeyed(c, `P15:${expenseId}:paid`)).toBe(0);
    expect(await rowsIn(c, 'expense_payment')).toBe(0);
    expect((await m.expenses.get(c.accountant, expenseId)).status).toBe('unpaid');
    expect(await bookAccount(c, '2500')).toBe(-10_000);

    await fund(c, 2_000);
    await pay();
    expect(await entryKeyed(c, `P15:${expenseId}:paid`)).toBe(1);
    expect((await m.expenses.get(c.accountant, expenseId)).status).toBe('paid');
    expect(await agentCash(c)).toBe(0);
    expect(await bookAccount(c, '2500')).toBe(0);
  });
});

describe('AC-05 F3 two payments at once out of the same agent cash', () => {
  it('takes them in turn under the owner’s lock: together beyond what is held, one is refused, and 1070 never goes below zero', async () => {
    const c = await agencyWithOwner('F3 Race');
    const owed = await rentTaxOwed(c);
    await fund(c, 100_000);
    // Two agent-paid expenses, each within what is held, together beyond it.
    const [first, second] = await Promise.allSettled(
      ['Roofer', 'Painter'].map((supplier) =>
        m.expenses.record(c.accountant, {
          propertyId: c.propertyId,
          category: 'repairs',
          supplierName: supplier,
          amountMinor: 60_000,
          expenseDate: today,
          paidBy: 'agent',
        }),
      ),
    );
    const outcomes = [first!, second!];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ ...REFUSED, details: { heldMinor: '40000' } });
    expect(await agentCash(c)).toBe(40_000);
    expect(await rowsIn(c, 'expense')).toBe(1);

    // Two paths at once: rent tax to GRA and an expense paid later, 24,000 + 20,000 > 40,000.
    const { expenseId } = await m.expenses.record(c.accountant, {
      propertyId: c.propertyId,
      category: 'repairs',
      supplierName: 'Glazier',
      amountMinor: 20_000,
      expenseDate: today,
      paidBy: 'unpaid',
    });
    const upload = await graUpload(c);
    const [gra, paid] = await Promise.allSettled([
      t.gra.recordGraPayment(c.accountant, {
        ownerId: c.ownerId,
        paidOn: today,
        amountMinor: owed,
        graReceiptNumber: 'GRA-F3-RACE',
        receiptUploadId: upload,
        paidFrom: 'agency_account',
      }),
      m.expenses.pay(c.accountant, expenseId, { paidOn: today, paidFrom: 'agency_account' }),
    ]);
    const both = [gra!, paid!];
    expect(both.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(
      (both.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject(REFUSED);
    const held = await agentCash(c);
    expect(held).toBe(gra!.status === 'fulfilled' ? 40_000 - owed : 20_000);
    expect(held).toBeGreaterThanOrEqual(0);
    expect(await entriesOf(c, 'P18')).toBe(gra!.status === 'fulfilled' ? 1 : 0);
    expect(await entryKeyed(c, `P15:${expenseId}:paid`)).toBe(paid!.status === 'fulfilled' ? 1 : 0);
  });
});

describe('AD-02 F3 a property-limited manager is checked against the owner’s whole agent cash', () => {
  it('counts money held from the owner’s other property, which the manager cannot see: refused beyond the whole, paid within it', async () => {
    const c = await agencyWithOwner('F3 Scoped');
    partCount += 1;
    const other = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: `K${String(partCount).padStart(2, '0')}`,
      ownerId: c.ownerId,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
    });
    // A move-out on the manager's property, its refund approved.
    const start = plusMonths(today, -3);
    const l = await lease(c, { start, deposit: 50_000 });
    await transfer(c, l.id, 450_000, start, 'owner_account');
    const planned = await m.moveOuts.plan(c.manager, l.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, {
      decision: 'approve',
    });
    const refund = (await m.moveOuts.get(c.manager, planned.id)).statement!.refundMinor;
    expect(refund).toBeGreaterThan(0);
    // What the agent holds for the owner comes only from the other property's rent.
    const elsewhere = await lease(c, {
      start: monthStart(today),
      unitId: Object.values(other.units)[0]!,
    });
    await transfer(c, elsewhere.id, 10_000, today, 'agency_account');
    const scoped = await staffIn(ctx, c.companyId, 'agency', 'property_manager', 'F3 Scoped mgr', {
      properties: [c.propertyId],
    });
    const visible = async () => {
      const rows = await withCompany(ctx.database, staffContext(scoped), (tx) =>
        tx.execute<{ total: string }>(
          sql`select coalesce(sum(amount_minor), 0)::bigint as total from journal_line
              where book_id = ${c.bookId}::uuid and account_code = '1070'`,
        ),
      );
      return Number(rows.rows[0]?.total ?? 0);
    };
    // The manager's own view of 1070 shows none of it; the check reads the whole in their session.
    expect(await visible()).toBe(0);
    expect(
      await withCompany(ctx.database, staffContext(scoped), (tx) => agentCashHeld(tx, c.bookId)),
    ).toBe(10_000);
    const proof = await uploadEvidence(ctx, (i) => m.moveOuts.createRefundUpload(scoped, i));
    const pay = () =>
      m.moveOuts.recordRefundPaid(scoped, planned.id, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO F3 SCOPED',
        proofUploadId: proof,
      });
    await expect(pay()).rejects.toMatchObject(refusedHolding(10_000));
    expect(await staged(c.companyId, 'refund_proof', proof)).toBeNull();
    await transfer(c, elsewhere.id, refund, today, 'agency_account');
    expect(await visible()).toBe(0);
    expect((await pay()).status).toBe('refund_paid');
    expect(await agentCash(c)).toBe(10_000);
    expect(await visible()).toBe(-refund);
  });
});

describe('AC-05 F3 the nightly agent cash check', () => {
  it('alerts when a chargeback, which cannot be refused, leaves an owner’s 1070 below zero; only for that company, and clear once funded', async () => {
    const alerts: Alert[] = [];
    const checker = new AgentCashCheckService(
      ctx.database,
      new CallbackAlert((alert) => {
        alerts.push(alert);
      }),
    );
    const c = await agencyWithOwner('F3 Chargeback');
    const quiet = await agencyWithOwner('F3 Quiet');
    const l = await lease(c, { start: monthStart(today) });
    await transfer(c, l.id, 100_000, today, 'agency_account');
    const ql = await lease(quiet, { start: monthStart(today) });
    await transfer(quiet, ql.id, 30_000, today, 'agency_account');
    await m.expenses.record(c.accountant, {
      propertyId: c.propertyId,
      category: 'repairs',
      supplierName: 'Before the chargeback',
      amountMinor: 80_000,
      expenseDate: today,
      paidBy: 'agent',
    });
    expect(await agentCash(c)).toBe(20_000);
    expect(await checker.check(c.companyId)).toMatchObject({ books: 1, negative: [] });
    expect(alerts).toEqual([]);

    // The bank pulls the rent back from the agency's account after the agent paid the bill.
    await chargeback(c.companyId, l.id, await paymentOf(c.companyId, l.id));
    expect(await agentCash(c)).toBe(-80_000);
    const result = await checker.check(c.companyId);
    expect(result.negative).toEqual([{ ownerId: c.ownerId, bookId: c.bookId, heldMinor: -80_000 }]);
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: 'critical',
        code: 'ledger.agent_cash_negative',
        context: expect.objectContaining({ companyId: c.companyId, owners: 1 }),
      }),
    ]);
    // Another company is checked on its own: nothing there.
    expect((await checker.check(quiet.companyId)).negative).toEqual([]);
    // Read without alerting.
    expect((await checker.check(c.companyId, { alert: false })).negative).toHaveLength(1);
    expect(alerts).toHaveLength(1);

    // While below zero, every payment out of it is refused, naming what is held.
    await expect(
      m.expenses.record(c.accountant, {
        propertyId: c.propertyId,
        category: 'repairs',
        supplierName: 'After the chargeback',
        amountMinor: 1,
        expenseDate: today,
        paidBy: 'agent',
      }),
    ).rejects.toMatchObject(refusedHolding(-80_000));
    await fund(c, 80_000);
    expect((await checker.check(c.companyId)).negative).toEqual([]);
    expect(alerts).toHaveLength(1);
  });
});
