import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { INCOME_ACCOUNTS } from '@rent/domain/ledger';
import { chargeReference } from '@rent/domain/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCard,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  activeAccount,
  CLIENT,
  deliverWebhook,
  issueReceipts,
  paymentsServices,
  runRefunds,
  type PaymentsServices,
} from './support/payments';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';
import { isoNow } from '../src/billing/records';

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let secondAdmin: Awaited<ReturnType<typeof staffIn>>;
let ownerA: string;
let ownerB: string;
let units: string[];
let agencyAccount: string;
let ownerAccount: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const nextUnit = () => units.shift()!;

/** A tenant with a phone, and SMS consent when asked (CM-09). */
async function tenant(name: string, options: { phone?: string; consent?: boolean } = {}) {
  const { tenant: t } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: name,
    ...(options.phone ? { phone: options.phone } : {}),
  });
  if (options.consent)
    await s.tenants.recordConsent(agency.manager, t.id, { channel: 'sms', action: 'grant' });
  return t.id;
}

/** A monthly lease from today, its first invoice issued and due today. */
async function lease(
  name: string,
  options: {
    unitId?: string;
    rent?: number;
    deposit?: number | null;
    phone?: string;
    consent?: boolean;
    start?: string;
  } = {},
) {
  const start = options.start ?? today;
  const l = await billedLease(ctx, s, b, agency.manager, {
    unitId: options.unitId ?? nextUnit(),
    tenantId: await tenant(name, options),
    startDate: start,
    endDate: plusDays(plusMonths(start, 12), -1),
    monthlyRentMinor: options.rent ?? 150_000,
    cycle: 'monthly',
    depositMinor: options.deposit ?? null,
    signedOn: plusDays(today, -1) < start ? plusDays(today, -1) : start,
    billingStartDate: start,
  });
  return l.id;
}

async function invoicesOf(leaseId: string) {
  return withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.leaseId, leaseId))
      .orderBy(schema.invoice.dueDate),
  );
}

/** A pay link for an invoice, as a reminder or the tenant app would make it; returns its token. */
async function payLink(invoiceId: string): Promise<string> {
  const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
    p.links.mint(tx, await p.links.invoice(tx, invoiceId)),
  );
  return url.split('/p/')[1]!;
}

/** Starts a MoMo payment on a link: the intent and its charge reference. */
async function startMomo(token: string, amountMinor: number, submissionId = randomUUID()) {
  // Each payment from its own address, as tenants' phones are (the per-address limit).
  const client = { ...CLIENT, ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
  const intent = await p.page.start(token, client, {
    amountMinor,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId,
  });
  return { intent, reference: chargeReference(intent.intentId) };
}

async function payments(leaseId: string) {
  return withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx.select().from(schema.payment).where(eq(schema.payment.leaseId, leaseId)),
  );
}

