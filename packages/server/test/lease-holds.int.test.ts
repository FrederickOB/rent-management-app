import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  instantFrom,
  parseBusinessDate,
  Temporal,
  toIsoDate,
} from '@rent/domain/dates';
import { money, multiplyRatio } from '@rent/domain/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { sqlStateOf } from '../src/core/db-errors';
import type { PartyInput } from '../src/tenancy/tenancy.types';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * What holds a unit, and for how long (review findings 2, 3, 5 and 8; M3 plan 4.6, 4.7 and 4.10):
 * a lease out for signature holds it; a lease the tenant holds over holds it until it ends, and
 * no two leases charge it for the same day; the lease names the property's owner; a tenant who
 * holds a lease anywhere stays open.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let agencyId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let manager: Awaited<ReturnType<typeof staffIn>>;
let ownerA: string;
let hld: { propertyId: string; units: Record<string, string> };
let today: string;

const DAY = 86_400_000;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));
/** The first day of the month `n` months from today. */
const firstOf = (n: number) => {
  const d = addMonths(parseBusinessDate(today), n);
  return toIsoDate(Temporal.PlainDate.from({ year: d.year, month: d.month, day: 1 }));
};
const plus = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

const sqlState = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => sqlStateOf(error) ?? String(error),
  );

async function tenantFor(name: string, actor = manager) {
  return (await s.tenants.create(actor, { kind: 'individual', displayName: name })).tenant;
}

async function paper(
  unitId: string,
  tenantId: string,
  over: Record<string, unknown> = {},
  actor = manager,
) {
  const scanUploadId = await uploadLeaseFile(ctx, s, actor);
  return s.leases.recordPaper(actor, {
    unitId,
    tenantId,
    startDate: day(-10),
    endDate: endAfter(day(-10), 12),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: [{ role: 'tenant', name: 'Tenant' }],
    scanUploadId,
    signedOn: (over.signedOn as string | undefined) ?? day(0),
    ...over,
  });
}

const signers = (tenantName: string): PartyInput[] => [
  { role: 'tenant', name: tenantName, phone: '+233200009901' },
  { role: 'landlord', name: 'Manager', staffPersonId: manager.personId },
  { role: 'witness', name: 'A Witness', phone: '+233200009902' },
];

/** A draft with every signer issuing needs. */
async function signable(unitId: string, tenantId: string, startDate: string, endDate: string) {
  return s.leases.createDraft(manager, {
    unitId,
    tenantId,
    startDate,
    endDate,
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: signers('Tenant'),
  });
}

