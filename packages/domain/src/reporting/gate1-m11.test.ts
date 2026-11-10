import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import {
  arrearsBaselineMonth,
  arrearsOver60,
  combineArrearsOver60,
  combineWeeklyActiveManagers,
  combineWhatsappAdoption,
  gate1Targets,
  GATE1_TARGET_BPS,
  meetsTarget,
  netRevenueRetention,
  timeToReceipt,
  timeToReceiptDelivered,
  weeklyActiveManagers,
  weeksStartingIn,
  whatsappAdoption,
  type ArrearsSnapshotRow,
  type StaffActiveDay,
  type StaffMember,
  type SubscriptionRevenue,
  type TenantForAdoption,
  type TenantWhatsappUse,
} from './gate1';
import { ratioOf } from './measures';

const snapshot = (
  values: Partial<ArrearsSnapshotRow> & { arrears0To30Minor?: number; arrears31To60Minor?: number },
): ArrearsSnapshotRow => ({
  arrears61To90Minor: 0,
  arrears90PlusMinor: 0,
  rentMinor: 0,
  serviceChargeMinor: 0,
  ...values,
});

const dayAfter = (date: string, days: number) => toIsoDate(addDays(parseBusinessDate(date), days));

describe('DA-05 Gate 1 targets (M11 decision 4)', () => {
  it('sets both targets at 95%', () => {
    expect(GATE1_TARGET_BPS).toEqual({ collectionRate: 9_500, autoMatch: 9_500 });
  });

  it('is met at 95% or more, judged exactly rather than on the rounded share', () => {
    expect(meetsTarget(ratioOf(95, 100), 9_500)).toBe(true);
    expect(meetsTarget(ratioOf(96, 100), 9_500)).toBe(true);
    expect(meetsTarget(ratioOf(94, 100), 9_500)).toBe(false);
    // 94.995% shows as 95.00% (half up), but it is short of 95%.
    const short = ratioOf(18_999, 20_000);
    expect(short.bps).toBe(9_500);
    expect(meetsTarget(short, 9_500)).toBe(false);
    expect(meetsTarget(ratioOf(19_000, 20_000), 9_500)).toBe(true);
  });

  it('is neither met nor missed when there is nothing to measure', () => {
    expect(gate1Targets({ collectionRate: ratioOf(0, 0), autoMatch: ratioOf(0, 0) })).toEqual({
      collectionRate: { targetBps: 9_500, met: null },
      autoMatch: { targetBps: 9_500, met: null },
    });
  });

  it('reports each target on its own', () => {
    expect(gate1Targets({ collectionRate: ratioOf(97, 100), autoMatch: ratioOf(90, 100) })).toEqual(
      {
        collectionRate: { targetBps: 9_500, met: true },
        autoMatch: { targetBps: 9_500, met: false },
      },
    );
  });

  it('agrees with exact arithmetic for any share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (a, b) => {
          const [numerator, denominator] = a <= b ? [a, b] : [b, a];
          expect(meetsTarget(ratioOf(numerator, denominator), 9_500)).toBe(
            numerator * 20 >= denominator * 19,
          );
        },
      ),
    );
  });

  it('refuses a target outside 0 to 100%', () => {
    expect(() => meetsTarget(ratioOf(1, 2), 10_001)).toThrow(/basis points/);
  });
});

