import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { money, multiplyBps } from '../money/money';
import { leaseArbitrary, operationsArbitrary, ScenarioRunner } from '../billing/testing/scenarios';
import {
  receiptTax,
  receiptTaxBase,
  rentTaxAlertDates,
  rentTaxDueDate,
  taxPeriodsFromWalk,
  type TaxPeriod,
} from './rent-tax';
import {
  certificateDebitAccount,
  checkCertificateConfirmer,
  checkWithholding,
} from './withholding';

const RULES = { rateBps: 800, includesServiceCharge: true, dueDays: 30, alertDays: [21, 28] };

/** Live tax items on a lease: what each payment's receipt pinned to each period. */
class TaxBook {
  readonly items = new Map<string, { key: string; baseMinor: number; taxMinor: number }[]>();

  pinned(): Map<string, { baseMinor: number; taxMinor: number }> {
    const totals = new Map<string, { baseMinor: number; taxMinor: number }>();
    for (const lines of this.items.values())
      for (const l of lines) {
        const t = totals.get(l.key) ?? { baseMinor: 0, taxMinor: 0 };
        totals.set(l.key, {
          baseMinor: t.baseMinor + l.baseMinor,
          taxMinor: t.taxMinor + l.taxMinor,
        });
      }
    return totals;
  }

  periods(run: ScenarioRunner): TaxPeriod[] {
    return taxPeriodsFromWalk({
      walk: run.model.walk(),
      periodKeyOf: (key) => run.periodOf.get(key) ?? key,
      taxed: this.pinned(),
      withheld: new Set(),
    });
  }

  /** Taxes a receipt as the tax module will when its payment posts. */
  receipt(run: ScenarioRunner, paymentId: string, rateBps: number): number {
    const periods = this.periods(run);
    const { pins } = receiptTaxBase(periods, RULES);
    const tax = receiptTax(pins, periods, rateBps);
    this.items.set(paymentId, [...tax.lines]);
    return tax.taxMinor;
  }

  /** P21 mirrors the payment's P17 entries. */
  reverse(paymentId: string): void {
    this.items.delete(paymentId);
  }
}

const eligibleCoverage = (periods: readonly TaxPeriod[]) =>
  periods.reduce((sum, p) => sum + p.coveredMinor, 0);
const taxedBase = (periods: readonly TaxPeriod[]) =>
  periods.reduce((sum, p) => sum + p.taxedBaseMinor, 0);

describe('TX-01 the rent tax base', () => {
  it('worked example A: GH₵36,000 received for 24 months is taxed GH₵2,880 at receipt, due in 30 days', () => {
    const periods: TaxPeriod[] = Array.from({ length: 24 }, (_, i) => ({
      key: `cp-${i}`,
      kind: 'rent' as const,
      amountMinor: 150_000,
      coveredMinor: 150_000,
      taxedBaseMinor: 0,
      taxMinor: 0,
      withheld: false,
    }));
    const { baseMinor, pins } = receiptTaxBase(periods, RULES);
    expect(baseMinor).toBe(3_600_000);
    expect(receiptTax(pins, periods, 800).taxMinor).toBe(288_000);
    expect(rentTaxDueDate('2026-10-25', 30)).toBe('2026-11-24');
    expect(rentTaxAlertDates('2026-10-25', [28, 21])).toEqual(['2026-11-15', '2026-11-22']);
  });

  it('taxes a later payment on the months an earlier payment’s credit moves to', () => {
    // Credit from p1 was taxed on months 2 and 3; p2 then pays the invoices for months 2 and 3,
    // so p1's credit now covers months 4 and 5. p2 is taxed on those, not on nothing.
    const period = (i: number, covered: number, taxed: number): TaxPeriod => ({
      key: `m${i}`,
      kind: 'rent',
      amountMinor: 100_000,
      coveredMinor: covered,
      taxedBaseMinor: taxed,
      taxMinor: multiplyBps(money(taxed), 800).amountMinor,
      withheld: false,
    });
    const after = [
      period(2, 100_000, 100_000),
      period(3, 100_000, 100_000),
      period(4, 100_000, 0),
      period(5, 100_000, 0),
    ];
    const { baseMinor, pins } = receiptTaxBase(after, RULES);
    expect(baseMinor).toBe(200_000);
    expect(pins).toEqual([
      { key: 'm4', baseMinor: 100_000 },
      { key: 'm5', baseMinor: 100_000 },
    ]);
  });

  it('never taxes withheld periods, or service charge when the rule is off', () => {
    const periods: TaxPeriod[] = [
      {
        key: 'r',
        kind: 'rent',
        amountMinor: 100,
        coveredMinor: 100,
        taxedBaseMinor: 0,
        taxMinor: 0,
        withheld: true,
      },
      {
        key: 's',
        kind: 'service_charge',
        amountMinor: 50,
        coveredMinor: 50,
        taxedBaseMinor: 0,
        taxMinor: 0,
        withheld: false,
      },
    ];
    expect(receiptTaxBase(periods, { includesServiceCharge: false }).baseMinor).toBe(0);
    expect(receiptTaxBase(periods, { includesServiceCharge: true }).baseMinor).toBe(50);
  });

  it('rounds once per receipt and keeps every period within the rate on its amount', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 24 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 24, maxLength: 24 }),
        fc.constantFrom(800, 1500),
        (amounts, taxedPercent, rate) => {
          const periods: TaxPeriod[] = amounts.map((amount, i) => {
            const taxed = Math.floor((amount * (taxedPercent[i] ?? 0)) / 100);
            return {
              key: `p${i}`,
              kind: 'rent' as const,
              amountMinor: amount,
              coveredMinor: amount,
              taxedBaseMinor: taxed,
              taxMinor: multiplyBps(money(taxed), rate).amountMinor,
              withheld: false,
            };
          });
          const { baseMinor, pins } = receiptTaxBase(periods, RULES);
          const tax = receiptTax(pins, periods, rate);
          const exact = multiplyBps(money(baseMinor), rate).amountMinor;
          expect(tax.taxMinor).toBeLessThanOrEqual(exact);
          expect(exact - tax.taxMinor).toBeLessThanOrEqual(pins.length);
          expect(tax.lines.reduce((s, l) => s + l.taxMinor, 0)).toBe(tax.taxMinor);
          for (const line of tax.lines) {
            const p = periods.find((x) => x.key === line.key);
            if (!p) throw new Error('period');
            expect(p.taxMinor + line.taxMinor).toBeLessThanOrEqual(
              multiplyBps(money(p.amountMinor), rate).amountMinor,
            );
          }
        },
      ),
    );
  });
});

