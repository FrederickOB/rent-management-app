import { createHash, createHmac, randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany, withSystem } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import { PaystackPayments, ProviderError } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { PaymentProviders } from '../src/core/payment-providers';
import { ReconciliationService } from '../src/payments/reconciliation.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  approvedTransfer,
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
  agreementInForce,
  CLIENT,
  deliverWebhook,
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

/**
 * The M4b review's defects (docs/plans/M4b.md, section 5), one test each, named after the
 * requirement it proves. Each failed before its fix.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let secondAdmin: Awaited<ReturnType<typeof staffIn>>;
let ownerA: string;
let ownerB: string;
let propertyA: string;
let propertyB: string;
let units: string[];
let ownerAccount: string;
let agencyAccount: string;

const HOUR = 3_600_000;
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });

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

async function lease(
  name: string,
  options: {
    unitId?: string;
    rent?: number;
    phone?: string;
    consent?: boolean;
    cycle?: 'monthly' | 'quarterly';
    months?: number;
  } = {},
) {
  const l = await billedLease(ctx, s, b, agency.manager, {
    unitId: options.unitId ?? units.shift()!,
    tenantId: await tenant(name, options),
    startDate: today,
    endDate: plusDays(plusMonths(today, options.months ?? 12), -1),
    monthlyRentMinor: options.rent ?? 150_000,
    cycle: options.cycle ?? 'monthly',
    depositMinor: null,
    signedOn: today,
    billingStartDate: today,
  });
  return l.id;
}

const invoicesOf = (leaseId: string) =>
  withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.leaseId, leaseId))
      .orderBy(schema.invoice.dueDate),
  );

async function payLink(invoiceId: string): Promise<string> {
  const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
    p.links.mint(tx, await p.links.invoice(tx, invoiceId)),
  );
  return url.split('/p/')[1]!;
}

const client = () => ({ ...CLIENT, ip: `198.51.100.${Math.floor(Math.random() * 200) + 1}` });

async function startMomo(token: string, amountMinor: number) {
  const intent = await p.page.start(token, client(), {
    amountMinor,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId: randomUUID(),
  });
  return { intent, reference: chargeReference(intent.intentId) };
}

/** A lease paid by MoMo through its pay link, the webhook delivered: the payment row. */
async function paidLease(name: string, amountMinor = 150_000, feesMinor = 0) {
  const leaseId = await lease(name);
  const [invoice] = await invoicesOf(leaseId);
  const { reference } = await startMomo(await payLink(invoice!.id), amountMinor);
  await deliverWebhook(
    ctx,
    p,
    'paystack',
    (await p.primary.completeCharge(reference, { status: 'success', feesMinor }))!,
  );
  const [payment] = await paymentsOf(leaseId);
  return { leaseId, reference, payment: payment! };
}

const paymentsOf = (leaseId: string) =>
  withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx.select().from(schema.payment).where(eq(schema.payment.leaseId, leaseId)),
  );

const subaccountOf = async (accountId: string) =>
  (
    await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select({ code: schema.providerSubaccount.subaccountCode })
        .from(schema.providerSubaccount)
        .where(eq(schema.providerSubaccount.settlementAccountId, accountId)),
    )
  ).find((r) => r.code.startsWith('ACCT_paystack'))!.code;

/** Money paid to a subaccount without our pay page: it waits in the unmatched queue. */
async function unmatchedExternal(accountId: string, amountMinor: number, feesMinor = 0) {
  const external = await p.primary.payExternal({
    subaccountCode: await subaccountOf(accountId),
    amountMinor,
    channel: 'momo',
    feesMinor,
  });
  await deliverWebhook(ctx, p, 'paystack', external.webhook);
  const row = (await b.read.unmatched(agency.manager)).find(
    (u) => u.providerReference === external.reference,
  )!;
  return { reference: external.reference, paymentId: row.paymentId };
}

async function approvedRefund(paymentId: string) {
  const approvalId = await p.queue.requestRefund(agency.accountant, paymentId, {
    reason: 'Paid to us by mistake',
  });
  await s.approvals.decide(agency.admin, approvalId, { decision: 'approve' });
}

const refundOf = async (paymentId: string) =>
  (
    await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select()
        .from(schema.unmatchedRefund)
        .where(eq(schema.unmatchedRefund.paymentId, paymentId)),
    )
  ).at(-1)!;