describe('DA-05 Gate 1 arrears over 60 days (M11 decision 4)', () => {
  it('counts what is more than 60 days overdue against the rent roll', () => {
    const result = arrearsOver60({
      month: '2026-12',
      rows: [
        snapshot({ arrears61To90Minor: 150_000, rentMinor: 150_000, serviceChargeMinor: 20_000 }),
        snapshot({ arrears90PlusMinor: 300_000, rentMinor: 100_000 }),
        // Younger arrears are left out.
        snapshot({ arrears0To30Minor: 80_000, arrears31To60Minor: 80_000, rentMinor: 80_000 }),
        // A lease that has ended still owes; it adds nothing to the rent roll.
        snapshot({ arrears90PlusMinor: 50_000 }),
      ],
      cutOverDate: null,
    });
    expect(result).toEqual({
      arrearsMinor: 500_000,
      rentRollMinor: 350_000,
      // More than the month's rent roll: a share above 100% is possible.
      share: { numerator: 500_000, denominator: 350_000, bps: 14_286 },
      baselineMonth: null,
      baselineShare: null,
    });
  });

  it('is empty, not 0%, with no rent roll', () => {
    expect(arrearsOver60({ month: '2026-12', rows: [], cutOverDate: null }).share).toEqual({
      numerator: 0,
      denominator: 0,
      bps: null,
    });
  });

  it('takes the first full month after the cut-over as the baseline', () => {
    expect(arrearsBaselineMonth('2026-11-01')).toBe('2026-11');
    expect(arrearsBaselineMonth('2026-11-10')).toBe('2026-12');
    expect(arrearsBaselineMonth('2026-12-31')).toBe('2027-01');
    expect(arrearsBaselineMonth(null)).toBeNull();
  });

  it('shows no baseline before its month, its own figure in it, and the stored one after', () => {
    const rows = [snapshot({ arrears90PlusMinor: 10_000, rentMinor: 100_000 })];
    const cutOverDate = '2026-11-10';
    const before = arrearsOver60({ month: '2026-11', rows, cutOverDate });
    expect([before.baselineMonth, before.baselineShare]).toEqual(['2026-12', null]);
    const during = arrearsOver60({ month: '2026-12', rows, cutOverDate });
    expect(during.baselineShare).toEqual(during.share);
    const stored = ratioOf(20_000, 100_000);
    const after = arrearsOver60({ month: '2027-03', rows, cutOverDate, baselineShare: stored });
    expect(after).toMatchObject({ baselineMonth: '2026-12', baselineShare: stored });
    expect(after.share.bps).toBe(1_000);
    expect(arrearsOver60({ month: '2027-03', rows, cutOverDate }).baselineShare).toBeNull();
  });

  it('refuses amounts below zero or not in whole pesewas', () => {
    expect(() =>
      arrearsOver60({ month: '2026-12', rows: [snapshot({ rentMinor: -1 })], cutOverDate: null }),
    ).toThrow(/zero or more/);
    expect(() =>
      arrearsOver60({
        month: '2026-12',
        rows: [snapshot({ arrears90PlusMinor: 0.5 })],
        cutOverDate: null,
      }),
    ).toThrow(/whole number/);
  });

  it('adds companies up exactly, with a baseline only once every company has one', () => {
    const a = arrearsOver60({
      month: '2027-01',
      rows: [snapshot({ arrears90PlusMinor: 10_000, rentMinor: 100_000 })],
      cutOverDate: '2026-11-01',
      baselineShare: ratioOf(30_000, 100_000),
    });
    const b = arrearsOver60({
      month: '2027-01',
      rows: [snapshot({ arrears61To90Minor: 5_000, rentMinor: 300_000 })],
      cutOverDate: '2026-12-15',
    });
    expect(combineArrearsOver60([a, b])).toEqual({
      arrearsMinor: 15_000,
      rentRollMinor: 400_000,
      share: ratioOf(15_000, 400_000),
      baselineMonth: '2027-01',
      baselineShare: ratioOf(35_000, 400_000),
    });
    const c = arrearsOver60({ month: '2027-01', rows: [], cutOverDate: null });
    expect(combineArrearsOver60([a, b, c])).toMatchObject({
      baselineMonth: null,
      baselineShare: null,
    });
    expect(combineArrearsOver60([])).toBeNull();
  });

  it('gives the platform the same figures as working out every company’s rows at once', () => {
    const amount = fc.integer({ min: 0, max: 10_000_000 });
    const row = fc.record({
      arrears61To90Minor: amount,
      arrears90PlusMinor: amount,
      rentMinor: amount,
      serviceChargeMinor: amount,
    });
    fc.assert(
      fc.property(
        fc.array(fc.array(row, { maxLength: 8 }), { minLength: 1, maxLength: 5 }),
        (companies) => {
          const parts = companies.map((rows) =>
            arrearsOver60({ month: '2026-12', rows, cutOverDate: null }),
          );
          const total = combineArrearsOver60(parts)!;
          const all = arrearsOver60({
            month: '2026-12',
            rows: companies.flat(),
            cutOverDate: null,
          });
          expect(total.share).toEqual(all.share);
          expect([total.arrearsMinor, total.rentRollMinor]).toEqual([
            all.arrearsMinor,
            all.rentRollMinor,
          ]);
        },
      ),
    );
  });
});

