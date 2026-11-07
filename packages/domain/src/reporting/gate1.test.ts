import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  autoMatchRate,
  collectionRate,
  digitalPaymentShare,
  noticeAcknowledgement,
  repairResponse,
  timeToReceipt,
  type CollectionLine,
  type NoticeForMetric,
  type RepairJobForMetric,
} from './gate1';
import { inReportMonth, medianOf, percentileOf, ratioOf, reportMonth } from './measures';

const rent = (
  lineId: string,
  dueDate: string,
  amountMinor: number,
  allocations: CollectionLine['allocations'] = [],
  kind: CollectionLine['kind'] = 'rent',
): CollectionLine => ({ lineId, kind, dueDate, amountMinor, allocations });

const paid = (
  amountMinor: number,
  valueDate: string,
  source: 'payment' | 'deposit' | 'withholding' = 'payment',
) => ({ source, amountMinor, valueDate }) as const;

describe('Gate 1 shares and percentiles', () => {
  it('gives shares in basis points, half up once, and none for nothing measured', () => {
    expect(ratioOf(1, 3)).toEqual({ numerator: 1, denominator: 3, bps: 3_333 });
    expect(ratioOf(2, 3).bps).toBe(6_667);
    expect(ratioOf(1, 8).bps).toBe(1_250);
    expect(ratioOf(1, 20_000).bps).toBe(1); // 0.5 bps rounds up
    expect(ratioOf(5, 5).bps).toBe(10_000);
    expect(ratioOf(0, 0)).toEqual({ numerator: 0, denominator: 0, bps: null });
    expect(() => ratioOf(-1, 3)).toThrow(/zero or more/);
  });

  it('takes percentiles by nearest rank, always one of the values', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([7])).toBe(7);
    expect(medianOf([4, 1, 3, 2])).toBe(2);
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(
      percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95),
    ).toBe(19);
    expect(percentileOf([10, 20], 95)).toBe(20);
    expect(percentileOf([3, 1, 2], 100)).toBe(3);
    expect(() => percentileOf([1], 0)).toThrow(/1 to 100/);
  });

  it('knows a month’s first and last day, leap years included', () => {
    expect(reportMonth('2026-11')).toEqual({
      month: '2026-11',
      firstDay: '2026-11-01',
      lastDay: '2026-11-30',
    });
    expect(reportMonth('2028-02').lastDay).toBe('2028-02-29');
    expect(inReportMonth('2026-11-30', reportMonth('2026-11'))).toBe(true);
    expect(inReportMonth('2026-12-01', reportMonth('2026-11'))).toBe(false);
    expect(() => reportMonth('2026-11-01')).toThrow(/Not a month/);
  });
});

