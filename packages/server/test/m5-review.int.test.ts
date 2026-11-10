import { schema, sql, withCompany } from '@rent/db';
import { templates } from '@rent/documents';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertTaxHooks, BillingModule } from '../src/billing/billing.module';
import { TaxAssessmentService } from '../src/tax/tax-assessment.service';
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
  billedLease,
  billingServices,
  leaseAccount,
  moneyCompany,
  runLeaseEvents,
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
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M5 review's findings (2026-11-03), one regression test each against the real database,
 * named after the requirement it proves; each failed before its fix. The reviewer's probes
 * (scenarios A to E) are reused as they were written.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let assessment: TaxAssessmentService;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let units: string[] = [];
let unitIndex = 0;
let parts = 0;
const TOTP_SECRET = 'm5-review-totp-secret';

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });
const base32 = (text: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

/** An owner with a user of their own, and four offices of theirs (the reviewer's probe). */
async function ownerAndUser(name: string) {
  const ownerId = (await s.owners.create(agency.admin, { kind: 'individual', displayName: name }))
    .id;
  const user = await staffIn(ctx, agency.companyId, 'agency', 'owner', `${name} user`, {
    owners: [ownerId],
  });
  parts += 1;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: `R${String(parts).padStart(2, '0')}`,
    ownerId,
    use: 'commercial',
    units: [{ unitType: 'office', count: 4 }],
  });
  units = Object.values(property.units);
  unitIndex = 0;
  return { ownerId, user };
}

/** A commercial office lease at GH₵10,000 a month: from this month's 1st, or starting later. */
async function officeLease(cycle: 'monthly' | 'annual', startOffsetDays = 0) {
  const tenantId = (
    await s.tenants.create(agency.manager, {
      kind: 'company',
      displayName: 'Corp',
      legalName: 'Corp Ltd',
    })
  ).tenant.id;
  const start =
    startOffsetDays === 0 ? `${today.slice(0, 7)}-01` : plusDays(today, startOffsetDays);
  const lease = await billedLease(ctx, s, b, agency.manager, {
    unitId: units[unitIndex++]!,
    tenantId,
    startDate: start,
    endDate: endAfter(start, 12),
    monthlyRentMinor: 1_000_000,
    cycle,
    use: 'commercial',
    signedOn: startOffsetDays === 0 ? plusDays(start, -1) : today,
    ...(startOffsetDays === 0 ? { billingStartDate: start } : {}),
  });
  await b.invoicing.accrueAll(agency.companyId, today);
  const lines = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
    tx
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(sql`lease_id = ${lease.id} and kind = 'rent'`)
      .orderBy(schema.invoiceLine.periodStart),
  );
  return { lease, lines: lines.map((l) => l.id) };
}

async function certify(
  withholdingId: string,
  confirmer: Parameters<TaxServices['withholding']['get']>[0],
) {
  await t.withholding.uploadCertificate(agency.manager, withholdingId, {
    uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(agency.manager, i)),
  });
  const certificate = (await t.withholding.get(confirmer, withholdingId)).certificate!;
  await t.withholding.confirmCertificate(confirmer, certificate.id);
}

/** Rent tax rules rows treated as missing while `fn` runs (TX-08; as a missing row would). */
async function withoutRule<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const resolveIn = s.rules.resolveIn.bind(s.rules);
  const spy = vi.spyOn(s.rules, 'resolveIn').mockImplementation(async (tx, country, k, at) => {
    if (k === key) throw new DomainError('rule.missing', `No rule ${k} for ${country}`);
    return resolveIn(tx, country, k, at);
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

async function paidUntil(leaseId: string): Promise<string | null> {
  return withCompany(
    ctx.database,
    sys(agency.companyId),
    async (tx) => b.engine.walk(await b.engine.load(tx, agency.companyId, leaseId)).paidUntil,
  );
}

const netTax = (items: Awaited<ReturnType<typeof taxItemsOf>>) =>
  items.reduce((sum, i) => sum + Number(i.taxMinor), 0);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  assessment = new TaxAssessmentService(ctx.database, s.policy, b.engine, t.rentTax);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Review Agency');
});

afterAll(async () => {
  await ctx?.close();
});