const p31Entries = (refundId: string) =>
  withCompany(ctx.database, sys(agency.companyId), async (tx) =>
    Number(
      (
        await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entry where rule = 'P31' and idempotency_key = ${`P31:${refundId}`}`,
        )
      ).rows[0]!.n,
    ),
  );

const sumFor = (paymentId: string, account: string) =>
  journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = $2`, [
    paymentId,
    account,
  ]);

const exceptionsWith = (dedupe: string) =>
  withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select()
      .from(schema.reconciliationException)
      .where(sql`${schema.reconciliationException.dedupeKey} like ${`${dedupe}%`}`),
  );

async function settleAll() {
  for (const settlement of await p.primary.settle())
    await p.reconciliation.settlement('paystack', settlement);
}

const reversed = async (paymentId: string) =>
  (
    await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select({ id: schema.paymentReversal.id })
        .from(schema.paymentReversal)
        .where(eq(schema.paymentReversal.paymentId, paymentId)),
    )
  ).length;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
  agency = await moneyCompany(ctx, s, 'agency', 'Review Agency');
  secondAdmin = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second Admin');
  ownerA = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Review Owner A',
      phone: '+233200000701',
    })
  ).id;
  ownerB = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Review Owner B' })
  ).id;
  const a = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'RVA',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 40, bedrooms: 2 }],
  });
  propertyA = a.propertyId;
  units = Object.values(a.units);
  propertyB = (
    await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'RVB',
      ownerId: ownerB,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    })
  ).propertyId;
  ownerAccount = await activeAccount(ctx, s, p, agency.admin, secondAdmin, {
    holder: 'owner',
    ownerId: ownerA,
  });
  agencyAccount = await activeAccount(ctx, s, p, agency.admin, secondAdmin, { holder: 'agency' });
  await agreementInForce(ctx, s, p, agency.admin, secondAdmin, ownerA, 'owner_account');
  await agreementInForce(ctx, s, p, agency.admin, secondAdmin, ownerB, 'agency_client_account');
});

afterAll(async () => {
  await ctx?.close();
});

