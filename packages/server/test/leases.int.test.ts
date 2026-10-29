import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { holdingOverSchedule, checkLeaseTerms, STARTER_TEMPLATES } from '@rent/domain/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

let ctx: ServerTestContext;
let s: TenancyServices;
let agencyId: string;
let landlordId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let manager: Awaited<ReturnType<typeof staffIn>>;
let accountant: Awaited<ReturnType<typeof staffIn>>;
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let clientA: Awaited<ReturnType<typeof staffIn>>;
let adviserA: Awaited<ReturnType<typeof staffIn>>;
let clientB: Awaited<ReturnType<typeof staffIn>>;
let landlord: Awaited<ReturnType<typeof staffIn>>;
let ownerA: string;
let ownerB: string;
let elg: { propertyId: string; units: Record<string, string> };
let osu: { propertyId: string; units: Record<string, string> };
let tem: { propertyId: string; units: Record<string, string> };
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
/** The day before `n` months from `from`: the end of a lease of `n` months. */
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));

async function tenantFor(name: string, actor = manager, phone?: string) {
  return (await s.tenants.create(actor, { kind: 'individual', displayName: name, phone })).tenant;
}

async function paper(
  unitId: string,
  tenantId: string,
  over: Record<string, unknown> = {},
  actor = manager,
) {
  const scanUploadId = await uploadLeaseFile(ctx, s, actor);
  const signedOn = (over.signedOn as string | undefined) ?? day(0);
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
    signedOn,
    ...over,
  });
}