describe('DA-05 Gate 1 weekly active managers (M11 decision 4)', () => {
  const ama: StaffMember = { companyId: 'c1', personId: 'ama' };
  const kojo: StaffMember = { companyId: 'c1', personId: 'kojo' };
  const on = (member: StaffMember, ...days: string[]): StaffActiveDay[] =>
    days.map((day) => ({ ...member, day }));

  it('starts a week on each Monday of the month, the last one ending in the next month', () => {
    // 1 November 2026 is a Sunday.
    expect(weeksStartingIn('2026-11')).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ]);
    expect(weeksStartingIn('2027-02')).toEqual([
      '2027-02-01',
      '2027-02-08',
      '2027-02-15',
      '2027-02-22',
    ]);
  });

  it('counts a staff member in a week when active on 3 days or more of it', () => {
    const result = weeklyActiveManagers({
      month: '2026-11',
      staff: [ama, kojo],
      activeDays: [
        // Ama: three days in the first week, the same day twice counted once in the second.
        ...on(ama, '2026-11-02', '2026-11-04', '2026-11-08'),
        ...on(ama, '2026-11-09', '2026-11-09', '2026-11-10'),
        // The last week runs into December.
        ...on(ama, '2026-11-30', '2026-12-01', '2026-12-06'),
        // Kojo: two days, and a Sunday that belongs to the week before.
        ...on(kojo, '2026-11-16', '2026-11-17', '2026-11-01'),
        // Someone no longer on staff is left out.
        ...on({ companyId: 'c1', personId: 'left' }, '2026-11-02', '2026-11-03', '2026-11-04'),
      ],
    });
    expect(result).toEqual({
      staff: 2,
      weeks: [
        { weekStart: '2026-11-02', active: 1 },
        { weekStart: '2026-11-09', active: 0 },
        { weekStart: '2026-11-16', active: 0 },
        { weekStart: '2026-11-23', active: 0 },
        { weekStart: '2026-11-30', active: 1 },
      ],
      share: { numerator: 2, denominator: 10, bps: 2_000 },
    });
  });

  it('leaves out weeks not started yet while the month runs', () => {
    const result = weeklyActiveManagers({
      month: '2026-11',
      staff: [ama],
      activeDays: on(ama, '2026-11-02', '2026-11-03', '2026-11-04'),
      asOf: '2026-11-10',
    });
    expect(result.weeks.map((w) => w.weekStart)).toEqual(['2026-11-02', '2026-11-09']);
    expect(result.share).toEqual(ratioOf(1, 2));
  });

  it('is empty with no staff, and refuses a staff member listed twice', () => {
    expect(
      weeklyActiveManagers({ month: '2026-11', staff: [], activeDays: [] }).share.bps,
    ).toBeNull();
    expect(() =>
      weeklyActiveManagers({ month: '2026-11', staff: [ama, { ...ama }], activeDays: [] }),
    ).toThrow(/listed once/);
  });

  const companyStaff = (companyId: string) =>
    fc
      .record({
        people: fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 5 }),
        days: fc.array(
          fc.record({
            personId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'x'),
            offset: fc.integer({ min: -3, max: 40 }),
          }),
          { maxLength: 60 },
        ),
      })
      .map(({ people, days }) => ({
        staff: people.map((personId) => ({ companyId, personId })),
        activeDays: days.map((d) => ({
          companyId,
          personId: d.personId,
          day: dayAfter('2026-11-01', d.offset),
        })),
      }));

  it('never goes above 100%, and the platform equals the sum of its companies', () => {
    fc.assert(
      fc.property(companyStaff('c1'), companyStaff('c2'), companyStaff('c3'), (...companies) => {
        const parts = companies.map((c) => weeklyActiveManagers({ month: '2026-11', ...c }));
        for (const part of parts) expect(part.share.bps ?? 0).toBeLessThanOrEqual(10_000);
        const total = combineWeeklyActiveManagers(parts)!;
        const all = weeklyActiveManagers({
          month: '2026-11',
          staff: companies.flatMap((c) => c.staff),
          activeDays: companies.flatMap((c) => c.activeDays),
        });
        expect(total).toEqual(all);
      }),
    );
  });
});

