import { describe, expect, it } from 'vitest';
import { billingStartChoices, billingStartNote } from './billing-start';

describe('decision 1 where billing starts for a lease recorded on paper', () => {
  const terms = { startDate: '2026-07-15', periodCount: 12 };

  it('defaults to the first rent period that starts on or after today, and offers every period start', () => {
    const { defaultStart, choices } = billingStartChoices(terms, '2026-10-30');
    expect(defaultStart).toBe('2026-11-15');
    expect(choices).toHaveLength(12);
    expect(choices[0]).toEqual({
      value: '2026-07-15',
      label: '15 Jul 2026, the first day of the lease',
    });
    expect(choices.find((c) => c.value === '2026-11-15')?.label).toBe(
      '15 Nov 2026, the default: the first period from today',
    );
    expect(choices.at(-1)?.value).toBe('2027-06-15');
  });

  it('starts on the lease’s first day when it has not started yet', () => {
    expect(
      billingStartChoices({ startDate: '2026-12-01', periodCount: 12 }, '2026-10-30').defaultStart,
    ).toBe('2026-12-01');
  });

  it('offers the first held-over month for a lease whose term has passed', () => {
    const { defaultStart, choices } = billingStartChoices(
      { startDate: '2025-01-10', periodCount: 12 },
      '2026-10-30',
    );
    expect(defaultStart).toBe('2026-01-10');
    expect(choices.at(-1)).toEqual({
      value: '2026-01-10',
      label: '10 Jan 2026, the default: the first period from today',
    });
  });

  it('says what an earlier or a later start means, and that no deposit is invoiced after the first day', () => {
    const base = { defaultStart: '2026-11-15', leaseStart: '2026-07-15', hasDeposit: false };
    expect(billingStartNote({ ...base, chosen: '2026-11-15' })).toBeNull();
    expect(billingStartNote({ ...base, chosen: '2026-08-15' })).toBe(
      'Rent from 15 Aug 2026 is invoiced at once, and shows as arrears until it is paid.',
    );
    expect(billingStartNote({ ...base, chosen: '2027-01-15' })).toBe(
      'Months before 15 Jan 2027 are never invoiced. Choose this when the tenant paid them before you used the platform.',
    );
    expect(billingStartNote({ ...base, chosen: '2026-11-15', hasDeposit: true })).toContain(
      'No deposit invoice is issued',
    );
    expect(billingStartNote({ ...base, chosen: '2026-07-15', hasDeposit: true })).toBe(
      'Rent from 15 Jul 2026 is invoiced at once, and shows as arrears until it is paid.',
    );
  });
});
