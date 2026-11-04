import { describe, expect, it } from 'vitest';
import { providerCostToMinor } from './money';

describe('CM-12 provider costs', () => {
  it('rounds a provider decimal half up to the pesewa, exactly', () => {
    expect(providerCostToMinor('0.0246').amountMinor).toBe(2);
    expect(providerCostToMinor('0.025').amountMinor).toBe(3);
    expect(providerCostToMinor('0.0249999').amountMinor).toBe(2);
    expect(providerCostToMinor('1.5').amountMinor).toBe(150);
    expect(providerCostToMinor('12').amountMinor).toBe(1200);
    expect(() => providerCostToMinor('1e-3')).toThrow();
  });
});