/** Marks a draft signed on paper, as the e-signing engine's completion does for e-signed ones. */
async function signOnPaper(leaseId: string) {
  const scan = await uploadLeaseFile(ctx, s, manager);
  const staged = await s.documents.stageEvidenceUpload(
    { companyId: agencyId, personId: manager.personId },
    scan,
    { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
  );
  await withCompany(
    ctx.database,
    { companyId: agencyId, personId: manager.personId, actorKind: 'staff' },
    async (tx) => {
      const documentId = await s.documents.recordStagedEvidence(tx, staged, 'lease_scan');
      await s.lifecycle.markSigned(tx, {
        leaseId,
        signedAt: ctx.clock.now(),
        source: 'paper',
        signedDocumentId: documentId,
      });
    },
  );
}

/** A lease's rent rows, oldest first. */
const rentRows = async (leaseId: string) =>
  (await s.leases.schedule(manager, leaseId)).filter((p) => p.chargeType === 'rent');

/** No day is charged by two leases. */
function noDayTwice(...schedules: { periodStart: string; periodEnd: string }[][]) {
  const days = new Map<string, number>();
  schedules.forEach((rows, i) => {
    for (const r of rows)
      for (let d = r.periodStart; d <= r.periodEnd; d = plus(d, 1)) {
        expect(days.get(d), `${d} is charged twice`).toBeUndefined();
        days.set(d, i);
      }
  });
}

/** Moves the clock to a business date (Africa/Accra is UTC+0), and back afterwards. */
async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Holds Agency Ltd');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager');
  ownerA = (await s.owners.create(admin, { kind: 'individual', displayName: 'Ama Owner' })).id;
  hld = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'HLD',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 12, bedrooms: 2 }],
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('PB-09 a lease out for signature holds its unit', () => {
  it('refuses a second lease over the same dates while the first waits for signatures', async () => {
    const unitId = hld.units['ACC-HLD-B1-01']!;
    const a = await tenantFor('Pending A');
    const b = await tenantFor('Pending B');
    const first = await signable(unitId, a.id, month(1), endAfter(month(1), 12));
    const second = await signable(unitId, b.id, month(3), endAfter(month(3), 12));
    await s.leaseSigning.issue(manager, first.id);
    await expect(s.leaseSigning.issue(manager, second.id)).rejects.toMatchObject({
      code: 'lease_overlap',
    });
    // Nor can a paper lease take the unit for those dates.
    await expect(
      paper(unitId, b.id, { startDate: month(2), endDate: endAfter(month(2), 6) }),
    ).rejects.toMatchObject({ code: 'lease_overlap' });
    // Once the first is recalled, the second can go out.
    await s.leaseSigning.recall(manager, first.id);
    expect(await s.leaseSigning.issue(manager, second.id)).toMatchObject({
      status: 'pending_signatures',
    });
  });

  it('keeps the unit from being archived or made not lettable while a lease waits for signatures', async () => {
    const unitId = hld.units['ACC-HLD-B1-02']!;
    const lease = await signable(
      unitId,
      (await tenantFor('Waiting')).id,
      month(1),
      endAfter(month(1), 12),
    );
    await s.leaseSigning.issue(manager, lease.id);
    await expect(s.register.archiveUnit(manager, unitId)).rejects.toMatchObject({
      code: 'unit_has_lease',
    });
    await expect(
      s.register.setAvailability(manager, unitId, {
        availability: 'not_lettable',
        reason: 'Store',
      }),
    ).rejects.toMatchObject({ code: 'unit.occupied' });
    // The database refuses it too.
    for (const change of [
      sql`update unit set archived_at = now() where id = ${unitId}`,
      sql`update unit set availability = 'not_lettable' where id = ${unitId}`,
    ])
      expect(
        await sqlState(
          withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
            tx.execute(change),
          ),
        ),
      ).toBe('RA026');
  });

  it('refuses to send a lease for signing once its unit has been made not lettable or archived', async () => {
    const unitId = hld.units['ACC-HLD-B1-03']!;
    const lease = await signable(
      unitId,
      (await tenantFor('Too Late')).id,
      month(1),
      endAfter(month(1), 12),
    );
    // A draft does not hold the unit, so its availability can still change.
    await s.register.setAvailability(manager, unitId, {
      availability: 'not_lettable',
      reason: 'Owner keeps it',
    });
    await expect(s.leaseSigning.issue(manager, lease.id)).rejects.toMatchObject({
      code: 'unit_not_lettable',
    });
    expect((await s.leases.get(manager, lease.id)).status).toBe('draft');
    await s.register.setAvailability(manager, unitId, {
      availability: 'available',
      reason: 'Owner changed their mind',
    });
    expect(await s.leaseSigning.issue(manager, lease.id)).toMatchObject({
      status: 'pending_signatures',
    });
  });
});

