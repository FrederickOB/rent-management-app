import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { templates } from '@rent/documents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  leaseAccount,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * The move-out settlement against the real database (TL-11, MI-11; M8 decision 12 and plan 4.8):
 * the statement drafted is the settlement run in a savepoint; a second person approves it; it
 * posts the end, P13, P11 (with P17), P12; and the refund paid leaves 2100, 2010 and 2400 at zero.
 * A lease that ended without one gets a deposit settlement. Every test makes its own company.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

type Company = Awaited<ReturnType<typeof moneyCompany>> & { units: string[]; next: number };

async function companyWithUnits(name: string, part: string): Promise<Company> {
  const company = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(company.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(s, company.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  return { ...company, units: Object.values(property.units), next: 0 };
}

/** A monthly lease that started three months ago with a deposit, paid as `paidMinor` on day one. */
async function depositLease(c: Company, input: { deposit: number; paidMinor: number }) {
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Tenant ${c.next}`,
  });
  const start = plusMonths(today, -3);
  const lease = await billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId: tenant.id,
    startDate: start,
    endDate: plusDays(plusMonths(start, 12), -1),
    monthlyRentMinor: 100_000,
    depositMinor: input.deposit,
    cycle: 'monthly',
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
  await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
    leaseId: lease.id,
    receivedInto: 'owner_account',
    amountMinor: input.paidMinor,
    receivedOn: start,
    senderReference: 'TEST',
  });
  return lease;
}

async function leaseStatus(companyId: string, leaseId: string) {
  const [row] = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ status: schema.lease.status })
      .from(schema.lease)
      .where(sql`id = ${leaseId}`),
  );
  return row?.status;
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('TL-11 and MI-11 the move-out settlement', () => {
  it('★ balances: the deposit pays arrears and keeps the deductions; a second person approves; the refund paid leaves 2100, 2010 and 2400 at zero', async () => {
    const c = await companyWithUnits('Move-out Agency', 'MOA');
    // A deposit of 200,000 and three months' rent paid; the rest of the rent is owed.
    const lease = await depositLease(c, { deposit: 200_000, paidMinor: 500_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    expect(await leaseStatus(c.companyId, lease.id)).toBe('ending');
    await m.moveOuts.addDeduction(c.manager, planned.id, {
      kind: 'cleaning',
      amountMinor: 30_000,
      reason: 'Deep clean after move-out',
      inspectionItemIds: [],
      photoIds: [],
    });
    const drafted = await m.moveOuts.get(c.manager, planned.id);
    const st = drafted.statement!;
    expect(st.depositHeldMinor).toBe(200_000);
    expect(st.arrearsMinor).toBeGreaterThan(0);
    // The statement balances to zero (plan 4.8): what was held went to arrears, deductions or back.
    expect(st.breakCreditMinor).toBe(0);
    expect(st.depositHeldMinor + st.creditMinor).toBe(
      st.creditAppliedMinor +
        st.depositAppliedMinor +
        st.retainedMinor +
        st.creditRefundMinor +
        st.depositRefundMinor,
    );
    expect(st.arrearsMinor + st.deductionsChargedMinor).toBe(
      st.creditAppliedMinor + st.depositAppliedMinor + st.stillOwedMinor,
    );
    expect(st.retainedMinor + st.depositAppliedMinor + st.depositRefundMinor).toBe(200_000);
    // Nothing posted yet: the preview rolled back.
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2100')).toBe(-200_000);
    expect(await leaseStatus(c.companyId, lease.id)).toBe('ending');

    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    expect(submitted.status).toBe('awaiting_approval');
    const requestId = submitted.approval!.request.id;
    // ★ The initiator can never approve (AD-05).
    await expect(
      s.approvals.decide(c.manager, requestId, { decision: 'approve' }),
    ).rejects.toThrow();
    await s.approvals.decide(c.accountant, requestId, { decision: 'approve' });

    const approved = await m.moveOuts.get(c.manager, planned.id);
    expect(approved.status).toBe(st.refundMinor > 0 ? 'approved' : 'closed');
    expect(approved.statement).toEqual(st);
    // An early end terminates the lease (decision 12).
    expect(await leaseStatus(c.companyId, lease.id)).toBe('terminated');
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2100')).toBe(0);
    expect(st.retainedMinor).toBe(30_000);
    expect(await leaseAccount(ctx, c.companyId, lease.id, '4300')).toBe(0 - st.retainedMinor);
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2010')).toBe(0);
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2400')).toBe(0 - st.refundMinor);
    // Rent settled from the deposit is rent received: P17 follows (P11).
    if (st.depositAppliedMinor > 0) {
      const items = await withCompany(
        ctx.database,
        { companyId: c.companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ kind: schema.rentTaxItem.kind })
            .from(schema.rentTaxItem)
            .where(sql`lease_id = ${lease.id} and kind = 'deposit_applied'`),
      );
      expect(items.length).toBe(1);
    }

    if (st.refundMinor > 0) {
      const proof = await uploadEvidence(ctx, (i) =>
        m.moveOuts.createRefundUpload(c.accountant, i),
      );
      const paid = await m.moveOuts.recordRefundPaid(c.accountant, planned.id, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO-123',
        proofUploadId: proof,
      });
      expect(paid.status).toBe('refund_paid');
      expect(await leaseAccount(ctx, c.companyId, lease.id, '2400')).toBe(0);
    }
    const check = await b.subledger.check(c.companyId, { alert: false });
    expect(check.mismatches).toEqual([]);
  });

  it('★ refuses deductions beyond the deposit held; damage beyond it is a charge', async () => {
    const c = await companyWithUnits('Deduction Agency', 'MOD');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    // The move-out inspection first: damage is shown by its items (MI-11).
    const inspected = await m.moveOuts.startInspection(c.manager, planned.id);
    const item = (await m.inspections.get(c.manager, inspected.inspectionId!)).items[0]!.id;
    await m.moveOuts.addDeduction(c.manager, planned.id, {
      kind: 'damage',
      amountMinor: 50_000,
      reason: 'Broken window',
      inspectionItemIds: [item],
      photoIds: [],
    });
    await expect(
      m.moveOuts.addDeduction(c.manager, planned.id, {
        kind: 'keys',
        amountMinor: 1,
        reason: 'Lost keys',
        inspectionItemIds: [],
        photoIds: [],
      }),
    ).rejects.toMatchObject({ status: 409, code: 'deductions_exceed_deposit' });
    // Damage beyond the deposit is recorded as a charge instead (P01).
    const charged = await m.moveOuts.setCharges(c.manager, planned.id, [
      { description: 'Window beyond the deposit', amountMinor: 20_000 },
    ]);
    expect(charged.statement!.chargesMinor).toBe(20_000);
  });

  it('cancels a planned move-out and returns the lease to active', async () => {
    const c = await companyWithUnits('Cancel Agency', 'MOC');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 150_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: plusDays(today, 30),
      reason: 'tenant_notice',
    });
    // The settlement waits for the last day.
    await expect(m.moveOuts.submit(c.manager, planned.id)).rejects.toMatchObject({
      code: 'move_out_not_yet',
    });
    await expect(
      m.moveOuts.plan(c.manager, lease.id, { plannedDate: today, reason: 'tenant_notice' }),
    ).rejects.toMatchObject({ code: 'move_out_exists' });
    const cancelled = await m.moveOuts.cancel(c.manager, planned.id, 'The tenant is staying');
    expect(cancelled.status).toBe('cancelled');
    expect(await leaseStatus(c.companyId, lease.id)).toBe('active');
  });

  it('settles the deposit of a lease ended by the quick move-out, and the lease stays ended', async () => {
    const c = await companyWithUnits('Quick Agency', 'MOQ');
    const lease = await depositLease(c, { deposit: 80_000, paidMinor: 480_000 });
    await expect(m.moveOuts.settleDeposit(c.manager, lease.id)).rejects.toMatchObject({
      code: 'lease_not_ended',
    });
    await s.lifecycle.recordMoveOut(c.manager, lease.id, { moveOutDate: today });
    await b.invoicing.onLeaseEnded(c.companyId, lease.id);
    const drafted = await m.moveOuts.settleDeposit(c.manager, lease.id);
    expect(drafted).toMatchObject({
      kind: 'deposit_settlement',
      status: 'settlement_drafted',
      reason: null,
    });
    expect(drafted.statement!.depositHeldMinor).toBe(80_000);
    const submitted = await m.moveOuts.submit(c.manager, drafted.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    expect(await leaseStatus(c.companyId, lease.id)).toBe('ended');
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2100')).toBe(0);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    await expect(m.moveOuts.settleDeposit(c.manager, lease.id)).rejects.toMatchObject({
      code: 'move_out_exists',
    });
  });
});

describe('TL-11 the final statement PDF', () => {
  it('asks for a render whose data fits the final statement template', async () => {
    const c = await companyWithUnits('Statement Agency', 'MOS');
    const lease = await depositLease(c, { deposit: 60_000, paidMinor: 400_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    const renderId = await m.moveOuts.renderFinalStatement(c.companyId, planned.id);
    expect(renderId).toBeTruthy();
    const [request] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.documentRenderRequest)
          .where(sql`id = ${renderId}`),
    );
    const branding = {
      senderName: 'Statement Agency',
      primaryColour: '#0F766E',
      accentColour: '#F59E0B',
    };
    expect(() =>
      templates
        .get(request!.templateKey, request!.templateVersion)
        .element(request!.data, branding),
    ).not.toThrow();
    // A second run asks for nothing new.
    expect(await m.moveOuts.renderFinalStatement(c.companyId, planned.id)).toBe(renderId);
  });
});

describe('TL-11 a settlement with no refund closes, then takes its final statement (0043)', () => {
  it('closes at approval, then the rendered statement attaches and goes to the tenant once', async () => {
    const c = await companyWithUnits('Closed Statement Agency', 'MOZ');
    // Rent paid up and the whole deposit kept for damage: nothing to refund.
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    // The move-out inspection first: damage is shown by its items (MI-11).
    const inspected = await m.moveOuts.startInspection(c.manager, planned.id);
    const item = (await m.inspections.get(c.manager, inspected.inspectionId!)).items[0]!.id;
    await m.moveOuts.addDeduction(c.manager, planned.id, {
      kind: 'damage',
      amountMinor: 50_000,
      reason: 'Broken window',
      inspectionItemIds: [item],
      photoIds: [],
    });
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    expect(submitted.statement!.refundMinor).toBe(0);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    const closed = await m.moveOuts.get(c.manager, planned.id);
    expect(closed.status).toBe('closed');
    expect(closed.statementDocument).toBeNull();

    // What the worker does next: render the PDF, then documents.rendered attaches it.
    const renderId = (await m.moveOuts.renderFinalStatement(c.companyId, planned.id))!;
    expect(renderId).toBeTruthy();
    await s.documents.renderRequested(c.companyId, renderId, async () =>
      Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'),
    );
    expect(await m.moveOuts.onDocumentRendered(c.companyId, renderId)).toBe(true);
    const attached = await m.moveOuts.get(c.manager, planned.id);
    expect(attached.status).toBe('closed');
    expect(attached.statementDocument?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(m.moveOuts.statementUrl(c.manager, planned.id)).resolves.toMatchObject({
      url: expect.any(String),
    });
    // A replay attaches nothing twice.
    expect(await m.moveOuts.onDocumentRendered(c.companyId, renderId)).toBe(false);
    const sent = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from outbox_event
              where payload->>'purpose' = 'final_statement' and payload->'related'->>'id' = ${planned.id}`,
        ),
    );
    expect(sent.rows[0]!.n).toBe(1);
  });
});
