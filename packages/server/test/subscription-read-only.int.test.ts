import { randomUUID } from 'node:crypto';
import { eq, schema, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { CURRENT_NOTICE_CONSENT } from '@rent/domain/esign';
import { chargeReference } from '@rent/domain/payments';
import { monthOf, shiftMonth } from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { withPlatform } from '../src/subscription/platform';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { PHONE, tokenIn } from './support/esign';
import { noticesServices, NoticesWorker, type NoticesServices } from './support/notices';
import {
  activeAccount,
  agreementInForce,
  CLIENT,
  deliverWebhook,
  issueReceipts,
  paymentsServices,
  sendQueued,
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
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * ★ PB-11 (M10 decision 11; plan section 6): a company in subscription arrears, read-only
 * included, still takes a tenant's provider payment (webhook to receipt), records cash with its
 * receipt, serves pay links, runs an issued notice's ladder and signing, and sends rent reminders.
 * Staff actors carry `subscriptionAccess: 'read_only'`, as the API's guard builds them; the
 * company's access is set by the subscription engine from a real past-due invoice. Also the web
 * e2e assumption A5: read-only refuses adding an owner (403 SUBSCRIPTION_READ_ONLY) and allows
 * recording cash on a lease with its photo. Real PostgreSQL with RLS, on a fixed clock.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let n: NoticesServices;
let worker: NoticesWorker;
let renderer: PdfRenderer;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let secondAdmin: Awaited<ReturnType<typeof staffIn>>;
let ownerId: string;
let units: string[];

const HOUR = 3_600_000;
/**
 * 10:00 in Accra, inside the daily sending window (07:00 to 20:00), on the latest day it is at
 * least two hours past: never in the future, since a settlement account becomes usable by the
 * database's real clock (now()), and never more than 26 hours back, since approval requests
 * expire by it. A fixed day (9 November 2026) failed once the real date passed it by a week
 * (founder-approved setup fix, 2026-11-19; what the tests check is unchanged).
 */
const START = (() => {
  const now = Date.now();
  const today = new Date(now);
  const at10 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10);
  return new Date(now - at10 >= 2 * HOUR ? at10 : at10 - 24 * HOUR);
})();
const plusDays = (date: string, days: number) => toIsoDate(addDays(parseBusinessDate(date), days));
const plusMonths = (date: string, months: number) =>
  toIsoDate(addMonths(parseBusinessDate(date), months));
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const readOnly = <T extends object>(actor: T) => ({
  ...actor,
  subscriptionAccess: 'read_only' as const,
});

/** A monthly lease billed from `start`, with a tenant who has a phone and SMS consent. */
async function billed(name: string, phone: string, start: string) {
  const { tenant } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: name,
    phone,
  });
  await s.tenants.recordConsent(agency.manager, tenant.id, { channel: 'sms', action: 'grant' });
  const lease = await billedLease(ctx, s, b, agency.manager, {
    unitId: units.shift()!,
    tenantId: tenant.id,
    startDate: start,
    endDate: plusDays(plusMonths(start, 12), -1),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    depositMinor: null,
    signedOn: plusDays(today, -1) < start ? plusDays(today, -1) : start,
    billingStartDate: start,
  });
  return lease.id;
}

/** A lease recorded from paper 60 days ago, its tenant with SMS consent (as M7's tests). */
async function noticeLease(phone: string) {
  const { tenant } = await s.tenants.create(agency.manager, {
    kind: 'individual',
    displayName: `Notice Tenant ${phone.slice(-3)}`,
    phone,
    consent: { sms: true },
  });
  const start = plusDays(today, -60);
  const lease = await s.leases.recordPaper(agency.manager, {
    unitId: units.shift()!,
    tenantId: tenant.id,
    startDate: start,
    endDate: plusDays(start, 364),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: [{ role: 'tenant', name: tenant.displayName }],
    scanUploadId: await uploadLeaseFile(ctx, s, agency.manager),
    signedOn: start,
  });
  return lease.id;
}

