import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { balanceOf, checkEntry } from '../ledger/journal';
import {
  creditApplicationLines,
  refundApprovedLines,
  withholdingLines,
} from '../ledger/tax-posting';
import { creditPools, isRecurring, lineBalance } from './lines';
import { applyCreditToOpenLines } from './termination';
import {
  leaseArbitrary,
  operationArbitrary,
  ScenarioRunner,
  type Operation,
} from './testing/scenarios';
import type { LeaseLedgerModel } from './testing/lease-ledger';

/**
 * M5's extensions of M4a's invariants 5 and 9 (plan section 6, ★): random leases and random
 * sequences of payments, accruals and reversals, now with withholding pinned to charged months
 * (P19) and early terminations settled by applying the credit to open lines and refunding the
 * rest (P13). The reference model has no withholding or termination of its own, so these tests
 * add them to its records exactly as the billing engine writes them.
 */
const runs = { numRuns: 150 };
const held = (journalBalance: number): number => 0 - journalBalance;

type M5Operation =
  | Operation
  | { readonly kind: 'withhold'; readonly pick: number; readonly percent: number }
  | { readonly kind: 'terminate'; readonly daysBack: number; readonly refundPercent: number };

const m5Operation = (withCorrections: boolean): fc.Arbitrary<M5Operation> =>
  fc.oneof(
    { arbitrary: operationArbitrary(withCorrections), weight: 8 },
    {
      arbitrary: fc.record({
        kind: fc.constant('withhold' as const),
        pick: fc.nat(),
        percent: fc.integer({ min: 1, max: 100 }),
      }),
      weight: 2,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant('terminate' as const),
        daysBack: fc.integer({ min: 0, max: 20 }),
        refundPercent: fc.integer({ min: 0, max: 100 }),
      }),
      weight: 1,
    },
  );

const m5Operations = (withCorrections: boolean) =>
  fc.array(m5Operation(withCorrections), { minLength: 5, maxLength: 40, size: 'max' });

let sequence = 1_000_000;
/** Payments part refunded at an early end: never also reversed (the service and RA055 refuse). */
const refunded = new WeakMap<LeaseLedgerModel, Set<string>>();

/** P19 on a charged rent or service-charge line, as `BillingEngine.withhold` writes it. */
function withhold(m: LeaseLedgerModel, pick: number, percent: number): void {
  const open = m.lines.filter(
    (l) => isRecurring(l.kind) && l.accrued && lineBalance(l, m.allocations).outstandingMinor > 0,
  );
  const line = open[pick % Math.max(open.length, 1)];
  if (!line) return;
  const amount = Math.floor((lineBalance(line, m.allocations).outstandingMinor * percent) / 100);
  if (amount <= 0) return;
  const id = `withholding-${(sequence += 1)}`;
  const lines = withholdingLines({
    bookId: m.book,
    lease: m.lease,
    paymentId: null,
    lines: [{ invoiceLineId: line.id, amountMinor: amount }],
  });
  checkEntry(lines, () => 'owner');
  m.entries.push({ rule: 'P19', key: `P19:${id}`, lines, valueDate: m.today });
  m.allocations.push({
    lineId: line.id,
    source: 'withholding',
    paymentId: null,
    amountMinor: amount,
    sequence: (sequence += 1),
  });
}

/**
 * AR-04 after a move-out, as `TerminationService` settles it: the credit pays open lines oldest
 * first (P13 apply), then part of what is left is refunded (P13 approved), reducing the payments'
 * credit as the engine's refund parts do. Returns whether it ran.
 */