describe('Gate 1 collection rate (M9 decision 9)', () => {
  it('counts rent and service charge falling due in the month, settled by its end', () => {
    const result = collectionRate({
      month: '2026-11',
      lines: [
        rent('nov-rent', '2026-11-01', 150_000, [paid(150_000, '2026-11-03')]),
        rent('nov-sc', '2026-11-01', 20_000, [paid(5_000, '2026-11-20')], 'service_charge'),
        rent('nov-b', '2026-11-15', 100_000),
        // Not due in the month, or not rent: left out.
        rent('oct-rent', '2026-10-01', 150_000, [paid(150_000, '2026-11-02')]),
        rent('dec-rent', '2026-12-01', 150_000, [paid(150_000, '2026-11-25')]),
        rent('deposit', '2026-11-01', 300_000, [paid(300_000, '2026-11-01')], 'deposit'),
        rent('vat', '2026-11-01', 22_500, [paid(22_500, '2026-11-01')], 'vat'),
        rent('charge', '2026-11-01', 10_000, [paid(10_000, '2026-11-01')], 'one_off'),
      ],
    });
    expect(result).toEqual({
      month: '2026-11',
      lines: 3,
      dueMinor: 270_000,
      collectedMinor: 155_000,
      rate: { numerator: 155_000, denominator: 270_000, bps: 5_741 },
    });
  });

  it('counts money paid in advance and tax withheld, never money after the month’s end', () => {
    const result = collectionRate({
      month: '2026-11',
      lines: [
        rent('advance', '2026-11-01', 150_000, [paid(150_000, '2025-11-01')]),
        rent('withheld', '2026-11-05', 1_000_000, [
          paid(850_000, '2026-11-05'),
          paid(150_000, '2026-11-05', 'withholding'),
        ]),
        rent('deposit-applied', '2026-11-01', 50_000, [paid(50_000, '2026-11-30', 'deposit')]),
        rent('late', '2026-11-01', 150_000, [paid(150_000, '2026-12-01')]),
      ],
    });
    expect(result.dueMinor).toBe(1_350_000);
    expect(result.collectedMinor).toBe(1_200_000);
  });

  it('reduces what is due by credit notes, takes back reversals, and never counts a write-off', () => {
    const result = collectionRate({
      month: '2026-11',
      lines: [
        rent('credited', '2026-11-01', 150_000, [
          { source: 'credit_note', amountMinor: 50_000, valueDate: '2026-11-10' },
          paid(100_000, '2026-11-11'),
        ]),
        rent('bounced', '2026-11-01', 150_000, [
          paid(150_000, '2026-11-02'),
          paid(-150_000, '2026-11-09'),
        ]),
        rent('written-off', '2026-11-01', 150_000, [
          { source: 'write_off', amountMinor: 150_000, valueDate: '2026-11-28' },
        ]),
        rent('credited-later', '2026-11-01', 150_000, [
          { source: 'credit_note', amountMinor: 150_000, valueDate: '2026-12-02' },
        ]),
      ],
    });
    expect(result.dueMinor).toBe(100_000 + 150_000 + 150_000 + 150_000);
    expect(result.collectedMinor).toBe(100_000);
  });

  it('is empty, not 0% or 100%, for a month with nothing due', () => {
    expect(collectionRate({ month: '2026-11', lines: [] }).rate).toEqual({
      numerator: 0,
      denominator: 0,
      bps: null,
    });
    expect(
      collectionRate({
        month: '2026-11',
        lines: [
          rent('void', '2026-11-01', 150_000, [
            { source: 'credit_note', amountMinor: 150_000, valueDate: '2026-11-01' },
          ]),
        ],
      }).rate.bps,
    ).toBeNull();
  });

  it('can never exceed 100%, however much is paid', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 0, max: 10_000_000 }),
            day: fc.integer({ min: 1, max: 30 }),
            allocations: fc.array(
              fc.record({
                source: fc.constantFrom(
                  'payment',
                  'deposit',
                  'withholding',
                  'credit_note',
                  'write_off',
                ),
                amountMinor: fc.integer({ min: -5_000_000, max: 20_000_000 }),
                day: fc.integer({ min: -400, max: 40 }),
              }),
              { maxLength: 6 },
            ),
          }),
          { maxLength: 12 },
        ),
        (lines) => {
          const dateOf = (offset: number) => {
            const d = new Date(Date.UTC(2026, 10, 1 + offset));
            return d.toISOString().slice(0, 10);
          };
          const result = collectionRate({
            month: '2026-11',
            lines: lines.map((l, i) =>
              rent(
                `line-${i}`,
                dateOf(l.day - 1),
                l.amount,
                l.allocations.map((a) => ({
                  source: a.source,
                  amountMinor: a.amountMinor,
                  valueDate: dateOf(a.day),
                })),
              ),
            ),
          });
          expect(result.collectedMinor <= result.dueMinor).toBe(true);
          expect(result.collectedMinor >= 0).toBe(true);
          if (result.rate.bps !== null) expect(result.rate.bps <= 10_000).toBe(true);
          else expect(result.dueMinor).toBe(0);
        },
      ),
    );
  });
});

