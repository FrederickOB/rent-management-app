import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planAccrual, planAllocation, drawFromPools } from './allocation';
import {
  inAllocationOrder,
  invoiceStatusOf,
  lineBalance,
  type AllocationRow,
  type BillingLine,
  type LineKind,
} from './lines';

const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };

let seq = 0;
const line = (over: Partial<BillingLine> & Pick<BillingLine, 'kind'>): BillingLine => {
  seq += 1;
  return {
    id: `line-${seq}`,
    baseLineId: null,
    rateBps: null,
    dueDate: '2026-11-01',
    periodStart: over.kind === 'rent' || over.kind === 'service_charge' ? '2026-11-01' : null,
    periodEnd: over.kind === 'rent' || over.kind === 'service_charge' ? '2026-11-30' : null,
    amountMinor: 100_000,
    accrued: false,
    sequence: seq,
    ...over,
  };
};

describe('BC-07 allocation order', () => {
  it('pays the deposit, then rent, service charge and one-off charges of the oldest due date', () => {
    const lines = [
      line({ kind: 'one_off', amountMinor: 5_000 }),
      line({ kind: 'service_charge', amountMinor: 20_000 }),
      line({ kind: 'rent', amountMinor: 150_000 }),
      line({ kind: 'deposit', amountMinor: 300_000 }),
      line({ kind: 'rent', dueDate: '2026-10-01', periodStart: '2026-10-01', accrued: true }),
    ];
    expect(inAllocationOrder(lines).map((l) => l.kind)).toEqual([
      'rent',
      'deposit',
      'rent',
      'service_charge',
      'one_off',
    ]);
  });

  it('puts VAT, NHIL and GETFund straight after the line they are charged on', () => {
    const rent = line({ kind: 'rent' });
    const service = line({ kind: 'service_charge' });
    const tax = (kind: LineKind, base: BillingLine) =>
      line({ kind, baseLineId: base.id, rateBps: 1500, periodStart: null, periodEnd: null });
    const lines = [tax('getfund', service), tax('vat', rent), service, tax('nhil', rent), rent];
    expect(
      inAllocationOrder(lines).map(
        (l) => `${l.kind}:${l.baseLineId === null ? '' : l.baseLineId === rent.id ? 'rent' : 'sc'}`,
      ),
    ).toEqual(['rent:', 'vat:rent', 'nhil:rent', 'service_charge:', 'getfund:sc']);
  });

  it('within a type and due date, earlier periods first', () => {
    const later = line({ kind: 'rent', periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    const earlier = line({ kind: 'rent' });
    expect(inAllocationOrder([later, earlier]).map((l) => l.id)).toEqual([earlier.id, later.id]);
  });

  it('never pays a later line while an earlier one is still open, and never overpays', () => {
    const kinds: LineKind[] = ['deposit', 'rent', 'service_charge', 'one_off'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...kinds),
            due: fc.integer({ min: 0, max: 5 }),
            amount: fc.integer({ min: 1, max: 500_000 }),
            paid: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer({ min: 1, max: 3_000_000 }),
        (specs, payment) => {
          const allocations: AllocationRow[] = [];
          const lines = specs.map((s) => {
            const l = line({
              kind: s.kind,
              dueDate: `2026-0${s.due + 1}-01`,
              periodStart:
                s.kind === 'rent' || s.kind === 'service_charge' ? `2026-0${s.due + 1}-01` : null,
              amountMinor: s.amount,
              accrued: s.kind === 'rent' || s.kind === 'service_charge',
            });
            const already = Math.floor((s.amount * s.paid) / 100);
            if (already > 0)
              allocations.push({
                lineId: l.id,
                source: 'payment',
                paymentId: 'old',
                amountMinor: already,
              });
            return l;
          });
          const plan = planAllocation({
            lines,
            allocations,
            paymentId: 'new',
            amountMinor: payment,
            lease,
            valueDate: '2026-12-31',
          });
          const after = [
            ...allocations,
            ...plan.allocations.map((a) => ({ ...a, source: 'payment' as const })),
          ];
          const ordered = inAllocationOrder(lines);
          let seenOpen = false;
          for (const l of ordered) {
            const got = plan.allocations.find((a) => a.lineId === l.id)?.amountMinor ?? 0;
            if (seenOpen) expect(got).toBe(0);
            expect(lineBalance(l, after).outstandingMinor).toBeGreaterThanOrEqual(0);
            if (lineBalance(l, after).outstandingMinor > 0) seenOpen = true;
          }
          const allocated = plan.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
          expect(allocated + plan.surplusMinor).toBe(payment);
          if (plan.surplusMinor > 0)
            for (const l of lines) expect(lineBalance(l, after).outstandingMinor).toBe(0);
        },
      ),
    );
  });
});