function terminate(m: LeaseLedgerModel, daysBack: number, refundPercent: number): boolean {
  if (m.lastDay === null) {
    const day = new Date(`${m.today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - daysBack);
    const last = day.toISOString().slice(0, 10);
    const first = m.lines.find((l) => isRecurring(l.kind))?.periodStart;
    if (!first || last < first) return false;
    m.moveOut(last);
  }
  m.accrueTo(m.today);
  const id = `termination-${(sequence += 1)}`;
  const { applications } = applyCreditToOpenLines(
    m.lines,
    m.allocations,
    creditPools(
      m.payments.filter((p) => !p.reversed),
      m.allocations,
    ),
  );
  if (applications.length > 0) {
    const lines = creditApplicationLines({
      bookId: m.book,
      lease: m.lease,
      applications: applications.map((a) => ({ invoiceLineId: a.lineId, draws: a.draws })),
    });
    checkEntry(lines, () => 'owner');
    m.entries.push({ rule: 'P13', key: `P13:${id}:apply`, lines, valueDate: m.today });
    for (const a of applications)
      for (const d of a.draws)
        m.allocations.push({
          lineId: a.lineId,
          source: 'payment',
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
          sequence: (sequence += 1),
        });
  }
  const pools = creditPools(
    m.payments.filter((p) => !p.reversed),
    m.allocations,
  );
  const left = pools.reduce((s, p) => s + p.amountMinor, 0);
  let refund = Math.floor((left * refundPercent) / 100);
  if (refund <= 0) return true;
  const credits = [];
  for (const pool of pools) {
    if (refund === 0) break;
    const take = Math.min(pool.amountMinor, refund);
    credits.push({ paymentId: pool.paymentId, amountMinor: take });
    refund -= take;
  }
  const lines = refundApprovedLines({ bookId: m.book, lease: m.lease, credits });
  checkEntry(lines, () => 'owner');
  m.entries.push({ rule: 'P13', key: `P13:${id}:refund`, lines, valueDate: m.today });
  // The engine records each payment's share; its credit is then what is left of it.
  for (const c of credits) {
    const index = m.payments.findIndex((p) => p.id === c.paymentId);
    const payment = m.payments[index]!;
    m.payments[index] = { ...payment, amountMinor: payment.amountMinor - c.amountMinor };
    refunded.set(m, (refunded.get(m) ?? new Set()).add(c.paymentId));
  }
  return true;
}

function apply(run: ScenarioRunner, op: M5Operation): 'correction' | 'other' {
  const m = run.model;
  if (op.kind === 'withhold') {
    withhold(m, op.pick, op.percent);
    return 'other';
  }
  if (op.kind === 'terminate') {
    const before = m.lastDay;
    terminate(m, op.daysBack, op.refundPercent);
    return before === null && m.lastDay !== null ? 'correction' : 'other';
  }
  if (op.kind === 'reverse') {
    const live = m.payments.filter((p) => !p.reversed);
    const target = live[op.pick % Math.max(live.length, 1)];
    if (target && refunded.get(m)?.has(target.id)) return 'other';
  }
  const count = run.correctionCount;
  try {
    run.apply(op);
  } catch (error) {
    // A credit note cannot release money a tenant withheld (only payments' money returns to
    // credit), so the domain refuses it before writing anything; staff see the refusal.
    if (error instanceof DomainError && error.code === 'billing.credit_exceeds_payments')
      return 'other';
    throw error;
  }
  return run.correctionCount === count ? 'other' : 'correction';
}

const compareNullable = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

describe('AR-01 recognised plus unearned equals the advance received', () => {
  it('under random payments, accruals, reversals and withholding, with no refunds or credit notes (★ M5)', () => {
    fc.assert(
      fc.property(
        leaseArbitrary,
        fc.array(
          fc.oneof(
            { arbitrary: operationArbitrary(false), weight: 6 },
            {
              arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }),
              weight: 1,
            },
            {
              arbitrary: fc.record({
                kind: fc.constant('withhold' as const),
                pick: fc.nat(),
                percent: fc.integer({ min: 1, max: 100 }),
              }),
              weight: 2,
            },
          ),
          { minLength: 5, maxLength: 40, size: 'max' },
        ),
        (lease, ops) => {
          const run = new ScenarioRunner(lease);
          for (const op of ops) apply(run, op);
          const m = run.model;
          let received = 0;
          let returned = 0;
          let recognised = 0;
          for (const entry of m.entries)
            for (const line of entry.lines) {
              if (line.accountCode !== '2010') continue;
              if (entry.rule === 'P03') received += -line.amountMinor;
              else if (entry.rule === 'P21') returned += line.amountMinor;
              else if (entry.rule === 'P02') recognised += line.amountMinor;
              else throw new Error(`2010 moved by ${entry.rule}`);
            }
          const walk = m.walk();
          const unearned =
            walk.unearnedRentMinor + walk.unearnedServiceChargeMinor + walk.creditLeftMinor;
          expect(unearned).toBe(held(balanceOf(m.journal(), { accountCode: '2010' })));
          expect(recognised + unearned).toBe(received - returned);
          m.checkInvariants();
        },
      ),
      runs,
    );
  });
});

describe('AR-02 paid-until never moves backwards except on a reversal', () => {
  it('nor on withholding or an early termination’s settlement: only reversals, credit notes and the move-out itself (★ M5)', () => {
    fc.assert(
      fc.property(leaseArbitrary, m5Operations(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        let before = run.model.walk().paidUntil;
        for (const op of ops) {
          const kind = apply(run, op);
          const after = run.model.walk().paidUntil;
          if (kind === 'other')
            expect(compareNullable(after, before), JSON.stringify(op)).toBeGreaterThanOrEqual(0);
          before = after;
        }
      }),
      runs,
    );
  });

  it('withholding keeps every sub-ledger whole (invariants 1 to 4 and 7)', () => {
    fc.assert(
      fc.property(leaseArbitrary, m5Operations(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops.filter((o) => o.kind !== 'terminate')) {
          apply(run, op);
          run.model.checkInvariants();
        }
        // Withholding never passes through prepayments or income: it only settles receivables.
        for (const entry of run.model.entries.filter((e) => e.rule === 'P19'))
          for (const line of entry.lines) expect(['1150', '1100']).toContain(line.accountCode);
      }),
      runs,
    );
  });
});