describe('ADR-008 a management agreement is a settlement change (review item 1)', () => {
  it('needs a second person, alerts the owner, is never back-dated, and takes effect 24 hours after approval', async () => {
    const owner = (
      await s.owners.create(agency.admin, {
        kind: 'individual',
        displayName: 'Agreement Owner',
        phone: '+233200000771',
      })
    ).id;
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'AGR',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const leaseId = await lease('Agreement Tenant', {
      unitId: Object.values(property.units)[0]!,
      phone: '+233200000772',
      consent: true,
    });
    const ownerAlerts = async () =>
      withCompany(ctx.database, sys(agency.companyId), async (tx) =>
        Number(
          (
            await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from outbox_event where payload->'recipient'->>'ownerId' = ${owner} and payload->>'purpose' = 'settlement_alert'`,
            )
          ).rows[0]!.n,
        ),
      );
    await expect(
      p.accounts.setAgreement(agency.admin, owner, {
        destination: 'agency_client_account',
        effectiveFrom: plusDays(today, -1),
      }),
    ).rejects.toThrow(/in the past/);
    const view = await p.accounts.setAgreement(agency.admin, owner, {
      destination: 'agency_client_account',
      effectiveFrom: today,
    });
    // Asked, not done: nothing is in force, and the owner is told.
    expect(view).toMatchObject({
      destination: null,
      openRequest: { destination: 'agency_client_account', effectiveFrom: today },
    });
    expect(await ownerAlerts()).toBe(1);
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_agreement',
    });
    // The person who asked can never approve it.
    await expect(
      s.approvals.decide(agency.admin, view.openRequest!.approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    // Nor can anyone write an agreement around the approvals engine (RA056).
    await expect(
      withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.insert(schema.managementAgreement).values({
          companyId: agency.companyId,
          ownerId: owner,
          destination: 'agency_client_account',
          effectiveFrom: today,
        }),
      ),
    ).rejects.toThrow();
    await s.approvals.decide(secondAdmin, view.openRequest!.approvalId, { decision: 'approve' });
    expect(await ownerAlerts()).toBe(2);
    const approved = (await p.accounts.agreements(agency.admin)).find((x) => x.ownerId === owner)!;
    expect(approved.destination).toBeNull();
    expect(approved.next?.destination).toBe('agency_client_account');
    expect(approved.next!.effectiveFrom > today).toBe(true);
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_agreement',
    });
    // Two days on, it is in force: the link can go, to the agency's client account.
    ctx.clock.advance(49 * HOUR);
    try {
      expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
        available: true,
      });
    } finally {
      ctx.clock.advance(-49 * HOUR);
    }
  });
});

describe('P31 a refund posts only once the provider has made it (review item 2)', () => {
  it('waits while the provider is making it, asks before any retry, and posts on its webhook', async () => {
    const { reference, paymentId } = await unmatchedExternal(agencyAccount, 40_000);
    await approvedRefund(paymentId);
    p.primary.pendingRefunds = true;
    try {
      await runRefunds(ctx, p, agency.companyId);
    } finally {
      p.primary.pendingRefunds = false;
    }
    let refund = await refundOf(paymentId);
    expect(refund.status).toBe('sent');
    expect(await p31Entries(refund.id)).toBe(0);
    expect(await sumFor(paymentId, '2090')).toBe(-40_000);
    // A retry asks first: no second refund is sent (the provider would refuse it).
    await runRefunds(ctx, p, agency.companyId);
    expect((await p.primary.reversals(reference)).filter((r) => r.kind === 'refund')).toHaveLength(
      1,
    );
    expect((await refundOf(paymentId)).status).toBe('sent');
    const webhook = await p.primary.completeRefund(reference, 'processed');
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('refund_refunded');
    refund = await refundOf(paymentId);
    expect(refund.status).toBe('refunded');
    expect(await p31Entries(refund.id)).toBe(1);
    expect(await sumFor(paymentId, '2090')).toBe(0);
    expect(await sumFor(paymentId, '1050')).toBe(0);
    // Our own refund is never a chargeback.
    expect(await p.providerPayments.recordChargeback('paystack', reference)).toBe('ignored');
    expect(await reversed(paymentId)).toBe(0);
  });

  it('posts nothing for a refund the provider failed or refused at once', async () => {
    const first = await unmatchedExternal(agencyAccount, 41_000);
    await approvedRefund(first.paymentId);
    p.primary.pendingRefunds = true;
    try {
      await runRefunds(ctx, p, agency.companyId);
    } finally {
      p.primary.pendingRefunds = false;
    }
    const webhook = await p.primary.completeRefund(first.reference, 'failed');
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('refund_failed');
    const failed = await refundOf(first.paymentId);
    expect(failed.status).toBe('failed');
    expect(await p31Entries(failed.id)).toBe(0);
    expect(await reversed(first.paymentId)).toBe(0);
    expect(await sumFor(first.paymentId, '2090')).toBe(-41_000);
    // The reviewer's probe: the provider answers "failed" straight away.
    const second = await unmatchedExternal(agencyAccount, 33_000);
    await approvedRefund(second.paymentId);
    const original = p.primary.refund.bind(p.primary);
    p.primary.refund = async () => ({ refundReference: 'rf-failed', status: 'failed' as const });
    try {
      await runRefunds(ctx, p, agency.companyId);
    } finally {
      p.primary.refund = original;
    }
    const refused = await refundOf(second.paymentId);
    expect(refused.status).toBe('failed');
    expect(await p31Entries(refused.id)).toBe(0);
  });
});

describe('P22 settlement deducts P31 refunds (review item 3)', () => {
  it('debits the account with the real net and clears provider clearing', async () => {
    await settleAll();
    const { reference, paymentId } = await unmatchedExternal(agencyAccount, 33_000, 500);
    await settleAll();
    await approvedRefund(paymentId);
    await runRefunds(ctx, p, agency.companyId);
    expect((await refundOf(paymentId)).status).toBe('refunded');
    await unmatchedExternal(agencyAccount, 100_000, 500);
    const settlements = await p.primary.settle();
    const mine = settlements.find((x) =>
      x.deductedReferences.some((d) => d.reference === reference),
    )!;
    expect(mine.netMinor).toBe(100_000 - 500 - 33_000);
    expect(await p.reconciliation.settlement('paystack', mine)).toBe(true);
    const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select({ id: schema.providerSettlement.id })
        .from(schema.providerSettlement)
        .where(eq(schema.providerSettlement.settlementRef, mine.settlementId)),
    );
    expect(
      await journalSum(
        ctx,
        agency.companyId,
        `l.settlement_id = $1 and l.account_code in ('1010', '1070')`,
        [row!.id],
      ),
    ).toBe(mine.netMinor);
    expect(await sumFor(paymentId, '1050')).toBe(0);
    expect(await exceptionsWith(`settlement_difference:paystack:${mine.settlementId}`)).toEqual([]);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('BC-12 money refunded to its payer is never also reversed (review item 4)', () => {
  it('is refused by the service and by the database (RA055)', async () => {
    const { paymentId } = await unmatchedExternal(agencyAccount, 44_000);
    await approvedRefund(paymentId);
    await runRefunds(ctx, p, agency.companyId);
    await expect(
      b.money.requestReversal(agency.manager, paymentId, {
        reason: 'wrong_entry',
        note: 'Entered twice',
        moneyNowIn: 'agency_account',
      }),
    ).rejects.toThrow(/refunded to its payer/);
    await expect(
      withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.insert(schema.paymentReversal).values({
          companyId: agency.companyId,
          paymentId,
          reason: 'wrong_entry',
          note: 'Entered twice',
          moneyNowIn: 'provider',
          entryId: randomUUID(),
          valueDate: today,
          accountingDate: today,
        }),
      ),
    ).rejects.toThrow();
    expect(await reversed(paymentId)).toBe(0);
  });
});

describe('P21 a settled provider payment is reversed from where its money is (review item 5)', () => {
  it('wrong lease: reverses out of the owner’s account, then records it again on the right lease', async () => {
    const right = await lease('Right Lease Payer');
    const { leaseId: wrong, payment } = await paidLease('Wrong Lease Payer', 150_000, 2_000);
    // Before it settles, the money is with the provider.
    expect((await b.read.payment(agency.manager, payment.id)).reversalOptions).toEqual([
      'provider',
    ]);
    await settleAll();
    expect((await b.read.payment(agency.manager, payment.id)).reversalOptions).toEqual([
      'owner_account',
    ]);
    await expect(
      b.money.requestReversal(agency.manager, payment.id, {
        reason: 'wrong_lease',
        note: 'Paid against the wrong lease',
        moneyNowIn: 'provider',
      }),
    ).rejects.toThrow(/one of the options/);
    const approvalId = await b.money.requestReversal(agency.manager, payment.id, {
      reason: 'wrong_lease',
      note: 'Paid against the wrong lease',
      moneyNowIn: 'owner_account',
    });
    await s.approvals.decide(agency.accountant, approvalId, { decision: 'approve' });
    // Recorded again where it is now: the owner's account, against the right lease.
    await approvedTransfer(ctx, s, b, agency.manager, agency.admin, {
      leaseId: right,
      receivedInto: 'owner_account',
      amountMinor: 150_000,
      receivedOn: today,
      senderReference: 'MoMo paid to the wrong lease',
    });
    expect(await sumFor(payment.id, '1050')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, right, '1100')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, wrong, '1100')).toBe(150_000);
    // The owner's account holds what the provider paid out (less its fee), and nothing twice.
    expect(
      (await sumFor(payment.id, '1010')) +
        (await journalSum(
          ctx,
          agency.companyId,
          `l.lease_id = $1 and l.account_code = '1010' and l.payment_id <> $2`,
          [right, payment.id],
        )),
    ).toBe(148_000);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('BC-02 settlements read through the Paystack adapter post P22 (review item 6)', () => {
  it('runs the job path end to end: settlements(provider, day) → listSettlements → P22', async () => {
    const { payment, reference } = await paidLease('Adapter Settled', 150_000, 2_925);
    const code = await subaccountOf(ownerAccount);
    const settledAt = new Date(ctx.clock.now().getTime()).toISOString();
    const tx = (ref: string, amount: number) => ({
      id: Math.floor(Math.random() * 1e9),
      status: 'success',
      reference: ref,
      amount,
      currency: 'GHS',
      channel: 'mobile_money',
      created_at: settledAt,
      fees: 0,
    });
    // Paystack's answers, in its documented shapes: two pages of the settlement's charges.
    const answers: Record<string, unknown> = {
      'GET /settlement': {
        status: true,
        data: [
          {
            id: 9_100_001,
            status: 'success',
            currency: 'GHS',
            total_amount: 150_000 + 1_000,
            total_fees: 2_925,
            effective_amount: 151_000 - 2_925,
            deductions: 0,
            settlement_date: settledAt,
            subaccount: { subaccount_code: code },
          },
        ],
        meta: { page: 1, pageCount: 1 },
      },
      'GET /settlement/9100001/transactions#1': {
        status: true,
        data: [tx('pi-stranger-on-page-one', 1_000)],
        meta: { page: 1, pageCount: 2 },
      },
      'GET /settlement/9100001/transactions#2': {
        status: true,
        data: [tx(reference, 150_000)],
        meta: { page: 2, pageCount: 2 },
      },
      'GET /transaction': { status: true, data: [], meta: { page: 1, pageCount: 1 } },
      'GET /refund': { status: true, data: [], meta: { page: 1, pageCount: 1 } },
      'GET /dispute': { status: true, data: [], meta: { page: 1, pageCount: 1 } },
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const page = url.searchParams.get('page');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const body = answers[`${key}#${page}`] ?? answers[key];
      return body
        ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
        : new Response('{"status":false,"message":"Not found"}', { status: 404 });
    }) as typeof fetch;
    const reconciliation = new ReconciliationService(
      ctx.database,
      new PaymentProviders([
        {
          name: 'paystack',
          port: new PaystackPayments({
            secretKey: 'sk_test_adapter_path',
            liveCollection: 'disabled',
            baseUrl: 'https://api.paystack.test',
            fetch: fetchImpl,
          }),
          settlesDirect: true,
        },
      ]),
      b.posting,
      p.providerPayments,
      p.alertPort,
      p.logger,
    );
    expect(await reconciliation.settlements('paystack', today)).toBe(1);
    expect(await sumFor(payment.id, '1050')).toBe(0);
    expect((await sumFor(payment.id, '1010')) + (await sumFor(payment.id, '5200'))).toBe(150_000);
    // The stranger on the first page is ours to look into.
    expect(await exceptionsWith('settlement_difference:paystack:9100001')).toHaveLength(1);
  });
});

describe('BC-02 a charge in another currency is never posted (review item 7)', () => {
  it('leaves it for a person on every path: webhook, pay-page intent and reconciliation', async () => {
    const usd = <T extends { currency: string }>(v: T): T => ({ ...v, currency: 'USD' });
    const verify = p.primary.verifyTransaction.bind(p.primary);
    // Money with no intent.
    const external = await p.primary.payExternal({
      subaccountCode: await subaccountOf(agencyAccount),
      amountMinor: 25_000,
      channel: 'card',
    });
    p.primary.verifyTransaction = async (ref) => usd(await verify(ref));
    try {
      expect((await deliverWebhook(ctx, p, 'paystack', external.webhook)).outcome).toBe(
        'currency_differs',
      );
    } finally {
      p.primary.verifyTransaction = verify;
    }
    expect(
      (await b.read.unmatched(agency.manager)).some(
        (u) => u.providerReference === external.reference,
      ),
    ).toBe(false);
    expect(await exceptionsWith(`currency_differs:paystack:${external.reference}`)).toHaveLength(1);
    // A pay-page intent.
    const leaseId = await lease('Dollar Payer');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    const webhook = (await p.primary.completeCharge(reference, { status: 'success' }))!;
    p.primary.verifyTransaction = async (ref) => usd(await verify(ref));
    try {
      expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('rejected');
    } finally {
      p.primary.verifyTransaction = verify;
    }
    expect(await paymentsOf(leaseId)).toEqual([]);
    expect(await exceptionsWith(`currency_differs:paystack:${reference}`)).toHaveLength(1);
    // Reconciliation, for a charge we never heard of.
    const lost = await p.primary.payExternal({
      subaccountCode: await subaccountOf(agencyAccount),
      amountMinor: 26_000,
      channel: 'card',
    });
    const list = p.primary.listTransactions.bind(p.primary);
    p.primary.listTransactions = async (range) =>
      (await list(range)).map((t) => (t.reference === lost.reference ? usd(t) : t));
    p.primary.verifyTransaction = async (ref) =>
      ref === lost.reference ? usd(await verify(ref)) : verify(ref);
    try {
      await p.reconciliation.transactions('paystack', today);
    } finally {
      p.primary.listTransactions = list;
      p.primary.verifyTransaction = verify;
    }
    expect(
      (await b.read.unmatched(agency.manager)).some((u) => u.providerReference === lost.reference),
    ).toBe(false);
    expect(await exceptionsWith(`currency_differs:paystack:${lost.reference}`)).toHaveLength(1);
  });
});

describe('P22 a settlement that pays out less than nothing still posts (review item 8)', () => {
  it('posts the negative net and raises it, without losing the rest of the report', async () => {
    const { payment: chargedBack, reference } = await paidLease('Charged Back Later', 44_000);
    await settleAll();
    expect(
      (await deliverWebhook(ctx, p, 'paystack', await p.primary.chargeback(reference))).outcome,
    ).toBe('reversed');
    const { paymentId: small } = await unmatchedExternal(ownerAccount, 44_000, 500);
    const settlements = await p.primary.settle();
    const mine = settlements.find((x) =>
      x.deductedReferences.some((d) => d.reference === reference),
    )!;
    expect(mine.netMinor).toBe(-500);
    expect(await p.reconciliation.settlement('paystack', mine)).toBe(true);
    expect(await sumFor(small, '1050')).toBe(0);
    expect(await sumFor(chargedBack.id, '1050')).toBe(0);
    const [problem] = await exceptionsWith(`settlement_difference:paystack:${mine.settlementId}`);
    expect(problem!.detail).toMatch(/paid out nothing/);
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('AR-02 spare credit pays debt a reversal reopened (review F4)', () => {
  it('a bounced cheque’s month is paid at once from the tenant’s other credit', async () => {
    const leaseId = await lease('Bounced Cheque Tenant', { rent: 100_000 });
    const cheque = await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId,
      amountMinor: 100_000,
      receivedOn: today,
      method: 'cheque',
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId,
      amountMinor: 300_000,
      receivedOn: today,
    });
    const [chequePayment] = (await paymentsOf(leaseId)).filter(
      (x) => x.sourceId === cheque.cashRecordId,
    );
    const approvalId = await b.money.requestReversal(agency.manager, chequePayment!.id, {
      reason: 'bounced_cheque',
      note: 'Returned unpaid by the bank',
      moneyNowIn: 'owner_account',
    });
    await s.approvals.decide(agency.accountant, approvalId, { decision: 'approve' });
    const card = await moneyCard(ctx, b, agency.companyId, leaseId);
    expect(await leaseAccount(ctx, agency.companyId, leaseId, '1100')).toBe(0);
    expect(card.earnedUnpaidMinor).toBe(0);
    expect(card.overdueMinor).toBe(0);
    // What the cash paid beyond the first month is still held ahead, in prepayments.
    expect(await leaseAccount(ctx, agency.companyId, leaseId, '2010')).toBe(-200_000);
    expect(card.paidUntil).not.toBeNull();
    expect((await b.subledger.check(agency.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('BC-08 an invoice covered by credit is never overdue (review F5)', () => {
  it('lists a quarter paid ahead as not overdue once its first month has started', async () => {
    const leaseId = await lease('Quarter Ahead', { rent: 100_000, cycle: 'quarterly' });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId,
      amountMinor: 600_000,
      receivedOn: today,
    });
    const quarter2 = plusMonths(today, 3);
    const later = plusDays(quarter2, 5);
    const ms = (to: string) => Date.parse(`${to}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`);
    ctx.clock.advance(ms(later));
    try {
      await b.invoicing.generateAll(agency.companyId, later);
      await b.invoicing.accrueAll(agency.companyId, later);
      const rows = await b.read.invoices(agency.manager, { leaseId });
      const second = rows.find((r) => r.dueDate === quarter2)!;
      expect(second).toBeTruthy();
      expect(second.overdue).toBe(false);
      expect(second.outstandingMinor).toBe(0);
      expect(await b.read.invoices(agency.manager, { leaseId, overdue: true })).toEqual([]);
    } finally {
      ctx.clock.advance(-ms(later));
    }
  });
});

describe('Invariant 11 provider clearing agrees with the provider (review item 11)', () => {
  it('raises a difference when our clearing and the provider’s unsettled balance part', async () => {
    const owner = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Clearing Owner' })
    ).id;
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'CLR',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const account = await activeAccount(ctx, s, p, agency.admin, secondAdmin, {
      holder: 'owner',
      ownerId: owner,
    });
    await agreementInForce(ctx, s, p, agency.admin, secondAdmin, owner, 'owner_account');
    const leaseId = await lease('Clearing Tenant', { unitId: Object.values(property.units)[0]! });
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(reference, { status: 'success' }))!,
    );
    await p.reconciliation.clearing('paystack', today);
    expect(await exceptionsWith(`clearing:paystack:${account}`)).toEqual([]);
    // The provider pays it out, and we never hear of the settlement: the two part.
    await p.primary.settle();
    await p.reconciliation.clearing('paystack', today);
    const [difference] = await exceptionsWith(`clearing:paystack:${account}`);
    expect(difference).toMatchObject({ kind: 'settlement_difference', amountMinor: 150_000 });
  });
});

describe('BC-02 failover never follows a lost answer (review item 12)', () => {
  it('asks the first provider for the charge before trying another', async () => {
    const leaseId = await lease('Lost Answer');
    const [invoice] = await invoicesOf(leaseId);
    const token = await payLink(invoice!.id);
    const original = p.primary.initialiseCharge.bind(p.primary);
    p.primary.initialiseCharge = async (request) => {
      await original(request);
      throw new ProviderError('paystack', 'request failed (TimeoutError)', true);
    };
    let reference: string;
    try {
      reference = (await startMomo(token, 150_000)).reference;
    } finally {
      p.primary.initialiseCharge = original;
    }
    await expect(p.second.verify(reference)).rejects.toThrow();
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(reference, { status: 'success' }))!,
    );
    expect(await paymentsOf(leaseId)).toHaveLength(1);
    // A request the first provider never took (it has no such charge): the second may take it.
    const other = await lease('Never Reached');
    const [otherInvoice] = await invoicesOf(other);
    p.primary.initialiseCharge = async () => {
      throw new ProviderError('paystack', 'request failed (TimeoutError)', true);
    };
    let second: string;
    try {
      second = (await startMomo(await payLink(otherInvoice!.id), 150_000)).reference;
    } finally {
      p.primary.initialiseCharge = original;
    }
    expect((await p.second.verify(second)).status).toBe('pending');
  });
});

describe('NFR-SEC a flood of bad webhooks is refused and keeps no bodies (review item 13)', () => {
  it('rate-limits each address, stores only size and hash, batches the alert, caps the size', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 1 } }));
    const before = p.alerts.filter((a) => a.code === 'payments.webhook_bad_signature').length;
    const results: string[] = [];
    for (let i = 0; i < 25; i += 1)
      results.push(
        await p.webhooks.intake('paystack', body, { 'x-paystack-signature': 'bad' }, '192.0.2.77'),
      );
    expect(results.slice(0, 20).every((r) => r === 'rejected')).toBe(true);
    expect(results.slice(20).every((r) => r === 'rate_limited')).toBe(true);
    const hash = createHash('sha256').update(body).digest('hex');
    const rows = await withSystem(ctx.database, {}, (tx) =>
      tx.select().from(schema.webhookInbox).where(eq(schema.webhookInbox.bodySha256, hash)),
    );
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.rawBody === null && r.bodyBytes === body.length)).toBe(true);
    expect(JSON.stringify(rows[0]!.headers)).not.toContain('192.0.2.77');
    expect(p.alerts.filter((a) => a.code === 'payments.webhook_bad_signature').length).toBe(
      before + 1,
    );
    // Larger than any provider event: refused, even signed.
    const huge = Buffer.from(JSON.stringify({ event: 'x', pad: 'x'.repeat(70 * 1024) }));
    const signature = createHmac('sha512', 'sk_test_primary').update(huge).digest('hex');
    expect(
      await p.webhooks.intake(
        'paystack',
        huge,
        { 'x-paystack-signature': signature },
        '192.0.2.78',
      ),
    ).toBe('too_large');
  });
});