describe('TX-04 P20 follows the rent tax recorded with the withholding, never the owner’s flag at confirmation (M5 review 1)', () => {
  it('settles 2200 when the owner became a letting business after the withholding was recorded (scenario A)', async () => {
    const { ownerId, user } = await ownerAndUser('Flip One');
    const { lease, lines } = await officeLease('monthly');
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-150_000);
    expect((await t.withholding.get(user, withholdingId)).rentTaxTreatment).toBe('accrued');
    await setLettingBusiness(ctx, agency.companyId, ownerId, true);
    await certify(withholdingId, user);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1160')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect((await t.withholding.get(user, withholdingId)).certificate?.debitAccount).toBe('2200');
    expect(await t.reports.dueList(agency.accountant, { ownerId })).toEqual([]);
  });

  it('is a tax credit when the owner was a letting business at recording and is not since (scenario B)', async () => {
    const { ownerId, user } = await ownerAndUser('Gamma Two');
    await setLettingBusiness(ctx, agency.companyId, ownerId, true);
    const { lease, lines } = await officeLease('monthly');
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    expect((await t.withholding.get(user, withholdingId)).rentTaxTreatment).toBe(
      'letting_business',
    );
    await setLettingBusiness(ctx, agency.companyId, ownerId, false);
    await certify(withholdingId, user);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1160')).toBe(150_000);
    expect(await taxItemsOf(ctx, agency.companyId, lease.id)).toEqual([]);
    const report = await t.reports.report(agency.accountant, {
      ownerId,
      from: plusDays(today, -40),
      to: today,
    });
    expect(report.totals.outstandingMinor).toBe(0);
  });

  it('is a tax credit when no rent tax was assessed, and settles 2200 once a later run assessed it (review 7)', async () => {
    const { ownerId, user } = await ownerAndUser('Unassessed Owner');
    const first = await officeLease('monthly');
    const second = await officeLease('monthly');
    const [early, late] = await withoutRule('rent_tax.rate.commercial', async () => [
      await t.withholding.record(agency.manager, {
        leaseId: first.lease.id,
        valueDate: today,
        lines: [{ lineId: first.lines[0]!, amountMinor: 150_000 }],
      }),
      await t.withholding.record(agency.manager, {
        leaseId: second.lease.id,
        valueDate: today,
        lines: [{ lineId: second.lines[0]!, amountMinor: 150_000 }],
      }),
    ]);
    expect((await t.withholding.get(user, early)).rentTaxTreatment).toBe('not_assessed');
    // Confirmed before any run could assess it: nothing in 2200 is owed for it, so 1160.
    await certify(early, user);
    expect(await leaseAccount(ctx, agency.companyId, first.lease.id, '1160')).toBe(150_000);
    expect(await leaseAccount(ctx, agency.companyId, first.lease.id, '2200')).toBe(0);
    // The run assesses the other (its rules are back) and leaves the confirmed one to a person.
    expect(await assessment.run(agency.companyId)).toBe(2);
    expect(await taxItemsOf(ctx, agency.companyId, first.lease.id)).toEqual([]);
    expect(
      (await taxItemsOf(ctx, agency.companyId, second.lease.id)).map((i) => [i.kind, i.taxMinor]),
    ).toEqual([['withholding', 150_000]]);
    await certify(late, user);
    expect(await leaseAccount(ctx, agency.companyId, second.lease.id, '2200')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, second.lease.id, '1160')).toBe(0);
    const events = await assessment.list(agency.accountant, { ownerId });
    expect(events.map((e) => [e.event, e.reason, e.ruleKey, e.assessed])).toEqual([
      ['withholding', 'rule_missing', 'rent_tax.rate.commercial', true],
      ['withholding', 'rule_missing', 'rent_tax.rate.commercial', true],
    ]);
  });
});