/** Staff notices queued about one lease, by subject prefix (other leases do not count). */
async function noticesFor(leaseId: string, subject: string): Promise<number> {
  const rows = await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from outbox_event where type = ${MESSAGE_SEND_JOB}
          and payload->'related'->>'id' = ${leaseId} and payload->>'subject' like ${`${subject}%`}`,
    ),
  );
  return rows.rows[0]!.n;
}

const setSettings = (companyId: string, settings: Record<string, unknown>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.company)
      .set({ settings: sql`${schema.company.settings} || ${JSON.stringify(settings)}::jsonb` })
      .where(sql`${schema.company.id} = ${companyId}`),
  );

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Leases Agency');
  landlordId = await company(ctx, 'landlord', 'Leases Landlord');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager');
  accountant = await staffIn(ctx, agencyId, 'agency', 'accountant', 'Accountant');
  landlord = await staffIn(ctx, landlordId, 'landlord', 'owner', 'Landlord');
  ownerA = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner A' })).id;
  ownerB = (await s.owners.create(admin, { kind: 'company', displayName: 'Owner B Ltd' })).id;
  elg = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 8, bedrooms: 2 }],
  });
  osu = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    ownerId: ownerB,
    use: 'commercial',
    units: [{ unitType: 'shop', count: 4 }],
  });
  tem = await propertyWithUnits(s, landlord, {
    areaCode: 'TEM',
    propertyPart: 'EST',
    units: [{ unitType: 'apartment', count: 2, bedrooms: 3 }],
  });
  caretaker = await staffIn(ctx, agencyId, 'agency', 'caretaker', 'Caretaker', {
    properties: [elg.propertyId],
  });
  clientA = await staffIn(ctx, agencyId, 'agency', 'owner', 'Client A', { owners: [ownerA] });
  adviserA = await staffIn(ctx, agencyId, 'agency', 'adviser', 'Adviser A', { owners: [ownerA] });
  clientB = await staffIn(ctx, agencyId, 'agency', 'owner', 'Client B', { owners: [ownerB] });
});

afterAll(async () => {
  await ctx?.close();
});

describe('TL-05 templates', () => {
  it('seeds the three starters on first use, each unreviewed', async () => {
    const list = await s.templates.list(manager);
    expect(list.map((t) => t.starterKind).sort()).toEqual([
      'commercial',
      'residential',
      'short_fixed_term',
    ]);
    expect(list.every((t) => t.latest.version === 1 && t.latest.counselReview === null)).toBe(true);
    expect((await s.templates.list(manager)).length).toBe(3); // seeded once
  });

  it('refuses unknown placeholders, markup and a removed required clause', async () => {
    const [residential] = (await s.templates.list(admin)).filter(
      (t) => t.starterKind === 'residential',
    );
    const content = STARTER_TEMPLATES.residential;
    const withClause = (body: string) => ({
      sections: [
        {
          ...content.sections[0]!,
          clauses: content.sections[0]!.clauses.map((c) => (c.key === 'use' ? { ...c, body } : c)),
        },
      ],
    });
    await expect(
      s.templates.publish(admin, residential!.id, { content: withClause('Pay {{tenant.salary}}') }),
    ).rejects.toMatchObject({ code: 'template.placeholder_unknown' });
    await expect(
      s.templates.publish(admin, residential!.id, { content: withClause('<b>bold</b>') }),
    ).rejects.toMatchObject({ code: 'template.html' });
    await expect(
      s.templates.publish(admin, residential!.id, {
        content: {
          sections: [
            {
              ...content.sections[0]!,
              clauses: content.sections[0]!.clauses.filter((c) => c.key !== 'electronic_service'),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'template.clause_required' });
    await expect(s.templates.publish(manager, residential!.id, { content })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('keeps versions immutable: a lease keeps its version, and counsel review is recorded once', async () => {
    const tenant = await tenantFor('Template Tenant');
    const draft = await s.leases.createDraft(manager, {
      unitId: elg.units['ACC-ELG-B1-08']!,
      tenantId: tenant.id,
      startDate: month(2),
      endDate: endAfter(month(2), 12),
      monthlyRentMinor: 180_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    expect(draft.template).toMatchObject({ version: 1, counselReviewed: false });
    expect(draft.counselReviewWarning).toBe(true);
    const content = STARTER_TEMPLATES.residential;
    const published = await s.templates.publish(admin, draft.template!.templateId, {
      content: {
        sections: [
          {
            ...content.sections[0]!,
            clauses: content.sections[0]!.clauses.map((c) =>
              c.key === 'repairs' ? { ...c, body: 'The landlord keeps the roof sound.' } : c,
            ),
          },
        ],
      },
      changeNote: 'Repairs wording from our lawyer',
    });
    expect(published.versions.map((v) => v.version)).toEqual([2, 1]);
    const kept = await s.leases.get(manager, draft.id);
    expect(kept.access === 'full' && kept.template?.version).toBe(1);

    await expect(
      s.templates.review(manager, published.latest.id, { note: 'Reviewed by our lawyer' }),
    ).rejects.toMatchObject({ status: 403 });
    const reviewed = await s.templates.review(admin, published.latest.id, {
      note: 'Reviewed by A. Lawyer on 2026-10-30',
    });
    expect(reviewed.latest.counselReview?.note).toBe('Reviewed by A. Lawyer on 2026-10-30');
    await expect(
      s.templates.review(admin, published.latest.id, { note: 'Reviewed again by someone' }),
    ).rejects.toMatchObject({ code: 'already_reviewed' });
  });

  it('renders the preview and the PDF request from the same snapshot, with the unreviewed warning', async () => {
    const tenant = await tenantFor('Preview Tenant', manager, '+233200000061');
    // The residential starter was reviewed above; the short fixed-term starter was not.
    const shortTerm = (await s.templates.list(manager)).find(
      (t) => t.starterKind === 'short_fixed_term',
    )!;
    const draft = await s.leases.createDraft(manager, {
      unitId: elg.units['ACC-ELG-B1-07']!,
      tenantId: tenant.id,
      templateId: shortTerm.id,
      startDate: month(1),
      endDate: endAfter(month(1), 12),
      monthlyRentMinor: 250_000,
      cycle: 'quarterly',
      depositMinor: 500_000,
      noticeDays: 60,
    });
    const preview = await s.leaseDocuments.preview(manager, draft.id);
    expect(preview.html).toContain('ACC-ELG-B1-07');
    expect(preview.html).toContain('GH₵2,500.00');
    expect(preview.html).toContain('Wording to be supplied by your lawyer.');
    expect(preview.html).toContain('The security deposit is GH₵5,000.00.');
    expect(preview.html).not.toContain('{{');
    expect(preview.warnings[0]).toMatch(/not been reviewed by your lawyer/);
    const queued = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => s.leaseDocuments.requestPdf(tx, draft.id, manager.personId),
    );
    expect(queued.snapshot.data).toEqual(preview.document);
    const [render] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.documentRenderRequest)
          .where(sql`${schema.documentRenderRequest.id} = ${queued.renderRequestId}`),
    );
    expect(render).toMatchObject({ templateKey: 'tenancy.lease', templateVersion: 1 });
    expect(render!.data).toEqual(preview.document);
    await expect(s.leaseDocuments.preview(caretaker, draft.id)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('TL-05 template versions keep their fixed clauses', () => {
  it('refuses a version that rewords a clause the last version fixed, or drops one it required', async () => {
    const [residential] = (await s.templates.list(admin)).filter(
      (t) => t.starterKind === 'residential',
    );
    const content = STARTER_TEMPLATES.residential;
    const section = content.sections[0]!;
    const withRent = (change: Record<string, unknown>) => ({
      sections: [
        {
          ...section,
          clauses: section.clauses.map((c) => (c.key === 'rent' ? { ...c, ...change } : c)),
        },
      ],
    });
    await expect(
      s.templates.publish(admin, residential!.id, {
        content: withRent({ body: 'The rent is GH₵1.00 a month.' }),
      }),
    ).rejects.toMatchObject({ code: 'template.clause_fixed' });
    await expect(
      s.templates.publish(admin, residential!.id, { content: withRent({ editable: true }) }),
    ).rejects.toMatchObject({ code: 'template.clause_fixed' });
    await expect(
      s.templates.publish(admin, residential!.id, {
        content: {
          sections: [{ ...section, clauses: section.clauses.filter((c) => c.key !== 'deposit') }],
        },
      }),
    ).rejects.toMatchObject({ code: 'template.clause_required' });
  });
});

describe('TL-06 rent schedule', () => {
  it('generates the schedule when a lease is signed: monthly, anchored, escalated and prorated', async () => {
    const tenant = await tenantFor('Schedule Tenant');
    const start = month(-1);
    const end = toIsoDate(addDays(addMonths(parseBusinessDate(start), 6), 14)); // a short final period
    const lease = await paper(elg.units['ACC-ELG-B1-01']!, tenant.id, {
      startDate: start,
      endDate: end,
      cycle: 'quarterly',
      serviceChargeMonthlyMinor: 20_000,
      steps: [
        {
          effectiveFrom: toIsoDate(addMonths(parseBusinessDate(start), 3)),
          monthlyRentMinor: 165_000,
        },
      ],
    });
    expect(lease.status).toBe('active');
    const schedule = await s.leases.schedule(manager, lease.id);
    const rent = schedule.filter((p) => p.chargeType === 'rent');
    expect(rent).toHaveLength(7);
    expect(rent[0]).toMatchObject({ periodStart: start, amountMinor: 150_000, prorated: false });
    expect(rent[3]!.amountMinor).toBe(165_000);
    expect(rent.at(-1)).toMatchObject({ periodEnd: end, prorated: true });
    expect(rent.at(-1)!.amountMinor).toBeLessThan(165_000);
    expect(schedule.filter((p) => p.chargeType === 'service_charge')).toHaveLength(7);
    // Periods are contiguous.
    for (let i = 1; i < rent.length; i += 1)
      expect(rent[i]!.periodStart).toBe(
        toIsoDate(addDays(parseBusinessDate(rent[i - 1]!.periodEnd), 1)),
      );
    await expect(s.leases.schedule(caretaker, lease.id)).rejects.toMatchObject({ status: 403 });
  });

  it('holds a lease over after its end date and adds a month at a time at the last rate (OQ-12)', async () => {
    const tenant = await tenantFor('Holding Tenant');
    const start = month(-14);
    const step = toIsoDate(addMonths(parseBusinessDate(start), 6));
    const lease = await paper(elg.units['ACC-ELG-B1-02']!, tenant.id, {
      startDate: start,
      endDate: endAfter(start, 12),
      steps: [{ effectiveFrom: step, monthlyRentMinor: 170_000 }],
      signedOn: start,
    });
    expect(lease.status).toBe('holding_over');
    expect(lease.lifecycle.holdingOverSince).toBe(
      toIsoDate(addDays(parseBusinessDate(endAfter(start, 12)), 1)),
    );
    const schedule = (await s.leases.schedule(manager, lease.id)).filter(
      (p) => p.source === 'holding_over',
    );
    const expected = holdingOverSchedule(
      checkLeaseTerms({
        startDate: start,
        endDate: endAfter(start, 12),
        monthlyRentMinor: 150_000,
        cycle: 'monthly',
        noticeDays: 30,
        use: 'residential',
        steps: [{ effectiveFrom: step, monthlyRentMinor: 170_000 }],
      }),
      today,
    );
    expect(schedule.map((p) => [p.sequence, p.periodStart, p.amountMinor])).toEqual(
      expected.map((p) => [p.sequence, p.periodStart, p.amountMinor]),
    );
    expect(schedule.length).toBeGreaterThanOrEqual(2);
    expect(schedule.every((p) => p.amountMinor === 170_000)).toBe(true);
    // The daily job adds nothing more today.
    await s.lifecycle.runTransitions(agencyId, today);
    expect(
      (await s.leases.schedule(manager, lease.id)).filter((p) => p.source === 'holding_over'),
    ).toHaveLength(schedule.length);
  });
});

describe('PB-09 occupancy', () => {
  it('reserves the unit after signature, occupies it from the start date, and frees it at move-out', async () => {
    const unitId = elg.units['ACC-ELG-B1-03']!;
    const tenant = await tenantFor('Occupancy Tenant');
    const lease = await paper(unitId, tenant.id, {
      startDate: day(5),
      endDate: endAfter(day(5), 12),
    });
    expect(lease.status).toBe('signed');
    expect(await s.read.getUnit(manager, unitId)).toMatchObject({
      status: 'reserved',
      occupancy: 'reserved',
    });
    await s.lifecycle.runTransitions(agencyId, day(4));
    expect(await s.read.getUnit(manager, unitId)).toMatchObject({ occupancy: 'reserved' });
    expect(await s.lifecycle.runTransitions(agencyId, day(5))).toBeGreaterThan(0);
    expect(await s.read.getUnit(manager, unitId)).toMatchObject({
      status: 'occupied',
      occupancy: 'occupied',
    });
    // A move-out is between the start of the lease and today.
    await expect(
      s.lifecycle.recordMoveOut(manager, lease.id, { moveOutDate: day(1) }),
    ).rejects.toMatchObject({ code: 'move_out_date' });
  });

  it('refuses an overlapping lease, and writes every change into the unit history', async () => {
    const unitId = elg.units['ACC-ELG-B1-04']!;
    const first = await tenantFor('First Occupier');
    const second = await tenantFor('Second Occupier');
    const lease = await paper(unitId, first.id);
    await expect(
      paper(unitId, second.id, { startDate: day(30), endDate: endAfter(day(30), 12) }),
    ).rejects.toMatchObject({ code: 'lease_overlap' });
    await s.lifecycle.recordMoveOut(manager, lease.id, {
      moveOutDate: day(0),
      note: 'Keys returned',
    });
    const detail = await s.read.getUnit(manager, unitId);
    expect(detail).toMatchObject({ status: 'vacant', occupancy: 'vacant' });
    const occupancy = detail.history.filter((h) => h.kind === 'occupancy');
    // A paper lease that has already started is signed, then started, in one transaction.
    expect(occupancy.map((h) => [h.fromValue, h.toValue, h.source]).reverse()).toEqual([
      ['vacant', 'reserved', 'lease'],
      ['reserved', 'occupied', 'lease'],
      ['occupied', 'vacant', 'lease'],
    ]);
    expect(occupancy[0]!.reason).toBe('Moved out: Keys returned');
  });
});

describe('PB-09 unit cannot be set vacant with an active lease', () => {
  it('refuses through the API services any availability but available or under repair, and archiving', async () => {
    const unitId = elg.units['ACC-ELG-B1-05']!;
    const tenant = await tenantFor('Sitting Tenant');
    await paper(unitId, tenant.id);
    await expect(
      s.register.setAvailability(manager, unitId, {
        availability: 'not_lettable',
        reason: 'Storage',
      }),
    ).rejects.toMatchObject({ code: 'unit.occupied' });
    await expect(
      s.register.setAvailability(manager, unitId, { availability: 'reserved', reason: 'Viewing' }),
    ).rejects.toMatchObject({ code: 'unit.occupied' });
    await expect(s.register.archiveUnit(manager, unitId)).rejects.toMatchObject({
      code: 'unit_has_lease',
    });
    await s.register.setAvailability(manager, unitId, {
      availability: 'under_repair',
      reason: 'Leaking tap',
    });
    expect(await s.read.getUnit(manager, unitId)).toMatchObject({
      status: 'occupied',
      underRepair: true,
    });
  });
});

describe('AR-05 advance check', () => {
  const twoYears = (unitId: string, tenantId: string, actor = landlord) =>
    s.leases.createDraft(actor, {
      unitId,
      tenantId,
      startDate: month(1),
      endDate: endAfter(month(1), 24),
      monthlyRentMinor: 300_000,
      cycle: 'annual',
      initialAdvanceMonths: 24,
      noticeDays: 90,
    });

  it('records the months demanded and the rule version under `off`, and shows nothing', async () => {
    const tenant = await tenantFor('Advance Tenant', landlord);
    const lease = await twoYears(tem.units['TEM-EST-B1-01']!, tenant.id);
    expect(lease.advanceFlag).toBeNull();
    const [row] = await withCompany(
      ctx.database,
      { companyId: landlordId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.lease)
          .where(sql`${schema.lease.id} = ${lease.id}`),
    );
    const rule = await s.rules.resolve(
      'GH',
      'advance_rent.max_months.over_six_months',
      parseBusinessDate(today),
    );
    expect(row).toMatchObject({
      advanceMonthsDemanded: 24,
      advanceRule: 'over_six_months',
      advanceLimitMonths: 6,
      advanceExceedsLimit: true,
      advanceRuleId: rule.ruleId,
      advancePolicy: 'off',
      advanceFlagged: false,
    });
    expect(JSON.stringify(lease)).not.toMatch(/compliant/i);
  });

  it('flags under `warn`, refuses under `block`, and finds no rule between one and six months (OQ-51)', async () => {
    await setSettings(landlordId, { advanceRentPolicy: 'warn' });
    const tenant = await tenantFor('Warned Tenant', landlord);
    const warned = await twoYears(tem.units['TEM-EST-B1-02']!, tenant.id);
    expect(warned.advanceFlag).toMatchObject({
      monthsDemanded: 24,
      limitMonths: 6,
      rule: { verificationStatus: 'unverified', warning: true },
    });
    const short = await s.leases.updateDraft(landlord, warned.id, {
      endDate: endAfter(month(1), 4),
      initialAdvanceMonths: 4,
      cycle: 'monthly',
    });
    expect(short.advanceFlag).toBeNull();
    await setSettings(landlordId, { advanceRentPolicy: 'block' });
    const refused = s.leases.updateDraft(landlord, warned.id, {
      endDate: endAfter(month(1), 24),
      initialAdvanceMonths: 24,
      cycle: 'annual',
    });
    await expect(refused).rejects.toMatchObject({ code: 'advance_over_limit', status: 422 });
    await expect(refused).rejects.not.toThrow(/compliant/i);
    await setSettings(landlordId, { advanceRentPolicy: 'off' });
  });
});

describe('TX-05 Rent Control tracker and OQ-45, OQ-44 trackers', () => {
  it('takes the deadlines from the rules table, with the unverified flag, and never blocks the lease', async () => {
    const tenant = await tenantFor('Tracked Tenant');
    const lease = await paper(elg.units['ACC-ELG-B1-06']!, tenant.id);
    expect(lease.status).toBe('active');
    expect(lease.trackers.rentControl).toMatchObject({
      applies: true,
      deadline: day(14),
      done: false,
      rule: { verificationStatus: 'unverified', warning: true },
    });
    expect(lease.trackers.stamping).toMatchObject({
      deadline: month(2),
      done: false,
      rule: { verificationStatus: 'unverified', warning: true },
    });
    expect(lease.trackers.formalLease).toMatchObject({ required: false });
  });

  it('reminds about Rent Control until the registration is recorded', async () => {
    const tenant = await tenantFor('Unregistered Tenant');
    const lease = await paper(osu.units['ACC-OSU-B1-01']!, tenant.id, { use: 'residential' });
    const sent = async (date: string) => {
      const before = await noticesFor(lease.id, 'Rent Control');
      await s.reminders.rentControl(agencyId, date);
      return (await noticesFor(lease.id, 'Rent Control')) - before;
    };
    expect(await sent(day(6))).toBe(0); // before the first step (7 days before the deadline)
    const first = await sent(day(7));
    expect(first).toBeGreaterThan(0);
    expect(await sent(day(7))).toBe(0); // once
    expect(await sent(day(12))).toBe(first);
    expect(await sent(day(21))).toBe(first); // weekly after the deadline, the latest step only
    await s.leases.recordRentControl(manager, lease.id, {
      registrationNumber: 'RC/ACC/2026/0001',
      registeredOn: day(0),
    });
    expect(await sent(day(28))).toBe(0);
    const after = await s.leases.get(manager, lease.id);
    expect(after.access === 'full' && after.trackers.rentControl.done).toBe(true);
    expect(after.status).toBe('active'); // collection and the lease were never blocked
  });

  it('reminds about stamping until the stamped copy is recorded, and about a formal lease weekly', async () => {
    const tenant = await tenantFor('Long Lease Tenant');
    const start = day(-5);
    const lease = await paper(elg.units['ACC-ELG-B1-08']!, tenant.id, {
      startDate: start,
      endDate: endAfter(start, 48),
      use: 'residential',
    });
    // B1-08 had only a draft above; recording this lease is allowed.
    expect(lease.trackers.formalLease).toMatchObject({
      required: true,
      done: false,
      rule: { verificationStatus: 'unverified' },
    });
    const stampDeadline = lease.trackers.stamping.deadline!;
    const before = (n: number) => toIsoDate(addDays(parseBusinessDate(stampDeadline), -n));
    const stamping = async (date: string) => {
      const was = await noticesFor(lease.id, 'Stamp');
      await s.reminders.stamping(agencyId, date);
      return (await noticesFor(lease.id, 'Stamp')) - was;
    };
    const first = await stamping(before(30));
    expect(first).toBeGreaterThan(0);
    expect(await stamping(before(30))).toBe(0);
    const uploadId = await uploadLeaseFile(ctx, s, manager);
    await s.leases.recordStamping(manager, lease.id, { stampedOn: day(0), uploadId });
    expect(await stamping(before(7))).toBe(0);

    const monday = (n: number) => {
      const d = parseBusinessDate(day(7 * n));
      return toIsoDate(addDays(d, 1 - d.dayOfWeek));
    };
    const formal = async (date: string) => {
      const was = await noticesFor(lease.id, 'Formal lease');
      await s.reminders.formalLeases(agencyId, date);
      return (await noticesFor(lease.id, 'Formal lease')) - was;
    };
    const weekly = await formal(monday(1));
    expect(weekly).toBeGreaterThan(0);
    expect(await formal(toIsoDate(addDays(parseBusinessDate(monday(1)), 2)))).toBe(0);
    expect(await formal(monday(2))).toBe(weekly);
    const copy = await uploadLeaseFile(ctx, s, manager);
    const done = await s.leases.recordFormalLease(manager, lease.id, {
      practitioner: 'A. Lawyer, Accra',
      wetSignedUploadId: copy,
      registeredOn: day(0),
      registrationNumber: 'LC/2026/123',
    });
    expect(done.trackers.formalLease.done).toBe(true);
    expect(await formal(monday(3))).toBe(0);
  });

  it('tracks commercial Rent Control only when the company chooses (OQ-52)', async () => {
    const tenant = await tenantFor('Shop Tenant');
    const lease = await paper(osu.units['ACC-OSU-B1-02']!, tenant.id);
    expect(lease.use).toBe('commercial');
    expect(lease.trackers.rentControl).toMatchObject({ applies: false, deadline: null });
    await setSettings(agencyId, { rentControlCommercial: true });
    const other = await tenantFor('Second Shop Tenant');
    const tracked = await paper(osu.units['ACC-OSU-B1-03']!, other.id);
    expect(tracked.trackers.rentControl.applies).toBe(true);
    await setSettings(agencyId, { rentControlCommercial: false });
  });
});

describe('TL-09 renewals', () => {
  it('reminds at 90, 60 and 30 days, once each as the clock moves, to the people who manage the property', async () => {
    const tenant = await tenantFor('Renewing Tenant');
    const start = month(-9);
    const lease = await paper(elg.units['ACC-ELG-B1-07']!, tenant.id, {
      startDate: start,
      endDate: endAfter(start, 12),
      signedOn: start,
    });
    const end = lease.terms.endDate;
    const before = (n: number) => toIsoDate(addDays(parseBusinessDate(end), -n));
    const recipientsOf = async () =>
      withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, async (tx) => {
        const rows = await tx.execute<{ person_id: string; subject: string }>(
          sql`select payload->'recipient'->>'personId' as person_id, payload->>'subject' as subject
              from outbox_event where type = ${MESSAGE_SEND_JOB}
                and payload->'related'->>'id' = ${lease.id}
                and payload->>'subject' like 'Lease ending%'`,
        );
        return rows.rows;
      });
    const renewals = async (date: string) => {
      const was = await noticesFor(lease.id, 'Lease ending');
      await s.reminders.renewals(agencyId, date);
      return (await noticesFor(lease.id, 'Lease ending')) - was;
    };
    expect(await renewals(before(91))).toBe(0);
    const at90 = await renewals(before(90));
    expect(at90).toBeGreaterThan(0);
    expect(await renewals(before(89))).toBe(0);
    const at60 = await renewals(before(60));
    const at30 = await renewals(before(30));
    expect(await renewals(before(29))).toBe(0);
    expect([at60, at30]).toEqual([at90, at90]);
    const sent = await recipientsOf();
    expect(new Set(sent.map((r) => r.subject))).toEqual(
      new Set([
        'Lease ending in 90 days: ACC-ELG-B1-07',
        'Lease ending in 60 days: ACC-ELG-B1-07',
        'Lease ending in 30 days: ACC-ELG-B1-07',
      ]),
    );
    // The managers, the agency admin and Owner A's users; never the caretaker, the accountant or Owner B's.
    const people = new Set(sent.map((r) => r.person_id));
    expect(people).toEqual(
      new Set([admin.personId, manager.personId, clientA.personId, adviserA.personId]),
    );
    expect(
      people.has(caretaker.personId) ||
        people.has(accountant.personId) ||
        people.has(clientB.personId),
    ).toBe(false);
  });

  it('lists expiring leases, and a signed renewal starts the day after the old lease ends', async () => {
    const unitId = elg.units['ACC-ELG-B1-06']!;
    const tenant = await tenantFor('Expiring Tenant');
    // B1-06 already holds a tracked lease (above); move that tenant out first.
    const held = (await s.leases.list(manager, { unitId, status: ['active'] }))[0]!;
    await s.lifecycle.recordMoveOut(manager, held.id, { moveOutDate: day(0) });
    const start = toIsoDate(addDays(parseBusinessDate(endAfter(month(-10), 0)), 1));
    const lease = await paper(unitId, tenant.id, { startDate: start, endDate: day(45) });
    const expiring = await s.leases.expiring(manager, 90);
    expect(expiring.find((e) => e.id === lease.id)).toMatchObject({
      unitCode: 'ACC-ELG-B1-06',
      endDate: day(45),
      daysLeft: 45,
      renewal: null,
    });
    expect((await s.leases.expiring(manager, 30)).find((e) => e.id === lease.id)).toBeUndefined();

    const occupancyEvents = async () =>
      (await s.read.getUnit(manager, unitId)).history.filter((h) => h.kind === 'occupancy');
    const historyBefore = await occupancyEvents();
    const renewal = await s.leases.offerRenewal(manager, lease.id);
    expect(renewal).toMatchObject({
      status: 'draft',
      renewsLeaseId: lease.id,
      terms: { startDate: day(46), monthlyRentMinor: 150_000 },
    });
    await expect(s.leases.offerRenewal(manager, lease.id)).rejects.toMatchObject({
      code: 'renewal_exists',
    });
    // The e-signing phase completes the signature through the same method a paper lease uses.
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
          leaseId: renewal.id,
          signedAt: ctx.clock.now(),
          source: 'paper',
          signedDocumentId: documentId,
        });
      },
    );
    expect(
      (await s.leases.expiring(manager, 90)).find((e) => e.id === lease.id)?.renewal,
    ).toMatchObject({
      id: renewal.id,
      status: 'signed',
    });
    await s.lifecycle.runTransitions(agencyId, day(46));
    const [old, next] = await Promise.all([
      s.leases.get(manager, lease.id),
      s.leases.get(manager, renewal.id),
    ]);
    expect(old).toMatchObject({
      status: 'ended',
      lifecycle: { endReason: 'renewed', endedOn: day(45) },
    });
    expect(next).toMatchObject({ status: 'active', lifecycle: { activatedOn: day(46) } });
    // The unit stayed occupied throughout: no history row between the two leases.
    const historyAfter = await occupancyEvents();
    expect(historyAfter).toEqual(historyBefore);
    expect(historyAfter[0]!.toValue).toBe('occupied');
  });
});

describe('TL-06 the lease side of e-signing (the seam for the e-signing phase)', () => {
  it('marks a lease signed when its signing request completes, once, and returns a recalled or declined one to draft', async () => {
    const tenant = await tenantFor('E-sign Seam Tenant');
    const draft = await s.leases.createDraft(manager, {
      unitId: elg.units['ACC-ELG-B1-07']!,
      tenantId: tenant.id,
      startDate: month(20),
      endDate: endAfter(month(20), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    // Issuing is the e-signing phase's: the lease waits for signatures, its terms frozen.
    const issue = () =>
      withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
        tx
          .update(schema.lease)
          .set({ status: 'pending_signatures' })
          .where(sql`${schema.lease.id} = ${draft.id}`),
      );
    const statusOf = async () => (await s.leases.get(manager, draft.id)).status;
    await issue();
    await expect(
      s.leases.updateDraft(manager, draft.id, { monthlyRentMinor: 1 }),
    ).rejects.toMatchObject({
      code: 'lease_not_draft',
    });
    await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      s.lifecycle.returnToDraft(tx, draft.id, 'recalled'),
    );
    expect(await statusOf()).toBe('draft');
    await issue();
    await s.lifecycle.onSigningDeclined(agencyId, { leaseId: draft.id });
    await s.lifecycle.onSigningDeclined(agencyId, { leaseId: draft.id });
    expect(await statusOf()).toBe('draft');
    await issue();
    const scan = await uploadLeaseFile(ctx, s, manager);
    const staged = await s.documents.stageEvidenceUpload(
      { companyId: agencyId, personId: manager.personId },
      scan,
      { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
    );
    const finalDocumentId = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => s.documents.recordStagedEvidence(tx, staged, 'signed_lease'),
    );
    const completedAt = ctx.clock.now();
    await s.lifecycle.onSigningCompleted(agencyId, {
      leaseId: draft.id,
      completedAt,
      finalDocumentId,
    });
    await s.lifecycle.onSigningCompleted(agencyId, {
      leaseId: draft.id,
      completedAt,
      finalDocumentId,
    });
    const signed = await s.leases.get(manager, draft.id);
    expect(signed).toMatchObject({
      status: 'signed',
      signing: { method: 'esign', signedOnPaper: false, signedDocument: true },
    });
    expect(
      (await s.leases.schedule(manager, draft.id)).filter((p) => p.chargeType === 'rent'),
    ).toHaveLength(12);
  });
});

describe('AD-05 cancelling a signed lease', () => {
  it('needs a second eligible person; the initiator is refused, in the service and the database', async () => {
    const unitId = osu.units['ACC-OSU-B1-04']!;
    const tenant = await tenantFor('Cancelled Tenant');
    const lease = await paper(unitId, tenant.id, {
      startDate: day(20),
      endDate: endAfter(day(20), 12),
    });
    expect(lease.status).toBe('signed');
    await expect(
      s.leases.requestCancelSigned(accountant, lease.id, 'Tenant withdrew before moving in'),
    ).rejects.toMatchObject({ status: 403 });
    const { request } = await s.leases.requestCancelSigned(
      manager,
      lease.id,
      'Tenant withdrew before moving in',
    );
    expect(request).toMatchObject({
      mode: 'two_person',
      status: 'pending',
      actionType: 'lease.cancel_signed',
    });
    await expect(
      s.approvals.decide(manager, request.id, { decision: 'approve' }),
    ).rejects.toThrow();
    await expect(
      s.approvals.decide(accountant, request.id, { decision: 'approve' }),
    ).rejects.toThrow();
    expect((await s.leases.get(manager, lease.id)).status).toBe('signed');
    const done = await s.approvals.decide(admin, request.id, { decision: 'approve' });
    expect(done.request.status).toBe('approved');
    const cancelled = await s.leases.get(manager, lease.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      lifecycle: { cancelReason: 'Tenant withdrew before moving in' },
    });
    expect(await s.read.getUnit(manager, unitId)).toMatchObject({ occupancy: 'vacant' });
  });

  it('puts a landlord with no one else into the cooling-off, and refuses a lease that has started', async () => {
    const tenant = await tenantFor('Solo Landlord Tenant', landlord);
    const scanUploadId = await uploadLeaseFile(ctx, s, landlord);
    const lease = await s.leases.recordPaper(landlord, {
      unitId: tem.units['TEM-EST-B1-01']!,
      tenantId: tenant.id,
      startDate: month(30),
      endDate: endAfter(month(30), 12),
      monthlyRentMinor: 400_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Tenant' }],
      scanUploadId,
      signedOn: day(0),
    });
    const { request } = await s.leases.requestCancelSigned(
      landlord,
      lease.id,
      'Changed our plans for the house',
    );
    expect(request).toMatchObject({ mode: 'single_user', status: 'cooling_off' });
    const started = await tenantFor('Started Tenant');
    const active = await paper(osu.units['ACC-OSU-B1-04']!, started.id, { use: 'residential' });
    expect(active.status).toBe('active');
    await expect(
      s.leases.requestCancelSigned(manager, active.id, 'Too late to cancel this one'),
    ).rejects.toMatchObject({ code: 'lease_started' });
  });
});

describe('AD-05 one cancellation waits at a time', () => {
  it('opens one request when two people ask at once, refuses more while it waits, and takes a new one once it is withdrawn', async () => {
    const cnl = await propertyWithUnits(s, manager, {
      areaCode: 'ACC',
      propertyPart: 'CNL',
      ownerId: ownerA,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const tenant = await tenantFor('Withdrawn Cancellation Tenant');
    const lease = await paper(cnl.units['ACC-CNL-B1-01']!, tenant.id, {
      startDate: day(20),
      endDate: endAfter(day(20), 12),
    });
    const asked = await Promise.allSettled([
      s.leases.requestCancelSigned(manager, lease.id, 'Tenant withdrew before moving in'),
      s.leases.requestCancelSigned(admin, lease.id, 'Tenant withdrew before moving in'),
    ]);
    const opened = asked.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = asked.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 409, code: 'approval_open' });
    await expect(
      s.leases.requestCancelSigned(manager, lease.id, 'Asking again while one waits'),
    ).rejects.toMatchObject({ status: 409, code: 'approval_open' });

    const { request } = opened[0]!;
    const initiator = request.initiatedBy === manager.personId ? manager : admin;
    await s.approvals.cancel(initiator, request.id);
    const again = await s.leases.requestCancelSigned(
      manager,
      lease.id,
      'Asking again after withdrawing',
    );
    expect(again.request).toMatchObject({ status: 'pending', actionType: 'lease.cancel_signed' });
  });
});

describe('NFR-SEC scope and the caretaker’s view', () => {
  it('shows a caretaker the unit and dates of leases in their property only, and an owner’s users their owner only', async () => {
    const caretakerView = await s.leases.list(caretaker);
    expect(caretakerView.length).toBeGreaterThan(0);
    expect(
      caretakerView.every((l) => l.access === 'limited' && l.unit.code.startsWith('ACC-ELG')),
    ).toBe(true);
    expect(JSON.stringify(caretakerView)).not.toMatch(/monthlyRentMinor|tenant/);
    const clientView = await s.leases.list(clientB);
    expect(clientView.length).toBeGreaterThan(0);
    expect(clientView.every((l) => l.access === 'full' && l.unit.code.startsWith('ACC-OSU'))).toBe(
      true,
    );
  });

  it('lets a scoped manager see the tenant they created before any lease, then through its lease', async () => {
    const scopedA = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Scoped A', {
      owners: [ownerA],
    });
    const scopedB = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Scoped B', {
      owners: [ownerB],
    });
    const { tenant } = await s.tenants.create(scopedA, {
      kind: 'individual',
      displayName: 'Prospect',
    });
    expect((await s.tenants.get(scopedA, tenant.id)).id).toBe(tenant.id);
    await expect(s.tenants.get(scopedB, tenant.id)).rejects.toMatchObject({ status: 404 });
    await s.leases.createDraft(scopedA, {
      unitId: elg.units['ACC-ELG-B1-08']!,
      tenantId: tenant.id,
      startDate: month(60),
      endDate: endAfter(month(60), 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    expect((await s.tenants.list(scopedA)).map((t) => t.id)).toContain(tenant.id);
    expect((await s.tenants.list(scopedB)).map((t) => t.id)).not.toContain(tenant.id);
    await expect(
      s.leases.createDraft(scopedB, {
        unitId: elg.units['ACC-ELG-B1-08']!,
        tenantId: tenant.id,
        startDate: month(80),
        endDate: endAfter(month(80), 12),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        noticeDays: 30,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('AD-07 lease audit', () => {
  it('records lease changes and tracker updates with before and after, contacts redacted', async () => {
    const tenant = await tenantFor('Audit Lease Tenant', manager, '+233200000062');
    const draft = await s.leases.createDraft(manager, {
      unitId: elg.units['ACC-ELG-B1-08']!,
      tenantId: tenant.id,
      startDate: month(40),
      endDate: endAfter(month(40), 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    await s.leases.updateDraft(manager, draft.id, { monthlyRentMinor: 110_000 });
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{
          action: string;
          data: { before?: Record<string, unknown>; after?: Record<string, unknown> };
        }>(
          sql`select action, data from audit_event where record_type = 'lease' and record_id = ${draft.id} order by seq`,
        ),
    );
    const update = events.rows.find(
      (e) => e.action === 'lease.update' && e.data.after?.monthly_rent_minor === 110_000,
    );
    expect(update?.data.before?.monthly_rent_minor).toBe(100_000);
    expect(JSON.stringify(events.rows)).not.toContain('200000062');
    expect(
      events.rows.every(
        (e) => JSON.stringify(e.data).includes('"service_phones":"[redacted]"') || !e.data.after,
      ),
    ).toBe(true);
  });
});