describe('BC-04 the card return page carries no pay-link token (review item 14)', () => {
  it('sends the provider a return address with the charge reference only, and shows status', async () => {
    const leaseId = await lease('Card Returner');
    const [invoice] = await invoicesOf(leaseId);
    const token = await payLink(invoice!.id);
    const original = p.primary.initialiseCharge.bind(p.primary);
    let callback: string | undefined;
    p.primary.initialiseCharge = async (request) => {
      callback = request.callbackUrl;
      return original(request);
    };
    let reference: string;
    try {
      const intent = await p.page.start(token, client(), {
        amountMinor: 150_000,
        method: 'card',
        submissionId: randomUUID(),
      });
      reference = chargeReference(intent.intentId);
    } finally {
      p.primary.initialiseCharge = original;
    }
    expect(callback).toBe(`${ctx.config.LINKS_ORIGIN}/p/return?reference=${reference}`);
    expect(callback).not.toContain(token);
    let view = await p.page.returned(reference, client());
    expect(Object.keys(view).sort()).toEqual(['failureCode', 'message', 'receiptNumber', 'status']);
    expect(view.status).toBe('pending');
    await p.primary.completeCharge(reference, { status: 'success' });
    view = await p.page.returned(reference, client());
    expect(view.status).toBe('confirmed');
    expect(view.receiptNumber).toBeTruthy();
    await expect(p.page.returned(`pi-${'0'.repeat(32)}`, client())).rejects.toThrow();
  });
});