describe('TX-01 the base taxed on a lease follows the rent its money covers', () => {
  it('equals the covered rent after every receipt, with no reversal or credit note', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(false), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        const book = new TaxBook();
        for (const op of ops) {
          run.apply(op);
          if (op.kind !== 'pay') continue;
          const payment = run.model.payments.at(-1);
          if (!payment) continue;
          book.receipt(run, payment.id, RULES.rateBps);
          const periods = book.periods(run);
          expect(taxedBase(periods)).toBe(eligibleCoverage(periods));
        }
        for (const p of book.periods(run))
          expect(p.taxedBaseMinor).toBeLessThanOrEqual(p.amountMinor);
      }),
      { numRuns: 120 },
    );
  });

  it('with reversals and credit notes, taxes no receipt beyond its money and the lease beyond what it received', () => {
    fc.assert(
      fc.property(leaseArbitrary, operationsArbitrary(true), (lease, ops) => {
        const run = new ScenarioRunner(lease);
        const book = new TaxBook();
        for (const op of ops) {
          const live = run.model.payments.filter((p) => !p.reversed).map((p) => p.id);
          run.apply(op);
          for (const id of live)
            if (run.model.payments.find((p) => p.id === id)?.reversed) book.reverse(id);
          if (op.kind !== 'pay') continue;
          const payment = run.model.payments.at(-1);
          if (!payment) continue;
          const periods = book.periods(run);
          const { baseMinor, pins } = receiptTaxBase(periods, RULES, payment.amountMinor);
          expect(baseMinor).toBeLessThanOrEqual(payment.amountMinor);
          const tax = receiptTax(pins, periods, RULES.rateBps);
          book.items.set(payment.id, [...tax.lines]);
          const after = book.periods(run);
          // Caught up, unless the receipt's own money was the limit.
          if (baseMinor < payment.amountMinor)
            expect(taxedBase(after)).toBeGreaterThanOrEqual(eligibleCoverage(after));
          const received = run.model.payments
            .filter((p) => !p.reversed)
            .reduce((sum, p) => sum + p.amountMinor, 0);
          expect(taxedBase(after)).toBeLessThanOrEqual(received);
          for (const line of tax.lines) {
            const p = after.find((x) => x.key === line.key);
            if (!p) throw new Error('period');
            expect(line.taxMinor).toBeLessThanOrEqual(
              multiplyBps(money(Math.max(p.amountMinor, p.taxedBaseMinor)), RULES.rateBps)
                .amountMinor,
            );
          }
        }
      }),
      { numRuns: 120 },
    );
  });
});

describe('TX-04 withholding', () => {
  it('worked example B: GH₵1,500 withheld on GH₵10,000 of commercial rent matches the rate', () => {
    const check = checkWithholding(
      [{ lineId: 'nov', netMinor: 1_000_000, outstandingMinor: 1_000_000, withheldMinor: 150_000 }],
      1500,
    );
    expect(check).toEqual({ totalMinor: 150_000, differsFromRate: [] });
  });

  it('warns, without refusing, when the amount differs from the rate, and refuses more than is owed', () => {
    expect(
      checkWithholding(
        [
          {
            lineId: 'nov',
            netMinor: 1_000_000,
            outstandingMinor: 1_000_000,
            withheldMinor: 80_000,
          },
        ],
        1500,
      ).differsFromRate,
    ).toEqual([{ lineId: 'nov', expectedMinor: 150_000, withheldMinor: 80_000 }]);
    expect(() =>
      checkWithholding(
        [{ lineId: 'nov', netMinor: 1_000_000, outstandingMinor: 100_000, withheldMinor: 150_000 }],
        1500,
      ),
    ).toThrow(/cannot exceed/);
  });

  it('settles rent tax, or is a credit for an owner in the letting business; never confirmed by its uploader', () => {
    expect(certificateDebitAccount({ lettingBusiness: false })).toBe('2200');
    expect(certificateDebitAccount({ lettingBusiness: true })).toBe('1160');
    expect(() => checkCertificateConfirmer({ uploadedBy: 'p1', confirmer: 'p1' })).toThrow(
      /cannot confirm/,
    );
  });
});
