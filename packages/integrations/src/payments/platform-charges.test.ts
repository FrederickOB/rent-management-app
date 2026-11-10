import { describe, expect, it } from 'vitest';
import { platformChargesContract } from '../testing/platform-charges.contract';
import { InMemoryPayments, isPlatformReference, PLATFORM_REFERENCE_PREFIX } from './payments';

platformChargesContract('in-memory', () => ({ port: new InMemoryPayments('sk_test_unit') }));

describe('PB-07 platform references', () => {
  it('start SUB-, which routes them to subscriptions and never to rent (decision 9)', () => {
    expect(PLATFORM_REFERENCE_PREFIX).toBe('SUB-');
    expect(isPlatformReference('SUB-0192f5a8111172228333444455556666')).toBe(true);
    expect(isPlatformReference('pi-0192f5a8111172228333444455556666')).toBe(false);
    expect(isPlatformReference('ext-12')).toBe(false);
    expect(isPlatformReference('sub-lowercase')).toBe(false);
  });

  it('in memory, settles the platform’s exact amounts apart from rent', async () => {
    const port = new InMemoryPayments('sk_test_unit');
    await port.initializePlatform({
      reference: 'SUB-exact-1',
      amountMinor: 20_000,
      currency: 'GHS',
      email: 'payer@example.test',
      metadata: {},
    });
    await port.chargePlatformMomo({
      reference: 'SUB-exact-2',
      amountMinor: 5_000,
      currency: 'GHS',
      email: 'payer@example.test',
      phone: '+233200000123',
      network: 'telecel',
      metadata: {},
    });
    await port.completeCharge('SUB-exact-1', { status: 'success', feesMinor: 300 });
    await port.completeCharge('SUB-exact-2', { status: 'success', feesMinor: 75 });
    expect(await port.settle()).toEqual([
      expect.objectContaining({
        subaccountCode: '',
        grossMinor: 25_000,
        feesMinor: 375,
        deductionsMinor: 0,
        netMinor: 24_625,
        references: ['SUB-exact-1', 'SUB-exact-2'],
      }),
    ]);
  });
});
