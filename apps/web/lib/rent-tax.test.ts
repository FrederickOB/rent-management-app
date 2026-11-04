import { describe, expect, it } from 'vitest';
import {
  dueCounts,
  dueLabel,
  dueList,
  dueState,
  emptyGraPayment,
  graPaymentForm,
  monthLabel,
  monthPeriod,
  owedOn,
  parsePeriod,
  periodWords,
  previousMonth,
  settlementPlan,
  tickedItems,
  type OwedItem,
} from './rent-tax';

/** A receipt of 1 Oct taxed GH₵80: due 31 Oct, alerted on 22 and 29 Oct (21 and 28 days). */
const item = (over: Partial<OwedItem> & Pick<OwedItem, 'id'>): OwedItem => ({
  status: 'open',
  valueDate: '2026-10-01',
  dueDate: '2026-10-31',

  receiptNumber: `RCT-${over.id}`,
  taxMinor: 8_000,
  outstandingMinor: 8_000,
  ...over,
});

describe('TX-02 the rent tax due-date tracker', () => {
  const open = item({ id: 'a' });

  it('is upcoming before the first alert', () => {
    expect(dueState(open, '2026-10-10')).toEqual({ kind: 'upcoming', daysLeft: 21 });
    expect(dueState({ ...open, alertsReached: [] }, '2026-10-10').kind).toBe('upcoming');
    expect(dueLabel(open, '2026-10-10')).toBe('Due 31 Oct 2026, in 21 days');
  });

  it('alerts at 21 days and at 28 days after the rent was received, as the API reads them', () => {
    const at21 = { ...open, alertsReached: [21] };
    const at28 = { ...open, alertsReached: [21, 28] };
    expect(dueState(at21, '2026-10-22')).toEqual({ kind: 'alert', day: 21, daysLeft: 9 });
    expect(dueLabel(at21, '2026-10-22')).toBe('21-day alert: due 31 Oct 2026, in 9 days');
    expect(dueState(at28, '2026-10-29')).toEqual({ kind: 'alert', day: 28, daysLeft: 2 });
    expect(dueLabel(at28, '2026-10-31')).toBe('28-day alert: due today, 31 Oct 2026');
  });

  it('is overdue after the due date', () => {
    expect(dueState(open, '2026-11-02')).toEqual({ kind: 'overdue', daysOver: 2 });
    expect(dueLabel(open, '2026-11-01')).toBe('Overdue by 1 day: it was due 31 Oct 2026');
  });

  it('raises no alert for an item withheld by the tenant, paid or reversed', () => {
    for (const status of ['withheld', 'paid', 'reversed'] as const) {
      expect(dueState(item({ id: 'b', status }), '2026-10-29')).toEqual({ kind: 'none' });
      expect(dueState(item({ id: 'b', status }), '2026-11-30')).toEqual({ kind: 'none' });
    }
    expect(dueLabel(item({ id: 'b', status: 'withheld' }), '2026-10-29')).toBe(
      'Withheld by the tenant',
    );
  });

  it('reads the alerts from the item, so a later rule never moves them', () => {
    const oneAlert = item({ id: 'c', alertsReached: [14] });
    expect(dueState(oneAlert, '2026-10-20')).toEqual({ kind: 'alert', day: 14, daysLeft: 11 });
    // A report's item, which carries no alerts, still says when it is due.
    expect(dueState(item({ id: 'd' }), '2026-10-29')).toEqual({ kind: 'upcoming', daysLeft: 2 });
  });

  it('lists only what is still owed to GRA, oldest due first, and counts the alerts', () => {
    const items = [
      item({
        id: 'late',
        valueDate: '2026-10-20',
        dueDate: '2026-11-19',
      }),
      item({ id: 'paid', status: 'paid', outstandingMinor: 0 }),
      item({ id: 'held', status: 'withheld' }),
      item({
        id: 'early',
        valueDate: '2026-09-25',
        dueDate: '2026-10-25',
      }),
      item({ id: 'part', status: 'part_paid', outstandingMinor: 3_000, alertsReached: [21, 28] }),
    ];
    expect(dueList(items).map((i) => i.id)).toEqual(['early', 'part', 'late']);
    expect(dueCounts(items, '2026-10-29')).toEqual({ overdue: 1, alerted: 1 });
  });
});

