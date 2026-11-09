import { schema, sql, withCompany } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { prepaidDrawLines, subscriptionPostingKeys } from '@rent/domain/ledger';
import { monthOf, previousMonth, shiftMonth } from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { IdempotencyStore, requestHash } from '../src/core/idempotency';
import { PlatformChargesUnavailable } from '../src/payments/platform-charges';
import { WebhooksService } from '../src/payments/webhooks.service';
import { platformBookId, withPlatform } from '../src/subscription/platform';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  claimInbox,
  deliverWebhook,
  paymentsServices,
  type PaymentsServices,
} from './support/payments';
import {
  openInvoice,
  subscribe,
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M10 paying (plan 4.4; decisions 7, 9 and 11), on the services with real PostgreSQL and RLS:
 * the platform's own charges by card and MoMo on the fake provider, the webhook routed by its
 * `SUB-` reference and verified before anything posts, P26 in the platform book, allocation oldest
 * first, gap-free receipts with their PDF, full access restored on payment, annual prepayment,
 * reconciliation and settlement of the platform's balance, reversals, the nightly sub-ledger
 * check, and no rent in the platform book nor subscription money anywhere else (D1).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let platformId: string;
let today: string;
let month: string;

type Company = Awaited<ReturnType<typeof moneyCompany>>;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const seq = (number: string) => Number(number.split('-')[2]);
const readOnly = <T extends object>(actor: T) => ({
  ...actor,
  subscriptionAccess: 'read_only' as const,
});

async function subscriber(name: string, kind: 'agency' | 'landlord' = 'agency') {
  const c = await moneyCompany(ctx, s, kind, name);
  await subscribe(ctx, sp, c.companyId);
  return c;
}

/** Refreshes the subscription as the lifecycle job would, returning what holds now. */
async function refresh(companyId: string) {
  return withPlatform(ctx.database, {}, async (tx, platform) => {
    const company = await sp.core.subscriberCompany(tx, companyId);
    const sub = await sp.core.find(tx, companyId);
    return sp.core.refresh(tx, platform, sub!, company!);
  });
}

/** A company in arrears beyond the grace period: read-only (decision 11). */
async function inArrears(c: Company, totalMinor = 10_000) {
  const invoice = await openInvoice(ctx, b.posting, c.companyId, {
    month: shiftMonth(month, -2),
    totalMinor,
    issuedOn: plusDays(today, -40),
    dueOn: plusDays(today, -33),
  });
  expect(await refresh(c.companyId)).toMatchObject({ status: 'read_only', access: 'read_only' });
  return invoice;
}

async function access(companyId: string) {
  const [row] = await asSuperuser(ctx, 'select access, plan from company where id = $1', [
    companyId,
  ]);
  return row as { access: string; plan: string };
}

async function statusOf(companyId: string) {
  const [row] = await asSuperuser(
    ctx,
    'select status from subscription where subscriber_company_id = $1',
    [companyId],
  );
  return (row as { status: string }).status;
}

async function paymentRow(id: string) {
  const [row] = await asSuperuser(ctx, 'select * from subscription_payment where id = $1', [id]);
  return row as Record<string, unknown>;
}

async function invoiceRow(id: string) {
  const [row] = await asSuperuser(
    ctx,
    'select status, paid_at from subscription_invoice where id = $1',
    [id],
  );
  return row as { status: string; paid_at: Date | null };
}

/** An entry's lines by key, with the kind of book each sits in. */
async function entryLines(key: string) {
  return (await asSuperuser(
    ctx,
    `select l.account_code, l.amount_minor::bigint as amount, l.invoice_line_id, l.payment_id,
            b.kind as book_kind, e.rule
       from journal_line l
       join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
       join book b on b.company_id = l.company_id and b.id = l.book_id
      where e.idempotency_key = $1 order by l.line_no`,
    [key],
  )) as {
    account_code: string;
    amount: number;
    invoice_line_id: string | null;
    payment_id: string | null;
    book_kind: string;
    rule: string;
  }[];
}

async function receiptOf(paymentId: string) {
  const [row] = await asSuperuser(
    ctx,
    'select id, number, render_request_id, document_id, sha256 from subscription_receipt where payment_id = $1',
    [paymentId],
  );
  return row as
    | {
        id: string;
        number: string;
        render_request_id: string;
        document_id: string | null;
        sha256: string | null;
      }
    | undefined;
}

/** The platform book's balance in an account, from the journal. */
async function platformBalance(account: string) {
  const [row] = await asSuperuser(
    ctx,
    `select coalesce(sum(l.amount_minor), 0)::bigint as total from journal_line l
       join book b on b.company_id = l.company_id and b.id = l.book_id
      where b.kind = 'platform' and l.account_code = $1`,
    [account],
  );
  return Number((row as { total: string }).total);
}

/** Pays every open invoice by card and completes the charge, returning the payment and webhook. */
async function paidByCard(c: Company, options: { feesMinor?: number } = {}) {
  const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
  const webhook = await p.primary.completeCharge(started.reference, {
    status: 'success',
    ...(options.feesMinor === undefined ? {} : { feesMinor: options.feesMinor }),
  });
  return { started, webhook: webhook! };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  sp = subscriptionPaymentsServices(ctx, s, b, p);
  platformId = await company(ctx, 'platform', 'Rent Platform');
  today = isoNow(ctx.clock, 'Africa/Accra');
  month = monthOf(today);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

let cardCompany: Company;
let cardPayment: Awaited<ReturnType<typeof paidByCard>>;

describe('PB-07 subscription payment by card and MoMo on the fake provider', () => {
  it('★ card: webhook, verified, P26 balanced in the platform book, oldest first, invoices paid, receipt, access restored at once', async () => {
    cardCompany = await subscriber('Card Agency');
    const older = await openInvoice(ctx, b.posting, cardCompany.companyId, {
      month: shiftMonth(month, -2),
      totalMinor: 10_000,
      issuedOn: plusDays(today, -40),
      dueOn: plusDays(today, -33),
    });
    const newer = await openInvoice(ctx, b.posting, cardCompany.companyId, {
      month: previousMonth(month),
      totalMinor: 15_000,
      issuedOn: plusDays(today, -8),
      dueOn: plusDays(today, -1),
    });
    expect(await refresh(cardCompany.companyId)).toMatchObject({ access: 'read_only' });
    expect((await access(cardCompany.companyId)).access).toBe('read_only');

    // Paying works while read-only (decision 11).
    const started = await sp.payments.pay(readOnly(cardCompany.admin), {
      purpose: 'invoices',
      channel: 'card',
    });
    expect(started).toMatchObject({
      purpose: 'invoices',
      channel: 'card',
      amountMinor: 25_000,
      status: 'pending',
      checkoutUrl: expect.stringMatching(/^https:\/\//),
      message: null,
      receiptId: null,
    });
    expect(started.reference).toMatch(/^SUB-[0-9a-f]{32}$/);
    // The charge names no subaccount: the platform's own balance (decision 9).
    expect((await p.primary.verifyTransaction(started.reference)).subaccountCode).toBe('');

    const webhook = await p.primary.completeCharge(started.reference, {
      status: 'success',
      feesMinor: 400,
    });
    cardPayment = { started, webhook: webhook! };
    expect(await deliverWebhook(ctx, p, 'paystack', webhook!)).toEqual({
      intake: 'stored',
      outcome: 'posted',
    });

    // P26 balances, in the platform book only: Dr 1050; Cr 1100 per invoice, oldest first.
    const lines = await entryLines(subscriptionPostingKeys.payment(started.id));
    expect(lines.every((l) => l.book_kind === 'platform' && l.rule === 'P26')).toBe(true);
    expect(lines.reduce((sum, l) => sum + Number(l.amount), 0)).toBe(0);
    expect(lines.map((l) => [l.account_code, Number(l.amount), l.invoice_line_id])).toEqual([
      ['1050', 25_000, null],
      ['1100', -10_000, older.id],
      ['1100', -15_000, newer.id],
    ]);
    const allocations = await asSuperuser(
      ctx,
      `select invoice_id, amount_minor::bigint as amount, source from subscription_allocation
        where payment_id = $1 order by amount_minor`,
      [started.id],
    );
    expect(allocations).toEqual([
      { invoice_id: older.id, amount: 10_000, source: 'payment' },
      { invoice_id: newer.id, amount: 15_000, source: 'payment' },
    ]);
    for (const invoice of [older, newer])
      expect(await invoiceRow(invoice.id)).toMatchObject({
        status: 'paid',
        paid_at: expect.any(Date),
      });

    // Paying in full restores full access at once (decision 11).
    expect((await access(cardCompany.companyId)).access).toBe('full');
    expect(await statusOf(cardCompany.companyId)).toBe('active');

    const receipt = await receiptOf(started.id);
    expect(receipt?.number).toMatch(/^SUBR-\d{4}-\d{6}$/);
    expect(await sp.payments.payment(cardCompany.accountant, started.id)).toMatchObject({
      status: 'succeeded',
      receiptId: receipt!.id,
    });
    expect(await sp.payments.receipts(cardCompany.admin)).toEqual([
      {
        id: receipt!.id,
        number: receipt!.number,
        paidOn: today,
        amountMinor: 25_000,
        channel: 'card',
        purpose: 'invoices',
        invoiceNumbers: [older.number, newer.number],
        hasDocument: false,
      },
    ]);

    // The PDF: 409 while it renders; then rendered from the platform's letterhead and recorded.
    await expect(sp.payments.receiptDocument(cardCompany.admin, receipt!.id)).rejects.toMatchObject(
      { status: 409, code: 'document_rendering' },
    );
    await s.documents.renderRequested(
      platformId,
      receipt!.render_request_id,
      async () => SAMPLE_PDF,
    );
    expect(await sp.payments.onDocumentRendered(platformId, receipt!.render_request_id)).toBe(true);
    expect(await sp.payments.onDocumentRendered(platformId, receipt!.render_request_id)).toBe(
      false,
    );
    expect((await receiptOf(started.id))?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const link = await sp.payments.receiptDocument(cardCompany.admin, receipt!.id);
    expect(link.url).toEqual(expect.any(String));
    expect(link.expiresAt.getTime()).toBeGreaterThan(ctx.clock.now().getTime());

    // The company's admins are told, in its own context; the subscriber's chain records it.
    const notices = await withCompany(
      ctx.database,
      { companyId: cardCompany.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ payload: schema.outboxEvent.payload })
          .from(schema.outboxEvent)
          .where(sql`${schema.outboxEvent.type} = 'messaging.send'`),
    );
    expect(notices.map((n) => n.payload)).toContainEqual(
      expect.objectContaining({
        purpose: 'staff_notice',
        recipient: { type: 'staff', personId: cardCompany.admin.personId },
        related: { type: 'subscription_receipt', id: receipt!.id },
      }),
    );
    expect(
      await asSuperuser(
        ctx,
        `select 1 from audit_event where company_id = $1 and action = 'subscription.payment_received'`,
        [cardCompany.companyId],
      ),
    ).toHaveLength(1);
  });

  it('★ MoMo: the prompt goes to the phone; the next receipt number follows without a gap', async () => {
    const c = await subscriber('Momo Landlord', 'landlord');
    const invoice = await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 5_000,
      issuedOn: plusDays(today, -3),
      dueOn: plusDays(today, 4),
    });
    await expect(
      sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'momo' }),
    ).rejects.toMatchObject({ status: 400, code: 'momo_phone' });
    const started = await sp.payments.pay(c.admin, {
      purpose: 'invoices',
      channel: 'momo',
      momoPhone: '024 000 0007',
      momoProvider: 'vodafone',
    });
    expect(started).toMatchObject({
      channel: 'momo',
      amountMinor: 5_000,
      status: 'pending',
      checkoutUrl: null,
      message: 'Approve the payment on your phone',
    });
    expect((await p.primary.verify(started.reference)).channel).toBe('momo');
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
    expect((await invoiceRow(invoice.id)).status).toBe('paid');
    const receipt = await receiptOf(started.id);
    expect(seq(receipt!.number)).toBe(seq((await receiptOf(cardPayment.started.id))!.number) + 1);
  });

  it('answers 409 NOTHING_TO_PAY with nothing open, and keeps paying to those who manage it', async () => {
    const c = await subscriber('Nothing Owed Agency');
    await expect(
      sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' }),
    ).rejects.toMatchObject({ status: 409, code: 'nothing_to_pay' });
    await expect(
      sp.payments.pay(c.accountant, { purpose: 'invoices', channel: 'card' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(sp.payments.receipts(c.manager)).rejects.toMatchObject({ status: 403 });
    // A subscriber never sees another's payment.
    await expect(sp.payments.payment(c.admin, cardPayment.started.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a retried request with the same Idempotency-Key starts no second charge', async () => {
    const c = await subscriber('Retry Agency');
    await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 7_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const store = new IdempotencyStore(ctx.database);
    const input = { purpose: 'invoices' as const, channel: 'card' as const };
    const run = () =>
      store.run(
        {
          companyId: c.companyId,
          personId: c.admin.personId,
          key: 'subscription-pay-retry-0001',
          operation: 'subscription.pay',
          hash: requestHash('subscription.pay', c.admin.personId, input),
        },
        (claim) => sp.payments.pay(c.admin, input, claim),
        (stored) => sp.payments.payment(c.admin, stored.id),
      );
    const [first, second] = await Promise.all([run(), run()]);
    const third = await run();
    expect(second.id).toBe(first.id);
    expect(third).toMatchObject({ id: first.id, status: 'pending' });
    expect(third.checkoutUrl).toEqual(expect.stringMatching(/^https:\/\//));
    const charged = await asSuperuser(
      ctx,
      `select id from subscription_payment
        where subscriber_company_id = $1 and status <> 'failed'`,
      [c.companyId],
    );
    expect(charged).toHaveLength(1);
    expect((await p.primary.verify(first.reference)).status).toBe('pending');
  });
});

describe('PB-07 a replayed webhook posts nothing new', () => {
  it('the same event is a duplicate; processing the reference again changes nothing', async () => {
    const { started, webhook } = cardPayment;
    const before = await asSuperuser(ctx, `select count(*)::int as n from journal_entry`);
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).intake).toBe('duplicate');
    expect(await sp.payments.processReference('paystack', started.reference)).toBe(
      'already_posted',
    );
    expect(await sp.payments.paid('paystack', started.reference)).toBe('already_posted');
    expect(await asSuperuser(ctx, `select count(*)::int as n from journal_entry`)).toEqual(before);
    expect(
      await asSuperuser(ctx, 'select id from subscription_receipt where payment_id = $1', [
        started.id,
      ]),
    ).toHaveLength(1);
    expect(
      await asSuperuser(ctx, 'select id from subscription_allocation where payment_id = $1', [
        started.id,
      ]),
    ).toHaveLength(2);
  });
});

describe('PB-07 receipt numbers stay gap-free under concurrency', () => {
  it('posts several payments at once, each with its own number, none missing', async () => {
    const companies: Company[] = [];
    for (let i = 0; i < 5; i += 1) {
      const c = await subscriber(`Concurrent Agency ${i}`);
      await openInvoice(ctx, b.posting, c.companyId, {
        month: previousMonth(month),
        totalMinor: 3_000 + i,
        issuedOn: plusDays(today, -2),
        dueOn: plusDays(today, 5),
      });
      companies.push(c);
    }
    const started = [];
    for (const c of companies) {
      const payment = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
      await p.primary.completeCharge(payment.reference, { status: 'success' });
      started.push(payment);
    }
    const outcomes = await Promise.all(
      started.map((payment) => sp.payments.processReference('paystack', payment.reference)),
    );
    expect(outcomes).toEqual(started.map(() => 'posted'));
    const numbers = (
      (await asSuperuser(ctx, 'select number from subscription_receipt')) as { number: string }[]
    )
      .map((r) => seq(r.number))
      .sort((x, y) => x - y);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('PB-07 reconciliation and settlement of the platform’s own balance (plan 4.4)', () => {
  it('posts a platform payment whose webhook never came, once, and never matches it to rent', async () => {
    const c = await subscriber('Lost Webhook Agency');
    await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 9_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    await p.primary.completeCharge(started.reference, { status: 'success', feesMinor: 150 });
    const first = await p.reconciliation.transactions('paystack', today);
    expect(first.processed).toBeGreaterThanOrEqual(1);
    expect((await paymentRow(started.id)).status).toBe('succeeded');
    await p.reconciliation.transactions('paystack', today);
    expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toHaveLength(2);
    expect(
      await asSuperuser(
        ctx,
        `select id from reconciliation_exception where reference like 'SUB-%'`,
      ),
    ).toHaveLength(0);
    expect(p.alerts.some((a) => a.code === 'payments.reconciliation_unowned')).toBe(false);
  });

  it('posts the payout of the platform balance once: 1050 cleared, fees to 5200, net to 1010', async () => {
    const settled = await p.primary.settle();
    const platform = settled.filter((x) => x.subaccountCode === '');
    expect(platform).toHaveLength(1);
    expect(platform[0]!.references.every((r) => r.startsWith('SUB-'))).toBe(true);
    expect(await p.reconciliation.settlements('paystack', today)).toBe(1);
    const lines = await asSuperuser(
      ctx,
      `select l.account_code, sum(l.amount_minor)::bigint as total, max(b.kind) as book_kind
         from journal_line l
         join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
         join book b on b.company_id = l.company_id and b.id = l.book_id
        where e.record_type = 'subscription_settlement' group by l.account_code order by 1`,
    );
    const { grossMinor, feesMinor, netMinor } = platform[0]!;
    expect(lines).toEqual([
      { account_code: '1010', total: netMinor, book_kind: 'platform' },
      { account_code: '1050', total: -grossMinor, book_kind: 'platform' },
      { account_code: '5200', total: feesMinor, book_kind: 'platform' },
    ]);
    expect(feesMinor).toBe(550);
    // Everything received has been paid out.
    expect(await platformBalance('1050')).toBe(0);
    // Again: nothing new.
    expect(await p.reconciliation.settlements('paystack', today)).toBe(0);
    expect(
      await asSuperuser(
        ctx,
        `select id from journal_entry where record_type = 'subscription_settlement'`,
      ),
    ).toHaveLength(1);
    expect(p.alerts.some((a) => a.code === 'payments.settlement_unowned')).toBe(false);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('PB-07 a verified amount, currency or reference that differs is refused', () => {
  let c: Company;
  let invoiceId: string;

  beforeAll(async () => {
    c = await subscriber('Mismatch Agency');
    invoiceId = (
      await openInvoice(ctx, b.posting, c.companyId, {
        month: previousMonth(month),
        totalMinor: 20_000,
        issuedOn: plusDays(today, -2),
        dueOn: plusDays(today, 5),
      })
    ).id;
  });

  it('refuses each difference: nothing posts, a security alert goes, and it stays refused', async () => {
    const forgeries = [
      (v: object) => ({ ...v, amountMinor: 19_999 }),
      (v: object) => ({ ...v, currency: 'NGN' }),
      (v: object & { reference: string }) => ({ ...v, reference: `${v.reference}x` }),
      (v: object) => ({ ...v, subaccountCode: 'ACCT_landlord' }),
    ];
    for (const forge of forgeries) {
      const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
      const verified = {
        ...(await p.primary.verifyTransaction(started.reference)),
        status: 'success' as const,
      };
      expect(
        await sp.payments.onVerifiedCharge('paystack', started.reference, forge(verified) as never),
      ).toBe('rejected');
      expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toHaveLength(0);
      expect(await paymentRow(started.id)).toMatchObject({
        status: 'failed',
        failure_reason: expect.stringMatching(/^verification_/),
      });
      // Refused for good, even when the provider later says all is well.
      expect(await sp.payments.onVerifiedCharge('paystack', started.reference, verified)).toBe(
        'rejected',
      );
    }
    expect(p.alerts.filter((a) => a.code === 'subscription.verification_mismatch')).toHaveLength(4);
    expect((await invoiceRow(invoiceId)).status).toBe('open');
  });

  it('refuses a payment the provider confirms for a different amount, through the webhook', async () => {
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, {
      status: 'success',
      amountMinor: 15_000,
    });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('rejected');
    expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toHaveLength(0);
    expect(await receiptOf(started.id)).toBeUndefined();
    // The provider pays it out on its own; reconciling that payout posts nothing and raises it.
    expect((await p.primary.settle()).map((x) => x.references)).toEqual([[started.reference]]);
    await p.reconciliation.settlements('paystack', today);
    expect(p.alerts.some((a) => a.code === 'subscription.settlement_difference')).toBe(true);
  });

  it('never posts from the body: a signed webhook claiming success for an unpaid charge', async () => {
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 990_001, reference: started.reference, amount: 20_000, status: 'success' },
    });
    const { hmacHex } = await import('../../integrations/src/hmac');
    const forged = {
      rawBody: body,
      headers: { 'x-paystack-signature': hmacHex('sha512', 'sk_test_primary', body) },
    };
    expect((await deliverWebhook(ctx, p, 'paystack', forged)).outcome).toBe('pending');
    expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toHaveLength(0);
  });

  it('a failed or abandoned charge is marked failed and posts nothing', async () => {
    for (const status of ['failed', 'abandoned'] as const) {
      const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
      expect(await p.primary.completeCharge(started.reference, { status })).toBeNull();
      expect(await sp.payments.processReference('paystack', started.reference)).toBe('failed');
      expect(await sp.payments.payment(c.admin, started.id)).toMatchObject({
        status: 'failed',
        message: 'The payment did not go through. You can try again.',
      });
      expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toHaveLength(0);
    }
  });

  it('a payment still waiting is checked with the provider after five minutes (lost webhook)', async () => {
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    await p.primary.completeCharge(started.reference, { status: 'success' });
    ctx.clock.advance(6 * 60_000);
    try {
      expect(await sp.payments.verifyPending()).toBeGreaterThanOrEqual(1);
    } finally {
      ctx.clock.advance(-6 * 60_000);
    }
    expect((await paymentRow(started.id)).status).toBe('succeeded');
    expect((await invoiceRow(invoiceId)).status).toBe('paid');
  });
});

describe('PB-05 annual prepayment becomes prepaid credit with its term recorded (decision 7)', () => {
  async function payAnnual(c: Company) {
    const started = await sp.payments.pay(c.admin, { purpose: 'annual', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
    return started;
  }

  it('prices 12 months on this month’s units at the tier, less the discount, all as credit (2020)', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Annual Agency');
    await asSuperuser(ctx, `update company set plan = 'starter' where id = $1`, [c.companyId]);
    await subscribe(ctx, sp, c.companyId);
    const owner = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner A' }))
      .id;
    const { units } = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'ANN',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 6, bedrooms: 1 }],
    });
    for (const [i, unitId] of Object.values(units).entries()) {
      const { tenant } = await s.tenants.create(c.manager, {
        kind: 'individual',
        displayName: `Annual Tenant ${i}`,
      });
      await billedLease(ctx, s, b, c.manager, {
        unitId,
        tenantId: tenant.id,
        startDate: today,
        endDate: plusDays(today, 364),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        depositMinor: null,
        signedOn: today,
        billingStartDate: today,
      });
    }
    // Starter placeholder: 6 self-contained units × GH₵10 = GH₵60 a month, above the GH₵50
    // minimum; 12 months less 10% is GH₵648.
    const started = await payAnnual(c);
    expect(started.amountMinor).toBe(64_800);
    expect(await paymentRow(started.id)).toMatchObject({
      purpose: 'annual',
      annual_first_month: month,
      annual_last_month: shiftMonth(month, 11),
      annual_discount_bps: 1000,
      status: 'succeeded',
    });
    expect(await entryLines(subscriptionPostingKeys.payment(started.id))).toEqual([
      expect.objectContaining({ account_code: '1050', amount: 64_800, book_kind: 'platform' }),
      expect.objectContaining({ account_code: '2020', amount: -64_800, book_kind: 'platform' }),
    ]);
    expect(
      await asSuperuser(ctx, 'select id from subscription_allocation where payment_id = $1', [
        started.id,
      ]),
    ).toHaveLength(0);
    expect(await withPlatform(ctx.database, {}, (tx) => sp.core.creditMinor(tx, c.companyId))).toBe(
      64_800,
    );
    const [event] = await asSuperuser(
      ctx,
      `select effective_on::text, data from subscription_event
        where subscriber_company_id = $1 and kind = 'annual_started'`,
      [c.companyId],
    );
    expect(event).toMatchObject({
      effective_on: `${month}-01`,
      data: expect.objectContaining({
        paymentId: started.id,
        firstMonth: month,
        lastMonth: shiftMonth(month, 11),
      }),
    });
    // The receipt says it is held as credit; it can be rendered.
    const receipt = await receiptOf(started.id);
    await s.documents.renderRequested(
      platformId,
      receipt!.render_request_id,
      async () => SAMPLE_PDF,
    );
    const [request] = await asSuperuser(
      ctx,
      'select data from document_render_request where id = $1',
      [receipt!.render_request_id],
    );
    expect((request as { data: unknown }).data).toMatchObject({
      purpose: 'annual',
      invoices: [],
      creditMinor: 64_800,
    });
    // One term at a time.
    await expect(
      sp.payments.pay(c.admin, { purpose: 'annual', channel: 'card' }),
    ).rejects.toMatchObject({ status: 409, code: 'annual_already_paid' });
  });

  it('prices on last month’s invoice net when there is one, never below 12 minimums', async () => {
    const withInvoice = await subscriber('Annual From Invoice');
    await openInvoice(ctx, b.posting, withInvoice.companyId, {
      month: previousMonth(month),
      totalMinor: 20_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    // Growth placeholder: 12 × GH₵200 less 10% is GH₵2,160, above 12 × the GH₵150 minimum.
    expect((await payAnnual(withInvoice)).amountMinor).toBe(216_000);
    const empty = await subscriber('Annual Empty');
    // No units and no invoice: the bill is the GH₵150 minimum; 12 × less 10% (GH₵1,620) is below
    // 12 minimums (GH₵1,800), which is the floor.
    expect((await payAnnual(empty)).amountMinor).toBe(180_000);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('PB-07 a reversal or chargeback of a subscription payment', () => {
  it('reverses from the allocations as they stand: invoices reopen, read-only returns, the payout deducts it', async () => {
    const c = await subscriber('Chargeback Agency');
    const invoice = await inArrears(c, 12_000);
    const { started, webhook } = await paidByCard(c);
    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).outcome).toBe('posted');
    expect((await access(c.companyId)).access).toBe('full');
    await p.primary.settle();
    await p.reconciliation.settlements('paystack', today);

    const dispute = await p.primary.chargeback(started.reference);
    expect((await deliverWebhook(ctx, p, 'paystack', dispute)).outcome).toBe('reversed');
    expect(await paymentRow(started.id)).toMatchObject({
      status: 'reversed',
      reversed_at: expect.any(Date),
    });
    expect(await invoiceRow(invoice.id)).toEqual({ status: 'open', paid_at: null });
    expect(
      (await entryLines(subscriptionPostingKeys.paymentReversal(started.id))).map((l) => [
        l.account_code,
        Number(l.amount),
        l.book_kind,
      ]),
    ).toEqual([
      ['1050', -12_000, 'platform'],
      ['1100', 12_000, 'platform'],
    ]);
    expect((await access(c.companyId)).access).toBe('read_only');
    expect(p.alerts.some((a) => a.code === 'subscription.chargeback')).toBe(true);
    // Replayed: nothing more.
    expect(await sp.payments.recordReversal('paystack', started.reference)).toBe('ignored');

    // The next payout of the platform balance deducts it, and still posts.
    const other = await subscriber('After Chargeback Agency');
    await openInvoice(ctx, b.posting, other.companyId, {
      month: previousMonth(month),
      totalMinor: 30_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const later = await paidByCard(other);
    expect((await deliverWebhook(ctx, p, 'paystack', later.webhook)).outcome).toBe('posted');
    const payout = (await p.primary.settle()).find((x) => x.subaccountCode === '');
    expect(payout).toMatchObject({ deductionsMinor: 12_000 });
    expect(await p.reconciliation.settlements('paystack', today)).toBeGreaterThanOrEqual(1);
    expect(await platformBalance('1050')).toBe(0);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });

  it('leaves a part taken back, or credit already drawn, to a person: nothing is reversed', async () => {
    const part = await subscriber('Part Chargeback Agency');
    await openInvoice(ctx, b.posting, part.companyId, {
      month: previousMonth(month),
      totalMinor: 8_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const paid = await paidByCard(part);
    await deliverWebhook(ctx, p, 'paystack', paid.webhook);
    const dispute = await p.primary.chargeback(paid.started.reference, 3_000);
    expect((await deliverWebhook(ctx, p, 'paystack', dispute)).outcome).toBe('partial');
    expect((await paymentRow(paid.started.id)).status).toBe('succeeded');

    // Annual credit that a monthly invoice has drawn on, then charged back.
    const drawn = await subscriber('Drawn Credit Agency');
    const annual = await sp.payments.pay(drawn.admin, { purpose: 'annual', channel: 'card' });
    await deliverWebhook(
      ctx,
      p,
      'paystack',
      (await p.primary.completeCharge(annual.reference, { status: 'success' }))!,
    );
    const invoice = await openInvoice(ctx, b.posting, drawn.companyId, {
      month: month,
      totalMinor: 15_000,
      issuedOn: today,
      dueOn: plusDays(today, 7),
    });
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      await tx.execute(
        sql`insert into subscription_allocation (company_id, subscriber_company_id, source, invoice_id, amount_minor)
            values (${platform}::uuid, ${drawn.companyId}::uuid, 'prepaid', ${invoice.id}::uuid, 15000)`,
      );
      await b.posting.post(tx, {
        companyId: platform,
        rule: 'P26',
        key: subscriptionPostingKeys.prepaidDraw(invoice.id),
        valueDate: today,
        lines: prepaidDrawLines({
          bookId: await platformBookId(tx, platform),
          invoiceId: invoice.id,
          amountMinor: 15_000,
        }),
        record: { type: 'subscription_invoice', id: invoice.id },
      });
    });
    const taken = await p.primary.chargeback(annual.reference);
    expect((await deliverWebhook(ctx, p, 'paystack', taken)).outcome).toBe('needs_review');
    expect((await paymentRow(annual.id)).status).toBe('succeeded');
    expect(
      p.alerts.filter((a) => a.code === 'subscription.reversal_needs_review').length,
    ).toBeGreaterThanOrEqual(2);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('D1 no rent in the platform book, and no subscription money in any other', () => {
  it('a SUB- reference never reaches rent: with nobody to take it, processing fails and retries', async () => {
    const c = await subscriber('Unrouted Agency');
    await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 4_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const { started, webhook } = await paidByCard(c);
    const unregistered = new WebhooksService(
      ctx.database,
      p.providers,
      p.alertPort,
      p.providerPayments,
      p.queue,
      ctx.config,
      ctx.clock,
    );
    expect(
      await unregistered.intake('paystack', Buffer.from(webhook.rawBody), webhook.headers),
    ).toBe('stored');
    const [inboxId] = await claimInbox(ctx);
    await expect(unregistered.process(inboxId!)).rejects.toBeInstanceOf(PlatformChargesUnavailable);
    expect(
      await asSuperuser(ctx, 'select id from payment where provider_reference = $1', [
        started.reference,
      ]),
    ).toHaveLength(0);
    // Registered, the retry posts it to the subscription.
    expect(await p.webhooks.process(inboxId!)).toBe('posted');
  });

  it('★ every P26 line is in the platform book, and every platform-book line is P26 (both directions)', async () => {
    // Rent money in an owner's book, recorded alongside.
    const c = cardCompany;
    const owner = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner D1' }))
      .id;
    const { units } = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'DON',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const { tenant } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: 'D1 Tenant',
    });
    const lease = await billedLease(ctx, s, b, c.manager, {
      unitId: Object.values(units)[0]!,
      tenantId: tenant.id,
      startDate: today,
      endDate: plusDays(today, 364),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      depositMinor: null,
      signedOn: today,
      billingStartDate: today,
    });
    await approvedCash(ctx, s, b, c.manager, c.admin, {
      leaseId: lease.id,
      amountMinor: 150_000,
      receivedOn: today,
    });
    const count = async (where: string) =>
      Number(
        (
          (await asSuperuser(
            ctx,
            `select count(*)::int as n from journal_line l
               join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
               join book b on b.company_id = l.company_id and b.id = l.book_id
              where ${where}`,
          )) as { n: number }[]
        )[0]!.n,
      );
    expect(await count(`e.rule = 'P26'`)).toBeGreaterThan(0);
    expect(await count(`b.kind <> 'platform' and e.rule <> 'P26'`)).toBeGreaterThan(0);
    // No rent in the platform book.
    expect(await count(`b.kind = 'platform' and e.rule <> 'P26'`)).toBe(0);
    expect(
      await count(
        `b.kind = 'platform' and (l.lease_id is not null or l.tenant_id is not null
           or l.property_id is not null or l.settlement_account_id is not null)`,
      ),
    ).toBe(0);
    // No subscription money in an owner's or a company's book.
    expect(await count(`b.kind <> 'platform' and e.rule = 'P26'`)).toBe(0);
    expect(await count(`b.kind <> 'platform' and l.account_code in ('2020', '4600')`)).toBe(0);
    // And no subscription payment is a rent payment.
    expect(
      await asSuperuser(ctx, `select id from payment where provider_reference like 'SUB-%'`),
    ).toHaveLength(0);
  });
});

describe('PB-07 the nightly subscription sub-ledger check', () => {
  it('agrees after everything above, and raises an alert naming the invoice when it does not', async () => {
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
    const c = await subscriber('Broken Books Agency');
    const invoice = await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 6_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    // Below the application: an allocation the ledger never saw.
    await asSuperuser(
      ctx,
      `insert into subscription_allocation (company_id, subscriber_company_id, source, invoice_id, amount_minor)
       values ($1, $2, 'prepaid', $3, 1000)`,
      [platformId, c.companyId, invoice.id],
    );
    const result = await sp.subledger.check();
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        { check: 'receivable', subject: invoice.id, expectedMinor: 5_000, actualMinor: 6_000 },
        { check: 'prepaid_credit', subject: c.companyId, expectedMinor: -1_000, actualMinor: 0 },
      ]),
    );
    expect(p.alerts.some((a) => a.code === 'subscription.subledger_mismatch')).toBe(true);
  });
});