describe('AR-05 the pay page keeps to the advance rent limit (review item 15)', () => {
  it('caps the amount under block, accepts and flags it under warn, and leaves off alone', async () => {
    const leaseId = await lease('Advance Payer');
    const [invoice] = await invoicesOf(leaseId);
    const token = await payLink(invoice!.id);
    const setPolicy = (advanceRentPolicy: string) =>
      withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx
          .update(schema.company)
          .set({
            settings: sql`${schema.company.settings} || ${JSON.stringify({ advanceRentPolicy })}::jsonb`,
          })
          .where(eq(schema.company.id, agency.companyId)),
      );
    try {
      expect((await p.page.open(token, client())).advance).toBeNull();
      await setPolicy('block');
      const blocked = await p.page.open(token, client());
      // A twelve-month lease: Act 220 s.25(5)'s six months (unverified) beyond what is due now.
      expect(blocked.advance).toMatchObject({ policy: 'block', limitMonths: 6 });
      expect(blocked.advance!.capMinor).toBe(150_000 + 6 * 150_000);
      expect(blocked.amounts.maxMinor).toBe(blocked.advance!.capMinor);
      await expect(startMomo(token, 1_200_000)).rejects.toThrow(/more than/);
      await setPolicy('warn');
      const warned = await p.page.open(token, client());
      expect(warned.advance?.policy).toBe('warn');
      expect(warned.amounts.maxMinor).toBe(150_000 * 12);
      const { intent } = await startMomo(token, 1_200_000);
      const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, intent.intentId)),
      );
      expect(row).toMatchObject({ advanceOverLimit: true, advanceLimitMonths: 6 });
    } finally {
      await setPolicy('off');
    }
  });
});

