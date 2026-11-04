import { describe, expect, it } from 'vitest';
import { dueRuleText, taxItemLabel } from './rent-tax';

describe('TX-02 and TX-08 the due rule is said from the items’ rules rows, never from the code', () => {
  it('says the due days and alert days the rules rows hold', () => {
    expect(
      dueRuleText([
        { dueDays: 30, alertDays: [28, 21] },
        { dueDays: 30, alertDays: [21, 28] },
      ]),
    ).toEqual({
      due: 'due 30 days after the rent was received',
      alerts: 'at 21 and 28 days',
    });
  });

  it('names each rule version’s days when items differ', () => {
    expect(
      dueRuleText([
        { dueDays: 30, alertDays: [21, 28] },
        { dueDays: 45, alertDays: [30] },
      ]),
    ).toEqual({
      due: 'due 30 and 45 days after the rent was received',
      alerts: 'at 21 and 28 days or at 30 days, by each item’s rule',
    });
  });

  it('falls back to each item’s own date when the API gives no days', () => {
    expect(dueRuleText([{}, { dueDays: null }])).toEqual({
      due: 'due by the date shown on each item',
      alerts: null,
    });
    expect(dueRuleText([])).toEqual({ due: 'due by the date shown on each item', alerts: null });
  });
});

describe('TX-04 tax on cash a withholding released is labelled plainly', () => {
  it('names a receipt’s tax that a withholding moved to another month', () => {
    expect(taxItemLabel({ kind: 'receipt', withholdingId: 'w-1' })).toBe(
      'Tax on rent this payment now covers, after the withholding moved it',
    );
    expect(taxItemLabel({ kind: 'receipt', withholdingId: null })).toBe('Rent received');
    expect(taxItemLabel({ kind: 'withholding', withholdingId: 'w-1' })).toBe(
      'Withheld by the tenant',
    );
  });
});