describe('DA-05 Gate 1 tenant WhatsApp adoption (M11 decision 4)', () => {
  const tenant = (
    tenantId: string,
    values: Partial<TenantForAdoption> = {},
  ): TenantForAdoption => ({
    companyId: 'c1',
    tenantId,
    activeLease: true,
    whatsappConsent: true,
    ...values,
  });
  const used = (tenantId: string, day: string, companyId = 'c1'): TenantWhatsappUse => ({
    companyId,
    tenantId,
    day,
  });

  it('counts tenants with consent who sent or read a WhatsApp message, out of those with an active lease', () => {
    const result = whatsappAdoption({
      month: '2026-11',
      tenants: [
        tenant('t1'),
        tenant('t2', { whatsappConsent: false }),
        tenant('t3'),
        tenant('t4', { activeLease: false }),
        tenant('t5'),
      ],
      uses: [
        used('t1', '2026-11-03'),
        used('t1', '2026-11-20'),
        // Used, but without consent: not adopted.
        used('t2', '2026-11-03'),
        // Used only outside the month.
        used('t3', '2026-10-31'),
        used('t3', '2026-12-01'),
        // No active lease: left out altogether.
        used('t4', '2026-11-03'),
        // The same tenant id with another landlord is another tenant.
        used('t5', '2026-11-03', 'c2'),
      ],
    });
    expect(result).toEqual({
      tenantsWithActiveLease: 4,
      adopted: 1,
      share: { numerator: 1, denominator: 4, bps: 2_500 },
    });
  });

  it('is empty with no tenants on a lease, and refuses a tenant listed twice', () => {
    expect(
      whatsappAdoption({
        month: '2026-11',
        tenants: [tenant('t1', { activeLease: false })],
        uses: [],
      }).share.bps,
    ).toBeNull();
    expect(() =>
      whatsappAdoption({ month: '2026-11', tenants: [tenant('t1'), tenant('t1')], uses: [] }),
    ).toThrow(/listed once/);
  });

  const companyTenants = (companyId: string) =>
    fc
      .record({
        tenants: fc.uniqueArray(
          fc.record({
            tenantId: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6'),
            activeLease: fc.boolean(),
            whatsappConsent: fc.boolean(),
          }),
          { selector: (t) => t.tenantId, maxLength: 6 },
        ),
        uses: fc.array(
          fc.record({
            tenantId: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7'),
            offset: fc.integer({ min: -5, max: 35 }),
          }),
          { maxLength: 20 },
        ),
      })
      .map(({ tenants, uses }) => ({
        tenants: tenants.map((t) => ({ companyId, ...t })),
        uses: uses.map((u) => ({
          companyId,
          tenantId: u.tenantId,
          day: dayAfter('2026-11-01', u.offset),
        })),
      }));

  it('never goes above 100%, and the platform equals the sum of its companies', () => {
    fc.assert(
      fc.property(companyTenants('c1'), companyTenants('c2'), (...companies) => {
        const parts = companies.map((c) => whatsappAdoption({ month: '2026-11', ...c }));
        for (const part of parts)
          expect(part.adopted).toBeLessThanOrEqual(part.tenantsWithActiveLease);
        const all = whatsappAdoption({
          month: '2026-11',
          tenants: companies.flatMap((c) => c.tenants),
          uses: companies.flatMap((c) => c.uses),
        });
        expect(combineWhatsappAdoption(parts)).toEqual(all);
        expect(all.share.bps ?? 0).toBeLessThanOrEqual(10_000);
      }),
    );
  });
});

describe('DA-05 Gate 1 time to receipt delivered (M11 decision 4)', () => {
  it('counts receipts delivered within a minute, a receipt never delivered as late', () => {
    expect(
      timeToReceiptDelivered([
        { latencyMs: 4_000 },
        { latencyMs: 60_000 },
        { latencyMs: 61_000 },
        { latencyMs: null },
      ]),
    ).toEqual({
      receipts: 4,
      delivered: 3,
      withinTarget: 2,
      share: { numerator: 2, denominator: 4, bps: 5_000 },
      medianMs: 60_000,
      p95Ms: 61_000,
    });
  });

  it('counts as time to sent does, over the delivery latencies', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: null }), { maxLength: 40 }),
        (latencies) => {
          const receipts = latencies.map((latencyMs) => ({ latencyMs }));
          const { sent, ...sentFigures } = timeToReceipt(receipts);
          const { delivered, ...deliveredFigures } = timeToReceiptDelivered(receipts);
          expect(delivered).toBe(sent);
          expect(deliveredFigures).toEqual(sentFigures);
          expect(deliveredFigures.share.bps ?? 0).toBeLessThanOrEqual(10_000);
        },
      ),
    );
  });

  it('is empty for a month with no receipts', () => {
    expect(timeToReceiptDelivered([])).toMatchObject({
      receipts: 0,
      delivered: 0,
      share: { bps: null },
      medianMs: null,
    });
  });
});