describe('BC-02 reconciliation catches a reversal whose webhook never came (review item 16)', () => {
  it('reverses a charged-back payment found by the daily run', async () => {
    const { payment, reference } = await paidLease('Silent Chargeback');
    await p.primary.chargeback(reference);
    await p.reconciliation.transactions('paystack', today);
    expect(await reversed(payment.id)).toBe(1);
  });

  it('settles a payment posted after its settlement was reconciled', async () => {
    const leaseId = await lease('Posted Late');
    const [invoice] = await invoicesOf(leaseId);
    const { reference } = await startMomo(await payLink(invoice!.id), 150_000);
    await p.primary.completeCharge(reference, { status: 'success' });
    const settlements = await p.primary.settle();
    const mine = settlements.find((x) => x.references.includes(reference))!;
    await p.reconciliation.settlement('paystack', mine);
    expect(await paymentsOf(leaseId)).toEqual([]);
    await p.reconciliation.transactions('paystack', today);
    const [payment] = await paymentsOf(leaseId);
    expect(payment).toBeTruthy();
    expect(await sumFor(payment!.id, '1050')).toBe(0);
    expect(await sumFor(payment!.id, '1010')).toBe(150_000);
  });
});

describe('P21 a part refund or chargeback is left for a person (review item 17)', () => {
  it('reverses nothing and raises the part taken back', async () => {
    const { payment, reference } = await paidLease('Part Chargeback');
    const webhook = await p.primary.chargeback(reference, 50_000);
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('partial');
    expect(await reversed(payment.id)).toBe(0);
    const [problem] = await exceptionsWith(`partial_reversal:paystack:${reference}`);
    expect(problem).toMatchObject({ kind: 'not_successful_at_provider', amountMinor: 50_000 });
  });
});