describe('TL-06 a tenant holding over holds the unit until the lease ends', () => {
  it('refuses a new lease while the tenant holds over, until their move-out is recorded', async () => {
    const unitId = hld.units['ACC-HLD-B1-04']!;
    const start = month(-14);
    const held = await paper(unitId, (await tenantFor('Holding A')).id, {
      startDate: start,
      endDate: endAfter(start, 12),
      signedOn: start,
    });
    expect(held.status).toBe('holding_over');
    const b = await tenantFor('Next B');
    const next = await signable(unitId, b.id, month(1), endAfter(month(1), 12));
    await expect(s.leaseSigning.issue(manager, next.id)).rejects.toMatchObject({
      code: 'tenant_holding_over',
      message: expect.stringMatching(/record their move-out first/),
    });
    await expect(
      paper(unitId, b.id, { startDate: month(1), endDate: endAfter(month(1), 12) }),
    ).rejects.toMatchObject({ code: 'tenant_holding_over' });
    // A lease ending past its end date, with no move-out recorded, holds over too.
    await s.lifecycle.recordEnding(manager, held.id, { reason: 'non_renewal' });
    await expect(s.leaseSigning.issue(manager, next.id)).rejects.toMatchObject({
      code: 'tenant_holding_over',
    });
    // Once the move-out is recorded (up to today), the next lease goes out.
    await s.lifecycle.recordMoveOut(manager, held.id, { moveOutDate: day(0) });
    expect(await s.leaseSigning.issue(manager, next.id)).toMatchObject({
      status: 'pending_signatures',
    });
  });

  it('starts the renewal of a held-over lease after the last day already charged, and refuses an earlier start', async () => {
    const unitId = hld.units['ACC-HLD-B1-05']!;
    const start = firstOf(-14);
    const held = await paper(unitId, (await tenantFor('Renewing A')).id, {
      startDate: start,
      endDate: endAfter(start, 12),
      signedOn: start,
      parties: signers('Renewing A'),
    });
    expect(held.status).toBe('holding_over');
    // On the first day of next month the daily job charges that month.
    const next = firstOf(1);
    await on(next, async () => {
      await s.lifecycle.runTransitions(agencyId, next);
      const charged = (await rentRows(held.id)).at(-1)!.periodEnd;
      expect(charged).toBe(endAfter(next, 1));
      // The renewal starts after it: never on a day already charged.
      const renewal = await s.leases.offerRenewal(manager, held.id);
      expect(renewal.terms.startDate).toBe(plus(charged, 1));
      // Moved back onto a charged day, it cannot be sent for signing.
      await s.leases.updateDraft(manager, renewal.id, {
        startDate: next,
        endDate: endAfter(next, 12),
      });
      await expect(s.leaseSigning.issue(manager, renewal.id)).rejects.toMatchObject({
        code: 'renewal_start_too_early',
      });
    });
  });

  it('stops charging a held-over lease the day before its signed renewal starts, prorating the period cut short', async () => {
    const unitId = hld.units['ACC-HLD-B1-06']!;
    const start = firstOf(-14);
    const held = await paper(unitId, (await tenantFor('Holding C')).id, {
      startDate: start,
      endDate: endAfter(start, 12),
      signedOn: start,
      parties: signers('Holding C'),
    });
    const chargedBefore = (await rentRows(held.id)).at(-1)!.periodEnd;
    // The renewal starts on the 16th of next month and is signed now.
    const next = firstOf(1);
    const sixteenth = plus(next, 15);
    const renewal = await s.leases.offerRenewal(manager, held.id);
    await s.leases.updateDraft(manager, renewal.id, {
      startDate: sixteenth,
      endDate: endAfter(sixteenth, 12),
    });
    await signOnPaper(renewal.id);
    // On the 1st, the month the renewal cuts short waits: it may yet be cancelled.
    await s.lifecycle.runTransitions(agencyId, next);
    expect((await rentRows(held.id)).at(-1)!.periodEnd).toBe(chargedBefore);
    // On the 16th the renewal starts: the old lease is charged to the 15th, prorated, and ends.
    await s.lifecycle.runTransitions(agencyId, sixteenth);
    const rows = await rentRows(held.id);
    const length = daysBetween(parseBusinessDate(next), parseBusinessDate(endAfter(next, 1))) + 1;
    expect(rows.at(-1)).toMatchObject({
      periodStart: next,
      periodEnd: plus(sixteenth, -1),
      prorated: true,
      amountMinor: multiplyRatio(money(150_000), 15, length).amountMinor,
    });
    expect(await s.leases.get(manager, held.id)).toMatchObject({
      status: 'ended',
      lifecycle: { endReason: 'renewed', endedOn: plus(sixteenth, -1) },
    });
    const following = await rentRows(renewal.id);
    expect(following[0]!.periodStart).toBe(sixteenth);
    noDayTwice(rows, following);
  });

  it('ends a lease when the next tenant’s lease starts, charging the days held over before it', async () => {
    const unitId = hld.units['ACC-HLD-B1-07']!;
    // A lease ending in five days, and a new tenant's lease from ten days after that.
    const end = day(5);
    const start = plus(toIsoDate(addMonths(parseBusinessDate(end), -12)), 1);
    const current = await paper(unitId, (await tenantFor('Leaving D')).id, {
      startDate: start,
      endDate: end,
      signedOn: start,
    });
    expect(current.status).toBe('active');
    const successorStart = plus(end, 10);
    const successor = await paper(unitId, (await tenantFor('Arriving E')).id, {
      startDate: successorStart,
      endDate: endAfter(successorStart, 12),
    });
    expect(successor.status).toBe('signed');
    await s.lifecycle.runTransitions(agencyId, plus(end, 1));
    expect((await s.leases.get(manager, current.id)).status).toBe('holding_over');
    await s.lifecycle.runTransitions(agencyId, successorStart);
    expect(await s.leases.get(manager, current.id)).toMatchObject({
      status: 'ended',
      lifecycle: { endReason: 'superseded', endedOn: plus(successorStart, -1) },
    });
    const rows = await rentRows(current.id);
    const heldOver = rows.filter((r) => r.source === 'holding_over');
    const periodEnd = endAfter(plus(end, 1), 1);
    const length = daysBetween(parseBusinessDate(plus(end, 1)), parseBusinessDate(periodEnd)) + 1;
    expect(heldOver).toEqual([
      expect.objectContaining({
        periodStart: plus(end, 1),
        periodEnd: plus(successorStart, -1),
        prorated: true,
        amountMinor: multiplyRatio(money(150_000), 9, length).amountMinor,
      }),
    ]);
    noDayTwice(rows, await rentRows(successor.id));
  });
});

