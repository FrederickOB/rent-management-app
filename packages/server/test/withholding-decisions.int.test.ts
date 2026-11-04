import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  journalSum,
  leaseAccount,
  moneyCard,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import { taxItemsOf, taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The founder's answers of 2026-11-03 (M5 decisions 7 to 9) against the real database:
 * a single-user landlord confirms their own certificate after the cooling-off with TOTP, and
 * nowhere else may an uploader; withholding on months not yet started is held as their advance
 * and drawn as each starts; a credit note on withheld tax is refused plainly, also in the
 * early-termination preview.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;
const DAY = 86_400_000;
const TOTP_SECRET = 'withholding-decisions-totp-secret';

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const base32 = (text: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

type Actor = Parameters<TenancyServices['owners']['create']>[0];

/** A commercial office with its owner, and a lease on it (worked example B's figures). */
async function officeLease(
  actor: Actor,
  companyId: string,
  input: { ownerId: string; part: string; start: string; cycle: 'monthly' | 'annual' },
) {
  const property = await propertyWithUnits(s, actor, {
    areaCode: 'ACC',
    propertyPart: input.part,
    ownerId: input.ownerId,
    use: 'commercial',
    units: [{ unitType: 'office', count: 2 }],
  });
  const tenantId = (
    await s.tenants.create(actor, {
      kind: 'company',
      displayName: `Corporate ${input.part}`,
      legalName: `Corporate ${input.part} Limited`,
    })
  ).tenant.id;
  const lease = await billedLease(ctx, s, b, actor, {
    unitId: Object.values(property.units)[0]!,
    tenantId,
    startDate: input.start,
    endDate: endAfter(input.start, 12),
    monthlyRentMinor: 1_000_000,
    cycle: input.cycle,
    use: 'commercial',
    signedOn: input.start < today ? plusDays(input.start, -1) : today,
    ...(input.start < today ? { billingStartDate: input.start } : {}),
  });
  await b.invoicing.accrueAll(companyId, today);
  return lease;
}

async function rentLines(companyId: string, leaseId: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ id: schema.invoiceLine.id, periodStart: schema.invoiceLine.periodStart })
      .from(schema.invoiceLine)
      .where(sql`lease_id = ${leaseId} and kind = 'rent'`)
      .orderBy(schema.invoiceLine.periodStart),
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('TX-04 a sole landlord confirms their own certificate after the cooling-off (M5 decision 7)', () => {
  it('raises a single-user request, refuses before the cooling-off ends, and confirms with a TOTP code after it', async () => {
    const companyId = await company(ctx, 'landlord', 'Sole Landlord');
    const personId = await person(ctx, 'Sole owner', { totpSecret: TOTP_SECRET });
    const owner = staff(
      companyId,
      'landlord',
      personId,
      await member(ctx, companyId, personId, 'owner'),
      'owner',
    );
    const ownerId = (
      await s.owners.create(owner, { kind: 'individual', displayName: 'Sole Owner' })
    ).id;
    const start = `${today.slice(0, 7)}-01`;
    const lease = await officeLease(owner, companyId, {
      ownerId,
      part: 'SOL',
      start,
      cycle: 'monthly',
    });
    const [line] = await rentLines(companyId, lease.id);
    const withholdingId = await t.withholding.record(owner, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await t.withholding.uploadCertificate(owner, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(owner, i)),
    });
    const view = await t.withholding.get(owner, withholdingId);
    const certificate = view.certificate!;
    expect(certificate).toMatchObject({ status: 'awaiting_confirmation', mayDecide: false });
    expect(certificate.selfConfirmation).toMatchObject({ status: 'cooling_off' });
    const approvalId = certificate.selfConfirmation!.approvalId;
    const request = await s.approvals.get(owner, approvalId);
    expect(request.request).toMatchObject({ mode: 'single_user', initiatedBy: personId });

    // Not directly, and not before the cooling-off ends.
    await expect(t.withholding.confirmCertificate(owner, certificate.id)).rejects.toMatchObject({
      code: 'certificate_self_confirm',
    });
    const code = await generate({ secret: base32(TOTP_SECRET) });
    await expect(
      s.approvals.decide(owner, approvalId, { decision: 'self_confirm', code }),
    ).rejects.toThrow(/cooling-off/);
    // Below the service: naming the request is not enough until it is self-confirmed.
    await expect(
      withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
        tx.execute(
          sql`update withholding_certificate set status = 'confirmed', decided_by = uploaded_by, decided_at = now(),
                debit_account = '2200', entry_id = (select entry_id from withholding where id = ${withholdingId}),
                self_confirm_request_id = ${approvalId} where id = ${certificate.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: 'RA057' } });

    // A day later (moved in the database and in the service clock), with a current code.
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = now() - interval '1 minute' where id = $1",
      [approvalId],
    );
    ctx.clock.advance(24 * 3_600_000 + 60_000);
    try {
      await s.approvals.decide(owner, approvalId, {
        decision: 'self_confirm',
        code: await generate({ secret: base32(TOTP_SECRET) }),
      });
    } finally {
      ctx.clock.advance(-(24 * 3_600_000 + 60_000));
    }
    const done = await t.withholding.get(owner, withholdingId);
    expect(done.status).toBe('certified');
    expect(done.certificate).toMatchObject({
      status: 'confirmed',
      decidedBy: personId,
      debitAccount: '2200',
    });
    expect(await leaseAccount(ctx, companyId, lease.id, '1150')).toBe(0);
    expect(await leaseAccount(ctx, companyId, lease.id, '2200')).toBe(0);
    expect((await s.approvals.get(owner, approvalId)).request.status).toBe('approved');
  });

  it('lets a nominated second approver confirm instead, and then the uploader never may', async () => {
    const companyId = await company(ctx, 'landlord', 'Landlord With Approver');
    const personId = await person(ctx, 'Landlord with approver');
    const owner = staff(
      companyId,
      'landlord',
      personId,
      await member(ctx, companyId, personId, 'owner'),
      'owner',
    );
    const approverId = await person(ctx, 'Nominated approver');
    const approver = staff(
      companyId,
      'landlord',
      approverId,
      await member(ctx, companyId, approverId, 'adviser', { nominatedApprover: true }),
      'adviser',
      true,
    );
    const ownerId = (
      await s.owners.create(owner, { kind: 'individual', displayName: 'Approver Owner' })
    ).id;
    const lease = await officeLease(owner, companyId, {
      ownerId,
      part: 'NOM',
      start: `${today.slice(0, 7)}-01`,
      cycle: 'monthly',
    });
    const [line] = await rentLines(companyId, lease.id);
    const withholdingId = await t.withholding.record(owner, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await t.withholding.uploadCertificate(owner, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(owner, i)),
    });
    const certificate = (await t.withholding.get(owner, withholdingId)).certificate!;
    expect(certificate.selfConfirmation).toBeNull();
    await expect(t.withholding.confirmCertificate(owner, certificate.id)).rejects.toMatchObject({
      status: 403,
    });
    expect((await t.withholding.get(approver, withholdingId)).certificate!.mayDecide).toBe(true);
    await t.withholding.confirmCertificate(approver, certificate.id);
    expect((await t.withholding.get(owner, withholdingId)).certificate).toMatchObject({
      status: 'confirmed',
      decidedBy: approverId,
    });
  });

  it('keeps refusing the uploader everywhere else, even naming another request (RA057)', async () => {
    const agency = await moneyCompany(ctx, s, 'agency', 'Two Person Agency');
    const ownerId = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Agency Owner' })
    ).id;
    await staffIn(ctx, agency.companyId, 'agency', 'owner', 'Agency Owner user', {
      owners: [ownerId],
    });
    const lease = await officeLease(agency.manager, agency.companyId, {
      ownerId,
      part: 'TWP',
      start: `${today.slice(0, 7)}-01`,
      cycle: 'monthly',
    });
    const [line] = await rentLines(agency.companyId, lease.id);
    const first = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 100_000 }],
    });
    const second = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 50_000 }],
    });
    await t.withholding.uploadCertificate(agency.manager, first, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(agency.manager, i)),
    });
    const certificate = (await t.withholding.get(agency.manager, first)).certificate!;
    expect(certificate.selfConfirmation).toBeNull();
    // Another request of the company, two-person (a write-off of the second withholding).
    const writeOff = await t.withholding.requestWriteOff(agency.manager, second, {
      reason: 'No certificate came for this one',
    });
    await expect(
      withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx.execute(
          sql`update withholding_certificate set status = 'confirmed', decided_by = uploaded_by, decided_at = now(),
                debit_account = '2200', entry_id = (select entry_id from withholding where id = ${first}),
                self_confirm_request_id = ${writeOff} where id = ${certificate.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: 'RA057' } });
  });
});