describe('BC-02 a step the network asks for that we cannot take fails clearly (review item 19)', () => {
  it('fails the payment with a code the page knows, for an OTP step and for a failed charge', async () => {
    const original = p.primary.initialiseCharge.bind(p.primary);
    for (const [answer, code] of [
      [{ status: 'pending' as const, unsupportedStep: 'send_otp' }, 'PROVIDER_STEP_UNSUPPORTED'],
      [{ status: 'failed' as const }, 'PROVIDER_CHARGE_FAILED'],
    ] as const) {
      const leaseId = await lease(`Network ${code}`);
      const [invoice] = await invoicesOf(leaseId);
      p.primary.initialiseCharge = async (request) => ({
        provider: 'paystack',
        providerReference: request.reference,
        ...answer,
      });
      try {
        const { intent } = await startMomo(await payLink(invoice!.id), 150_000);
        expect(intent).toMatchObject({ status: 'failed', failureCode: code });
      } finally {
        p.primary.initialiseCharge = original;
      }
    }
  });
});

describe('AD-02 chargeback alerts go only to people who see the property (review item 20)', () => {
  it('tells a manager of that property, never one of another', async () => {
    const here = await staffIn(ctx, agency.companyId, 'agency', 'property_manager', 'Here', {
      properties: [propertyA],
    });
    const elsewhere = await staffIn(
      ctx,
      agency.companyId,
      'agency',
      'property_manager',
      'Elsewhere',
      { properties: [propertyB] },
    );
    const { payment, reference } = await paidLease('Alerted Chargeback');
    await deliverWebhook(ctx, p, 'paystack', await p.primary.chargeback(reference));
    const told = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ person: string }>(
        sql`select payload->'recipient'->>'personId' as person from outbox_event
            where payload->'related'->>'id' = ${payment.id} and payload->>'purpose' = 'staff_notice'`,
      ),
    );
    const people = told.rows.map((r) => r.person);
    expect(people).toContain(here.personId);
    expect(people).toContain(agency.admin.personId);
    expect(people).not.toContain(elsewhere.personId);
  });
});

