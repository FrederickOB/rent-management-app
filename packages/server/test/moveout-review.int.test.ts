import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { statementBalances } from '@rent/domain/moveout';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockCounters, lockLeases, leaseGroup, paymentsByIds } from '../src/billing/records';
import { IdempotencyStore, requestHash } from '../src/core/idempotency';
import { startServerTest, type ServerTestContext } from './support';
import { asSuperuser, company, member, person, staff } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  leaseAccount,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import { taxItemsOf, taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M8 review's move-out fixes against the real database: the statement's identities with
 * charges and break credit (BE 1), a settled deposit's payment reversed (BE 2), a move-out whose
 * lease ended first (BE 3), the caller's scope on every write (BE 4), the tenant's documents
 * (BE 6), keys (BE 7), previews that raise nothing, M5 and M8 kept apart, the live comparison,
 * Closed after Refund paid, and the sole landlord (OQ-29). Every test makes its own company.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const pdf = async () => Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

/**
 * A statement's figures, without the ids of the lines it pays: a preview's charges are lines in
 * memory, which get their ids and invoice numbers when the settlement is done.
 */
const figures = (st: object) =>
  Object.fromEntries(
    Object.entries(st).map(([k, v]) => [
      k,
      Array.isArray(v)
        ? (v as { amountMinor: number; label: string }[]).map((l) => [l.label, l.amountMinor])
        : v,
    ]),
  );

type Company = Awaited<ReturnType<typeof moneyCompany>> & {
  units: string[];
  next: number;
  propertyId: string;
};

async function companyWithUnits(name: string, part: string): Promise<Company> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  return { ...c, units: Object.values(property.units), next: 0, propertyId: property.propertyId };
}