describe('DA-05 Gate 1 net revenue retention (M11 decision 4)', () => {
  const invoice = (companyId: string, month: string, amountMinor: number): SubscriptionRevenue => ({
    companyId,
    month,
    amountMinor,
  });

  it('waits for 12 months of invoices', () => {
    expect(netRevenueRetention({ month: '2027-06', invoices: [] })).toEqual({
      available: false,
      monthsOfHistory: 0,
      share: null,
    });
    const invoices = [invoice('c1', '2026-12', 50_000), invoice('c1', '2027-11', 50_000)];
    expect(netRevenueRetention({ month: '2027-11', invoices })).toEqual({
      available: false,
      monthsOfHistory: 11,
      share: null,
    });
    expect(netRevenueRetention({ month: '2027-12', invoices })).toMatchObject({
      available: true,
      monthsOfHistory: 12,
    });
  });

  it('compares this month’s revenue from last year’s paying companies with their revenue then', () => {
    const result = netRevenueRetention({
      month: '2027-12',
      invoices: [
        // Grew from 500 to 800 (two invoices this month).
        invoice('c1', '2026-12', 50_000),
        invoice('c1', '2027-12', 60_000),
        invoice('c1', '2027-12', 20_000),
        // Left: counts nothing now.
        invoice('c2', '2026-12', 30_000),
        // Joined since: left out.
        invoice('c3', '2027-03', 40_000),
        invoice('c3', '2027-12', 40_000),
        // Paid nothing a year ago (a free month): left out.
        invoice('c4', '2026-12', 0),
        invoice('c4', '2027-12', 25_000),
        // Months after this one are ignored.
        invoice('c1', '2028-01', 99_000),
      ],
    });
    expect(result).toEqual({
      available: true,
      monthsOfHistory: 12,
      share: { numerator: 80_000, denominator: 80_000, bps: 10_000 },
    });
  });

  it('can pass 100% with growth, and refuses an amount below zero', () => {
    const result = netRevenueRetention({
      month: '2028-01',
      invoices: [invoice('c1', '2027-01', 40_000), invoice('c1', '2028-01', 50_000)],
    });
    expect(result.share?.bps).toBe(12_500);
    expect(() =>
      netRevenueRetention({ month: '2028-01', invoices: [invoice('c1', '2027-01', -1)] }),
    ).toThrow(/zero or more/);
  });

  it('gives the platform the sum of what each company retained', () => {
    const months = ['2026-11', '2026-12', '2027-06', '2027-12', '2028-01'];
    const companyInvoices = (companyId: string) =>
      fc
        .array(
          fc.record({
            month: fc.constantFrom(...months),
            amountMinor: fc.integer({ min: 0, max: 500_000 }),
          }),
          { maxLength: 8 },
        )
        .map((rows) => rows.map((r) => invoice(companyId, r.month, r.amountMinor)));
    fc.assert(
      fc.property(
        companyInvoices('c1'),
        companyInvoices('c2'),
        companyInvoices('c3'),
        (c1, c2, c3) => {
          // c1 has a year of history, so the platform's figure is always available.
          const companies = [[invoice('c1', '2026-12', 1), ...c1], c2, c3];
          const total = netRevenueRetention({ month: '2027-12', invoices: companies.flat() });
          expect(total.available).toBe(true);
          const parts = companies.map((invoices) =>
            netRevenueRetention({ month: '2027-12', invoices }),
          );
          expect(total.share!.numerator).toBe(
            parts.reduce((s, p) => s + (p.share?.numerator ?? 0), 0),
          );
          expect(total.share!.denominator).toBe(
            parts.reduce((s, p) => s + (p.share?.denominator ?? 0), 0),
          );
        },
      ),
    );
  });
});