describe('TL-12 a tenant of another lease in the same company sees none of this tenancy (review)', () => {
  it('refuses the money card, the pay link and the receipts of a neighbour’s lease', async () => {
    const { leaseId: theirs } = await paidLease('Neighbour Payer');
    const mine = await lease('Nosy Neighbour', { phone: '+233200000781' });
    const [row] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ person_id: string }>(
        sql`select t.person_id from lease l join tenant t on t.id = l.tenant_id where l.id = ${mine}`,
      ),
    ).then((r) => r.rows);
    const intruder = {
      kind: 'tenant' as const,
      personId: row!.person_id,
      authMethod: 'phone_otp' as const,
    };
    expect((await p.tenantMoney.billing(intruder, mine)).leaseId).toBe(mine);
    await expect(p.tenantMoney.billing(intruder, theirs)).rejects.toMatchObject({ status: 404 });
    await expect(p.tenantMoney.payLink(intruder, theirs)).rejects.toMatchObject({ status: 404 });
    const visible = await p.tenantMoney.payments(intruder);
    expect(visible.some((x) => x.leaseId === theirs)).toBe(false);
    const [receipt] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.receipt).where(eq(schema.receipt.leaseId, theirs)),
    );
    await expect(p.tenantMoney.receiptDownload(intruder, receipt!.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('BC-07 one charge reported every way at once posts once (review)', () => {
  it('races the webhook, the status poll and verify-pending, then a second event id', async () => {
    const leaseId = await lease('Raced Payer');
    const [invoice] = await invoicesOf(leaseId);
    const token = await payLink(invoice!.id);
    const { intent, reference } = await startMomo(token, 150_000);
    const webhook = (await p.primary.completeCharge(reference, { status: 'success' }))!;
    ctx.clock.advance(6 * 60_000);
    try {
      await Promise.all([
        deliverWebhook(ctx, p, 'paystack', webhook),
        p.page.status(token, client(), intent.intentId),
        p.providerPayments.verifyPending(agency.companyId),
        p.providerPayments.processReference('paystack', reference),
      ]);
    } finally {
      ctx.clock.advance(-6 * 60_000);
    }
    // Paystack resends the same charge under another event id.
    const event = JSON.parse(webhook.rawBody) as { data: { id: number } };
    event.data.id += 1_000_000;
    const raw = JSON.stringify(event);
    const again = await deliverWebhook(ctx, p, 'paystack', {
      rawBody: raw,
      headers: {
        'x-paystack-signature': createHmac('sha512', 'sk_test_primary').update(raw).digest('hex'),
      },
    });
    expect(again).toMatchObject({ intake: 'stored', outcome: 'already_posted' });
    const posted = await paymentsOf(leaseId);
    expect(posted).toHaveLength(1);
    const receipts = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.receipt).where(eq(schema.receipt.paymentId, posted[0]!.id)),
    );
    expect(receipts).toHaveLength(1);
  });
});

describe('ADR-008 a new account is used only after its 24 hours (review)', () => {
  it('refuses the pay link while it waits, and activates once 24 hours have passed', async () => {
    const owner = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Waiting Owner' })
    ).id;
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'WAI',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    await agreementInForce(ctx, s, p, agency.admin, secondAdmin, owner, 'owner_account');
    const leaseId = await lease('Waiting Tenant', {
      unitId: Object.values(property.units)[0]!,
      phone: '+233200000791',
      consent: true,
    });
    const ask = async (accountNumber: string) =>
      p.accounts.request(agency.admin, {
        holder: 'owner',
        ownerId: owner,
        bankCode: 'FAKEBANK1',
        accountNumber,
        accountName: 'Waiting Owner',
      });
    // Approved now: it waits its 24 hours, and the link cannot go.
    const waiting = await ask('0123456781');
    await s.approvals.decide(secondAdmin, waiting.approvalId, { decision: 'approve' });
    expect(await p.accounts.ready(agency.companyId, waiting.accountId)).toMatchObject({
      again: expect.any(Date),
    });
    expect((await p.accounts.view(agency.admin, waiting.accountId)).status).toBe('cooling_off');
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_active_account',
    });
    // The database itself holds the 24 hours, whatever the application's clock says (RA051).
    ctx.clock.advance(25 * HOUR);
    try {
      await expect(p.accounts.ready(agency.companyId, waiting.accountId)).rejects.toThrow();
    } finally {
      ctx.clock.advance(-25 * HOUR);
    }
    // Approved 25 hours ago: past its 24 hours, it still takes nothing until the ready job
    // activates it; then the link can go.
    ctx.clock.advance(-25 * HOUR);
    let past: { accountId: string; approvalId: string };
    try {
      past = await ask('0123456782');
      await s.approvals.decide(secondAdmin, past.approvalId, { decision: 'approve' });
    } finally {
      ctx.clock.advance(25 * HOUR);
    }
    expect((await p.accounts.view(agency.admin, past.accountId)).status).toBe('cooling_off');
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: false,
      reason: 'no_active_account',
    });
    expect(await p.accounts.ready(agency.companyId, past.accountId)).toEqual({ again: null });
    expect((await p.accounts.view(agency.admin, past.accountId)).status).toBe('active');
    expect((await moneyCard(ctx, b, agency.companyId, leaseId)).payLink).toMatchObject({
      available: true,
    });
  });
});
