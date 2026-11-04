import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { balanceOf } from '../ledger/journal';
import { checkLeaseTerms, rentSchedule } from '../tenancy';
import { creditPools, isRecurring, lineBalance, paymentShares } from './lines';
import {
  leaseArbitrary,
  operationArbitrary,
  ScenarioRunner,
  type Operation,
  type ScenarioLease,
} from './testing/scenarios';
import type { LeaseLedgerModel } from './testing/lease-ledger';

/**
 * M5 review items 2 and 5 (★): withholding on any rent or service-charge month, started or not,
 * and before or after the tenant's money arrived. The reference model now posts P19, its draws at
 * accrual and P13 with the same planning and posting functions as the billing engine
 * (`planWithholding`, `withholdingLines`, `withholdingDrawsFor`, `applyCreditToOpenLines`,
 * `refundCredits`), so these tests prove the rules the engine runs.
 */
const runs = { numRuns: 150 };
const held = (journalBalance: number): number => 0 - journalBalance;
let sequence = 0;

type ReviewOperation =
  | Operation
  | { readonly kind: 'withhold'; readonly pick: number; readonly percent: number }
  | { readonly kind: 'settle'; readonly refundPercent: number };

const reviewOperations = (withCorrections: boolean) =>
  fc.array(
    fc.oneof(
      { arbitrary: operationArbitrary(withCorrections), weight: 7 },
      {
        arbitrary: fc.record({
          kind: fc.constant('withhold' as const),
          pick: fc.nat(),
          percent: fc.integer({ min: 1, max: 100 }),
        }),
        weight: 3,
      },
      {
        arbitrary: fc.record({
          kind: fc.constant('settle' as const),
          refundPercent: fc.integer({ min: 0, max: 100 }),
        }),
        weight: 1,
      },
    ),
    { minLength: 5, maxLength: 40, size: 'max' },
  );

/** What a withholding may take on a line: what is still owed plus the payments' cash on it. */
function withholdable(m: LeaseLedgerModel, lineId: string): number {
  const line = m.lines.find((l) => l.id === lineId)!;
  let cash = 0;
  for (const share of paymentShares(line.id, m.allocations).values()) cash += share;
  return lineBalance(line, m.allocations).outstandingMinor + cash;
}

/** Withholding on any recurring line, started or not, paid or not; returns whether it ran. */
function withhold(m: LeaseLedgerModel, pick: number, percent: number): boolean {
  const lines = m.lines.filter(
    (l) => isRecurring(l.kind) && l.baseLineId === null && withholdable(m, l.id) > 0,
  );
  const line = lines[pick % Math.max(lines.length, 1)];
  if (!line) return false;
  const amount = Math.floor((withholdable(m, line.id) * percent) / 100);
  if (amount <= 0) return false;
  m.withhold([{ lineId: line.id, amountMinor: amount }], `withholding-${(sequence += 1)}`);
  return true;
}

function apply(run: ScenarioRunner, op: ReviewOperation): 'correction' | 'other' {
  const m = run.model;
  if (op.kind === 'withhold') {
    withhold(m, op.pick, op.percent);
    return 'other';
  }
  if (op.kind === 'settle') {
    // AR-04's settlement as the engine runs it: credit pays open charged lines, then part of
    // what is left is refunded. Refunded payments are never reversed afterwards (RA055).
    m.applyCreditToOpen(`settle-${(sequence += 1)}`);
    const left = creditPools(
      m.payments.filter((p) => !p.reversed),
      m.allocations,
    ).reduce((sum, p) => sum + p.amountMinor, 0);
    const refund = Math.floor((left * op.refundPercent) / 100);
    if (refund > 0) {
      m.refund(`settle-${sequence}`, refund);
      refunded.add(m);
    }
    return 'other';
  }
  if (op.kind === 'reverse' && refunded.has(m)) return 'other';
  const count = run.correctionCount;
  try {
    run.apply(op);
  } catch (error) {
    // A credit note cannot take back withheld tax (decision 9): the domain refuses it.
    if (error instanceof DomainError && error.code === 'billing.credit_exceeds_payments')
      return 'other';
    throw error;
  }
  return run.correctionCount === count ? 'other' : 'correction';
}
const refunded = new WeakSet<LeaseLedgerModel>();

const compareNullable = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

