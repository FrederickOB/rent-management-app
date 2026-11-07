import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import {
  agentCashMovements,
  failedStatementChecks,
  flattenStatementFigures,
  ownerStatementFigures,
  type AgentCashEntry,
  type OwnerStatementInput,
  type StatementPropertyInput,
} from './statement';

/**
 * The M9 review's statement findings in the domain: unearned rent, unearned service charge and
 * credit add up to 2010 (#7); the rent-tax hold-back leaves out tax a tenant withheld (#9); and the
 * agent's cash identity fails when 1070 moved by something the statement cannot name (note 6).
 */
const OWNER = '019a3000-0000-7000-8000-00000000a001';
const OSU = '019a3000-0000-7000-8000-00000000b001';

const page = (over: Partial<StatementPropertyInput> = {}): StatementPropertyInput => ({
  propertyId: OSU,
  collections: [],
  expenses: [],
  feesMinor: 0,
  rentTax: { accruedMinor: 0, paidMinor: 0 },
  rentEarnedMinor: 0,
  serviceChargeEarnedMinor: 0,
  unearnedRentMinor: 0,
  depositsHeldMinor: 0,
  arrears: [],
  occupancy: {},
  ...over,
});

const agency = (over: Partial<OwnerStatementInput> = {}): OwnerStatementInput => ({
  ownerId: OWNER,
  month: '2026-11',
  properties: [page()],
  rentTaxPayable: { openingMinor: 0, closingMinor: 150_000 },
  agent: {
    cash: { openingMinor: 0, closingMinor: 850_000, in: [], out: [] },
    feesDue: { openingMinor: 0, closingMinor: 0 },
    graPaidBy: 'agency',
  },
  ...over,
});

describe('AC-04 the statement splits 2010 three ways (M9 review #7)', () => {
  it('shows unearned rent, unearned service charge and credit, which add up to all of 2010', () => {
    const f = ownerStatementFigures(
      agency({
        properties: [
          page({
            unearnedRentMinor: 300_000,
            unearnedServiceChargeMinor: 20_000,
            creditMinor: 45_000,
          }),
        ],
      }),
    );
    expect(f.properties[0]!.accrual).toMatchObject({
      unearnedRentMinor: 300_000,
      unearnedServiceChargeMinor: 20_000,
      creditMinor: 45_000,
      unearnedMinor: 365_000,
    });
    expect(f.summary.accrual.creditMinor).toBe(45_000);
    const keys = flattenStatementFigures(f).map((r) => r.key);
    expect(keys).toContain(`property.${OSU}.accrual.credit`);
    expect(keys).toContain('summary.accrual.credit');
  });

  it('refuses credit below zero: the ledger and its sub-ledger disagree', () => {
    expect(() =>
      ownerStatementFigures(agency({ properties: [page({ creditMinor: -1 })] })),
    ).toThrow(DomainError);
  });

  it('adds up on every page and the summary, whatever the amounts (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            rent: fc.integer({ min: 0, max: 10_000_000 }),
            service: fc.integer({ min: 0, max: 1_000_000 }),
            credit: fc.integer({ min: 0, max: 5_000_000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (amounts) => {
          const f = ownerStatementFigures(
            agency({
              properties: amounts.map((a, i) =>
                page({
                  propertyId: `019a3000-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`,
                  unearnedRentMinor: a.rent,
                  unearnedServiceChargeMinor: a.service,
                  creditMinor: a.credit,
                }),
              ),
            }),
          );
          for (const p of [...f.properties, f.summary])
            expect(p.accrual.unearnedMinor).toBe(
              p.accrual.unearnedRentMinor +
                p.accrual.unearnedServiceChargeMinor +
                p.accrual.creditMinor,
            );
          expect(f.summary.accrual.creditMinor).toBe(amounts.reduce((s, a) => s + a.credit, 0));
        },
      ),
    );
  });
});

describe('TX-04 the rent-tax hold-back leaves out tax a tenant withheld (M9 review #9)', () => {
  it('worked example B: GH₵1,500 withheld, pending its certificate, is not held back', () => {
    const f = ownerStatementFigures(
      agency({
        agent: {
          cash: { openingMinor: 0, closingMinor: 850_000, in: [], out: [] },
          feesDue: { openingMinor: 0, closingMinor: 100_000 },
          graPaidBy: 'agency',
          withholdingPendingMinor: 150_000,
        },
      }),
    );
    expect(f.agent!.rentTaxHeldBackMinor).toBe(0);
    expect(f.agent!.netRemittableMinor).toBe(850_000 - 100_000);
  });

  it('holds back the rest of the payable, never below zero, and nothing when the owner pays GRA', () => {
    const held = (payable: number, pending: number, graPaidBy: 'agency' | 'owner' = 'agency') =>
      ownerStatementFigures(
        agency({
          rentTaxPayable: { openingMinor: 0, closingMinor: payable },
          agent: {
            cash: { openingMinor: 0, closingMinor: 850_000, in: [], out: [] },
            feesDue: { openingMinor: 0, closingMinor: 0 },
            graPaidBy,
            withholdingPendingMinor: pending,
          },
        }),
      ).agent!;
    expect(held(200_000, 150_000).rentTaxHeldBackMinor).toBe(50_000);
    expect(held(200_000, 150_000).netRemittableMinor).toBe(800_000);
    expect(held(100_000, 150_000).rentTaxHeldBackMinor).toBe(0);
    expect(held(200_000, 0).rentTaxHeldBackMinor).toBe(200_000);
    expect(held(200_000, 150_000, 'owner').rentTaxHeldBackMinor).toBe(0);
  });
});

