import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isOpeningAllocation,
  lineBalance,
  paymentCredit,
  type BillingLine,
} from '../billing/lines';
import { leaseArbitrary, operationsArbitrary, type Operation } from '../billing/testing/scenarios';
import { expectedTaxMinor } from '../billing/invoicing';
import { AGE_BUCKETS, ageBucket, type AgeBucket } from '../billing/walk';
import { DomainError } from '../errors';
import { feeBearing } from '../ledger/allocation-fees';
import { balanceOf } from '../ledger/journal';
import { ledgerArrears } from '../reporting/dashboard';
import { taxPeriodsFromWalk } from '../tax/rent-tax';
import {
  openingLeaseFigures,
  planOpeningAdjustment,
  planOpeningLease,
  type OpeningItems,
  type OpeningLeaseFigures,
  type OpeningLeaseState,
} from './opening';
import {
  importedArbitrary,
  ImportedRunner,
  itemsOf,
  paidThroughOf,
  platformTwin,
  TaxBook,
  type Imported,
} from './testing';

/**
 * Opening balances (P25), property-tested per plan section 6: for any generated workbook, every
 * book balances and every sub-ledger holds; each lease is what the workbook says; no rent tax and
 * no fee is charged on opening money; committing twice changes nothing; no adjustment goes below
 * what is paid or drawn; and after the cut-over the lease behaves as one billed on the platform.
 */
const runs = { numRuns: 120 };

const runOf = (i: Imported) => new ImportedRunner(i.lease, i.cutOver, i.billingStart);

const total = (xs: readonly { readonly amountMinor: number }[] | undefined) =>
  (xs ?? []).reduce((s, x) => s + x.amountMinor, 0);

function commit(run: ImportedRunner, items: OpeningItems, batchId = 'batch-1') {
  const plan = planOpeningLease({ ...run.context(batchId), state: run.state(), items });
  run.adopt(plan);
  return plan;
}

const figuresOf = (run: ImportedRunner): OpeningLeaseFigures =>
  openingLeaseFigures({
    state: run.state(),
    scheduled: run.model.scheduled,
    asOf: run.model.today,
    lastDay: run.model.lastDay,
  });

/** 1100 plus 2010 for the lease (2010 is a credit, so negative): the tenant's net position. */
const netPosition = (run: ImportedRunner) =>
  run.model.balance('1100', { leaseId: 'lease-1' }) +
  run.model.balance('2010', { leaseId: 'lease-1' });

/**
 * The workbook as a lease will show it, worked out on its own: the advance pays the arrears oldest
 * first (BC-07), then the platform's charges in order. `before` is the lease before the commit.
 */
