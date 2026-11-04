import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { creditableMinor, planCreditNote, planWriteOff, writeOffableMinor } from './corrections';
import { leaseArbitrary, operationsArbitrary, ScenarioRunner } from './testing/scenarios';

/**
 * What the screens may offer to credit or write off (M4a review): the caps are the planners' own
 * checks, so the most offered is accepted and a pesewa more is refused, on every line, after any
 * sequence of invoices, payments, accruals and corrections.
 */
describe('P27 and P24 what a line can take', () => {
  it('creditableMinor and writeOffableMinor are exactly what the credit note and write-off accept', () => {
    // Every check expects a refusal for a pesewa more; their stack traces are never read, and
    // capturing them was most of this test's time (CI timed out at 30 s), so none is captured.
    const stackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      runCaps();
    } finally {
      Error.stackTraceLimit = stackTraceLimit;
    }
  });
});

/** One broken claim, named so a failure reads as plainly as one assertion did. */
interface CapFailure {
  readonly line: string;
  readonly kind: 'credit_note' | 'write_off';
  readonly limit: number;
  readonly problem: string;
}

/**
 * The three claims for one line and one kind, checked in plain code (M4b: six `expect` calls per
 * line per step were most of this test's time in CI): the limit is at least zero; the limit
 * itself is accepted when it is above zero; and the limit plus one pesewa is refused with a
 * DomainError.
 */
function checkCap(
  failures: CapFailure[],
  line: string,
  kind: CapFailure['kind'],
  limit: number,
  plan: (amountMinor: number) => unknown,
): void {
  const fail = (problem: string) => failures.push({ line, kind, limit, problem });
  if (!(limit >= 0)) fail('the limit is below zero');
  if (limit > 0) {
    try {
      plan(limit);
    } catch (error) {
      fail(`the limit itself was refused: ${String(error)}`);
    }
  }
  let refused: unknown = null;
  try {
    plan(limit + 1);
  } catch (error) {
    refused = error;
  }
  if (refused === null) fail('the limit plus one pesewa was accepted');
  else if (!(refused instanceof DomainError))
    fail(`the limit plus one pesewa was refused, but not with a DomainError: ${String(refused)}`);
}

function runCaps(): void {
  fc.assert(
    fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
      const run = new ScenarioRunner(lease);
      for (const op of ops) {
        run.apply(op);
        const { lines, allocations, payments } = run.model;
        const failures: CapFailure[] = [];
        for (const line of lines) {
          const taxLines = lines.filter((l) => l.baseLineId === line.id);
          checkCap(
            failures,
            line.id,
            'credit_note',
            creditableMinor(line, allocations),
            (amountMinor) => planCreditNote({ line, taxLines, allocations, payments, amountMinor }),
          );
          checkCap(
            failures,
            line.id,
            'write_off',
            writeOffableMinor(line, allocations),
            (amountMinor) => planWriteOff({ line, allocations, amountMinor }),
          );
        }
        expect(failures).toEqual([]);
      }
    }),
    { numRuns: 150 },
  );
}