/** A monthly lease that started three months ago with a deposit, paid as `paidMinor` on day one. */
async function depositLease(
  c: Company,
  input: { deposit: number; paidMinor: number; breakCredit?: boolean; phone?: string },
) {
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Tenant ${c.next}`,
    ...(input.phone ? { phone: input.phone } : {}),
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
    ...(input.breakCredit !== undefined
      ? {
          breakClause: {
            fromDate: plusMonths(start, 1),
            party: 'tenant' as const,
            noticeDays: 30,
            creditUnusedDays: input.breakCredit,
          },
        }
      : {}),
  });
  if (input.paidMinor > 0)
    await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
      leaseId: lease.id,
      receivedInto: 'owner_account',
      amountMinor: input.paidMinor,
      receivedOn: start,
      senderReference: 'TEST',
    });
  return { ...lease, tenant };
}

const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

async function leaseStatus(companyId: string, leaseId: string) {
  const [row] = await system(companyId, (tx) =>
    tx
      .select({ status: schema.lease.status })
      .from(schema.lease)
      .where(sql`id = ${leaseId}`),
  );
  return row?.status;
}

async function approve(c: Company, moveOutId: string, note?: string) {
  const submitted = await m.moveOuts.submit(c.manager, moveOutId, note);
  await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
  return m.moveOuts.get(c.manager, moveOutId);
}

/** What the worker does with the final statement: render it, then attach it. */
async function renderStatement(companyId: string, moveOutId: string) {
  const renderId = (await m.moveOuts.renderFinalStatement(companyId, moveOutId))!;
  await s.documents.renderRequested(companyId, renderId, pdf);
  await m.moveOuts.onDocumentRendered(companyId, renderId);
  return renderId;
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

describe('TL-11 and MI-11 the statement’s identities with charges and break credit (BE 1)', () => {
  it('★ balances with a charge beyond the deposit: arrears include the charge, the approval and the PDF carry the same figures', async () => {
    const c = await companyWithUnits('Identity Charges', 'MIC');
    // Rent paid up; the whole deposit kept for damage, and a charge beyond it.
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
    const charged = await m.moveOuts.setCharges(c.manager, planned.id, [
      { description: 'Door beyond the deposit', amountMinor: 20_000 },
    ]);
    const st = charged.statement!;
    expect(st.chargesMinor).toBe(20_000);
    expect(st.arrearsMinor).toBeGreaterThanOrEqual(20_000);
    expect(statementBalances(st)).toBe(true);
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
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    const payload = submitted.approval!.request.payload as Record<string, number>;
    for (const key of ['creditMinor', 'arrearsMinor', 'chargesMinor', 'stillOwedMinor'] as const)
      expect(payload[key], key).toBe(st[key]);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    const done = await m.moveOuts.get(c.manager, planned.id);
    // Done as it was shown.
    expect(figures(done.statement!)).toEqual(figures(st));
    const renderId = (await m.moveOuts.renderFinalStatement(c.companyId, planned.id))!;
    const [request] = await system(c.companyId, (tx) =>
      tx
        .select()
        .from(schema.documentRenderRequest)
        .where(sql`id = ${renderId}`),
    );
    const data = request!.data as Record<string, unknown>;
    expect(JSON.stringify(data)).toContain(String(st.arrearsMinor));
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('★ balances with a break-clause credit on a paid month, and with a charge as well', async () => {
    const c = await companyWithUnits('Identity Break', 'MIB');
    for (const withCharge of [false, true]) {
      const lease = await depositLease(c, {
        deposit: 200_000,
        paidMinor: 600_000,
        breakCredit: true,
      });
      const planned = await m.moveOuts.plan(c.manager, lease.id, {
        plannedDate: today,
        reason: 'early_termination',
      });
      if (withCharge)
        await m.moveOuts.setCharges(c.manager, planned.id, [
          { description: 'Agreed early-end charge', amountMinor: 30_000 },
        ]);
      const shown = (await m.moveOuts.get(c.manager, planned.id)).statement!;
      expect(shown.early).toBe(true);
      expect(shown.breakCreditMinor).toBeGreaterThan(0);
      expect(statementBalances(shown)).toBe(true);
      const done = await approve(c, planned.id);
      expect(figures(done.statement!)).toEqual(figures(shown));
      expect(statementBalances(done.statement!)).toBe(true);
    }
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('TL-11 rent settled from the deposit is rent received, every time (P17; weak test)', () => {
  it('records a deposit_applied rent tax item of the rent the deposit settled', async () => {
    const c = await companyWithUnits('Deposit Tax', 'MDT');
    // Deposit 200,000, and only two of the four months started paid: the deposit pays rent.
    const lease = await depositLease(c, { deposit: 200_000, paidMinor: 400_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    const done = await approve(c, planned.id);
    const st = done.statement!;
    expect(st.depositAppliedMinor).toBeGreaterThan(0);
    const items = (await taxItemsOf(ctx, c.companyId, lease.id)).filter(
      (i) => i.kind === 'deposit_applied',
    );
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.baseMinor)).toBe(st.depositAppliedMinor);
    // Residential rent tax at the seeded rate (8%), due 30 days after it was received (TX-02).
    expect(Number(items[0]!.taxMinor)).toBeGreaterThan(0);
    expect(items[0]!.dueDate).toBe(plusDays(today, 30));
  });
});

describe('TL-11 a settled deposit’s payment reversed (BE 2)', () => {
  it('★ refuses a staff reversal; a chargeback takes the share back, leaves no deposit below zero and blocks the refund', async () => {
    const c = await companyWithUnits('Deposit Reversal', 'MDR');
    const lease = await depositLease(c, { deposit: 60_000, paidMinor: 460_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const done = await approve(c, planned.id);
    expect(done.status).toBe('approved');
    expect(done.statement!.depositRefundMinor).toBe(60_000);
    const [paid] = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.payment.id })
        .from(schema.payment)
        .where(sql`lease_id = ${lease.id}`),
    );
    // A staff correction would leave the deposit below zero: refused.
    await expect(
      b.money.requestReversal(c.manager, paid!.id, {
        reason: 'wrong_entry',
        note: 'Entered against the wrong tenant',
        moneyNowIn: 'owner_account',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'payment_deposit_settled' });
    // A chargeback cannot be refused: the reversal takes the share back first (P21b).
    const result = await system(c.companyId, async (tx) => {
      const leases = await leaseGroup(tx, lease.id);
      await lockLeases(tx, c.companyId, leases);
      await lockCounters(tx, c.companyId);
      const [payment] = await paymentsByIds(tx, [paid!.id]);
      const states = [];
      for (const id of leases) states.push(await b.engine.load(tx, c.companyId, id));
      return b.engine.reverse(tx, states, payment!, {
        reason: 'chargeback',
        note: 'Charged back at the provider',
        moneyNowIn: 'provider',
        approvalRequestId: null,
        requestedBy: null,
        today,
      });
    });
    expect(result.depositUnwound).toEqual([
      expect.objectContaining({ moveOutId: planned.id, amountMinor: 60_000, refundMinor: 60_000 }),
    ]);
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2100')).toBe(0);
    expect(await leaseAccount(ctx, c.companyId, lease.id, '2400')).toBe(0);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    const proof = await uploadEvidence(ctx, (i) => m.moveOuts.createRefundUpload(c.accountant, i));
    await expect(
      m.moveOuts.recordRefundPaid(c.accountant, planned.id, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO-1',
        proofUploadId: proof,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'deposit_charged_back' });
  });
});

describe('TL-11 a move-out whose lease ended first (BE 3)', () => {
  it('settles a lease the scheduler ended on the last day; refuses another day, cancels, and settles the deposit', async () => {
    const c = await companyWithUnits('Ended First', 'MEF');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    // The successor started: the scheduler ends the lease on its last day.
    await system(c.companyId, (tx) =>
      s.lifecycle.endForMoveOutIn(tx, lease.id, { lastDay: today, terminated: false }),
    );
    const done = await approve(c, planned.id);
    expect(['approved', 'closed']).toContain(done.status);
    expect(await leaseStatus(c.companyId, lease.id)).toBe('ended');

    const other = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    const second = await m.moveOuts.plan(c.manager, other.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    await system(c.companyId, (tx) =>
      s.lifecycle.endForMoveOutIn(tx, other.id, {
        lastDay: plusDays(today, -1),
        terminated: false,
      }),
    );
    await expect(m.moveOuts.submit(c.manager, second.id)).rejects.toMatchObject({
      status: 409,
      code: 'lease_ended_first',
    });
    await m.moveOuts.cancel(c.manager, second.id, 'Ended before the move-out');
    expect(await leaseStatus(c.companyId, other.id)).toBe('ended');
    const deposit = await m.moveOuts.settleDeposit(c.manager, other.id);
    expect(deposit.kind).toBe('deposit_settlement');
  });

  it('refuses M3’s quick move-out while an M8 move-out is live', async () => {
    const c = await companyWithUnits('Quick Guard', 'MQG');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    await m.moveOuts.plan(c.manager, lease.id, { plannedDate: today, reason: 'end_of_term' });
    await expect(
      s.lifecycle.recordMoveOut(c.manager, lease.id, { moveOutDate: today }),
    ).rejects.toMatchObject({ status: 409, code: 'move_out_live' });
  });
});

describe('AD-02 move-out writes read the caller’s scope first (BE 4)', () => {
  it('★ answers 404 to a manager of another property before writing, and lets the property’s own manager write', async () => {
    const c = await companyWithUnits('Scoped Writes', 'MSW');
    const otherOwner = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Scoped other owner' })
    ).id;
    const other = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'MSX',
      ownerId: otherOwner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const outsider = await staffIn(
      ctx,
      c.companyId,
      'agency',
      'property_manager',
      'Scoped outsider',
      {
        properties: [other.propertyId],
      },
    );
    const insider = await staffIn(
      ctx,
      c.companyId,
      'agency',
      'property_manager',
      'Scoped insider',
      {
        properties: [c.propertyId],
      },
    );
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    await expect(
      m.moveOuts.plan(outsider, lease.id, { plannedDate: today, reason: 'end_of_term' }),
    ).rejects.toMatchObject({ status: 404 });
    const planned = await m.moveOuts.plan(insider, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const deduction = {
      kind: 'cleaning' as const,
      amountMinor: 5_000,
      reason: 'Deep clean',
      inspectionItemIds: [],
      photoIds: [],
    };
    for (const write of [
      () => m.moveOuts.addDeduction(outsider, planned.id, deduction),
      () => m.moveOuts.setCharges(outsider, planned.id, []),
      () => m.moveOuts.startInspection(outsider, planned.id),
      () => m.moveOuts.cancel(outsider, planned.id, 'Not mine'),
      () => m.moveOuts.submit(outsider, planned.id),
    ])
      await expect(write()).rejects.toMatchObject({ status: 404 });
    const written = await m.moveOuts.addDeduction(insider, planned.id, deduction);
    expect(written.deductions).toHaveLength(1);
  });
});

describe('TL-08 and TL-11 the tenant downloads the move-in report and the final statement (BE 6)', () => {
  it('serves both to the tenant, and neither to another tenant', async () => {
    const c = await companyWithUnits('Tenant Documents', 'MTD');
    const lease = await depositLease(c, {
      deposit: 50_000,
      paidMinor: 450_000,
      phone: '+233200000611',
    });
    const neighbour = await depositLease(c, {
      deposit: 50_000,
      paidMinor: 450_000,
      phone: '+233200000612',
    });
    const tenantActor = async (tenantId: string) => {
      const [row] = await system(c.companyId, (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(sql`id = ${tenantId}`),
      );
      return {
        kind: 'tenant' as const,
        personId: row!.personId!,
        authMethod: 'phone_otp' as const,
      };
    };
    // A signed move-in report, as the e-sign engine leaves it once everyone has signed.
    const inspection = await m.inspections.start(c.manager, {
      unitId: c.units[0]!,
      kind: 'move_in',
      leaseId: lease.id,
    });
    const report = await s.documents.storeWriteOnce({
      companyId: c.companyId,
      countryCode: 'GH',
      key: `documents/${c.companyId}/move-in-${inspection.id}.pdf`,
      bytes: await pdf(),
      contentType: 'application/pdf',
    });
    const reportId = await system(c.companyId, (tx) =>
      s.documents.recordWriteOnce(tx, report, { kind: 'pdf', createdBy: null } as never),
    );
    await asSuperuser(
      ctx,
      `insert into signing_request (company_id, property_id, tenant_id, lease_id, subject_type, inspection_id, status,
         document_id, document_sha256, final_document_id, final_sha256, completed_at)
       select l.company_id, l.property_id, l.tenant_id, l.id, 'move_in_report', $2, 'completed', d.id, d.sha256,
         d.id, d.sha256, now()
       from lease l join document d on d.company_id = l.company_id and d.id = $3 where l.id = $1`,
      [lease.id, inspection.id, reportId],
    );
    // The final statement of a settlement with no refund.
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    await m.moveOuts.addDeduction(c.manager, planned.id, {
      kind: 'cleaning',
      amountMinor: 50_000,
      reason: 'Deep clean and repainting',
      inspectionItemIds: [],
      photoIds: [],
    });
    await approve(c, planned.id);
    await renderStatement(c.companyId, planned.id);
    const [statement] = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.moveOut.statementDocumentId })
        .from(schema.moveOut)
        .where(sql`id = ${planned.id}`),
    );
    const mine = await tenantActor(lease.tenant.id);
    const theirs = await tenantActor(neighbour.tenant.id);
    for (const documentId of [reportId, statement!.id!]) {
      await expect(s.tenantApp.documentUrl(mine, documentId)).resolves.toEqual(expect.any(String));
      await expect(s.tenantApp.documentUrl(theirs, documentId)).rejects.toMatchObject({
        status: 404,
      });
    }
  });
});

describe('MI-11 a retried deduction is recorded once (BE 7)', () => {
  it('replays the same key: one deduction, one withdrawal, one set of charges', async () => {
    const c = await companyWithUnits('Keyed Deductions', 'MKD');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const store = new IdempotencyStore(ctx.database, { attempts: 50, ms: 50 });
    const keyed = <T>(
      key: string,
      operation: string,
      input: unknown,
      write: (claim: never) => Promise<T>,
    ) =>
      store.run(
        {
          companyId: c.companyId,
          personId: c.manager.personId,
          key,
          operation,
          hash: requestHash(operation, c.manager.personId, input),
        },
        write as never,
      );
    const input = {
      kind: 'keys' as const,
      amountMinor: 2_000,
      reason: 'Two keys lost',
      inspectionItemIds: [],
      photoIds: [],
    };
    const add = () =>
      keyed('deduction-key-0001', 'moveouts.add-deduction', input, async (claim) => {
        await m.moveOuts.addDeduction(c.manager, planned.id, input, { claim });
        return { moveOutId: planned.id };
      });
    await Promise.allSettled([add(), add(), add()]);
    const after = await m.moveOuts.get(c.manager, planned.id);
    expect(after.deductions).toHaveLength(1);
    const withdraw = () =>
      keyed('withdraw-key-0001', 'moveouts.withdraw-deduction', {}, async (claim) => {
        await m.moveOuts.withdrawDeduction(c.manager, planned.id, after.deductions[0]!.id, {
          claim,
        });
        return { moveOutId: planned.id };
      });
    await withdraw();
    await withdraw();
    const [count] = await system(c.companyId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from deposit_deduction_withdrawal where move_out_id = ${planned.id}`,
      ),
    ).then((r) => r.rows);
    expect(count!.n).toBe(1);
  });
});

