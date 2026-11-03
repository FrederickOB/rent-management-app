import { describe, expect, it } from 'vitest';
import { forwardWalk, walkLines } from '../billing/walk';
import { money, toDecimal } from '../money/money';
import { receiptTaxBase, taxPeriodsFromWalk } from './rent-tax';
import {
  checkChosenSettlement,
  rentTaxAlertsReached,
  settleOldestFirst,
  taxItemOutstanding,
  taxItemStatus,
  toCsv,
} from './report';

describe('TX-01 the rent tax base', () => {
  it('never taxes VAT and levies: the walk’s tax lines are left out of the periods', () => {
    const rent = {
      id: 'rent-1',
      kind: 'rent' as const,
      baseLineId: null,
      rateBps: null,
      dueDate: '2026-11-01',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      amountMinor: 1_000_000,
      accrued: false,
      sequence: 1,
    };
    const vat = {
      ...rent,
      id: 'vat-1',
      kind: 'vat' as const,
      baseLineId: 'rent-1',
      rateBps: 1500,
      periodStart: null,
      periodEnd: null,
      amountMinor: 150_000,
      sequence: 2,
    };
    const walk = forwardWalk(walkLines({ lines: [rent, vat], allocations: [], scheduled: [] }), [
      { paymentId: 'p1', order: '1', amountMinor: 1_150_000 },
    ]);
    expect(walk.lines.map((l) => l.key)).toEqual(['rent-1', 'vat-1']);
    const periods = taxPeriodsFromWalk({
      walk,
      periodKeyOf: (k) => (k === 'rent-1' ? 'cp-1' : k),
      taxed: new Map(),
      withheld: new Set(),
    });
    expect(periods.map((p) => [p.key, p.coveredMinor])).toEqual([['cp-1', 1_000_000]]);
    expect(receiptTaxBase(periods, { includesServiceCharge: true }).baseMinor).toBe(1_000_000);
  });
});

describe('TX-02 alerts', () => {
  it('reaches each alert day once, in order, from the day the rent was received', () => {
    expect(rentTaxAlertsReached('2026-10-25', [28, 21], '2026-11-14')).toEqual([]);
    expect(rentTaxAlertsReached('2026-10-25', [28, 21], '2026-11-15')).toEqual([21]);
    expect(rentTaxAlertsReached('2026-10-25', [28, 21, 21], '2026-11-30')).toEqual([21, 28]);
  });
});

describe('TX-03 rent tax items and GRA payments', () => {
  it('derives an item’s status from GRA payments, corrections and withholding', () => {
    const base = { kind: 'receipt' as const, taxMinor: 1_000, correctedMinor: 0, paidMinor: 0 };
    expect(taxItemStatus(base)).toBe('open');
    expect(taxItemStatus({ ...base, paidMinor: 400 })).toBe('part_paid');
    expect(taxItemStatus({ ...base, paidMinor: 1_000 })).toBe('paid');
    expect(taxItemStatus({ ...base, correctedMinor: -1_000 })).toBe('reversed');
    expect(taxItemStatus({ ...base, correctedMinor: -400, paidMinor: 600 })).toBe('paid');
    expect(taxItemStatus({ ...base, kind: 'withholding' })).toBe('withheld');
    expect(taxItemStatus({ ...base, kind: 'withholding', withholdingWrittenOff: true })).toBe(
      'open',
    );
    expect(taxItemStatus({ ...base, kind: 'reversal', taxMinor: -1_000 })).toBe('correction');
    expect(taxItemOutstanding({ ...base, correctedMinor: -400, paidMinor: 100 })).toBe(500);
    expect(taxItemOutstanding({ ...base, kind: 'withholding' })).toBe(0);
    expect(taxItemOutstanding({ ...base, kind: 'withholding', withholdingWrittenOff: true })).toBe(
      1_000,
    );
  });

  it('settles a GRA payment oldest due first, and checks amounts chosen per item', () => {
    const items = [
      { id: 'b', dueDate: '2026-12-01', outstandingMinor: 500 },
      { id: 'a', dueDate: '2026-11-24', outstandingMinor: 300 },
    ];
    expect(settleOldestFirst(items, 600)).toEqual([
      { itemId: 'a', amountMinor: 300 },
      { itemId: 'b', amountMinor: 300 },
    ]);
    expect(() => settleOldestFirst(items, 801)).toThrow(/more than the rent tax still owed/);
    const owed = new Map([
      ['a', 300],
      ['b', 500],
    ]);
    expect(checkChosenSettlement(owed, [{ itemId: 'b', amountMinor: 200 }])).toBe(200);
    expect(() => checkChosenSettlement(owed, [{ itemId: 'a', amountMinor: 301 }])).toThrow(
      /no more than the item still owes/,
    );
    expect(() => checkChosenSettlement(owed, [{ itemId: 'c', amountMinor: 1 }])).toThrow(
      /not open/,
    );
  });

  it('writes RFC 4180 CSV: every field quoted, quotes doubled, CRLF, the same bytes every time', () => {
    const rows = [
      ['Unit', 'Tenant', 'Tax (GHS)'],
      ['ACC-LEG-B1-01', 'Ama "Akos" Mensah, Ltd', toDecimal(money(9_600))],
      ['ACC-LEG-B1-02', null, toDecimal(money(-7))],
    ];
    const csv = toCsv(rows);
    expect(csv).toBe(
      '"Unit","Tenant","Tax (GHS)"\r\n' +
        '"ACC-LEG-B1-01","Ama ""Akos"" Mensah, Ltd","96.00"\r\n' +
        '"ACC-LEG-B1-02","","-0.07"\r\n',
    );
    expect(toCsv(rows)).toBe(csv);
  });
});
