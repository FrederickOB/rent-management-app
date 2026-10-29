import { MAX_UNITS_PER_REQUEST } from '@rent/domain/portfolio';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { registerContract } from './register';

const input = (procedure: { '~orpc': { inputSchema?: unknown } }) =>
  procedure['~orpc'].inputSchema as z.ZodType;

const blocksOf = (units: number) =>
  Array.from({ length: Math.ceil(units / 200) }, (_, i) => ({
    code: `B${i + 1}`,
    units: [{ unitType: 'single_room', count: Math.min(200, units - i * 200) }],
  }));

const property = (blocks: unknown[]) => ({
  areaCode: 'ACC',
  propertyPart: 'BIG',
  name: 'Big estate',
  propertyType: 'gated_estate',
  use: 'residential',
  address: { region: 'Greater Accra' },
  blocks,
});

describe('PR-01 bulk creation limits (API contract)', () => {
  it(`accepts ${MAX_UNITS_PER_REQUEST} units in one request and refuses one more`, () => {
    const schema = input(registerContract.createProperty);
    expect(schema.safeParse(property(blocksOf(MAX_UNITS_PER_REQUEST))).success).toBe(true);
    const refused = schema.safeParse(property(blocksOf(MAX_UNITS_PER_REQUEST + 1)));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.message)).toEqual([
      'Add at most 5,000 units at a time',
    ]);
  });

  it('counts the default block’s units only when there are no blocks, as the service does', () => {
    const schema = input(registerContract.createProperty);
    const units = [{ unitType: 'single_room', count: 200 }];
    expect(schema.safeParse({ ...property(blocksOf(MAX_UNITS_PER_REQUEST)), units }).success).toBe(
      true,
    );
  });
});