describe('Gate 1 digital payment share (M9 decision 10)', () => {
  it('counts MoMo, card and bank against cash and cheques, by amount', () => {
    const share = digitalPaymentShare([
      { method: 'momo', amountMinor: 150_000 },
      { method: 'momo', amountMinor: 50_000 },
      { method: 'card', amountMinor: 100_000 },
      { method: 'bank_transfer', amountMinor: 300_000 },
      { method: 'cash', amountMinor: 300_000 },
      { method: 'cheque', amountMinor: 100_000 },
    ]);
    expect(share.byMethod).toEqual({
      momo: 200_000,
      card: 100_000,
      bank_transfer: 300_000,
      cash: 300_000,
      cheque: 100_000,
      test: 0,
    });
    expect(share.digitalMinor).toBe(600_000);
    expect(share.totalMinor).toBe(1_000_000);
    expect(share.share.bps).toBe(6_000);
  });

  it('is empty for a month with no money, and refuses a negative payment', () => {
    expect(digitalPaymentShare([]).share.bps).toBeNull();
    expect(digitalPaymentShare([{ method: 'cash', amountMinor: 0 }]).share.bps).toBeNull();
    expect(() => digitalPaymentShare([{ method: 'cash', amountMinor: -1 }])).toThrow(
      /zero or more/,
    );
    expect(() => digitalPaymentShare([{ method: 'barter' as 'cash', amountMinor: 1 }])).toThrow(
      /Not a payment method/,
    );
  });
});

describe('Gate 1 auto-match rate (M9 decision 10, prd-issues 35)', () => {
  it('counts provider payments matched with no person, and shows direct transfers apart', () => {
    const rate = autoMatchRate({
      providerPayments: [
        { match: 'automatic' },
        { match: 'automatic' },
        { match: 'automatic' },
        { match: 'by_person' },
        { match: 'unmatched' },
      ],
      directTransfers: [
        { recordedAgainstLease: true },
        { recordedAgainstLease: true },
        { recordedAgainstLease: true },
        { recordedAgainstLease: true },
        { recordedAgainstLease: false },
      ],
    });
    // The M4b seed: 3 of 5 provider payments (60%), 4 of 5 direct transfers (80%).
    expect(rate.provider).toEqual({
      automatic: 3,
      byPerson: 1,
      unmatched: 1,
      rate: { numerator: 3, denominator: 5, bps: 6_000 },
    });
    expect(rate.directTransfers).toEqual({
      againstLease: 4,
      unmatched: 1,
      rate: { numerator: 4, denominator: 5, bps: 8_000 },
    });
  });

  it('is empty when there were no payments of a kind', () => {
    const rate = autoMatchRate({ providerPayments: [], directTransfers: [] });
    expect(rate.provider.rate.bps).toBeNull();
    expect(rate.directTransfers.rate.bps).toBeNull();
  });
});

describe('Gate 1 time to receipt (M9 decision 10)', () => {
  it('counts receipts within a minute, inclusive, with the median and 95th percentile', () => {
    const latencies = [800, 1_200, 2_000, 3_500, 59_999, 60_000, 60_001, 120_000];
    const result = timeToReceipt(latencies.map((latencyMs) => ({ latencyMs })));
    expect(result.receipts).toBe(8);
    expect(result.sent).toBe(8);
    expect(result.withinTarget).toBe(6);
    expect(result.share.bps).toBe(7_500);
    expect(result.medianMs).toBe(3_500);
    expect(result.p95Ms).toBe(120_000);
  });

  it('counts a receipt never sent as late, and leaves it out of the times', () => {
    const result = timeToReceipt([{ latencyMs: 1_000 }, { latencyMs: null }]);
    expect(result.share).toEqual({ numerator: 1, denominator: 2, bps: 5_000 });
    expect(result.medianMs).toBe(1_000);
    const unsent = timeToReceipt([{ latencyMs: null }]);
    expect(unsent.share.bps).toBe(0);
    expect(unsent.medianMs).toBeNull();
    expect(unsent.p95Ms).toBeNull();
  });

  it('is empty for a month with no receipts', () => {
    expect(timeToReceipt([])).toEqual({
      receipts: 0,
      sent: 0,
      withinTarget: 0,
      share: { numerator: 0, denominator: 0, bps: null },
      medianMs: null,
      p95Ms: null,
    });
    expect(() => timeToReceipt([{ latencyMs: -1 }])).toThrow(/zero or more/);
  });
});