describe('TL-11 a preview raises nothing and takes no company-wide lock (should fix)', () => {
  it('shows the statement while another transaction holds the counter lock, and raises no alert', async () => {
    const c = await companyWithUnits('Quiet Preview', 'MQP');
    const lease = await depositLease(c, { deposit: 200_000, paidMinor: 400_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    await m.moveOuts.setCharges(c.manager, planned.id, [
      { description: 'Agreed charge', amountMinor: 10_000 },
    ]);
    const alertsBefore = t.alerts.length;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const taken = new Promise<void>((r) => (locked = r));
    const holder = system(c.companyId, async (tx) => {
      await lockCounters(tx, c.companyId);
      locked();
      await held;
    });
    await taken;
    const shown = await Promise.race([
      m.moveOuts.get(c.manager, planned.id),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    release();
    await holder;
    expect(shown?.statement).toBeTruthy();
    expect(statementBalances(shown!.statement!)).toBe(true);
    expect(shown!.statement!.depositAppliedMinor).toBeGreaterThan(0);
    expect(t.alerts.length).toBe(alertsBefore);
    // Nothing of the preview was kept: no invoice for the charge, no rent tax item.
    expect(
      (await taxItemsOf(ctx, c.companyId, lease.id)).filter((i) => i.kind === 'deposit_applied'),
    ).toEqual([]);
  });
});

describe('AR-04 and TL-11 M5’s refund and an M8 move-out never settle one lease (should fix)', () => {
  it('refuses M5’s early-termination refund once the lease has a move-out', async () => {
    const c = await companyWithUnits('No Overlap', 'MNO');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    await m.moveOuts.plan(c.manager, lease.id, { plannedDate: today, reason: 'tenant_notice' });
    await expect(
      t.termination.request(c.manager, lease.id, { charges: [], deductions: [] }),
    ).rejects.toMatchObject({ status: 409, code: 'move_out_exists' });
  });

  it('settles the deposit of M3’s early quick move-out as an early end: the break clause credits the unused days', async () => {
    const c = await companyWithUnits('Quick Early', 'MQE');
    const lease = await depositLease(c, {
      deposit: 100_000,
      paidMinor: 500_000,
      breakCredit: true,
    });
    await s.lifecycle.recordMoveOut(c.manager, lease.id, { moveOutDate: today });
    const drafted = await m.moveOuts.settleDeposit(c.manager, lease.id);
    expect(drafted.statement!.early).toBe(true);
    expect(drafted.statement!.breakCreditMinor).toBeGreaterThan(0);
    expect(statementBalances(drafted.statement!)).toBe(true);
  });
});

describe('TL-11 the live comparison for "the figures no longer hold" (should fix)', () => {
  it('says the figures hold while nothing moved, and no longer hold once the lease’s money moves', async () => {
    const c = await companyWithUnits('Live Figures', 'MLF');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 300_000 });
    const planned = await m.moveOuts.plan(c.manager, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    expect(planned.approvalFiguresHold).toBeNull();
    await m.moveOuts.submit(c.manager, planned.id);
    expect((await m.moveOuts.get(c.manager, planned.id)).approvalFiguresHold).toBe(true);
    await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
      leaseId: lease.id,
      receivedInto: 'owner_account',
      amountMinor: 25_000,
      receivedOn: today,
      senderReference: 'LATE',
    });
    expect((await m.moveOuts.get(c.manager, planned.id)).approvalFiguresHold).toBe(false);
  });
});

describe('TL-11 a settlement with a refund reaches Closed (should fix)', () => {
  it('closes once the refund is paid and its statement attached, in either order', async () => {
    const c = await companyWithUnits('Refund Closes', 'MRC');
    for (const statementFirst of [false, true]) {
      const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
      const planned = await m.moveOuts.plan(c.manager, lease.id, {
        plannedDate: today,
        reason: 'end_of_term',
      });
      const done = await approve(c, planned.id);
      expect(done.status).toBe('approved');
      if (statementFirst) await renderStatement(c.companyId, planned.id);
      const proof = await uploadEvidence(ctx, (i) =>
        m.moveOuts.createRefundUpload(c.accountant, i),
      );
      const paid = await m.moveOuts.recordRefundPaid(c.accountant, planned.id, {
        paidOn: today,
        paidFrom: 'agency_account',
        reference: 'MOMO-9',
        proofUploadId: proof,
      });
      if (statementFirst) expect(paid.status).toBe('closed');
      else {
        expect(paid.status).toBe('refund_paid');
        await renderStatement(c.companyId, planned.id);
        expect((await m.moveOuts.get(c.manager, planned.id)).status).toBe('closed');
      }
    }
  });
});

describe('OQ-29 a sole landlord settles a move-out after the cooling-off (RA089 self-confirm)', () => {
  it('confirms their own settlement with a current code once the cooling-off is over', async () => {
    const TOTP_SECRET = 'moveout-review-totp-secret-value';
    const base32 = (text: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
      let out = '';
      for (let i = 0; i < bits.length; i += 5)
        out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
      return out;
    };
    const companyId = await company(ctx, 'landlord', 'Solo Move-out');
    const personId = await person(ctx, 'Solo move-out owner', { totpSecret: TOTP_SECRET });
    const owner = staff(
      companyId,
      'landlord',
      personId,
      await member(ctx, companyId, personId, 'owner'),
      'owner',
    );
    const ownerId = (
      await s.owners.create(owner, { kind: 'individual', displayName: 'Solo owner' })
    ).id;
    const property = await propertyWithUnits(s, owner, {
      areaCode: 'ACC',
      propertyPart: 'MSO',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const { tenant } = await s.tenants.create(owner, {
      kind: 'individual',
      displayName: 'Solo tenant',
    });
    const start = plusMonths(today, -2);
    const lease = await billedLease(ctx, s, b, owner, {
      unitId: Object.values(property.units)[0]!,
      tenantId: tenant.id,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 80_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    const planned = await m.moveOuts.plan(owner, lease.id, {
      plannedDate: today,
      reason: 'tenant_notice',
    });
    const submitted = await m.moveOuts.submit(owner, planned.id);
    const request = submitted.approval!.request;
    expect(request).toMatchObject({ mode: 'single_user', status: 'cooling_off' });
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = now() - interval '1 minute' where id = $1",
      [request.id],
    );
    ctx.clock.advance(24 * 3_600_000 + 60_000);
    const decided = await s.approvals.decide(owner, request.id, {
      decision: 'self_confirm',
      code: await generate({ secret: base32(TOTP_SECRET) }),
    });
    expect(decided.request.status).toBe('approved');
    const done = await m.moveOuts.get(owner, planned.id);
    expect(['approved', 'closed']).toContain(done.status);
    expect(statementBalances(done.statement!)).toBe(true);
  });
});

describe('MI-11 damage always shows its evidence (founder, 2026-11-06)', () => {
  it('asks for the move-out inspection first on a deposit settlement without one, then takes damage shown by it', async () => {
    const c = await companyWithUnits('Damage Evidence', 'MDE');
    const lease = await depositLease(c, { deposit: 50_000, paidMinor: 450_000 });
    await s.lifecycle.recordMoveOut(c.manager, lease.id, { moveOutDate: today });
    const drafted = await m.moveOuts.settleDeposit(c.manager, lease.id);
    const damage = {
      kind: 'missing_items' as const,
      amountMinor: 5_000,
      reason: 'The curtain rail is gone',
      inspectionItemIds: [] as string[],
      photoIds: [],
    };
    await expect(m.moveOuts.addDeduction(c.manager, drafted.id, damage)).rejects.toMatchObject({
      status: 400,
      code: 'deduction_evidence_required',
      message: expect.stringMatching(/inspection first/),
    });
    const inspected = await m.moveOuts.startInspection(c.manager, drafted.id);
    const item = (await m.inspections.get(c.manager, inspected.inspectionId!)).items[0]!.id;
    const added = await m.moveOuts.addDeduction(c.manager, drafted.id, {
      ...damage,
      inspectionItemIds: [item],
    });
    expect(added.deductions).toHaveLength(1);
  });
});