async function exceptions(kind: string) {
  return withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select()
      .from(schema.reconciliationException)
      .where(eq(schema.reconciliationException.kind, kind)),
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
  agency = await moneyCompany(ctx, s, 'agency', 'Pay Agency');
  secondAdmin = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second Admin');
  ownerA = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Owner Own Account',
      phone: '+233200000501',
    })
  ).id;
  ownerB = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner Agency Account' })
  ).id;
  const propertyA = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'PYA',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 40, bedrooms: 2 }],
  });
  units = Object.values(propertyA.units);
  // Owner A's rent goes to their own account; owner B's to the agency's client account.
  ownerAccount = await activeAccount(ctx, s, p, agency.admin, secondAdmin, {
    holder: 'owner',
    ownerId: ownerA,
  });
  agencyAccount = await activeAccount(ctx, s, p, agency.admin, secondAdmin, { holder: 'agency' });
  await p.accounts.setAgreement(agency.admin, ownerA, {
    destination: 'owner_account',
    effectiveFrom: plusDays(today, -30),
  });
  await p.accounts.setAgreement(agency.admin, ownerB, {
    destination: 'agency_client_account',
    effectiveFrom: plusDays(today, -30),
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-04 and BC-06 the tenant pays by MoMo and gets a receipt within a minute', () => {
  it('opens the link, pays through the fake, posts once from the verified charge, and sends the receipt', async () => {
    const leaseId = await lease('Kwame Payer', { phone: '+233200000301', consent: true });
    const [invoice] = await invoicesOf(leaseId);
    const token = await payLink(invoice!.id);
    const page = await p.page.open(token, CLIENT);
    expect(page).toMatchObject({
      screen: 'pay',
      dueNowMinor: 150_000,
      amounts: { prefillMinor: 150_000, minMinor: 100, maxMinor: 150_000 * 12 },
      methods: ['momo', 'card'],
      latest: null,
    });
    const submissionId = randomUUID();
    const { intent, reference } = await startMomo(token, 150_000, submissionId);
    expect(intent).toMatchObject({
      status: 'pending',
      message: 'Approve the payment on your phone',
    });
    // A double tap is the same intent and one charge.
    const again = await startMomo(token, 150_000, submissionId);
    expect(again.intent.intentId).toBe(intent.intentId);
    const webhook = await p.primary.completeCharge(reference, {
      status: 'success',
      feesMinor: 2_925,
    });
    expect(await deliverWebhook(ctx, p, 'paystack', webhook!)).toEqual({
      intake: 'stored',
      outcome: 'posted',
    });
    // The same webhook again changes nothing.
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).intake).toBe('duplicate');
    expect(await payments(leaseId)).toHaveLength(1);
    expect(await p.page.status(token, CLIENT, intent.intentId)).toMatchObject({
      status: 'confirmed',
      receiptNumber: expect.stringMatching(/^RC-\d{6}$/),
    });
    expect((await p.page.open(token, CLIENT)).screen).toMatch(/^(paid|settled)$/);
    const card = await moneyCard(ctx, b, agency.companyId, leaseId);
    expect(card.dueNowMinor).toBe(0);
    expect(card.paidUntil).toBe(plusDays(plusMonths(today, 1), -1));
    const before = s.sms.sent.length;
    const outcomes = await issueReceipts(ctx, p, agency.companyId);
    expect(outcomes).toContain('sent');
    const sms = s.sms.sent.slice(before).map((m) => m.body);
    expect(
      sms.some((body) => /receipt/i.test(body) && body.includes(`${ctx.config.LINKS_ORIGIN}/r/`)),
    ).toBe(true);
    const paymentId = (await payments(leaseId))[0]!.id;
    const [delivery] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select()
        .from(schema.receiptDelivery)
        .where(eq(schema.receiptDelivery.paymentId, paymentId)),
    );
    expect(delivery).toMatchObject({ status: 'sent', channel: 'sms' });
    expect(delivery!.latencyMs).toBeLessThan(60_000);
    // The receipt link opens the receipt.
    const link = sms.find((body) => body.includes('/r/'))!.match(/\/r\/([A-Za-z0-9_-]{43})/)![1]!;
    expect(await p.receipts.open(link, CLIENT)).toMatchObject({
      receiptNumber: expect.stringMatching(/^RC-/),
      amountMinor: 150_000,
    });
  });
});

describe('BC-02 a tampered amount or bad signature posts nothing', () => {
  it('rejects a bad signature: stored as rejected, a security alert, nothing posted', async () => {
    const leaseId = await lease('Tampered Signature');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    const webhook = await p.primary.completeCharge(reference, { status: 'success' });
    const forged = {
      rawBody: webhook!.rawBody,
      headers: { 'x-paystack-signature': 'ab'.repeat(64) },
    };
    expect((await deliverWebhook(ctx, p, 'paystack', forged)).intake).toBe('rejected');
    expect(p.alerts.some((a) => a.code === 'payments.webhook_bad_signature')).toBe(true);
    expect(await payments(leaseId)).toHaveLength(0);
    // The genuine event still goes through afterwards: a forgery cannot take its place.
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
  });

  it('never posts from the body: a signed webhook claiming success for an unpaid charge posts nothing', async () => {
    const leaseId = await lease('Claims Success');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    // Signed with the provider's key, claiming 1,500,000 paid; the provider says it is pending.
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 999_001, reference, amount: 1_500_000, status: 'success', currency: 'GHS' },
    });
    const { hmacHex } = await import('../../integrations/src/hmac');
    const webhook = {
      rawBody: body,
      headers: { 'x-paystack-signature': hmacHex('sha512', 'sk_test_primary', body) },
    };
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('pending');
    expect(await payments(leaseId)).toHaveLength(0);
  });

  it('posts what the provider verified, not what was asked, and flags the difference', async () => {
    const leaseId = await lease('Short Payer');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    const webhook = await p.primary.completeCharge(reference, {
      status: 'success',
      amountMinor: 100_000,
    });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted_flagged');
    const [payment] = await payments(leaseId);
    expect(payment!.amountMinor).toBe(100_000);
    expect(
      (await exceptions('verified_amount_differs')).some((e) => e.paymentId === payment!.id),
    ).toBe(true);
  });

  it('refuses a verified answer whose reference or currency differs: nothing posts, an alert goes', async () => {
    const leaseId = await lease('Wrong Currency');
    const [invoice] = await invoicesOf(leaseId);
    const { intent, reference } = await startMomo(await payLink(invoice!.id), 150_000);
    const verified = {
      ...(await p.primary.verifyTransaction(reference)),
      status: 'success' as const,
    };
    for (const forged of [
      { ...verified, currency: 'NGN' },
      { ...verified, reference: `${reference}x` },
    ])
      expect(
        await p.providerPayments.confirmIntent(
          agency.companyId,
          intent.intentId,
          'paystack',
          forged,
        ),
      ).toBe('rejected');
    expect(await payments(leaseId)).toHaveLength(0);
    expect(p.alerts.some((a) => a.code === 'payments.verification_mismatch')).toBe(true);
  });
});