function expectedFigures(
  run: ImportedRunner,
  items: OpeningItems,
  before: OpeningLeaseState,
): OpeningLeaseFigures {
  const arrears = [...(items.arrears ?? [])].sort((a, b) =>
    a.dueDate !== b.dueDate
      ? a.dueDate < b.dueDate
        ? -1
        : 1
      : a.periodStart !== b.periodStart
        ? a.periodStart < b.periodStart
          ? -1
          : 1
        : a.kind === b.kind
          ? 0
          : a.kind === 'rent'
            ? -1
            : 1,
  );
  let credit = total(items.advances);
  const left = new Map<string, number>();
  for (const a of arrears) {
    const paid = Math.min(credit, a.amountMinor);
    credit -= paid;
    left.set(a.lineId, a.amountMinor - paid);
  }
  const byAge = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;
  let owed = 0;
  for (const a of arrears) {
    const amount = left.get(a.lineId) ?? 0;
    owed += amount;
    const bucket = ageBucket(a.dueDate, run.model.today);
    if (bucket) byAge[bucket] += amount;
  }
  // Paid-until: the opening months in order, each paid when all its arrears are; then the
  // platform's months, each paid while the credit left reaches its whole charge.
  const end = (start: string) =>
    run.lease.schedule.find((s) => s.periodStart === start)?.periodEnd as string;
  const months = [...new Set(arrears.map((a) => a.periodStart))].sort();
  let paidUntil: string | null = null;
  let broken = false;
  for (const m of months) {
    if (arrears.some((a) => a.periodStart === m && (left.get(a.lineId) ?? 0) > 0)) {
      broken = true;
      break;
    }
    paidUntil = end(m);
  }
  // The credit left pays the platform's charges in order: each month's rent then its VAT and
  // levies, then its service charge and theirs. VAT on an invoice already issued is owed (P32), so
  // money paying it leaves prepayments; everything else it pays stays in 2010 until its month.
  const taxed = new Set(
    before.lines
      .filter((l) => l.baseLineId !== null)
      .map((l) => {
        const base = before.lines.find((b) => b.id === l.baseLineId) as BillingLine;
        return `${base.periodStart}|${base.kind}`;
      }),
  );
  const pieces = new Map<string, { amountMinor: number; owed: boolean }[]>();
  const rows = [...run.platformRows()].sort((a, b) =>
    a.periodStart !== b.periodStart
      ? a.periodStart < b.periodStart
        ? -1
        : 1
      : a.chargeType === 'rent'
        ? -1
        : 1,
  );
  for (const row of rows) {
    const list = pieces.get(row.periodStart) ?? [];
    list.push({ amountMinor: row.amountMinor, owed: false });
    const tax = expectedTaxMinor(row, run.lease.vat);
    if (tax > 0)
      list.push({ amountMinor: tax, owed: taxed.has(`${row.periodStart}|${row.chargeType}`) });
    pieces.set(row.periodStart, list);
  }
  let reach = credit;
  let paidOwed = 0;
  for (const [start, list] of pieces) {
    let whole = true;
    for (const piece of list) {
      const pay = Math.min(reach, piece.amountMinor);
      reach -= pay;
      if (piece.owed) paidOwed += pay;
      if (pay < piece.amountMinor) whole = false;
    }
    if (whole && !broken) paidUntil = end(start);
    else broken = true;
  }
  const advance = credit - paidOwed;
  return {
    arrearsMinor: owed,
    arrearsByAge: byAge,
    advanceMinor: advance,
    paidUntil,
    depositHeldMinor: total(items.deposits),
    withholdingOutstandingMinor: 0,
    balanceMinor: owed - advance,
  };
}

/** Every allocation of opening money bears no fee; every one a platform payment makes on rent does. */
function checkFees(run: ImportedRunner): void {
  const opening = run.openingPaymentIds();
  for (const a of run.model.allocations) {
    const line = run.model.lines.find((l) => l.id === a.lineId) as BillingLine;
    const bears = feeBearing({
      lineKind: line.kind,
      source: a.source,
      opening: isOpeningAllocation(a, opening),
    });
    if (isOpeningAllocation(a, opening)) expect(bears).toBe(false);
    else if (a.source === 'payment' && (line.kind === 'rent' || line.kind === 'service_charge'))
      expect(bears).toBe(true);
  }
}