describe('TX-04 withholding on any month, before or after the money arrived (M5 review 2 and 5, ★)', () => {
  it('keeps every sub-ledger whole, and prepayments equal unearned rent and credit (AR-01)', () => {
    fc.assert(
      fc.property(leaseArbitrary, reviewOperations(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) {
          apply(run, op);
          // A refund lowers a payment's credit while its cash stays where it is, so invariant 7
          // (cash side equals the payment) no longer holds for it; as in the M5 invariants.
          if (!refunded.has(run.model)) run.model.checkInvariants();
          const walk = run.model.walk();
          expect(
            walk.unearnedRentMinor + walk.unearnedServiceChargeMinor + walk.creditLeftMinor,
          ).toBe(held(balanceOf(run.model.journal(), { accountCode: '2010' })));
        }
      }),
      runs,
    );
  });

  it('never moves paid-until backwards when tax is withheld, whatever the tenant paid first (AR-02)', () => {
    fc.assert(
      fc.property(leaseArbitrary, reviewOperations(false), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        let before = run.model.walk().paidUntil;
        for (const op of ops) {
          const kind = apply(run, op);
          const after = run.model.walk().paidUntil;
          if (kind === 'other' && op.kind !== 'settle')
            expect(compareNullable(after, before), JSON.stringify(op)).toBeGreaterThanOrEqual(0);
          before = after;
        }
      }),
      runs,
    );
  });

  it('holds in 1150 exactly what was withheld, and P19 moves only 1150, 1100 and 2010', () => {
    fc.assert(
      fc.property(leaseArbitrary, reviewOperations(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) apply(run, op);
        const m = run.model;
        const withheld = m.allocations
          .filter((a) => a.source === 'withholding')
          .reduce((sum, a) => sum + a.amountMinor, 0);
        expect(balanceOf(m.journal(), { accountCode: '1150' })).toBe(withheld);
        for (const entry of m.entries.filter((e) => e.rule === 'P19'))
          for (const line of entry.lines)
            expect(['1150', '1100', '2010']).toContain(line.accountCode);
        // Cash returned to credit never leaves a payment over-allocated or a line over-paid.
        for (const line of m.lines) expect(() => lineBalance(line, m.allocations)).not.toThrow();
      }),
      runs,
    );
  });
});

/** The reviewer's lease: annual, commercial, GH₵10,000 a month, starting in ten days. */
function annualLease(): ScenarioLease {
  const start = '2026-11-13';
  const end = toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1));
  const terms = checkLeaseTerms({
    startDate: start,
    endDate: end,
    monthlyRentMinor: 1_000_000,
    cycle: 'annual',
    noticeDays: 30,
    use: 'commercial',
  });
  return {
    terms,
    schedule: rentSchedule(terms).map((p) => ({
      id: `cp-${p.chargeType}-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'schedule' as const,
    })),
    vat: null,
  };
}

describe('TX-04 an annual advance paid net before the withholding is recorded (M5 review 2)', () => {
  it('covers all twelve months with GH₵102,000 cash and GH₵18,000 withheld, and draws it month by month', () => {
    const run = new ScenarioRunner(annualLease());
    const m = run.model;
    // Ten days before the start: the annual invoice is issued, nothing has started.
    for (let i = 0; i < 10; i += 1) run.apply({ kind: 'days', days: 1 });
    m.pay(10_200_000);
    const rent = m.lines.filter((l) => l.kind === 'rent');
    expect(rent).toHaveLength(12);
    m.withhold(
      rent.map((l) => ({ lineId: l.id, amountMinor: 150_000 })),
      'withholding-annual',
    );
    m.checkInvariants();
    expect(m.walk().paidUntil).toBe(run.lease.terms.endDate);
    for (const line of rent) {
      const shares = [...paymentShares(line.id, m.allocations).values()].reduce((s, a) => s + a, 0);
      // Each month: what the walk applies forward from credit, its cash, and its withholding.
      expect(shares).toBeLessThanOrEqual(850_000);
    }
    expect(balanceOf(m.journal(), { accountCode: '1150' })).toBe(1_800_000);
    // The whole year runs: every month accrues in full, nothing is ever owed.
    run.apply({ kind: 'days', days: 380 });
    m.checkInvariants();
    for (const { id } of rent) {
      const line = m.lines.find((l) => l.id === id)!;
      expect(lineBalance(line, m.allocations).outstandingMinor).toBe(0);
      expect(line.accrued).toBe(true);
    }
    expect(balanceOf(m.journal(), { accountCode: '2010' })).toBe(0);
    expect(balanceOf(m.journal(), { accountCode: '4000' })).toBe(-12_000_000);
  });
});