describe('BC-02 a payment confirmed during an outage is picked up by reconciliation', () => {
  it('posts a charge whose webhook never came, once, on the next run', async () => {
    const leaseId = await lease('Outage Payer');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await p.primary.completeCharge(reference, { status: 'success' });
    expect(await payments(leaseId)).toHaveLength(0);
    const first = await p.reconciliation.transactions('paystack', today);
    expect(first.processed).toBeGreaterThanOrEqual(1);
    expect(await payments(leaseId)).toHaveLength(1);
    await p.reconciliation.transactions('paystack', today);
    expect(await payments(leaseId)).toHaveLength(1);
    expect((await exceptions('missing_here')).some((e) => e.reference === reference)).toBe(false);
  });
});

describe('BC-05 a cash receipt cannot be approved by the person who recorded it', () => {
  it('refuses the recorder as approver; nothing posts until someone else approves', async () => {
    const leaseId = await lease('Cash Payer');
    const { uploadMoneyProof } = await import('./support/billing');
    const recorded = await b.money.recordCash(agency.manager, {
      leaseId,
      method: 'cash',
      amountMinor: 50_000,
      receivedOn: today,
      payerName: 'Cash Payer',
      photoUploadId: await uploadMoneyProof(ctx, b, agency.manager, 'cash_photo'),
    });
    await expect(
      s.approvals.decide(agency.manager, recorded.approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    expect(await payments(leaseId)).toHaveLength(0);
    await s.approvals.decide(agency.accountant, recorded.approvalId, { decision: 'approve' });
    expect(await payments(leaseId)).toHaveLength(1);
  });
});

describe('BC-06 receipt numbers have no gaps under concurrent payments', () => {
  it('numbers concurrent webhooks and cash approvals 1, 2, 3… with no gaps or duplicates', async () => {
    const fresh = await moneyCompany(ctx, s, 'landlord', 'Numbers Landlord');
    const second = await staffIn(ctx, fresh.companyId, 'landlord', 'owner', 'Second Owner');
    const owner = (
      await s.owners.create(fresh.admin, { kind: 'individual', displayName: 'Numbers Owner' })
    ).id;
    const property = await propertyWithUnits(s, fresh.manager, {
      areaCode: 'ACC',
      propertyPart: 'NUM',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 10, bedrooms: 1 }],
    });
    await activeAccount(ctx, s, p, fresh.admin, second, { holder: 'owner', ownerId: owner });
    const leaseIds: string[] = [];
    for (const unitId of Object.values(property.units))
      leaseIds.push(
        (
          await billedLease(ctx, s, b, fresh.manager, {
            unitId,
            tenantId: (
              await s.tenants.create(fresh.manager, {
                kind: 'individual',
                displayName: 'Numbers Tenant',
              })
            ).tenant.id,
            startDate: today,
            endDate: plusDays(plusMonths(today, 12), -1),
            monthlyRentMinor: 100_000,
            cycle: 'monthly',
            signedOn: today,
            billingStartDate: today,
          })
        ).id,
      );
    const webhooks = [];
    for (const leaseId of leaseIds.slice(0, 6)) {
      const [invoice] = await withCompany(ctx.database, sys(fresh.companyId), (tx) =>
        tx.select().from(schema.invoice).where(eq(schema.invoice.leaseId, leaseId)),
      );
      const { url } = await withCompany(ctx.database, sys(fresh.companyId), async (tx) =>
        p.links.mint(tx, await p.links.invoice(tx, invoice!.id)),
      );
      const intent = await p.page.start(url.split('/p/')[1]!, CLIENT, {
        amountMinor: 100_000,
        method: 'card',
        submissionId: randomUUID(),
      });
      webhooks.push(
        (await p.primary.completeCharge(chargeReference(intent.intentId), { status: 'success' }))!,
      );
    }
    const { uploadMoneyProof } = await import('./support/billing');
    const cash = [];
    for (const leaseId of leaseIds.slice(6)) {
      const recorded = await b.money.recordCash(fresh.manager, {
        leaseId,
        method: 'cash',
        amountMinor: 100_000,
        receivedOn: today,
        payerName: 'Numbers Tenant',
        photoUploadId: await uploadMoneyProof(ctx, b, fresh.manager, 'cash_photo'),
      });
      cash.push(recorded.approvalId);
    }
    for (const w of webhooks)
      await p.webhooks.intake('paystack', Buffer.from(w.rawBody), w.headers);
    const { claimInbox } = await import('./support/payments');
    const inbox = await claimInbox(ctx);
    await Promise.all([
      ...inbox.map((id) => p.webhooks.process(id)),
      ...cash.map((id) => s.approvals.decide(fresh.accountant, id, { decision: 'approve' })),
    ]);
    const numbers = await withCompany(ctx.database, sys(fresh.companyId), (tx) =>
      tx.select({ n: schema.receipt.number }).from(schema.receipt).orderBy(schema.receipt.number),
    );
    expect(numbers.map((r) => r.n)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });
});

describe('BC-11 deposit money never appears in rent income', () => {
  it('a provider payment on a deposit and rent puts the deposit in 2100 and only rent in income', async () => {
    const leaseId = await lease('Deposit Payer', { deposit: 300_000, start: plusDays(today, 10) });
    const invoices = await invoicesOf(leaseId);
    const deposit = invoices.find((i) => i.kind === 'deposit')!;
    const { reference } = await startMomo(await payLink(deposit.id), 450_000);
    const webhook = await p.primary.completeCharge(reference, { status: 'success' });
    await deliverWebhook(ctx, p, 'paystack', webhook!);
    expect(-(await leaseAccount(ctx, agency.companyId, leaseId, '2100'))).toBe(300_000);
    let income = 0;
    for (const code of INCOME_ACCOUNTS)
      income += await leaseAccount(ctx, agency.companyId, leaseId, code);
    expect(income).toBe(0);
  });
});

describe('BC-03 automatic matching only on metadata or an exact reference', () => {
  it('matches an exact lease reference in the narration; a near-miss waits for a person', async () => {
    const leaseId = await lease('Reference Payer');
    const card = await moneyCard(ctx, b, agency.companyId, leaseId);
    const reference = card.paymentReference!;
    const subaccount = (await subaccountOf(ownerAccount))!;
    const exact = await p.primary.payExternal({
      subaccountCode: subaccount,
      amountMinor: 150_000,
      channel: 'momo',
      narration: `Rent ${reference}`,
    });
    expect((await deliverWebhook(ctx, p, 'paystack', exact.webhook)).outcome).toBe(
      'matched_by_reference',
    );
    expect(await payments(leaseId)).toHaveLength(1);
    const typo = `${reference.slice(0, 6)}${reference[6] === 'A' ? 'B' : 'A'}`;
    const near = await p.primary.payExternal({
      subaccountCode: subaccount,
      amountMinor: 150_000,
      channel: 'momo',
      narration: `Rent ${typo}`,
    });
    expect((await deliverWebhook(ctx, p, 'paystack', near.webhook)).outcome).toBe('unmatched');
    expect(await payments(leaseId)).toHaveLength(1);
    const unmatched = await b.read.unmatched(agency.manager);
    expect(unmatched.find((u) => u.providerReference === near.reference)).toMatchObject({
      receivedInto: 'provider',
      ownerId: ownerA,
      settlesInto: 'owner_account',
    });
  });
});

async function subaccountOf(accountId: string): Promise<string | undefined> {
  const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select({ code: schema.providerSubaccount.subaccountCode })
      .from(schema.providerSubaccount)
      .where(eq(schema.providerSubaccount.settlementAccountId, accountId)),
  );
  return row?.code;
}