describe('AC-04 the agent’s cash identity can fail (M9 review, note 6)', () => {
  const statementWith = (entries: AgentCashEntry[], opening: number, closing: number) => {
    const m = agentCashMovements(entries);
    // The fees taken were due at the start, so the fees-due identity holds and only cash is tested.
    const taken = m.out.find((o) => o.kind === 'fees_taken')?.amountMinor ?? 0;
    return {
      movements: m,
      figures: ownerStatementFigures(
        agency({
          rentTaxPayable: { openingMinor: 0, closingMinor: 0 },
          agent: {
            cash: { openingMinor: opening, closingMinor: closing, in: m.in, out: m.out },
            feesDue: {
              openingMinor: taken + m.settledAtSourceMinor,
              closingMinor: 0,
              settledAtSourceMinor: m.settledAtSourceMinor,
            },
            graPaidBy: 'owner',
          },
        }),
      ),
    };
  };

  it('names every movement it knows: collections, funding, payments, remittances, reversals', () => {
    const entries: AgentCashEntry[] = [
      { rule: 'P22', cashMinor: 850_000, feesMinor: 0 },
      { rule: 'P28', cashMinor: 100_000, feesMinor: 0 },
      { rule: 'P30', cashMinor: 50_000, feesMinor: 0 },
      { rule: 'P15', cashMinor: -20_000, feesMinor: 0 },
      { rule: 'P18', cashMinor: -30_000, feesMinor: 0 },
      { rule: 'P12', cashMinor: -10_000, feesMinor: 0 },
      { rule: 'P16', cashMinor: -500_000, feesMinor: 60_000 },
      { rule: 'P21', reversedRule: 'P28', cashMinor: -100_000, feesMinor: 0 },
      { rule: 'P21', reversedRule: 'P15', cashMinor: 20_000, feesMinor: 0 },
      { rule: 'P21', reversedRule: 'P30', cashMinor: -50_000, feesMinor: 0 },
    ];
    const net = entries.reduce((s, e) => s + e.cashMinor, 0);
    const { movements, figures } = statementWith(entries, 10_000, 10_000 + net);
    expect(movements.unexplained).toEqual([]);
    const a = figures.agent!;
    expect(a.in).toMatchObject({ collections: 950_000, owner_funding: 50_000, other_in: 20_000 });
    expect(a.out).toMatchObject({
      expenses_paid: 20_000,
      rent_tax_paid: 30_000,
      refunds_paid: 10_000,
      fees_taken: 60_000,
      remittances: 440_000,
      reversals: 150_000,
    });
    expect(failedStatementChecks(figures)).toEqual([]);
  });

  it('fails when 1070 moved by a rule it cannot name, or the wrong way for its rule', () => {
    for (const odd of [
      { rule: 'P14', cashMinor: 5_000, feesMinor: 0 },
      { rule: 'P30', cashMinor: -5_000, feesMinor: 0 },
      { rule: 'P15', cashMinor: 5_000, feesMinor: 0 },
      { rule: 'P21', reversedRule: 'P15', cashMinor: -5_000, feesMinor: 0 },
    ] satisfies AgentCashEntry[]) {
      const entries: AgentCashEntry[] = [{ rule: 'P22', cashMinor: 100_000, feesMinor: 0 }, odd];
      const closing = 100_000 + odd.cashMinor;
      const { movements, figures } = statementWith(entries, 0, closing);
      expect(movements.unexplained).toEqual([odd]);
      const failed = failedStatementChecks(figures);
      expect(failed.map((c) => c.name)).toEqual(['agent_cash']);
      expect(failed[0]!.actualMinor - failed[0]!.expectedMinor).toBe(odd.cashMinor);
    }
  });

  it('balances whenever every movement is named, and fails by exactly what is not (property)', () => {
    const known = fc.oneof(
      fc.record({
        rule: fc.constantFrom('P03', 'P06', 'P07', 'P22', 'P28'),
        cashMinor: fc.integer({ min: 1, max: 1_000_000 }),
        feesMinor: fc.constant(0),
      }),
      fc.record({
        rule: fc.constantFrom('P15', 'P18', 'P33', 'P12', 'P13', 'P31'),
        cashMinor: fc.integer({ min: -1_000_000, max: -1 }),
        feesMinor: fc.constant(0),
      }),
      fc.record({
        rule: fc.constant('P16'),
        cashMinor: fc.integer({ min: -1_000_000, max: -1 }),
        feesMinor: fc.integer({ min: 0, max: 100_000 }),
      }),
    );
    const unknown = fc.record({
      rule: fc.constantFrom('P01', 'P02', 'P14', 'P17', 'P24', 'P27'),
      cashMinor: fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((n) => n !== 0),
      feesMinor: fc.constant(0),
    });
    fc.assert(
      fc.property(
        fc.array(known, { maxLength: 12 }),
        fc.array(unknown, { maxLength: 3 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (named, unnamed, opening) => {
          const entries = [...named, ...unnamed];
          // Remittances keep fees within their total, as P16 does.
          for (const e of entries)
            if (e.rule === 'P16') e.feesMinor = Math.min(e.feesMinor, -e.cashMinor);
          const net = entries.reduce((s, e) => s + e.cashMinor, 0);
          const { figures } = statementWith(entries, opening, opening + net);
          const check = figures.checks.find((c) => c.name === 'agent_cash')!;
          const missing = unnamed.reduce((s, e) => s + e.cashMinor, 0);
          expect(check.actualMinor - check.expectedMinor).toBe(missing);
          expect(check.passed).toBe(missing === 0);
        },
      ),
    );
  });
});
