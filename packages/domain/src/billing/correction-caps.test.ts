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
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        for (const op of ops) {
          run.apply(op);
          const { lines, allocations, payments } = run.model;
          for (const line of lines) {
            const taxLines = lines.filter((l) => l.baseLineId === line.id);
            const credit = (amountMinor: number) =>
              planCreditNote({ line, taxLines, allocations, payments, amountMinor });
            const creditable = creditableMinor(line, allocations);
            expect(creditable).toBeGreaterThanOrEqual(0);
            if (creditable > 0) expect(() => credit(creditable)).not.toThrow();
            expect(() => credit(creditable + 1)).toThrow(DomainError);
            const writeOff = (amountMinor: number) =>
              planWriteOff({ line, allocations, amountMinor });
            const writable = writeOffableMinor(line, allocations);
            expect(writable).toBeGreaterThanOrEqual(0);
            if (writable > 0) expect(() => writeOff(writable)).not.toThrow();
            expect(() => writeOff(writable + 1)).toThrow(DomainError);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});