describe('P25 any Balances workbook, committed on the cut-over (AR-01, AR-02, BC-07, BC-08, BC-11)', () => {
  it('every book balances, the sub-ledgers hold, and each lease is what the workbook says', () => {
    fc.assert(
      fc.property(importedArbitrary(leaseArbitrary, { minDaysBefore: 1 }), (imported) => {
        const run = runOf(imported);
        run.model.checkInvariants();
        const items = itemsOf(run, imported.workbook);
        const before = netPosition(run);
        const state = run.state();
        const lease = { ...state, lines: [...state.lines] };
        const plan = commit(run, items);
        // Every book sums to zero; 1100 per line, 2010 and 2100 per lease match the sub-ledger.
        run.model.checkInvariants();
        const f = figuresOf(run);
        expect(f).toEqual(expectedFigures(run, items, lease));
        expect(
          ledgerArrears({
            lines: run.model.lines,
            allocations: run.model.allocations,
            asOf: run.model.today,
          }).byBucket,
        ).toEqual(f.arrearsByAge);
        // An advance given as a paid-through date is paid exactly to it.
        if (imported.workbook.advance.kind === 'paid_through' && (items.arrears ?? []).length === 0)
          expect(f.paidUntil).toBe(
            total(items.advances) > 0 ? paidThroughOf(run, imported.workbook.advance.month) : null,
          );
        // The money moved is the workbook's, against opening balances only.
        const A = total(items.arrears);
        const V = total(items.advances);
        const D = total(items.deposits);
        const W = total(items.withholding);
        expect(netPosition(run) - before).toBe(A - V);
        expect(run.model.balance('2100', { leaseId: 'lease-1' })).toBe(0 - D);
        expect(run.model.balance('1150')).toBe(W);
        expect(run.model.balance('3900')).toBe(-A + D + V - W);
        const accounts = new Set(plan.entries.flatMap((e) => e.lines.map((l) => l.accountCode)));
        for (const code of ['4000', '4100', '5300', '2200', '5100', '2300'] as const)
          expect(accounts.has(code)).toBe(false);
        // No P17 and no P14 on opening money.
        expect(new TaxBook(true).base(run)).toBe(0);
        checkFees(run);
      }),
      runs,
    );
  });

  it('committing twice plans the same entries under the same keys, and posting them again changes nothing', () => {
    fc.assert(
      fc.property(
        importedArbitrary(leaseArbitrary),
        fc.integer({ min: 0, max: 20 }),
        (imported, delay) => {
          const run = runOf(imported);
          run.days(delay);
          const items = itemsOf(run, imported.workbook);
          const state = run.state();
          const first = planOpeningLease({ ...run.context('batch-1'), state, items });
          const again = planOpeningLease({ ...run.context('batch-1'), state, items });
          expect(again).toEqual(first);
          expect(new Set(first.entries.map((e) => e.key)).size).toBe(first.entries.length);
          run.adopt(first);
          const journal = run.model.journal();
          run.model.adopt({ entries: first.entries });
          run.model.adopt({ entries: again.entries });
          expect(run.model.journal()).toEqual(journal);
          run.model.checkInvariants();
        },
      ),
      runs,
    );
  });
});

describe('P25 before and after the cut-over (AC-01, BC-07, TX-01, AC-02)', () => {
  it('with platform activity before the commit and any history after, the invariants hold throughout', () => {
    const before = fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant('days' as const), days: fc.integer({ min: 1, max: 10 }) }),
        fc.record({
          kind: fc.constant('pay' as const),
          amountMinor: fc.integer({ min: 1, max: 2_000_000 }),
          cash: fc.constant('1050' as const),
          daysBack: fc.constant(0),
        }),
      ),
      { maxLength: 4 },
    );
    fc.assert(
      fc.property(
        importedArbitrary(leaseArbitrary),
        before,
        operationsArbitrary(true),
        (imported, early, ops) => {
          const run = runOf(imported);
          for (const op of early) run.apply(op);
          run.model.checkInvariants();
          const items = itemsOf(run, imported.workbook);
          const net = netPosition(run);
          const deposits = run.model.balance('2100', { leaseId: 'lease-1' });
          commit(run, items);
          run.model.checkInvariants();
          expect(netPosition(run) - net).toBe(total(items.arrears) - total(items.advances));
          expect(run.model.balance('2100', { leaseId: 'lease-1' }) - deposits).toBe(
            0 - total(items.deposits),
          );
          expect(new TaxBook(true).base(run)).toBeLessThanOrEqual(new TaxBook(false).base(run));
          for (const op of ops) {
            run.apply(op);
            run.model.checkInvariants();
          }
          checkFees(run);
          // Opening lines were never accrued again: never income, only opening balances.
          for (const line of run.model.lines.filter((l) => l.opening))
            for (const code of ['4000', '4100'] as const)
              expect(run.model.balance(code, { invoiceLineId: line.id })).toBe(0);
        },
      ),
      runs,
    );
  });

  it('a lease brought in behaves, month after month, as the same lease billed on the platform', () => {
    fc.assert(
      fc.property(importedArbitrary(leaseArbitrary), operationsArbitrary(true), (imported, ops) => {
        const run = runOf(imported);
        const items = itemsOf(run, imported.workbook);
        commit(run, items);
        const twin = platformTwin(run, items);
        const twinAdvance = twin.model.payments.at(-1)?.id;
        const same = () => {
          const [a, b] = [run.model.walk(), twin.model.walk()];
          expect({ ...a, lines: undefined }).toEqual({ ...b, lines: undefined });
          for (const code of ['1100', '2010', '2100'] as const)
            expect(run.model.balance(code, { leaseId: 'lease-1' })).toBe(
              twin.model.balance(code, { leaseId: 'lease-1' }),
            );
          expect(run.balancesByKey()).toEqual(twin.balancesByKey());
          expect(figuresOf(run)).toEqual(figuresOf(twin));
          // AC-02: the same money bears the same fees, but for the advance, which bore its fee
          // before the platform.
          const fees = (r: ImportedRunner, skip: string | undefined) => {
            const out: Record<string, number> = {};
            const opening = r.openingPaymentIds();
            for (const a of r.model.allocations) {
              if (skip && a.paymentId === skip && total(items.advances) > 0) continue;
              const line = r.model.lines.find((l) => l.id === a.lineId) as BillingLine;
              if (
                !feeBearing({
                  lineKind: line.kind,
                  source: a.source,
                  opening: isOpeningAllocation(a, opening),
                })
              )
                continue;
              const key = r.keyOf(line);
              out[key] = (out[key] ?? 0) + a.amountMinor;
            }
            return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0));
          };
          expect(fees(run, undefined)).toEqual(fees(twin, twinAdvance));
        };
        same();
        for (const op of ops) {
          run.apply(op);
          twin.apply(op);
          same();
          run.model.checkInvariants();
        }
      }),
      runs,
    );
  });
});

