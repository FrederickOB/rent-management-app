import { describe, expect, it } from 'vitest';
import { differsWarning, optionLines, suggestionFor, type OptionLine } from './withholding';

const rent: OptionLine = {
  lineId: 'rent-nov',
  invoiceNumber: 'INV-000201',
  kind: 'rent',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  netMinor: 1_000_000,
  outstandingMinor: 1_000_000,
  suggestedMinor: 150_000,
};

describe('TX-04 the withholding form offers the API’s months and rate, and warns before an amount that differs', () => {
  it('lists the started months still owed, in words', () => {
    expect(
      optionLines([rent, { ...rent, lineId: 'sc', kind: 'service_charge', suggestedMinor: 4_500 }]),
    ).toEqual([
      {
        id: 'rent-nov',
        invoiceNumber: 'INV-000201',
        label: 'Rent, 1 Nov 2026 to 30 Nov 2026',
        netMinor: 1_000_000,
        outstandingMinor: 1_000_000,
        suggestedMinor: 150_000,
      },
      expect.objectContaining({ id: 'sc', label: 'Service charge, 1 Nov 2026 to 30 Nov 2026' }),
    ]);
  });

  it('suggests the API’s amount, and the rate when the API gave none', () => {
    const [line] = optionLines([{ ...rent, suggestedMinor: 120_000 }]);
    expect(suggestionFor(line!, 1500)).toBe('1200.00');
    expect(suggestionFor({ ...line!, suggestedMinor: undefined }, 1500)).toBe('1500.00');
  });

  it('warns before recording an amount that is not the rate, naming the line', () => {
    const lines = optionLines([
      rent,
      { ...rent, lineId: 'dec', periodStart: '2026-12-01', periodEnd: '2026-12-31' },
    ]);
    expect(differsWarning(['rent-nov'], lines, 1500)).toBe(
      'This amount is not 15% of the line: INV-000201 Rent, 1 Nov 2026 to 30 Nov 2026. Check against the tenant’s advice or certificate before recording; it is recorded as typed.',
    );
    expect(differsWarning(['rent-nov', 'dec'], lines, 1500)).toMatch(
      /^These amounts are not 15% of the lines: /,
    );
    expect(differsWarning([], lines, 1500)).toBeNull();
  });
});