describe('BC-12 the unmatched queue', () => {
  let leaseB: string;
  beforeAll(async () => {
    const propertyB = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'PYB',
      ownerId: ownerB,
      units: [{ unitType: 'apartment', count: 4, bedrooms: 2 }],
    });
    const unitsB = Object.values(propertyB.units);
    leaseB = await lease('Ama Queue', { unitId: unitsB[0]!, phone: '+233200000777' });
    await lease('Someone Else', { unitId: unitsB[1]!, phone: '+233200000778', rent: 90_000 });
  });

  it('ranks the lease whose tenant paid from their own phone the exact amount due first', async () => {
    const external = await p.primary.payExternal({
      subaccountCode: (await subaccountOf(agencyAccount))!,
      amountMinor: 150_000,
      channel: 'momo',
      payerPhone: '+233200000777',
    });
    expect((await deliverWebhook(ctx, p, 'paystack', external.webhook)).outcome).toBe('unmatched');
    const row = (await b.read.unmatched(agency.manager)).find(
      (u) => u.providerReference === external.reference,
    )!;
    expect(row).toMatchObject({
      receivedInto: 'provider',
      ownerId: null,
      settlesInto: 'agency_account',
    });
    expect(row.payerPhoneMasked).not.toContain('200000777');
    const suggestions = await p.queue.suggestions(agency.manager, row.paymentId);
    expect(suggestions[0]).toMatchObject({ leaseId: leaseB, tenantName: 'Ama Queue' });
    expect(suggestions[0]!.reasons).toEqual(
      expect.arrayContaining(['amount_is_due_now', 'phone_is_tenant']),
    );
  });

  it('matches money settled into the agency’s account across books, moving its net and fee; each book balances', async () => {
    const external = await p.primary.payExternal({
      subaccountCode: (await subaccountOf(agencyAccount))!,
      amountMinor: 120_000,
      channel: 'momo',
      feesMinor: 2_340,
    });
    await deliverWebhook(ctx, p, 'paystack', external.webhook);
    const [settlement] = (await p.primary.settle()).filter((x) =>
      x.references.includes(external.reference),
    );
    await p.reconciliation.settlement('paystack', settlement!);
    const row = (await b.read.unmatched(agency.manager)).find(
      (u) => u.providerReference === external.reference,
    )!;
    await b.money.match(agency.manager, row.paymentId, leaseB);
    const lines = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ book_id: string; account_code: string; total: string }>(
        sql`select book_id, account_code, sum(amount_minor)::bigint as total from journal_line
            where payment_id = ${row.paymentId} group by book_id, account_code`,
      ),
    );
    const byBook = new Map<string, number>();
    for (const l of lines.rows)
      byBook.set(l.book_id, (byBook.get(l.book_id) ?? 0) + Number(l.total));
    expect(byBook.size).toBe(2);
    for (const total of byBook.values()) expect(total).toBe(0);
    // Nothing of it is left in the company book: suspense cleared, net and fee moved out.
    const [companyBook] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select({ id: schema.book.id }).from(schema.book).where(eq(schema.book.kind, 'company')),
    );
    for (const l of lines.rows.filter((r) => r.book_id === companyBook!.id))
      expect([l.account_code, Number(l.total)]).toEqual([l.account_code, 0]);
    // In the owner's book: the net in the agency's account for them, the fee as their expense.
    const owner = lines.rows.filter((r) => r.book_id !== companyBook!.id);
    // The settlement's fees are shared across its payments by gross (P22), so this payment's net
    // and fee add up to it exactly.
    const net = Number(owner.find((l) => l.account_code === '1070')!.total);
    const fee = Number(owner.find((l) => l.account_code === '5200')!.total);
    expect(net + fee).toBe(120_000);
    expect(fee).toBeGreaterThan(0);
    const result = await b.subledger.check(agency.companyId, { alert: false });
    expect(result.mismatches).toEqual([]);
  });

  it('refunds money that belongs to no one, with a second person’s approval, through the provider (P31)', async () => {
    const external = await p.primary.payExternal({
      subaccountCode: (await subaccountOf(agencyAccount))!,
      amountMinor: 33_000,
      channel: 'momo',
    });
    await deliverWebhook(ctx, p, 'paystack', external.webhook);
    const row = (await b.read.unmatched(agency.manager)).find(
      (u) => u.providerReference === external.reference,
    )!;
    const approvalId = await p.queue.requestRefund(agency.accountant, row.paymentId, {
      reason: 'Paid to us by mistake',
    });
    await expect(
      s.approvals.decide(agency.accountant, approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    expect(
      (await b.read.unmatched(agency.manager)).find((u) => u.paymentId === row.paymentId)!
        .openRefund,
    ).toMatchObject({
      status: 'awaiting_approval',
    });
    await s.approvals.decide(agency.admin, approvalId, { decision: 'approve' });
    await runRefunds(ctx, p, agency.companyId);
    expect((await p.primary.verify(external.reference)).status).toBe('reversed');
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '2090'`, [
        row.paymentId,
      ]),
    ).toBe(0);
    expect(
      (await b.read.unmatched(agency.manager)).some((u) => u.paymentId === row.paymentId),
    ).toBe(false);
    // The provider's refund event is ours, not a chargeback.
    expect(await p.providerPayments.recordChargeback('paystack', external.reference)).toBe(
      'ignored',
    );
  });
});

describe('BC-09 the reminder ladder', () => {
  it('sends each step once, by the clock, needs consent, and stops when the invoice is paid', async () => {
    const start = plusDays(today, 7);
    const consenting = await lease('Reminded Tenant', {
      start,
      phone: '+233200000601',
      consent: true,
    });
    const silent = await lease('No Consent Tenant', { start, phone: '+233200000602' });
    const [invoice] = (await invoicesOf(consenting)).filter((i) => i.kind === 'cycle');
    expect(invoice!.dueDate).toBe(start);
    expect(await p.reminders.run(agency.companyId, today)).toBeGreaterThanOrEqual(2);
    expect(await p.reminders.run(agency.companyId, today)).toBe(0);
    const before = s.sms.sent.length;
    const { sendQueued } = await import('./support/payments');
    await sendQueued(ctx, s, agency.companyId);
    const sent = s.sms.sent.slice(before);
    expect(
      sent.some(
        (m) => m.to === '+233200000601' && m.body.includes(`${ctx.config.LINKS_ORIGIN}/p/`),
      ),
    ).toBe(true);
    expect(sent.some((m) => m.to === '+233200000602')).toBe(false);
    // On the due date the next step goes; once paid, the ladder stops.
    expect(await p.reminders.run(agency.companyId, start)).toBeGreaterThanOrEqual(1);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(reference, { status: 'success' }))!,
    );
    const after = await p.reminders.run(agency.companyId, plusDays(start, 3));
    const steps = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.reminderSent).where(eq(schema.reminderSent.invoiceId, invoice!.id)),
    );
    expect(steps.map((r) => [r.offsetDays, r.status]).sort()).toEqual([
      [-7, 'sent'],
      [0, 'sent'],
    ]);
    expect(after).toBeGreaterThanOrEqual(0);
    const detail = await b.read.invoice(agency.manager, invoice!.id);
    expect(detail.reminders.map((r) => r.offsetDays)).toEqual([-7, 0]);
    expect(silent).toBeTruthy();
  });
});

describe('P22 settlement', () => {
  it('posts gross, fees and net per book, payment by payment, once; a difference raises an exception', async () => {
    const leaseId = await lease('Settled Payer');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(reference, { status: 'success', feesMinor: 2_925 }))!,
    );
    // A charge paid but never posted here: the report names a payment we do not have.
    const strayLease = await lease('Stray Payer');
    const [strayInvoice] = await invoicesOf(strayLease);
    const stray = await startMomo(await payLink(strayInvoice!.id), 1_000);
    await p.primary.completeCharge(stray.reference, { status: 'success' });
    const settlements = await p.primary.settle();
    const mine = settlements.find((x) => x.references.includes(reference))!;
    expect(await p.reconciliation.settlement('paystack', mine)).toBe(true);
    expect(await p.reconciliation.settlement('paystack', mine)).toBe(false);
    const [payment] = await payments(leaseId);
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '1050'`, [
        payment!.id,
      ]),
    ).toBe(0);
    // Each payment's net and its share of the fees add up to it; the settlement's lines add up to
    // the report: the fees in 5200, the net in the owner's account (1010).
    expect(
      await journalSum(
        ctx,
        agency.companyId,
        `l.payment_id = $1 and l.account_code in ('5200', '1010')`,
        [payment!.id],
      ),
    ).toBe(150_000);
    const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select({ id: schema.providerSettlement.id })
        .from(schema.providerSettlement)
        .where(eq(schema.providerSettlement.settlementRef, mine.settlementId)),
    );
    expect(
      await journalSum(ctx, agency.companyId, `l.settlement_id = $1 and l.account_code = '5200'`, [
        row!.id,
      ]),
    ).toBe(mine.feesMinor);
    // The stray GH₵10 is not ours: it is not posted, and the difference is raised below.
    expect(
      await journalSum(ctx, agency.companyId, `l.settlement_id = $1 and l.account_code = '1010'`, [
        row!.id,
      ]),
    ).toBe(mine.netMinor - 1_000);
    expect(await journalSum(ctx, agency.companyId, `l.settlement_id = $1`, [row!.id])).toBe(0);
    expect(
      (await exceptions('settlement_difference')).some(
        (e) => e.settlementRef === mine.settlementId,
      ),
    ).toBe(true);
  });
});