describe('TX-01 the rent tax walk excludes opening money and taxes arrears paid after the cut-over', () => {
  const later = fc.array(
    fc.oneof(
      {
        arbitrary: fc.record({
          kind: fc.constant('days' as const),
          days: fc.integer({ min: 1, max: 45 }),
        }),
        weight: 2,
      },
      {
        arbitrary: fc.record({
          kind: fc.constant('pay' as const),
          amountMinor: fc.oneof(
            fc.integer({ min: 1, max: 300_000 }),
            fc.integer({ min: 300_000, max: 10_000_000 }),
          ),
          cash: fc.constant('1050' as const),
          daysBack: fc.integer({ min: 0, max: 5 }),
        }),
        weight: 3,
      },
      {
        arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }),
        weight: 1,
      },
    ),
    { minLength: 3, maxLength: 25 },
  );

  /**
   * What a model's money covers of rent and service charge now, leaving out the money of the
   * payments named (none: all of it).
   */
  const covered = (run: ImportedRunner, without: ReadonlySet<string> = new Set()) =>
    taxPeriodsFromWalk({
      walk: run.model.walk(),
      periodKeyOf: (k: string) => k,
      taxed: new Map(),
      withheld: new Set<string>(),
      ...(without.size > 0
        ? { opening: { paymentIds: without, allocations: run.model.allocations } }
        : {}),
    }).reduce((s, p) => s + p.coveredMinor, 0);

  /** What one payment's money covers of rent and service charge now, in a model's walk. */
  const coverBy = (run: ImportedRunner, paymentId: string) =>
    covered(run) - covered(run, new Set([paymentId]));

  /** The base the live (not reversed) receipts were taxed on, leaving out the payment named. */
  const liveBase = (run: ImportedRunner, book: TaxBook, leaveOut?: string) =>
    run.platformPayments
      .filter((id) => id !== leaveOut)
      .filter((id) => !run.model.payments.find((p) => p.id === id)?.reversed)
      .reduce((s, id) => s + (book.bases.get(id) ?? 0), 0);

  it('each receipt after the cut-over is taxed as on the platform-billed lease, the advance never', () => {
    fc.assert(
      fc.property(importedArbitrary(leaseArbitrary), later, (imported, ops) => {
        const run = runOf(imported);
        const items = itemsOf(run, imported.workbook);
        commit(run, items);
        const twin = platformTwin(run, items);
        const taxed = new TaxBook(true);
        const taxedTwin = new TaxBook(false);
        // The twin's advance was rent received on the platform: taxed then. Ours never is.
        const advance = total(items.advances) > 0 ? twin.model.payments.at(-1)?.id : undefined;
        if (advance) taxedTwin.receipt(twin, advance);
        expect(taxed.base(run)).toBe(0);
        const atCommit = advance ? coverBy(twin, advance) : 0;
        const reversed = (r: ImportedRunner) =>
          r.platformPayments.map((id) => r.model.payments.find((p) => p.id === id)?.reversed);
        // Whether the twin's advance has covered, at every step since the commit, what it covered
        // when it was taxed (founder, 2026-11-10: the premise of the equality below).
        let still = true;
        for (const op of ops) {
          const count = run.platformPayments.length;
          const was = reversed(run);
          run.apply(op);
          twin.apply(op);
          if (advance && coverBy(twin, advance) !== atCommit) still = false;
          if (op.kind === 'reverse') {
            // P21 mirrors the payment's P17: the same payment in each model.
            const i = reversed(run).findIndex((r, k) => r && !was[k]);
            if (i >= 0) {
              taxed.reverse(run.platformPayments[i] as string);
              taxedTwin.reverse(twin.platformPayments[i] as string);
            }
            continue;
          }
          if (run.platformPayments.length === count) continue;
          const ours = run.platformPayments.at(-1) as string;
          const theirs = twin.platformPayments.at(-1) as string;
          const base = taxed.receipt(run, ours);
          const twinBase = taxedTwin.receipt(twin, theirs);
          const amount = run.model.payments.find((p) => p.id === ours)?.amountMinor as number;
          expect(base).toBeGreaterThanOrEqual(0);
          expect(base).toBeLessThanOrEqual(amount);
          // While the twin's advance has covered, since the commit, what it covered when it was
          // taxed, each receipt is taxed exactly as the twin's. (Once a receipt pushes the twin's
          // advance onto VAT or past the lease's end, the twin's cumulative walk shares pesewas
          // between its receipts differently: its advance was taxed on rent it no longer covers.)
          if (!advance || still) expect(base).toBe(twinBase);
        }
        // Whatever happened: our platform money covers exactly the rent the twin's money covers,
        // less what the twin's advance covers now (the opening advance is never taxed).
        expect(covered(run, run.openingPaymentIds())).toBe(
          covered(twin) - (advance ? coverBy(twin, advance) : 0),
        );
        // While the premise holds, the live receipts carry the same base in total. Total tax is
        // not asserted equal: rounding once per receipt line (CLAUDE.md section 4) can split the
        // same base into different totals.
        if (!advance || still)
          expect(liveBase(run, taxed)).toBe(liveBase(twin, taxedTwin, advance));
      }),
      runs,
    );
  });
});