describe('Gate 1 notice acknowledgement (M9 decision 10)', () => {
  const issuedAt = '2026-11-02T09:00:00Z';
  const asOf = '2026-12-01T04:00:00Z';
  const notice = (
    type: NoticeForMetric['type'],
    signed: (string | null)[],
    at = issuedAt,
  ): NoticeForMetric => ({
    type,
    issuedAt: at,
    recipients: signed.map((signedAt) => ({ signedAt })),
  });

  it('counts e-signatures within 7 days of issue, per recipient of a building-wide notice', () => {
    const result = noticeAcknowledgement({
      asOf,
      notices: [
        notice('rent_demand', ['2026-11-03T10:00:00Z']),
        notice('building_wide', [
          '2026-11-02T09:30:00Z',
          '2026-11-09T09:00:00Z', // exactly 7 days: within
          '2026-11-09T09:00:00.001Z', // just after: missed
          null,
        ]),
        notice('tenant_originated', [null, null]),
      ],
    });
    expect(result).toEqual({
      met: 3,
      missed: 2,
      pending: 0,
      rate: { numerator: 3, denominator: 5, bps: 6_000 },
    });
  });

  it('leaves recipients whose 7 days are still running out, signed or not as of the day', () => {
    const late = '2026-11-28T12:00:00Z';
    const result = noticeAcknowledgement({
      asOf,
      notices: [
        notice('entry', [null], late),
        // Signed after the moment measured: not yet signed as of then.
        notice('breach', ['2026-12-02T08:00:00Z'], late),
        notice('entry', ['2026-11-29T08:00:00Z'], late),
      ],
    });
    expect(result).toEqual({
      met: 1,
      missed: 0,
      pending: 2,
      rate: { numerator: 1, denominator: 1, bps: 10_000 },
    });
  });

  it('is empty for a month with no notices to tenants', () => {
    expect(noticeAcknowledgement({ asOf, notices: [] }).rate.bps).toBeNull();
    expect(
      noticeAcknowledgement({ asOf, notices: [notice('tenant_originated', [null])] }).rate.bps,
    ).toBeNull();
  });
});

describe('Gate 1 repair response (M9 decision 10, M8 data)', () => {
  const job = (
    priority: RepairJobForMetric['priority'],
    attendedAt: string | null,
    clockStartedAt = '2026-11-10T08:00:00Z',
  ): RepairJobForMetric => ({ priority, clockStartedAt, attendedAt, targetMinutes: 120 });
  const asOf = '2026-11-30T23:00:00Z';

  it('counts emergency jobs attended within their target', () => {
    const result = repairResponse({
      asOf,
      jobs: [
        job('emergency', '2026-11-10T09:00:00Z'),
        job('emergency', '2026-11-10T10:00:00Z'), // exactly 2 hours: within
        job('emergency', '2026-11-10T10:01:00Z'),
        job('emergency', null),
        job('urgent', null),
        job('routine', '2026-11-20T08:00:00Z'),
      ],
    });
    expect(result).toEqual({
      met: 2,
      missed: 2,
      pending: 0,
      rate: { numerator: 2, denominator: 4, bps: 5_000 },
    });
  });

  it('leaves a job still inside its target out of the share', () => {
    const result = repairResponse({
      asOf,
      jobs: [job('emergency', null, '2026-11-30T22:00:00Z')],
    });
    expect(result).toEqual({
      met: 0,
      missed: 0,
      pending: 1,
      rate: { numerator: 0, denominator: 0, bps: null },
    });
  });

  it('is empty for a month with no emergencies', () => {
    expect(repairResponse({ asOf, jobs: [] }).rate.bps).toBeNull();
    expect(() =>
      repairResponse({ asOf, jobs: [{ ...job('emergency', null), targetMinutes: -1 }] }),
    ).toThrow(/whole number of minutes/);
  });
});
