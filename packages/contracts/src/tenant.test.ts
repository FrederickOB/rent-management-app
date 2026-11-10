import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { tenantContract } from './tenant';

describe('NFR-PERF the tenant app’s contracts entry (M11 decision 8)', () => {
  it('holds exactly the main contract’s tenant routers, unchanged', () => {
    expect(Object.keys(tenantContract).sort()).toEqual(
      ['me', 'tenantApp', 'tenantMessaging', 'tenantMoney', 'tenantRepairs'].sort(),
    );
    for (const key of Object.keys(tenantContract) as (keyof typeof tenantContract)[])
      expect(tenantContract[key]).toBe(contract[key]);
  });
});