describe('P21 chargeback', () => {
  it('reverses from current allocations with a credit receipt, and the next settlement deducts it', async () => {
    const leaseId = await lease('Disputed Payer');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(reference, { status: 'success' }))!,
    );
    for (const settlement of await p.primary.settle())
      await p.reconciliation.settlement('paystack', settlement);
    const webhook = await p.primary.chargeback(reference);
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('reversed');
    const [payment] = await payments(leaseId);
    const detail = await b.read.payment(agency.manager, payment!.id);
    expect(detail.status).toBe('reversed');
    expect(detail.reversal).toMatchObject({
      reason: 'chargeback',
      moneyNowIn: 'provider',
      approvalId: null,
    });
    expect(detail.receipts.map((r) => r.kind).sort()).toEqual(['credit_receipt', 'receipt']);
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).dueNowMinor).toBe(150_000);
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '1050'`, [
        payment!.id,
      ]),
    ).toBe(-150_000);
    // The next payout takes it back: 1050 for the payment returns to zero.
    const later = await lease('Later Payer');
    const [laterInvoice] = await invoicesOf(later);
    const next = await startMomo(await payLink(laterInvoice!.id), 150_000);
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(next.reference, { status: 'success' }))!,
    );
    for (const settlement of await p.primary.settle())
      await p.reconciliation.settlement('paystack', settlement);
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '1050'`, [
        payment!.id,
      ]),
    ).toBe(0);
    expect(p.alerts.some((a) => a.code === 'payments.chargeback')).toBe(true);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('ADR-008 settlement account changes', () => {
  it('needs a second person and 24 hours, alerts the owner, and keeps the number encrypted and masked', async () => {
    const owner = (
      await s.owners.create(agency.admin, {
        kind: 'individual',
        displayName: 'New Account Owner',
        phone: '+233200000909',
      })
    ).id;
    const { accountId, approvalId } = await p.accounts.request(agency.admin, {
      holder: 'owner',
      ownerId: owner,
      bankCode: 'FAKEBANK2',
      accountNumber: '1441000123456',
      accountName: 'New Account Owner',
    });
    const [view] = (await p.accounts.list(agency.admin)).filter((a) => a.id === accountId);
    expect(view).toMatchObject({
      status: 'awaiting_approval',
      numberMasked: '•••• 3456',
      accountNameChecked: 'TEST ACCOUNT 3456',
      openRequest: { kind: 'add', approvalId },
    });
    const [raw] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.settlementAccount).where(eq(schema.settlementAccount.id, accountId)),
    );
    expect(raw!.numberEncrypted.toString('latin1')).not.toContain('1441000123456');
    const alerts = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ purpose: string }>(
        sql`select payload->>'purpose' as purpose from outbox_event
            where type = 'messaging.send' and payload->'recipient'->>'ownerId' = ${owner}`,
      ),
    );
    expect(alerts.rows).toEqual([{ purpose: 'settlement_alert' }]);
    await expect(
      s.approvals.decide(agency.admin, approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    await s.approvals.decide(secondAdmin, approvalId, { decision: 'approve' });
    const approved = await p.accounts.view(agency.admin, accountId);
    expect(approved.status).toBe('cooling_off');
    expect(approved.usableFrom!.getTime() - ctx.clock.now().getTime()).toBe(24 * 3_600_000);
    // The ready job sets it up with each provider now, and activates it only after 24 hours.
    const { again } = await p.accounts.ready(agency.companyId, accountId);
    expect(again?.getTime()).toBe(approved.usableFrom!.getTime());
    expect(await p.accounts.view(agency.admin, accountId)).toMatchObject({
      status: 'cooling_off',
      providerReady: true,
    });
    // Shown in full only with a reason, and audited.
    await expect(p.accounts.reveal(agency.manager, accountId, 'Checking it')).rejects.toThrow();
    expect(
      await p.accounts.reveal(agency.admin, accountId, 'Checking the number with the owner'),
    ).toBe('1441000123456');
    const audited = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_event where action = 'settlement_account.number_revealed' and record_id = ${accountId}`,
      ),
    );
    expect(audited.rows[0]!.n).toBe(1);
  });

  it('says why a pay link cannot go: no agreement for the owner, then no usable account', async () => {
    const owner = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Unset Owner' })
    ).id;
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'UNS',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const leaseId = await lease('Unset Tenant', {
      unitId: Object.values(property.units)[0]!,
      phone: '+233200000611',
      consent: true,
    });
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_agreement',
    });
    await p.accounts.setAgreement(agency.admin, owner, {
      destination: 'owner_account',
      effectiveFrom: today,
    });
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_active_account',
    });
    await p.accounts.setAgreement(agency.admin, owner, {
      destination: 'agency_client_account',
      effectiveFrom: today,
    });
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: true,
    });
  });
});

describe('BC-02 failover', () => {
  it('takes the charge with the second provider when the first is down, only if it settles directly', async () => {
    const leaseId = await lease('Failover Payer');
    const [invoice] = await invoicesOf(leaseId);
    p.primary.failCharges = true;
    try {
      const { intent, reference } = await startMomo(await payLink(invoice!.id), 150_000);
      expect(intent.status).toBe('pending');
      const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, intent.intentId)),
      );
      expect(row!.provider).toBe('second');
      const webhook = await p.second.completeCharge(reference, { status: 'success' });
      expect((await deliverWebhook(ctx, p, 'second', webhook!)).outcome).toBe('posted');
    } finally {
      p.primary.failCharges = false;
    }
  });

  it('with no provider left, shows the landlord’s own instructions and raises an incident', async () => {
    await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .update(schema.company)
        .set({
          settings: sql`settings || ${JSON.stringify({ paymentProviderOrder: ['paystack'], manualPaymentInstructions: 'Pay into GCB 0000 at any branch.' })}::jsonb`,
        })
        .where(eq(schema.company.id, agency.companyId)),
    );
    const leaseId = await lease('Outage Tenant');
    const [invoice] = await invoicesOf(leaseId);
    p.primary.failCharges = true;
    try {
      const { intent } = await startMomo(await payLink(invoice!.id), 150_000);
      expect(intent.status).toBe('failed');
      expect(intent.message).toContain('Pay into GCB 0000 at any branch.');
      expect(p.alerts.some((a) => a.code === 'payments.provider_unavailable')).toBe(true);
    } finally {
      p.primary.failCharges = false;
      await withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx
          .update(schema.company)
          .set({ settings: sql`settings - 'paymentProviderOrder' - 'manualPaymentInstructions'` })
          .where(eq(schema.company.id, agency.companyId)),
      );
    }
  });
});

describe('NFR-SEC payments isolation', () => {
  it('the webhook and reconciliation system functions return ids and amounts only', async () => {
    const rows = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ fn: string; cols: string }>(
        sql`select p.proname as fn, pg_get_function_result(p.oid) as cols from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname in ('payment_intent_by_reference', 'settlement_by_subaccount',
              'provider_payment_refs', 'provider_payments_between', 'companies_with_pending_intents', 'claim_webhook_inbox')
            order by 1`,
      ),
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.fn, r.cols]))).toEqual({
      claim_webhook_inbox: 'TABLE(id uuid, provider text, event_id text)',
      companies_with_pending_intents: 'TABLE(company_id uuid)',
      payment_intent_by_reference: 'TABLE(company_id uuid, intent_id uuid)',
      provider_payment_refs:
        'TABLE(reference text, company_id uuid, payment_id uuid, amount_minor bigint, reversed boolean)',
      provider_payments_between:
        'TABLE(reference text, company_id uuid, payment_id uuid, amount_minor bigint, reversed boolean)',
      settlement_by_subaccount: 'TABLE(company_id uuid, settlement_account_id uuid)',
    });
  });

  it('a tenant sees only their own tenancy’s money and pay link', async () => {
    const other = await moneyCompany(ctx, s, 'landlord', 'Other Landlord');
    const otherOwner = (
      await s.owners.create(other.admin, { kind: 'individual', displayName: 'Other Owner' })
    ).id;
    const otherProperty = await propertyWithUnits(s, other.manager, {
      areaCode: 'ACC',
      propertyPart: 'OTH',
      ownerId: otherOwner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const otherLease = await billedLease(ctx, s, b, other.manager, {
      unitId: Object.values(otherProperty.units)[0]!,
      tenantId: (
        await s.tenants.create(other.manager, { kind: 'individual', displayName: 'Other Tenant' })
      ).tenant.id,
      startDate: today,
      endDate: plusDays(plusMonths(today, 12), -1),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: today,
      billingStartDate: today,
    });
    const intruder = { kind: 'tenant' as const, personId: randomUUID(), companies: [] } as never;
    await expect(p.tenantMoney.billing(intruder, otherLease.id)).rejects.toThrow();
    await expect(p.tenantMoney.payLink(intruder, otherLease.id)).rejects.toThrow();
  });
});