describe('TX-04 withholding recorded after the money arrived (M5 review 2)', () => {
  it('the reviewer’s scenario: an annual lease paid GH₵102,000 net first, then GH₵1,500 withheld on each month', async () => {
    const { ownerId, user } = await ownerAndUser('Order Probe');
    const { lease, lines } = await officeLease('annual', 10);
    expect(lines).toHaveLength(12);
    const { paymentId } = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 12 * 850_000,
      receivedOn: today,
    });
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      paymentId,
      valueDate: today,
      lines: lines.map((lineId) => ({ lineId, amountMinor: 150_000 })),
    });
    // 102,000 cash and 18,000 withheld cover all twelve months: nothing is owed.
    expect(await paidUntil(lease.id)).toBe(endAfter(plusDays(today, 10), 12));
    // Rent tax totals GH₵18,000, all of it withheld; the tax on the cash it replaced is offset.
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(netTax(items)).toBe(1_800_000);
    expect(
      items.filter((i) => i.kind === 'withholding').reduce((s, i) => s + Number(i.taxMinor), 0),
    ).toBe(1_800_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(1_800_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-1_800_000);
    expect(await t.reports.dueList(agency.accountant, { ownerId })).toEqual([]);
    expect((await t.withholding.get(user, withholdingId)).lines.every((l) => l.heldAsAdvance)).toBe(
      true,
    );
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
    // The certificates settle it.
    await certify(withholdingId, user);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
  });

  it('moves a started month’s cash to the next month, and taxes it as it covers that month', async () => {
    await ownerAndUser('Started Month');
    const { lease, lines } = await officeLease('monthly');
    const { paymentId } = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 1_000_000,
      receivedOn: today,
    });
    await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(0);
    // GH₵1,500 of the cash is credit again, paying the next month forward.
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010')).toBe(-150_000);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, Number(i.taxMinor)])).toEqual([
      ['receipt', 150_000],
      ['withholding_offset', -150_000],
      ['withholding', 150_000],
      ['receipt', 22_500],
    ]);
    expect(items[3]!.paymentId).toBe(paymentId);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('TX-03 the report shows tax withheld awaiting its certificate on its own, never as still owed (M5 review 3)', () => {
  it('worked example B with the certificate pending: still owed 0, GH₵1,500 withheld and awaiting, on screen, in the CSV and the PDF data', async () => {
    const { ownerId, user } = await ownerAndUser('Epsilon Owner');
    const { lease, lines } = await officeLease('monthly');
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    const period = { ownerId, from: plusDays(today, -40), to: today };
    const report = await t.reports.report(agency.accountant, period);
    expect(report.totals).toMatchObject({
      taxMinor: 150_000,
      withheldMinor: 150_000,
      withheldAwaitingCertificateMinor: 150_000,
      outstandingMinor: 0,
    });
    const csv = (await t.reports.csv(agency.accountant, period)).content.split('\r\n');
    expect(csv).toContain(
      '"Withheld by tenants, awaiting certificate","","","","","","","","1500.00","",""',
    );
    expect(csv).toContain(
      '"Still owed at the end of the period","","","","","","","","0.00","",""',
    );
    const data = templates
      .get('tax.rent-tax-report', 2)
      .schema.parse(t.reports.documentData(report)) as { totals: Record<string, number> };
    expect(data.totals.withheldAwaitingCertificateMinor).toBe(150_000);
    expect(await t.reports.dueList(agency.accountant, { ownerId })).toEqual([]);
    // The certificate settles it: nothing awaits and nothing is owed.
    await certify(withholdingId, user);
    expect((await t.reports.report(agency.accountant, period)).totals).toMatchObject({
      withheldAwaitingCertificateMinor: 0,
      outstandingMinor: 0,
    });
  });
});