describe('TX-04 withholding on months not yet started is held as an advance (M5 decision 8)', () => {
  let agency: Awaited<ReturnType<typeof moneyCompany>>;
  let ownerId: string;
  let ownerUser: Awaited<ReturnType<typeof staffIn>>;
  beforeAll(async () => {
    agency = await moneyCompany(ctx, s, 'agency', 'Advance Withholding Agency');
    ownerId = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Annual Owner' })
    ).id;
    ownerUser = await staffIn(ctx, agency.companyId, 'agency', 'owner', 'Annual Owner user', {
      owners: [ownerId],
    });
  });

  /** An annual commercial advance paid net: GH₵1,500 withheld on each month, GH₵102,000 paid. */
  async function annualNet(part: string) {
    const start = plusDays(today, 10);
    const lease = await officeLease(agency.manager, agency.companyId, {
      ownerId,
      part,
      start,
      cycle: 'annual',
    });
    const lines = await rentLines(agency.companyId, lease.id);
    expect(lines.length).toBe(12);
    const options = await t.withholding.options(agency.manager, lease.id);
    expect(options.lines).toEqual([]);
    expect(options.advanceLines!.map((l) => [l.started, l.suggestedMinor])).toEqual(
      lines.map(() => [false, 150_000]),
    );
    const withholdingId = await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: today,
      lines: lines.map((l) => ({ lineId: l.id, amountMinor: 150_000 })),
    });
    const payment = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 12 * 850_000,
      receivedOn: today,
    });
    return { lease, lines, start, withholdingId, payment };
  }

  it('pins the withholding to the future months, draws it as each starts, and the certificate settles it, over the whole year', async () => {
    const { lease, lines, start, withholdingId } = await annualNet('ANN');
    // Held as the months' advance: Dr 1150, Cr 2010; never a receivable before a month starts.
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(1_800_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010')).toBe(-12_000_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(0);
    const view = await t.withholding.get(agency.manager, withholdingId);
    expect(view.lines.every((l) => l.heldAsAdvance)).toBe(true);
    // The tax on those months is the amount withheld; the net cash is not taxed again.
    expect(
      (await taxItemsOf(ctx, agency.companyId, lease.id)).map((i) => [i.kind, i.taxMinor]),
    ).toEqual([['withholding', 1_800_000]]);
    // Covered for paid-until, reminders, ageing and the invoice list.
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card).toMatchObject({ paidUntil: endAfter(start, 12), dueNowMinor: 0, creditMinor: 0 });
    const invoices = await b.read.invoices(agency.manager, { leaseId: lease.id });
    expect(invoices.map((i) => [i.outstandingMinor, i.status])).toEqual([[0, 'paid']]);

    for (let month = 0; month < 12; month += 1) {
      const date = plusMonths(start, month);
      await on(date, () => b.invoicing.accrueAll(agency.companyId, date));
      expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100'), `month ${month}`).toBe(0);
      expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010'), `month ${month}`).toBe(
        0 - 1_000_000 * (11 - month),
      );
      expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000'), `month ${month}`).toBe(
        -1_000_000 * (month + 1),
      );
    }
    for (const line of lines)
      expect(
        await journalSum(
          ctx,
          agency.companyId,
          `e.idempotency_key = $1 and l.account_code = '2010'`,
          [`P02:${line.id}:withholding:${withholdingId}`],
        ),
      ).toBe(150_000);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);

    // The certificate settles it as usual (P20).
    await t.withholding.uploadCertificate(agency.manager, withholdingId, {
      uploadId: await uploadEvidence(ctx, (i) => t.withholding.createUpload(agency.manager, i)),
    });
    const certificate = (await t.withholding.get(ownerUser, withholdingId)).certificate!;
    await t.withholding.confirmCertificate(ownerUser, certificate.id);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010')).toBe(0);
  });

  it('keeps the withholding when the net payment is reversed: each month is then owed only its cash', async () => {
    const { lease, start, payment } = await annualNet('REV');
    for (const month of [0, 1]) {
      const date = plusMonths(start, month);
      await on(date, () => b.invoicing.accrueAll(agency.companyId, date));
    }
    const day = plusMonths(start, 1);
    await on(day, async () => {
      const approval = await b.money.requestReversal(agency.manager, payment.paymentId, {
        reason: 'other',
        note: 'The tenant’s bank recalled the payment',
        moneyNowIn: 'provider',
      });
      await s.approvals.decide(agency.accountant, approval, { decision: 'approve' });
    });
    // Two months started: each owes GH₵8,500; the ten to come hold only the withholding.
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(2 * 850_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010')).toBe(-10 * 150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1150')).toBe(1_800_000);
    const card = await on(day, () => moneyCard(ctx, b, agency.companyId, lease.id));
    expect(card.paidUntil).toBeNull();
    expect(card.earnedUnpaidMinor).toBe(2 * 850_000);
    expect((await taxItemsOf(ctx, agency.companyId, lease.id)).map((i) => i.kind)).toEqual([
      'withholding',
    ]);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('TX-04 a credit note on a withheld month is refused plainly (M5 decision 9)', () => {
  it('refuses the request with its own code, and the early-termination preview says so before a refund is asked for', async () => {
    const agency = await moneyCompany(ctx, s, 'agency', 'Credit Note Agency');
    const ownerId = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Credit Owner' })
    ).id;
    const started = await officeLease(agency.manager, agency.companyId, {
      ownerId,
      part: 'CRN',
      start: `${today.slice(0, 7)}-01`,
      cycle: 'monthly',
    });
    const [line] = await rentLines(agency.companyId, started.id);
    await t.withholding.record(agency.manager, {
      leaseId: started.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: started.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    const refusal = {
      status: 422,
      code: 'credit_note_withheld',
      message:
        'This month has tax the tenant withheld; a credit note cannot take that back. Settle it by hand.',
    };
    await expect(
      b.money.requestCreditNote(agency.manager, line!.id, {
        amountMinor: 1_000_000,
        reason: 'The tenant was never in the office',
      }),
    ).rejects.toMatchObject(refusal);

    // An annual advance paid net, ended early: the months after the end hold withheld tax.
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'CRE',
      ownerId,
      use: 'commercial',
      units: [{ unitType: 'office', count: 1 }],
    });
    const tenantId = (
      await s.tenants.create(agency.manager, {
        kind: 'company',
        displayName: 'Early Leaver',
        legalName: 'Early Leaver Ltd',
      })
    ).tenant.id;
    const start = plusMonths(`${today.slice(0, 7)}-01`, -2);
    const ended = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(property.units)[0]!,
      tenantId,
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 1_000_000,
      cycle: 'annual',
      use: 'commercial',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await b.invoicing.accrueAll(agency.companyId, today);
    const lines = await rentLines(agency.companyId, ended.id);
    await t.withholding.record(agency.manager, {
      leaseId: ended.id,
      valueDate: today,
      lines: lines.map((l) => ({ lineId: l.id, amountMinor: 150_000 })),
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: ended.id,
      amountMinor: 12 * 850_000,
      receivedOn: today,
    });
    await s.lifecycle.recordMoveOut(agency.manager, ended.id, { moveOutDate: plusDays(today, -1) });
    // The lease's end is processed: its later months are cancelled, the withheld tax stays.
    await runLeaseEvents(ctx, b, agency.companyId);
    await expect(
      t.termination.preview(agency.manager, ended.id, { charges: [], deductions: [] }),
    ).rejects.toMatchObject(refusal);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});
