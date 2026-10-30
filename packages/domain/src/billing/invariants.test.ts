import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { INCOME_ACCOUNTS } from '../ledger/accounts';
import { balanceOf } from '../ledger/journal';
import { lineBalance, isRecurring } from './lines';
import { leaseArbitrary, operationsArbitrary, ScenarioRunner } from './testing/scenarios';

/**
 * The ledger invariants (architecture section 5), property-tested against random leases and
 * random sequences of invoices, payments, accruals, reversals, credit notes and write-offs.
 */
const runs = { numRuns: 150 };

/** A liability's balance as a positive figure (credits are negative in the journal). */
const held = (journalBalance: number): number => 0 - journalBalance;

const compareNullable = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

describe('AC-01 the ledger balances', () => {
  it('every entry balances and every sub-ledger matches after any sequence (invariants 1 to 4, 7)', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        run.model.checkInvariants();
        for (const op of ops) {
          run.apply(op);
          run.model.checkInvariants();
        }
      }),
      runs,
    );
  });
});

describe('BC-07 allocation never exceeds what is owed', () => {
  it('no line is allocated beyond its amount and no payment beyond itself (invariants 2, 3, 7)', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) run.apply(op);
        for (const line of run.model.lines) {
          const b = lineBalance(line, run.model.allocations);
          expect(b.outstandingMinor).toBeGreaterThanOrEqual(0);
          expect(b.settledMinor + b.writtenOffMinor).toBeLessThanOrEqual(b.netMinor);
        }
        run.model.checkInvariants();
      }),
      runs,
    );
  });
});

describe('BC-11 deposits never reach income', () => {
  it('income is exactly what was charged, and 2100 is exactly the deposits received (invariant 4)', () => {
    fc.assert(
      fc.property(
        leaseArbitrary.filter((l) => (l.terms.depositMinor ?? 0) > 0),
        operationsArbitrary(true),
        (lease, ops) => {
          const run = new ScenarioRunner(lease);
          for (const op of ops) run.apply(op);
          const m = run.model;
          const journal = m.journal();
          const income = held(
            INCOME_ACCOUNTS.reduce(
              (sum, code) => sum + balanceOf(journal, { accountCode: code }),
              0,
            ),
          );
          const charged = m.lines
            .filter((l) => (isRecurring(l.kind) && l.accrued) || l.kind === 'one_off')
            .reduce((sum, l) => sum + lineBalance(l, m.allocations).netMinor, 0);
          expect(income).toBe(charged);
          const depositLines = m.lines.filter((l) => l.kind === 'deposit');
          const received = depositLines.reduce(
            (sum, l) => sum + lineBalance(l, m.allocations).settledMinor,
            0,
          );
          expect(held(balanceOf(journal, { accountCode: '2100' }))).toBe(received);
          // Money on a deposit line never leaves 2100 except by reversing the payment that paid it.
          for (const entry of m.entries)
            for (const line of entry.lines)
              if (line.accountCode === '2100' && line.amountMinor > 0)
                expect(entry.rule).toBe('P21');
        },
      ),
      runs,
    );
  });
});

describe('AR-01 recognition plus prepayments equal what was prepaid', () => {
  it('holds for any lease with no reversal or credit note (invariant 5)', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(false), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) run.apply(op);
        const m = run.model;
        let prepaid = 0;
        let recognised = 0;
        for (const entry of m.entries)
          for (const line of entry.lines) {
            if (line.accountCode !== '2010') continue;
            if (entry.rule === 'P03') prepaid += -line.amountMinor;
            else if (entry.rule === 'P02') recognised += line.amountMinor;
            else throw new Error(`2010 moved by ${entry.rule}`);
          }
        expect(recognised + held(balanceOf(m.journal(), { accountCode: '2010' }))).toBe(prepaid);
      }),
      runs,
    );
  });
});

describe('AR-02 paid-until moves back only on a reversal, credit note or schedule change', () => {
  it('never moves backwards under payments, invoices, accruals and write-offs (invariant 9)', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        let before = run.model.walk().paidUntil;
        let corrections = run.correctionCount;
        for (const op of ops) {
          run.apply(op);
          const after = run.model.walk().paidUntil;
          if (run.correctionCount === corrections)
            expect(compareNullable(after, before)).toBeGreaterThanOrEqual(0);
          before = after;
          corrections = run.correctionCount;
        }
      }),
      runs,
    );
  });

  it('unearned rent plus service charge plus spare credit equal prepayments', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) run.apply(op);
        const walk = run.model.walk();
        const prepayments = held(balanceOf(run.model.journal(), { accountCode: '2010' }));
        expect(
          walk.unearnedRentMinor + walk.unearnedServiceChargeMinor + walk.creditLeftMinor,
        ).toBe(prepayments);
      }),
      runs,
    );
  });
});