describe('TX-04 a sole landlord’s certificate never gets stuck (M5 review 4)', () => {
  it('raises a fresh request after the first was cancelled: to withdraw the upload, then to confirm the next', async () => {
    const companyId = await company(ctx, 'landlord', 'Sole Probe');
    const personId = await person(ctx, 'Sole probe owner', { totpSecret: TOTP_SECRET });
    const owner = staff(
      companyId,
      'landlord',
      personId,
      await member(ctx, companyId, personId, 'owner'),
      'owner',
    );
    const ownerId = (
      await s.owners.create(owner, { kind: 'individual', displayName: 'Sole Probe Owner' })
    ).id;
    const property = await propertyWithUnits(s, owner, {
      areaCode: 'ACC',
      propertyPart: 'SPR',
      ownerId,
      use: 'commercial',
      units: [{ unitType: 'office', count: 1 }],
    });
    const tenantId = (
      await s.tenants.create(owner, {
        kind: 'company',
        displayName: 'SP Corp',
        legalName: 'SP Corp Ltd',
      })
    ).tenant.id;
    const start = `${today.slice(0, 7)}-01`;
    const lease = await billedLease(ctx, s, b, owner, {
      unitId: Object.values(property.units)[0]!,
      tenantId,
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 1_000_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await b.invoicing.accrueAll(companyId, today);
    const [line] = await withCompany(ctx.database, sys(companyId), (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${lease.id} and kind = 'rent'`)
        .orderBy(schema.invoiceLine.periodStart),
    );
    const withholdingId = await t.withholding.record(owner, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await t.withholding.uploadCertificate(owner, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(owner, i)),
    });
    const first = (await t.withholding.get(owner, withholdingId)).certificate!;
    await s.approvals.cancel(owner, first.selfConfirmation!.approvalId);
    // Stuck before review 4: no request open, and nobody else may decide it.
    await expect(t.withholding.confirmCertificate(owner, first.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await t.withholding.get(owner, withholdingId)).certificate?.mayRequestSelfDecision,
    ).toBe(true);
    // M11 (founder-approved, 2026-11-10): each self-confirm uses a fresh code, the next 30-second
    // step's, because a TOTP step-up is accepted once per step (security review R1 F4).
    let selfDecisions = 0;
    const selfDecide = async (approvalId: string) => {
      await asSuperuser(
        ctx,
        "update approval_request set cooling_off_until = now() - interval '1 minute' where id = $1",
        [approvalId],
      );
      ctx.clock.advance(24 * 3_600_000 + 60_000);
      try {
        await s.approvals.decide(owner, approvalId, {
          decision: 'self_confirm',
          code: await generate({
            secret: base32(TOTP_SECRET),
            epoch: Math.floor(Date.now() / 1000) + 30 * selfDecisions++,
          }),
        });
      } finally {
        ctx.clock.advance(-(24 * 3_600_000 + 60_000));
      }
    };
    // 1. Withdraw it (the wrong certificate was uploaded): rejected, nothing posted.
    const withdrawal = await t.withholding.requestSelfDecision(owner, first.id, 'withdraw');
    await expect(
      t.withholding.requestSelfDecision(owner, first.id, 'confirm'),
    ).rejects.toMatchObject({ code: 'approval_open' });
    await selfDecide(withdrawal);
    const withdrawn = await t.withholding.get(owner, withholdingId);
    expect(withdrawn).toMatchObject({ status: 'awaiting_certificate', rejectedCertificates: 1 });
    expect(await leaseAccount(ctx, companyId, lease.id, '1150')).toBe(150_000);
    // 2. The right one, its request cancelled too, then confirmed through a fresh one.
    await t.withholding.uploadCertificate(owner, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(owner, i)),
    });
    const second = (await t.withholding.get(owner, withholdingId)).certificate!;
    await s.approvals.cancel(owner, second.selfConfirmation!.approvalId);
    const confirmation = await t.withholding.requestSelfDecision(owner, second.id, 'confirm');
    await selfDecide(confirmation);
    expect((await t.withholding.get(owner, withholdingId)).status).toBe('certified');
    expect(await leaseAccount(ctx, companyId, lease.id, '1150')).toBe(0);
    expect(await leaseAccount(ctx, companyId, lease.id, '2200')).toBe(0);
  });

  it('refuses a fresh request while someone else may decide it (decision 3)', async () => {
    await ownerAndUser('Others Decide');
    const { lease, lines } = await officeLease('monthly');
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    await t.withholding.uploadCertificate(agency.manager, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(agency.manager, i)),
    });
    const certificate = (await t.withholding.get(agency.manager, withholdingId)).certificate!;
    expect(certificate.mayRequestSelfDecision).toBe(false);
    await expect(
      t.withholding.requestSelfDecision(agency.manager, certificate.id, 'confirm'),
    ).rejects.toMatchObject({ code: 'certificate_others_decide' });
  });
});

describe('TX-08 rent tax a missing rules row could not assess (M5 review 7)', () => {
  it('posts the receipt, records it as not assessed with an alert, and a later run assesses it on its own key', async () => {
    const { ownerId } = await ownerAndUser('Missing Rule');
    const { lease } = await officeLease('monthly');
    const alertsBefore = t.alerts.length;
    const { paymentId } = await withoutRule('rent_tax.rate.commercial', () =>
      b.money.recordProviderPayment(agency.companyId, {
        leaseId: lease.id,
        amountMinor: 1_000_000,
        receivedOn: today,
      }),
    );
    expect(await taxItemsOf(ctx, agency.companyId, lease.id)).toEqual([]);
    expect(t.alerts.slice(alertsBefore)).toEqual([
      expect.objectContaining({ code: 'tax.not_assessed', severity: 'critical' }),
    ]);
    const open = await assessment.list(agency.accountant, { ownerId, open: true });
    expect(open).toEqual([
      expect.objectContaining({
        event: 'receipt',
        eventKey: `P17:${paymentId}`,
        paymentId,
        reason: 'rule_missing',
        ruleKey: 'rent_tax.rate.commercial',
        assessed: false,
      }),
    ]);
    // Still missing: the run leaves it. Back: assessed once, on P17's key.
    expect(
      await withoutRule('rent_tax.rate.commercial', () => assessment.run(agency.companyId)),
    ).toBe(0);
    expect(await assessment.run(agency.companyId)).toBe(1);
    expect(await assessment.run(agency.companyId)).toBe(0);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, i.paymentId, Number(i.taxMinor)])).toEqual([
      ['receipt', paymentId, 150_000],
    ]);
    expect(await assessment.list(agency.accountant, { ownerId, open: true })).toEqual([]);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });

  it('refuses to start billing without the tax hooks registered', () => {
    expect(() => assertTaxHooks({ taxHooksRegistered: false })).toThrow(/TaxModule/);
    expect(() => assertTaxHooks({ taxHooksRegistered: true })).not.toThrow();
    const billing = new BillingModule(
      {} as never,
      {} as never,
      {
        taxHooksRegistered: false,
      } as never,
    );
    expect(() => billing.onApplicationBootstrap()).toThrow(/TaxModule/);
    // The test services wire rent tax as Nest does.
    expect(b.engine.taxHooksRegistered).toBe(true);
  });
});

describe('TX-04 withholding advised after its tax was paid to GRA (M5 review N1)', () => {
  it('warns on the withholding and alerts a person: the owner’s rent tax is overpaid', async () => {
    const { ownerId } = await ownerAndUser('Paid First');
    const { lease, lines } = await officeLease('monthly');
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 1_000_000,
      receivedOn: today,
    });
    const [item] = await taxItemsOf(ctx, agency.companyId, lease.id);
    await t.gra.recordGraPayment(agency.accountant, {
      ownerId,
      paidOn: today,
      amountMinor: 150_000,
      graReceiptNumber: 'GRA-N1',
      receiptUploadId: await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i)),
      paidFrom: 'owner_account',
      items: [{ itemId: item!.id, amountMinor: 150_000 }],
    });
    const alertsBefore = t.alerts.length;
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
    });
    const view = await t.withholding.get(agency.manager, withholdingId);
    expect(view.warnings).toEqual([expect.stringMatching(/GRA was already paid GH₵1,500\.00/)]);
    expect(t.alerts.slice(alertsBefore)).toEqual([
      expect.objectContaining({
        code: 'tax.withheld_after_paid',
        context: expect.objectContaining({ withholdingId }),
      }),
    ]);
  });
});

describe('TX-03 a GRA payment and a correction of the same rent tax never cross (M5 review 10)', () => {
  it('serialises a GRA payment with withholding that replaces the same tax: each sees the other, under concurrency', async () => {
    const { ownerId } = await ownerAndUser('Racing Owner');
    const rounds = 4;
    for (let round = 0; round < rounds; round += 1) {
      const { lease, lines } = await officeLease('monthly');
      await b.money.recordProviderPayment(agency.companyId, {
        leaseId: lease.id,
        amountMinor: 1_000_000,
        receivedOn: today,
      });
      const [item] = await taxItemsOf(ctx, agency.companyId, lease.id);
      const receiptUploadId = await uploadEvidence(ctx, (i) =>
        t.gra.createUpload(agency.accountant, i),
      );
      const alertsBefore = t.alerts.length;
      const [gra, withheld] = await Promise.allSettled([
        t.gra.recordGraPayment(agency.accountant, {
          ownerId,
          paidOn: today,
          amountMinor: 150_000,
          graReceiptNumber: `GRA-RACE-${round}`,
          receiptUploadId,
          paidFrom: 'owner_account',
          items: [{ itemId: item!.id, amountMinor: 150_000 }],
        }),
        t.withholding.record(agency.manager, {
          leaseId: lease.id,
          valueDate: today,
          lines: [{ lineId: lines[0]!, amountMinor: 150_000 }],
        }),
      ]);
      expect(withheld.status).toBe('fulfilled');
      const after = (await t.reports.items(agency.accountant, { leaseId: lease.id })).find(
        (i) => i.id === item!.id,
      )!;
      if (gra.status === 'fulfilled') {
        // GRA was paid first: the withholding saw it, warned and alerted a person.
        expect(after.paidMinor).toBe(150_000);
        expect(t.alerts.slice(alertsBefore).map((a) => a.code)).toContain(
          'tax.withheld_after_paid',
        );
      } else {
        // The withholding came first: the GRA payment saw the item had nothing left to settle.
        expect(after.paidMinor).toBe(0);
        expect(after.correctedMinor).toBe(-150_000);
      }
    }
  }, 120_000);
});

describe('AR-04 the early-termination preview is for people who may settle it (M5 review N3)', () => {
  it('refuses a read-only adviser', async () => {
    await ownerAndUser('Preview Owner');
    const { lease } = await officeLease('monthly');
    const adviser = await staffIn(ctx, agency.companyId, 'agency', 'adviser', 'Review Adviser');
    await expect(
      t.termination.preview(adviser, lease.id, { charges: [], deductions: [] }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('TX-01 cash a credit note released is not taxed again when it pays the renewal (M5 review N2)', () => {
  it('taxes it once, on the receipt that brought it, when the credit is carried to the renewal', async () => {
    await ownerAndUser('Renewal Owner');
    const tenantId = (
      await s.tenants.create(agency.manager, {
        kind: 'company',
        displayName: 'Renewing Corp',
        legalName: 'Renewing Corp Ltd',
      })
    ).tenant.id;
    const start = plusMonths(today, -11);
    const end = endAfter(start, 12);
    const old = await billedLease(ctx, s, b, agency.manager, {
      unitId: units[unitIndex++]!,
      tenantId,
      startDate: start,
      endDate: end,
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await b.invoicing.generateAll(agency.companyId, plusDays(end, -13));
    await b.invoicing.accrueAll(agency.companyId, today);
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: old.id,
      amountMinor: 12 * 100_000,
      receivedOn: today,
    });
    expect(netTax(await taxItemsOf(ctx, agency.companyId, old.id))).toBe(180_000);
    // A credit note gives back 70,000 of a paid month; its tax stays in place (OQ-19).
    const [fifth] = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(
          sql`lease_id = ${old.id} and kind = 'rent' and period_start = ${plusMonths(start, 4)}`,
        ),
    );
    const requestId = await b.money.requestCreditNote(agency.manager, fifth!.id, {
      amountMinor: 70_000,
      reason: 'Agreed discount for repairs',
    });
    await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
    // The renewal, signed now, starts the day after the end and takes the credit (P29).
    const renewal = await s.leases.offerRenewal(agency.manager, old.id);
    const scan = await uploadLeaseFile(ctx, s, agency.manager);
    const staged = await s.documents.stageEvidenceUpload(
      { companyId: agency.companyId, personId: agency.manager.personId },
      scan,
      { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
    );
    await withCompany(
      ctx.database,
      { companyId: agency.companyId, personId: agency.manager.personId, actorKind: 'staff' },
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
    await runLeaseEvents(ctx, b, agency.companyId);
    const renewalStart = plusDays(end, 1);
    const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(renewalStart)) * 86_400_000;
    ctx.clock.advance(ms);
    try {
      await s.lifecycle.runTransitions(agency.companyId, renewalStart);
      await runLeaseEvents(ctx, b, agency.companyId);
      await b.invoicing.generateAll(agency.companyId, renewalStart);
      await b.invoicing.accrueAll(agency.companyId, renewalStart);
    } finally {
      ctx.clock.advance(-ms);
    }
    expect(await leaseAccount(ctx, agency.companyId, old.id, '2010')).toBe(0);
    // The carried 70,000 pays the renewal's first month, and is not taxed a second time.
    expect(netTax(await taxItemsOf(ctx, agency.companyId, renewal.id))).toBe(0);
    expect(netTax(await taxItemsOf(ctx, agency.companyId, old.id))).toBe(180_000);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  }, 60_000);
});