describe('BC-07 part payments and overpayments', () => {
  const rent = line({ kind: 'rent', amountMinor: 150_000, accrued: true });

  it('leaves a part-paid line partly owed', () => {
    const plan = planAllocation({
      lines: [rent],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 100_000,
      lease,
      valueDate: '2026-11-05',
    });
    expect(plan.allocations).toEqual([{ lineId: rent.id, paymentId: 'p1', amountMinor: 100_000 }]);
    expect(plan.postings[0]?.postingClass).toBe('receivable');
    expect(plan.surplusMinor).toBe(0);
  });

  it('holds an overpayment as the payment’s credit', () => {
    const plan = planAllocation({
      lines: [rent],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 200_000,
      lease,
      valueDate: '2026-11-05',
    });
    expect(plan.surplusMinor).toBe(50_000);
  });

  it('prepays a line whose period has not started, and refuses one waiting for accrual', () => {
    const future = line({ kind: 'rent', periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    const plan = planAllocation({
      lines: [future],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 1_000,
      lease,
      valueDate: '2026-11-05',
    });
    expect(plan.postings[0]?.postingClass).toBe('prepayment');
    expect(() =>
      planAllocation({
        lines: [future],
        allocations: [],
        paymentId: 'p1',
        amountMinor: 1_000,
        lease,
        valueDate: '2026-12-01',
      }),
    ).toThrow(/accrued first/);
  });

  it('sends money on a deposit line to deposits held', () => {
    const deposit = line({ kind: 'deposit', amountMinor: 300_000 });
    const plan = planAllocation({
      lines: [deposit],
      allocations: [],
      paymentId: 'p1',
      amountMinor: 300_000,
      lease,
      valueDate: '2026-10-20',
    });
    expect(plan.postings[0]?.postingClass).toBe('deposit');
  });
});

describe('AR-01 accrual draws its own advance, then credit first in, first out', () => {
  it('uses the line’s advance allocations, then the oldest payment’s credit', () => {
    const rent = line({ kind: 'rent', amountMinor: 150_000 });
    const allocations: AllocationRow[] = [
      { lineId: rent.id, source: 'payment', paymentId: 'p2', amountMinor: 40_000 },
    ];
    const pools = [
      { paymentId: 'p1', order: '2026-09-01#1', amountMinor: 30_000 },
      { paymentId: 'p3', order: '2026-10-01#3', amountMinor: 500_000 },
    ];
    const plan = planAccrual(rent, allocations, pools);
    expect(plan.amountMinor).toBe(150_000);
    expect(plan.advance).toEqual([{ paymentId: 'p2', amountMinor: 40_000 }]);
    expect(plan.draws).toEqual([
      { paymentId: 'p1', amountMinor: 30_000 },
      { paymentId: 'p3', amountMinor: 80_000 },
    ]);
    expect(plan.owedMinor).toBe(0);
    expect(drawFromPools(pools, plan.draws)).toEqual([
      { paymentId: 'p3', order: '2026-10-01#3', amountMinor: 420_000 },
    ]);
  });

  it('owes what nothing covers, and recognises a credited line at its net amount', () => {
    const rent = line({ kind: 'rent', amountMinor: 150_000 });
    const plan = planAccrual(
      rent,
      [{ lineId: rent.id, source: 'credit_note', paymentId: null, amountMinor: 50_000 }],
      [],
    );
    expect(plan).toMatchObject({ amountMinor: 100_000, owedMinor: 100_000, draws: [] });
  });
});

describe('BC-07 invoice status', () => {
  const b = (netMinor: number, settledMinor: number, writtenOffMinor = 0) => ({
    netMinor,
    settledMinor,
    writtenOffMinor,
    outstandingMinor: netMinor - settledMinor - writtenOffMinor,
  });

  it('is derived from the lines: issued, part paid, paid, written off or voided', () => {
    expect(invoiceStatusOf([b(100, 0), b(50, 0)])).toBe('issued');
    expect(invoiceStatusOf([b(100, 100), b(50, 0)])).toBe('part_paid');
    expect(invoiceStatusOf([b(100, 100), b(50, 50)])).toBe('paid');
    expect(invoiceStatusOf([b(100, 60, 40)])).toBe('written_off');
    expect(invoiceStatusOf([b(0, 0), b(0, 0)])).toBe('voided');
  });
});