describe('P25 adjustments: no change goes below what is paid or drawn', () => {
  type Change =
    | {
        readonly kind: 'lower_arrears' | 'lower_advance' | 'lower_deposit';
        readonly pick: number;
        readonly percent: number;
      }
    | { readonly kind: 'raise_arrears'; readonly pick: number; readonly amountMinor: number }
    | { readonly kind: 'raise_advance' | 'raise_deposit'; readonly amountMinor: number };
  const change: fc.Arbitrary<Change> = fc.oneof(
    fc.record({
      kind: fc.constantFrom(
        'lower_arrears' as const,
        'lower_advance' as const,
        'lower_deposit' as const,
      ),
      pick: fc.nat(),
      percent: fc.integer({ min: 1, max: 150 }),
    }),
    fc.record({
      kind: fc.constant('raise_arrears' as const),
      pick: fc.nat(),
      amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
    }),
    fc.record({
      kind: fc.constantFrom('raise_advance' as const, 'raise_deposit' as const),
      amountMinor: fc.integer({ min: 1, max: 2_000_000 }),
    }),
  );
  const between: fc.Arbitrary<Operation[]> = fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('days' as const), days: fc.integer({ min: 1, max: 40 }) }),
      fc.record({
        kind: fc.constant('pay' as const),
        amountMinor: fc.integer({ min: 1, max: 2_000_000 }),
        cash: fc.constant('1050' as const),
        daysBack: fc.constant(0),
      }),
    ),
    { maxLength: 5 },
  );

  it('each lowering is refused exactly when it would go below what is paid or drawn, and every book still balances', () => {
    fc.assert(
      fc.property(
        importedArbitrary(leaseArbitrary),
        between,
        fc.array(fc.tuple(change, between), { minLength: 1, maxLength: 8 }),
        (imported, first, changes) => {
          const run = runOf(imported);
          commit(run, itemsOf(run, imported.workbook));
          for (const op of first) run.apply(op);
          changes.forEach(([c, ops], i) => {
            const batch = `adj-${i}`;
            const state = run.state();
            const ctx = run.context(batch);
            const opening = state.lines.filter((l) => l.opening);
            let limit = Number.POSITIVE_INFINITY;
            let amount = 0;
            let plan: () => ReturnType<typeof planOpeningAdjustment>;
            const held = run.model.balance('2100', { leaseId: 'lease-1' });
            switch (c.kind) {
              case 'lower_arrears': {
                const lines = opening.filter((l) => l.kind !== 'deposit');
                const line = lines[c.pick % Math.max(1, lines.length)];
                if (!line) return;
                limit = lineBalance(line, state.allocations).outstandingMinor;
                amount = Math.max(1, Math.floor((limit * c.percent) / 100));
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    lower: { arrears: [{ itemId: 'x', lineId: line.id, amountMinor: amount }] },
                  });
                break;
              }
              case 'lower_advance': {
                limit = state.payments
                  .filter((p) => state.openingPaymentIds.has(p.id))
                  .reduce((s, p) => s + paymentCredit(p, state.allocations), 0);
                amount = Math.max(1, Math.floor((limit * c.percent) / 100));
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    lower: { advances: [{ itemId: 'x', amountMinor: amount }] },
                  });
                break;
              }
              case 'lower_deposit': {
                const onLines = opening
                  .filter((l) => l.kind === 'deposit')
                  .reduce((s, l) => s + lineBalance(l, state.allocations).settledMinor, 0);
                limit = Math.min(onLines, -held);
                amount = Math.max(1, Math.floor((limit * c.percent) / 100));
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    depositHeldMinor: -held,
                    lower: { deposits: [{ itemId: 'x', amountMinor: amount }] },
                  });
                break;
              }
              case 'raise_arrears': {
                const rows = run.openingRows();
                const row = rows[c.pick % rows.length];
                if (!row) return;
                amount = c.amountMinor;
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    raise: {
                      arrears: [
                        {
                          itemId: 'x',
                          lineId: `adj-line-${i}`,
                          kind: row.chargeType,
                          periodStart: row.periodStart,
                          dueDate: row.periodStart,
                          amountMinor: c.amountMinor,
                        },
                      ],
                    },
                  });
                break;
              }
              case 'raise_advance':
                amount = c.amountMinor;
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    raise: {
                      advances: [
                        {
                          itemId: 'x',
                          paymentId: `adj-pay-${i}`,
                          order: `${run.cutOver}#000000${i + 1}`,
                          amountMinor: c.amountMinor,
                        },
                      ],
                    },
                  });
                break;
              case 'raise_deposit':
                amount = c.amountMinor;
                plan = () =>
                  planOpeningAdjustment({
                    ...ctx,
                    state,
                    raise: {
                      deposits: [{ itemId: 'x', lineId: `adj-dep-${i}`, amountMinor: amount }],
                    },
                  });
                break;
            }
            const lowering = c.kind.startsWith('lower');
            if (lowering && amount > limit) {
              let code = '';
              try {
                plan();
              } catch (error) {
                code = error instanceof DomainError ? error.code : String(error);
              }
              expect(code).toBe(
                c.kind === 'lower_arrears' ? 'opening.below_paid' : 'opening.below_drawn',
              );
            } else {
              const net = netPosition(run);
              const deposits = run.model.balance('2100', { leaseId: 'lease-1' });
              const p = plan();
              run.adopt(p);
              run.model.checkInvariants();
              const moved = netPosition(run) - net;
              if (c.kind === 'lower_arrears' || c.kind === 'raise_advance')
                expect(moved).toBe(-Math.abs(amount));
              if (c.kind === 'lower_advance' || c.kind === 'raise_arrears')
                expect(moved).toBe(Math.abs(amount));
              const depositMoved = run.model.balance('2100', { leaseId: 'lease-1' }) - deposits;
              if (c.kind === 'lower_deposit') expect(depositMoved).toBe(amount);
              else if (c.kind === 'raise_deposit') expect(depositMoved).toBe(-amount);
              else expect(depositMoved).toBe(0);
              checkFees(run);
            }
            for (const op of ops) run.apply(op);
            run.model.checkInvariants();
          });
          expect(
            balanceOf(run.model.journal(), {
              accountCode: '4000',
              invoiceLineId: 'opening-line-0',
            }),
          ).toBe(0);
        },
      ),
      runs,
    );
  });
});