/** A breach notice, issued and sent while the company still has full access. */
async function issuedNotice(leaseId: string) {
  const draft = await n.notices.create(agency.manager, {
    type: 'breach',
    subtype: 'noise',
    leaseId,
    fields: { particulars: 'Loud music after midnight', remedyBy: plusDays(today, 10) },
  });
  await n.notices.issue(agency.manager, draft.id);
  return draft.id;
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

const codeSentTo = (phone: string) => {
  const code = /^(\d{6}) is your code/.exec(s.sms.lastTo(phone)?.body ?? '')?.[1];
  if (!code) throw new Error('no code was texted');
  return code;
};

let payLease: string;
let cashLease: string;
let reminderLease: string;
let ladderNotice: string;
let signedNotice: string;
const SIGNER = '+233200000722';

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  sp = subscriptionPaymentsServices(ctx, s, b, p);
  n = noticesServices(ctx, s, b);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new NoticesWorker(ctx, s, n, (html) => renderer.render(html));
  await company(ctx, 'platform', 'Rent Platform');
  today = isoNow(ctx.clock, 'Africa/Accra');

  // While it has full access: the register, the money destinations, leases and two notices.
  agency = await moneyCompany(ctx, s, 'agency', 'Arrears Agency');
  secondAdmin = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Second Admin');
  ownerId = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Arrears Owner',
      phone: '+233200000701',
    })
  ).id;
  units = Object.values(
    (
      await propertyWithUnits(s, agency.manager, {
        areaCode: 'ACC',
        propertyPart: 'ARR',
        ownerId,
        units: [{ unitType: 'apartment', count: 10, bedrooms: 2 }],
      })
    ).units,
  );
  await activeAccount(ctx, s, p, agency.admin, secondAdmin, { holder: 'owner', ownerId });
  await agreementInForce(ctx, s, p, agency.admin, secondAdmin, ownerId, 'owner_account');
  payLease = await billed('Provider Payer', '+233200000711', today);
  cashLease = await billed('Cash Payer', '+233200000713', today);
  reminderLease = await billed('Reminded Tenant', '+233200000712', plusDays(today, 7));
  ladderNotice = await issuedNotice(await noticeLease('+233200000721'));
  signedNotice = await issuedNotice(await noticeLease(SIGNER));
  await worker.run(agency.companyId);

  // Then the subscription falls into arrears beyond the grace period: read-only, by the engine.
  await subscribe(ctx, sp, agency.companyId);
  await openInvoice(ctx, b.posting, agency.companyId, {
    month: shiftMonth(monthOf(today), -2),
    totalMinor: 15_000,
    issuedOn: plusDays(today, -40),
    dueOn: plusDays(today, -33),
  });
  const refreshed = await withPlatform(ctx.database, {}, async (tx, platformId) => {
    const subscriber = await sp.core.subscriberCompany(tx, agency.companyId);
    const sub = await sp.core.find(tx, agency.companyId);
    return sp.core.refresh(tx, platformId, sub!, subscriber!);
  });
  expect(refreshed).toMatchObject({ status: 'read_only', access: 'read_only' });
}, 180_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('PB-11 ★ a company in arrears, read-only included, keeps every tenant flow', () => {
  it('is read-only: the company row says so', async () => {
    const [row] = await asSuperuser(ctx, 'select access from company where id = $1', [
      agency.companyId,
    ]);
    expect(row).toEqual({ access: 'read_only' });
  });

  it('serves pay links and takes a tenant’s provider payment, webhook to receipt', async () => {
    const [invoice] = await invoicesOf(payLease);
    const { url } = await withCompany(ctx.database, sys(agency.companyId), async (tx) =>
      p.links.mint(tx, await p.links.invoice(tx, invoice!.id)),
    );
    const token = url.split('/p/')[1]!;
    expect(await p.page.open(token, CLIENT)).toMatchObject({ screen: 'pay', dueNowMinor: 150_000 });
    const intent = await p.page.start(token, CLIENT, {
      amountMinor: 150_000,
      method: 'momo',
      momo: { phone: '024 000 0711', network: 'mtn' },
      submissionId: randomUUID(),
    });
    expect(intent).toMatchObject({ status: 'pending' });
    const webhook = await p.primary.completeCharge(chargeReference(intent.intentId), {
      status: 'success',
    });
    expect(await deliverWebhook(ctx, p, 'paystack', webhook!)).toEqual({
      intake: 'stored',
      outcome: 'posted',
    });
    const before = s.sms.sent.length;
    expect(await issueReceipts(ctx, p, agency.companyId)).toContain('sent');
    expect(
      s.sms.sent
        .slice(before)
        .some((m) => m.to === '+233200000711' && m.body.includes(`${ctx.config.LINKS_ORIGIN}/r/`)),
    ).toBe(true);
  });

  it('records cash on a lease with its photo, approved and receipted, by read-only staff', async () => {
    const recorded = await approvedCash(
      ctx,
      s,
      b,
      readOnly(agency.manager),
      readOnly(secondAdmin),
      { leaseId: cashLease, amountMinor: 150_000, receivedOn: today },
    );
    const [cash] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.cashRecord).where(eq(schema.cashRecord.id, recorded.cashRecordId)),
    );
    expect(cash?.photoDocumentId).toEqual(expect.any(String));
    const [payment] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.payment).where(eq(schema.payment.leaseId, cashLease)),
    );
    expect(payment?.amountMinor).toBe(150_000);
    const [receipt] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.select().from(schema.receipt).where(eq(schema.receipt.paymentId, payment!.id)),
    );
    expect(receipt).toMatchObject({ kind: 'receipt', amountMinor: 150_000 });
  });

  it('sends rent reminders', async () => {
    const [invoice] = await invoicesOf(reminderLease);
    expect(invoice!.dueDate).toBe(plusDays(today, 7));
    expect(await p.reminders.run(agency.companyId, today)).toBeGreaterThanOrEqual(1);
    const before = s.sms.sent.length;
    await sendQueued(ctx, s, agency.companyId);
    expect(
      s.sms.sent
        .slice(before)
        .some((m) => m.to === '+233200000712' && m.body.includes(`${ctx.config.LINKS_ORIGIN}/p/`)),
    ).toBe(true);
  });

  it('lets the tenant sign (acknowledge) an issued notice', async () => {
    const token = tokenIn(s.sms.lastTo(SIGNER)?.body);
    expect(await s.signingPage.open(token, PHONE)).toMatchObject({
      screen: 'sign',
      subject: 'notice',
    });
    await s.signingPage.sendCode(token, PHONE);
    await s.signingPage.sign(token, PHONE, {
      code: codeSentTo(SIGNER),
      method: 'typed',
      typedName: 'Notice Tenant',
      consentVersion: CURRENT_NOTICE_CONSENT,
      consentAccepted: true,
    });
    await worker.run(agency.companyId);
    // Reading stays open to read-only staff.
    expect((await n.notices.get(readOnly(agency.manager), signedNotice)).status).toBe('signed');
  });

  it('runs an issued notice’s ladder to escalation', async () => {
    try {
      for (const hours of [24, 72, 120, 168]) {
        ctx.clock.set(new Date(START.getTime() + hours * HOUR));
        await n.tracking.runLadder(agency.companyId);
        await worker.run(agency.companyId);
      }
      const notice = await n.notices.get(readOnly(agency.manager), ladderNotice);
      const steps = notice.events.map((e) => e.data?.step ?? null);
      for (const step of ['reminder_1', 'reminder_2', 'manager_alert', 'escalate'])
        expect(steps, step).toContain(step);
      expect(notice.status).toBe('escalated');
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('PB-11 the web e2e assumption A5: what read-only refuses and allows', () => {
  it('refuses adding an owner with 403 SUBSCRIPTION_READ_ONLY', async () => {
    await expect(
      s.owners.create(readOnly(agency.admin), { kind: 'individual', displayName: 'Refused' }),
    ).rejects.toMatchObject({ status: 403, code: 'subscription_read_only' });
  });

  it('allows uploading a cash photo and recording cash on a lease (payment.record)', async () => {
    const upload = await b.money.createUpload(readOnly(agency.manager), {
      purpose: 'cash_photo',
      contentType: 'application/pdf',
      sizeBytes: SAMPLE_PDF.length,
    });
    expect(upload.uploadId).toEqual(expect.any(String));
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: SAMPLE_PDF,
      contentType: 'application/pdf',
    });
    await expect(
      b.money.recordCash(readOnly(agency.manager), {
        leaseId: cashLease,
        method: 'cash',
        amountMinor: 50_000,
        receivedOn: today,
        payerName: 'Payer',
        chequeNumber: null,
        chequeBank: null,
        photoUploadId: upload.uploadId,
      }),
    ).resolves.toMatchObject({ approvalId: expect.any(String) });
  });
});

describe('PB-11 paying in full restores full access at once (decision 11)', () => {
  it('a read-only admin pays; access is full again and changes work', async () => {
    const started = await sp.payments.pay(readOnly(agency.admin), {
      purpose: 'invoices',
      channel: 'card',
    });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
    const [row] = await asSuperuser(ctx, 'select access from company where id = $1', [
      agency.companyId,
    ]);
    expect(row).toEqual({ access: 'full' });
    await expect(
      s.owners.create(agency.admin, { kind: 'individual', displayName: 'Allowed Again' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    // D1, with rent and subscription money both posted here: neither reaches the other's book.
    const [mixed] = await asSuperuser(
      ctx,
      `select count(*)::int as n from journal_line l
         join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
         join book b on b.company_id = l.company_id and b.id = l.book_id
        where (b.kind = 'platform') <> (e.rule = 'P26')`,
    );
    expect(mixed).toEqual({ n: 0 });
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});
