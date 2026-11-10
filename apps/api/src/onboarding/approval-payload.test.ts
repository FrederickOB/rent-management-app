import { openingBalancesApprovalSchema } from '@rent/contracts';
import { openingApprovalPayload, openingApprovalSchema } from '@rent/server/onboarding';
import { describe, expect, it } from 'vitest';

const OWNER = '019a3000-0000-7000-8000-00000000a021';
const BATCH = '019a3000-0000-7000-8000-00000000b021';

/** M11 review C2: the `opening_balances` request carries what its approval card shows. */
describe('P25 the opening balances approval payload (M11 review C2)', () => {
  const figures = {
    arrearsMinor: 70_000,
    advancesMinor: 300_000,
    depositsMinor: 200_000,
    withholdingMinor: 30_000,
    agentCashMinor: 50_000,
    rentTaxOutstandingMinor: 24_000,
  };
  const payload = openingApprovalPayload(
    {
      id: BATCH,
      kind: 'balances',
      cutOverDate: '2026-11-01',
      fileName: 'balances.xlsx',
      report: {
        sha256: 'a'.repeat(64),
        counts: {},
        issues: [],
        issueCount: 0,
        totals: figures,
        summary: { leases: 3, owners: [{ ownerId: OWNER, ...figures }] },
      },
    },
    new Map([[OWNER, 'Opening Owner']]),
  );

  it('is what the contract’s approval schema reads, field for field', () => {
    expect(openingBalancesApprovalSchema.parse(payload)).toEqual(payload);
    expect(payload).toEqual({
      batchId: BATCH,
      kind: 'balances',
      cutOverDate: '2026-11-01',
      fileName: 'balances.xlsx',
      link: '/onboarding',
      leases: 3,
      owners: [{ owner: { id: OWNER, name: 'Opening Owner' }, ...figures }],
      totals: figures,
    });
  });

  it('is checked by the server with the same shape as the contract', () => {
    const contract = openingBalancesApprovalSchema.parse(payload);
    expect(openingApprovalSchema.parse(contract)).toEqual(contract);
    expect(() => openingApprovalSchema.parse({ ...payload, link: '/elsewhere' })).toThrow();
    expect(() => openingBalancesApprovalSchema.parse({ ...payload, link: '/elsewhere' })).toThrow();
  });
});
