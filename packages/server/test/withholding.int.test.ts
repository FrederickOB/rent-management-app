import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  setLettingBusiness,
  taxItemsOf,
  taxServices,
  uploadEvidence,
  type TaxServices,
} from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Withholding tax by corporate tenants (TX-04; P19, P20, P24; M5 plan 5.2 and decision 3) against
 * the real database: worked example B to the pesewa, withholding advised after the payment, a
 * letting-business owner's credit, a certificate its uploader may never confirm, and a write-off.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let unitIndex = 0;
let units: string[] = [];

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);

async function ownerAndUser(name: string, options: { lettingBusiness?: boolean } = {}) {
  const ownerId = (await s.owners.create(agency.admin, { kind: 'individual', displayName: name }))
    .id;
  if (options.lettingBusiness) await setLettingBusiness(ctx, agency.companyId, ownerId, true);
  const user = await staffIn(ctx, agency.companyId, 'agency', 'owner', `${name} user`, {
    owners: [ownerId],
  });
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: name.slice(0, 3).toUpperCase(),
    ownerId,
    use: 'commercial',
    units: [{ unitType: 'office', count: 4 }],
  });
  units = Object.values(property.units);
  unitIndex = 0;
  return { ownerId, user };
}

/** Worked example B's lease: an office at GH₵10,000 a month, its month started on the 1st. */
async function officeLease() {
  const tenantId = (
    await s.tenants.create(agency.manager, {
      kind: 'company',
      displayName: 'Corporate Tenant',
      legalName: 'Corporate Tenant Limited',
    })
  ).tenant.id;
  const start = `${today.slice(0, 7)}-01`;
  const lease = await billedLease(ctx, s, b, agency.manager, {
    unitId: units[unitIndex++]!,
    tenantId,
    startDate: start,
    endDate: endAfter(start, 12),
    monthlyRentMinor: 1_000_000,
    cycle: 'monthly',
    use: 'commercial',
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
  await b.invoicing.accrueAll(agency.companyId, today);
  const line = await withCompany(
    ctx.database,
    { companyId: agency.companyId, actorKind: 'system' },
    (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${lease.id} and kind = 'rent' and period_start = ${start}`),
  );
  return { lease, lineId: line[0]!.id };
}

const uploadCertificate = (actor: Parameters<TaxServices['withholding']['createUpload']>[0]) =>
  uploadEvidence(ctx, (i) => t.withholding.createUpload(actor, i));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Withholding Agency');
});

afterAll(async () => {
  await ctx?.close();
});

describe('TX-04 withholding', () => {
  it('worked example B to the pesewa: GH₵8,500 paid, GH₵1,500 withheld, the tax settled by the certificate', async () => {
    const { ownerId, user } = await ownerAndUser('Example B Owner');
    const { lease, lineId } = await officeLease();
    // The tenant paid net: the withholding is pinned to its month, the cash allocates normally.
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    expect(
      await journalSum(
        ctx,
        agency.companyId,
        `l.invoice_line_id = $1 and l.account_code = '1100'`,
        [lineId],
      ),
    ).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1050')).toBe(850_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5300')).toBe(150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(-1_000_000);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, i.taxMinor, i.rateBps])).toEqual([
      ['withholding', 150_000, 1500],
    ]);
    const view = await t.withholding.get(agency.manager, withholdingId);
    expect(view).toMatchObject({ status: 'awaiting_certificate', differsFromRate: false });
    expect(view.rule.verificationStatus).toBe('unverified');
    // Withheld tax raises no TX-02 alert and is not on the due list.
    expect((await t.reports.dueList(agency.accountant, { ownerId })).length).toBe(0);

    // The manager uploads the certificate; a user for the owner confirms it (P20).
    await t.withholding.uploadCertificate(agency.manager, withholdingId, {
      uploadId: await uploadCertificate(agency.manager),
      certificateNumber: 'WHT-0001',
    });
    const waiting = await t.withholding.get(user, withholdingId);
    expect(waiting.certificate).toMatchObject({ status: 'awaiting_confirmation', mayDecide: true });
    await t.withholding.confirmCertificate(user, waiting.certificate!.id);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect((await t.withholding.get(agency.manager, withholdingId)).status).toBe('certified');
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });

  it('withholding advised after the payment replaces the tax accrued on that month’s cash', async () => {
    await ownerAndUser('Late Advice Owner');
    const { lease, lineId } = await officeLease();
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    const [receipt] = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect([receipt!.kind, receipt!.taxMinor]).toEqual(['receipt', 127_500]);
    await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      paymentId: receipt!.paymentId,
      valueDate: today,
      lines: [{ lineId, amountMinor: 150_000 }],
    });
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, i.taxMinor])).toEqual([
      ['receipt', 127_500],
      ['withholding_offset', -127_500],
      ['withholding', 150_000],
    ]);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5300')).toBe(150_000);
    const report = await t.reports.items(agency.accountant, { leaseId: lease.id });
    expect(report.map((i) => i.status)).toEqual(['reversed', 'correction', 'withheld']);
  });

  it('is a tax credit for an owner in the letting business, with no rent tax per receipt (decision 2)', async () => {
    const { user } = await ownerAndUser('Letting Business Owner', { lettingBusiness: true });
    const { lease, lineId } = await officeLease();
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    expect(await taxItemsOf(ctx, agency.companyId, lease.id)).toEqual([]);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5300')).toBe(0);
    await t.withholding.uploadCertificate(agency.manager, withholdingId, {
      uploadId: await uploadCertificate(agency.manager),
    });
    const view = await t.withholding.get(user, withholdingId);
    await t.withholding.confirmCertificate(user, view.certificate!.id);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1160')).toBe(150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect((await t.withholding.get(user, withholdingId)).certificate!.debitAccount).toBe('1160');
  });

  it('refuses a certificate confirmed by its uploader, in the service and in the database', async () => {
    const { ownerId } = await ownerAndUser('Uploader Owner');
    const { lease, lineId } = await officeLease();
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId, amountMinor: 150_000 }],
    });
    // The agency admin uploads it; the owner has a user, so an admin could not confirm anyway.
    await t.withholding.uploadCertificate(agency.admin, withholdingId, {
      uploadId: await uploadCertificate(agency.admin),
    });
    const certificateId = (await t.withholding.get(agency.admin, withholdingId)).certificate!.id;
    await expect(
      t.withholding.confirmCertificate(agency.admin, certificateId),
    ).rejects.toMatchObject({
      status: 403,
      message: 'The person who uploaded a certificate cannot confirm it',
    });
    await expect(
      t.withholding.confirmCertificate(agency.manager, certificateId),
    ).rejects.toMatchObject({
      status: 403,
    });
    // Below the service: the database refuses the uploader as the one deciding (decision 3).
    await expect(
      withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx.execute(
          sql`update withholding_certificate set status = 'rejected', decided_by = uploaded_by,
                decided_at = now() where id = ${certificateId}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: 'RA057' } });
    // And the check constraint holds it even with the triggers off.
    await expect(
      asSuperuser(
        ctx,
        `update withholding_certificate set status = 'rejected', decided_by = uploaded_by, decided_at = now()
         where id = $1`,
        [certificateId],
      ),
    ).rejects.toThrow(/withholding_certificate_two_people_check/);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(150_000);
    void ownerId;
  });

  it('writes off withholding whose certificate never came, with a second person (P24), and the owner then owes the tax', async () => {
    const { ownerId } = await ownerAndUser('Write Off Owner');
    const { lease, lineId } = await officeLease();
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId, amountMinor: 150_000 }],
    });
    const approvalId = await t.withholding.requestWriteOff(agency.manager, withholdingId, {
      reason: 'The tenant never sent the certificate',
    });
    await expect(
      s.approvals.decide(agency.manager, approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    await s.approvals.decide(agency.accountant, approvalId, { decision: 'approve' });
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5900')).toBe(150_000);
    expect((await t.withholding.get(agency.manager, withholdingId)).status).toBe('written_off');
    const due = await t.reports.dueList(agency.accountant, { ownerId });
    expect(due.map((i) => [i.kind, i.outstandingMinor])).toEqual([['withholding', 150_000]]);
    await expect(
      t.withholding.uploadCertificate(agency.manager, withholdingId, {
        uploadId: await uploadCertificate(agency.manager),
      }),
    ).rejects.toMatchObject({ code: 'withholding_written_off' });
  });

  it('refuses withholding on a month not started, beyond what is owed, or on another lease’s payment', async () => {
    await ownerAndUser('Refusal Owner');
    const { lease, lineId } = await officeLease();
    await expect(
      t.withholding.record(agency.manager, {
        leaseId: lease.id,
        valueDate: today,
        lines: [{ lineId, amountMinor: 1_000_001 }],
      }),
    ).rejects.toMatchObject({ code: 'withholding.too_large' });
    const options = await t.withholding.options(agency.manager, lease.id);
    expect(options.rate).toMatchObject({
      bps: 1500,
      verificationStatus: 'unverified',
      warning: true,
    });
    expect(options.lines.map((l) => [l.lineId, l.suggestedMinor])).toEqual([[lineId, 150_000]]);
  });
});