describe('TX-03 a GRA payment settles the tax items it is for, oldest first by default', () => {
  const items = [
    item({ id: 'nov', valueDate: '2026-11-01', dueDate: '2026-12-01', outstandingMinor: 8_000 }),
    item({ id: 'sep', valueDate: '2026-09-01', dueDate: '2026-10-01', outstandingMinor: 8_000 }),
    item({ id: 'oct', valueDate: '2026-10-01', dueDate: '2026-10-31', outstandingMinor: 12_000 }),
    item({ id: 'gone', status: 'withheld', outstandingMinor: 1_500 }),
  ];

  it('pays the oldest items first, the last one part paid', () => {
    expect(settlementPlan(items, 14_000, null)).toEqual({
      lines: [
        { itemId: 'sep', amountMinor: 8_000 },
        { itemId: 'oct', amountMinor: 6_000 },
      ],
      unappliedMinor: 0,
    });
    expect(tickedItems(items, 14_000, null)).toEqual(['sep', 'oct']);
    expect(tickedItems(items, null, null)).toEqual([]);
  });

  it('pays only the items ticked by hand, still oldest first', () => {
    expect(settlementPlan(items, 20_000, ['nov', 'oct'])).toEqual({
      lines: [
        { itemId: 'oct', amountMinor: 12_000 },
        { itemId: 'nov', amountMinor: 8_000 },
      ],
      unappliedMinor: 0,
    });
    expect(owedOn(items, ['nov', 'oct', 'gone'])).toBe(20_000);
  });

  it('never settles an item withheld by the tenant, and says what is left over', () => {
    expect(settlementPlan(items, 30_000, ['oct', 'gone'])).toEqual({
      lines: [{ itemId: 'oct', amountMinor: 12_000 }],
      unappliedMinor: 18_000,
    });
  });

  const today = '2026-11-03';
  const draft = {
    ...emptyGraPayment(today, true),
    amount: '140',
    graReceiptNumber: ' GRA-2026-0042 ',
    paidFrom: 'agency_account' as const,
  };

  it('turns the form into the API’s input, with what each item takes', () => {
    expect(graPaymentForm(draft, { ownerId: 'owner-1', items }, today).input).toEqual({
      ownerId: 'owner-1',
      paidOn: today,
      amountMinor: 14_000,
      graReceiptNumber: 'GRA-2026-0042',
      paidFrom: 'agency_account',
      note: null,
      items: [
        { itemId: 'sep', amountMinor: 8_000 },
        { itemId: 'oct', amountMinor: 6_000 },
      ],
    });
  });

  it('refuses a payment larger than the items ticked owe', () => {
    const parsed = graPaymentForm({ ...draft, chosen: ['sep'] }, { ownerId: 'o', items }, today);
    expect(parsed.input).toBeNull();
    expect(parsed.errors.items).toBe(
      'The items ticked owe GH₵80.00, less than the payment. Tick more items, or check the amount.',
    );
  });

  it('asks for the receipt number, the account, a past date and some items', () => {
    const parsed = graPaymentForm(
      {
        ...emptyGraPayment(today, true),
        amount: '10',
        paidOn: '2026-11-04',
        chosen: [],
      },
      { ownerId: 'o', items },
      today,
    );
    expect(parsed.errors).toEqual({
      paidOn: 'The date cannot be in the future',
      graReceiptNumber: 'Enter the number on the GRA receipt',
      paidFrom: 'Choose the account it was paid from',
      items: 'Tick the tax items this payment settles',
    });
    expect(graPaymentForm(draft, { ownerId: 'o', items: [items[3]!] }, today).errors.items).toBe(
      'Nothing is owed to GRA for this owner',
    );
    expect(graPaymentForm(draft, { ownerId: null, items }, today).errors.items).toBe(
      'Choose the owner first',
    );
  });

  it('starts a landlord on their own account; an agency chooses', () => {
    expect(emptyGraPayment(today, false).paidFrom).toBe('owner_account');
    expect(emptyGraPayment(today, true).paidFrom).toBe('');
  });
});

describe('TX-03 the rent tax report’s period', () => {
  it('reads a whole month, leap years included', () => {
    expect(monthPeriod('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthPeriod('2026-13')).toBeNull();
    expect(monthPeriod('2026-1')).toBeNull();
    expect(previousMonth('2026-01-15')).toBe('2025-12');
    expect(monthLabel('2026-11')).toBe('November 2026');
  });

  it('names a whole month by its name, anything else by its dates', () => {
    expect(periodWords({ from: '2026-11-01', to: '2026-11-30' })).toBe('November 2026');
    expect(periodWords({ from: '2026-10-01', to: '2026-12-31' })).toBe('1 Oct 2026 to 31 Dec 2026');
  });

  it('takes a period from the address only when both dates are real and in order', () => {
    expect(parsePeriod('2026-10-01', '2026-10-31')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(parsePeriod('2026-10-31', '2026-10-01')).toBeNull();
    expect(parsePeriod('2026-02-30', '2026-03-01')).toBeNull();
    expect(parsePeriod(null, '2026-03-01')).toBeNull();
  });
});