describe('TL-07 the lease names the property’s owner as landlord', () => {
  it('names the owner when a manager scoped to the property drafts the lease', async () => {
    const scoped = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Scoped Manager', {
      properties: [hld.propertyId],
    });
    const tenant = await tenantFor('Scoped Tenant', scoped);
    const draft = await s.leases.createDraft(scoped, {
      unitId: hld.units['ACC-HLD-B1-08']!,
      tenantId: tenant.id,
      startDate: month(1),
      endDate: endAfter(month(1), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    const preview = await s.leaseDocuments.preview(scoped, draft.id);
    const text = preview.document.sections.flatMap((x) => x.clauses.map((c) => c.text)).join('\n');
    expect(text).toContain('This agreement is between Ama Owner ("the landlord")');
    expect(text).not.toContain('Holds Agency Ltd ("the landlord")');
  });

  it('refuses to prepare the lease of an agency property with no owner on record today', async () => {
    const tomorrow = day(1);
    const unitId = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      async (tx) => {
        const property = await tx.execute<{ id: string }>(
          sql`insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
              select ${agencyId}, id, 'ACC-NOW', 'ACC', 'Owner from tomorrow', 'apartment_block', 'residential', 'Greater Accra'
              from portfolio where company_id = ${agencyId} limit 1 returning id`,
        );
        const propertyId = property.rows[0]!.id;
        await tx.execute(
          sql`insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from)
              values (${agencyId}, ${propertyId}, ${ownerA}, 10000, ${tomorrow}::date)`,
        );
        const block = await tx.execute<{ id: string }>(
          sql`insert into block (company_id, property_id, code, is_default) values (${agencyId}, ${propertyId}, 'B1', true) returning id`,
        );
        const unit = await tx.execute<{ id: string }>(
          sql`insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
              values (${agencyId}, ${propertyId}, ${block.rows[0]!.id}, 'ACC-NOW-B1-01', '01', 'apartment', 'self_contained') returning id`,
        );
        return unit.rows[0]!.id;
      },
    );
    const draft = await signable(
      unitId,
      (await tenantFor('No Owner Tenant')).id,
      month(1),
      endAfter(month(1), 12),
    );
    await expect(s.leaseDocuments.preview(manager, draft.id)).rejects.toMatchObject({
      code: 'property_without_owner',
    });
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'property_without_owner',
    });
  });
});

