import { describe, expect, it } from 'vitest';
import { OWNER_COLUMNS, onboardingWorkbookHeaders } from './rows';

describe('PR-08 onboarding: the workbooks’ sheets and headers (M11 decision 2)', () => {
  it('lists each workbook’s sheets in order, with every header once', () => {
    expect(onboardingWorkbookHeaders('tenancies').map((s) => s.sheet)).toEqual([
      'Tenants',
      'Leases',
    ]);
    expect(onboardingWorkbookHeaders('balances').map((s) => s.sheet)).toEqual([
      'Arrears',
      'Advances',
      'Deposits',
      'Withholding',
      'Owner items',
    ]);
    expect(onboardingWorkbookHeaders('adjustment')).toEqual(onboardingWorkbookHeaders('balances'));
    expect(onboardingWorkbookHeaders('register')).toEqual([
      { sheet: 'Owners', headers: OWNER_COLUMNS.map((c) => c.header) },
    ]);
    for (const book of ['register', 'tenancies', 'balances', 'adjustment'] as const)
      for (const { headers } of onboardingWorkbookHeaders(book))
        expect(new Set(headers).size).toBe(headers.length);
  });
});