describe('TL-01 a tenant who holds a lease anywhere stays open', () => {
  it('refuses a scoped manager archiving a tenant whose other lease is outside their scope', async () => {
    const other = await propertyWithUnits(s, manager, {
      areaCode: 'ACC',
      propertyPart: 'HL2',
      ownerId: ownerA,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
    });
    const scoped = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Legon Manager', {
      properties: [hld.propertyId],
    });
    const tenant = await tenantFor('Two Places');
    const past = await paper(hld.units['ACC-HLD-B1-09']!, tenant.id, {
      startDate: day(-60),
      endDate: endAfter(day(-60), 12),
    });
    await s.lifecycle.recordMoveOut(manager, past.id, { moveOutDate: day(-1) });
    await paper(other.units['ACC-HL2-B1-01']!, tenant.id);
    // The scoped manager sees the tenant through the ended lease in their scope only.
    expect((await s.tenants.get(scoped, tenant.id)).id).toBe(tenant.id);
    await expect(s.tenants.archive(scoped, tenant.id)).rejects.toMatchObject({
      code: 'tenant_has_lease',
    });
    expect(await s.tenants.get(manager, tenant.id)).toMatchObject({ archived: false });
  });
});

describe('TX-08 staff warnings follow the rule version used', () => {
  it('words the advance refusal and the tracker reminders from the verification of each rule', async () => {
    const platformId = await company(ctx, 'platform', 'Platform');
    for (const [key, value] of [
      ['advance_rent.max_months.over_six_months', { months: 6 }],
      ['rent_control.registration_days', { days: 14 }],
    ] as const)
      await s.rules.add(
        {
          country: 'GH',
          key,
          value,
          effectiveFrom: today,
          source: 'Counsel’s opinion (test)',
          verificationStatus: 'verified',
          verifiedBy: 'A. Counsel',
          createdBy: 'test',
        },
        platformId,
      );
    const set = (settings: Record<string, unknown>) =>
      withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
        tx
          .update(schema.company)
          .set({ settings: sql`${schema.company.settings} || ${JSON.stringify(settings)}::jsonb` })
          .where(sql`${schema.company.id} = ${agencyId}`),
      );
    await set({ advanceRentPolicy: 'block' });
    try {
      const refusal = await s.leases
        .createDraft(manager, {
          unitId: hld.units['ACC-HLD-B1-10']!,
          tenantId: (await tenantFor('Advance Tenant')).id,
          startDate: month(1),
          endDate: endAfter(month(1), 24),
          monthlyRentMinor: 300_000,
          cycle: 'annual',
          initialAdvanceMonths: 24,
          noticeDays: 90,
        })
        .then(
          () => null,
          (error: unknown) => error as { code: string; message: string },
        );
      expect(refusal?.code).toBe('advance_over_limit');
      expect(refusal?.message).toContain('Act 220 s.25(5)');
      expect(refusal?.message).not.toMatch(/unverified/i);
    } finally {
      await set({ advanceRentPolicy: 'off' });
    }
    const lease = await paper(hld.units['ACC-HLD-B1-11']!, (await tenantFor('Registered')).id);
    expect(lease.trackers.rentControl.rule).toMatchObject({ verificationStatus: 'verified' });
    await s.reminders.rentControl(agencyId, plus(lease.trackers.rentControl.deadline!, -7));
    await s.reminders.stamping(agencyId, plus(lease.trackers.stamping.deadline!, -30));
    const bodies = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      async (tx) =>
        (
          await tx.execute<{ subject: string; body: string }>(
            sql`select payload->>'subject' as subject, payload->>'body' as body from outbox_event
                where type = ${MESSAGE_SEND_JOB} and payload->'related'->>'id' = ${lease.id}`,
          )
        ).rows,
    );
    const rentControl = bodies.find((b) => b.subject.startsWith('Rent Control'))!;
    const stamping = bodies.find((b) => b.subject.startsWith('Stamp'))!;
    // The Rent Control period is now verified; the stamping period still is not.
    expect(rentControl.body).not.toMatch(/unverified/i);
    expect(stamping.body).toMatch(/unverified: counsel to confirm/);
  });
});
