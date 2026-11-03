import { describe, expect, it } from 'vitest';
import {
  emptyRefundPaid,
  emptyRow,
  emptyTermination,
  endedEarly,
  mayRequestAgain,
  previewInput,
  refundPaidForm,
  requestSummary,
  terminationForm,
  terminationNext,
  terminationSteps,
  type TerminationFigures,
} from './termination';

/** A lease ending on 15 Nov after a year paid ahead, with a break clause that credits unused days. */
const figures: TerminationFigures = {
  lastDay: '2026-11-15',
  endDate: '2027-10-31',
  breakClauseCreditsUnusedDays: true,
  creditBeforeMinor: 1_050_000,
  chargesMinor: 50_000,
  unusedDays: [
    {
      lineId: 'r11',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      unusedDays: 15,
      periodDays: 30,
      creditMinor: 75_000,
    },
  ],
  unusedDaysCreditMinor: 75_000,
  appliedMinor: 50_000,
  creditLeftMinor: 1_075_000,
  deductionsMinor: 25_000,
  refundMinor: 1_050_000,
  arrearsMinor: 0,
};
const asked = {
  charges: [{ description: 'Early termination fee', amountMinor: 50_000 }],
  deductions: [{ description: 'Broken window, agreed', amountMinor: 25_000 }],
};

describe('AR-04 the early termination settlement is shown step by step', () => {
  it('shows charges, the unused-day credit, the prepayment applied, deductions, the refund and what is owed', () => {
    const steps = terminationSteps(figures, asked);
    expect(steps.map((s) => s.title)).toEqual([
      '1. Agreed termination charges',
      '2. Unused days of the last month',
      '3. Prepayment applied to open charges, oldest first',
      '4. Deductions agreed with the tenant',
      '5. Refund to the tenant',
      '6. Still owed',
    ]);
    expect(steps[0]).toMatchObject({
      lines: [{ label: 'Early termination fee', amount: 'GH₵500.00' }],
      total: 'GH₵500.00',
    });
    expect(steps[1]).toMatchObject({
      lines: [{ label: '1 Nov 2026 to 30 Nov 2026: 15 of 30 days unused', amount: 'GH₵750.00' }],
      note: 'Credited because the break clause allows it. The tenancy ended on 15 Nov 2026.',
    });
    expect(steps[2]).toMatchObject({
      total: 'GH₵500.00',
      note: 'GH₵10,500.00 was paid ahead. GH₵10,750.00 is left once the open charges are paid.',
    });
    expect(steps[3]?.total).toBe('GH₵250.00');
    expect(steps[4]?.total).toBe('GH₵10,500.00');
    expect(steps[5]).toMatchObject({ total: 'GH₵0.00', note: 'Nothing is owed.' });
  });

  it('says the month is not prorated when the break clause does not credit unused days', () => {
    const steps = terminationSteps(
      { ...figures, breakClauseCreditsUnusedDays: false, unusedDays: [], unusedDaysCreditMinor: 0 },
      { charges: [], deductions: [] },
    );
    expect(steps[0]).toMatchObject({ lines: [], total: null, note: 'None agreed.' });
    expect(steps[1]).toMatchObject({
      lines: [],
      total: null,
      note: 'The lease’s break clause does not credit unused days, so the last month is not prorated.',
    });
  });

  it('leaves open lines as arrears when the prepayment does not cover them', () => {
    const steps = terminationSteps(
      { ...figures, creditLeftMinor: 0, refundMinor: 0, arrearsMinor: 20_000 },
      asked,
    );
    expect(steps[4]).toMatchObject({ total: 'GH₵0.00', note: 'Nothing is left to refund.' });
    expect(steps[5]?.note).toContain('stay as arrears');
  });
});

describe('AR-04 the refund is asked for, less agreed deductions, for a second person to approve', () => {
  it('asks for nothing but the settlement when nothing is charged or deducted', () => {
    expect(terminationForm(emptyTermination, 1_075_000)).toEqual({
      input: { charges: [], deductions: [], note: null },
      errors: {},
      deductionsMinor: 0,
      refundMinor: 1_075_000,
    });
  });

  it('takes agreed charges and deductions, each with what it is for', () => {
    const parsed = terminationForm(
      {
        charges: [{ description: ' Early exit fee ', amount: '500' }, emptyRow],
        deductions: [
          { description: 'Broken window, agreed', amount: '250' },
          { description: 'Keys not returned', amount: '50' },
        ],
        note: ' Agreed at the move-out ',
      },
      1_025_000,
    );
    expect(parsed.input).toEqual({
      charges: [{ description: 'Early exit fee', amountMinor: 50_000 }],
      deductions: [
        { description: 'Broken window, agreed', amountMinor: 25_000 },
        { description: 'Keys not returned', amountMinor: 5_000 },
      ],
      note: 'Agreed at the move-out',
    });
    expect(parsed.deductionsMinor).toBe(30_000);
    expect(parsed.refundMinor).toBe(995_000);
  });

  it('says which row is wrong', () => {
    expect(
      terminationForm(
        {
          charges: [{ description: 'x', amount: '500' }],
          deductions: [{ description: 'Paint', amount: 'lots' }],
          note: '',
        },
        1_000,
      ).errors,
    ).toEqual({
      'charges.0.description': 'Say what the charge is for',
      'deductions.0.amount': 'Enter an amount in cedis, such as 1500 or 1,500.50',
    });
  });

  it('never deducts more than is left, and waits for the figures before saying the refund', () => {
    expect(
      terminationForm(
        { ...emptyTermination, deductions: [{ description: 'Damage', amount: '20000' }] },
        1_075_000,
      ).errors,
    ).toEqual({ deductions: 'Deductions cannot be more than is left to refund: GH₵10,750.00' });
    const waiting = terminationForm(emptyTermination, null);
    expect(waiting.refundMinor).toBeNull();
    expect(waiting.input).toEqual({ charges: [], deductions: [], note: null });
  });

  it('previews only the rows typed in full', () => {
    expect(
      previewInput({
        charges: [
          { description: 'Early exit fee', amount: '500' },
          { description: 'Clean', amount: '' },
          emptyRow,
        ],
        deductions: [{ description: 'Paint', amount: '100' }],
      }),
    ).toEqual({
      charges: [{ description: 'Early exit fee', amountMinor: 50_000 }],
      deductions: [{ description: 'Paint', amountMinor: 10_000 }],
    });
  });

  it('says what is left to do after approval, and allows a new request only after a rejection', () => {
    expect(terminationNext('settled', 995_000)).toBe(
      'Pay the tenant GH₵9,950.00 outside the platform, then record it here with the reference and proof.',
    );
    expect(terminationNext('settled', 0)).toBe('Nothing is left to refund.');
    expect(terminationNext('refund_paid', 995_000)).toBeNull();
    expect(mayRequestAgain(null)).toBe(true);
    expect(mayRequestAgain('rejected')).toBe(true);
    expect(mayRequestAgain('awaiting_approval')).toBe(false);
    expect(mayRequestAgain('settled')).toBe(false);
  });

  it('records the refund as paid with a reference, never before it was approved', () => {
    const today = '2026-11-20';
    const draft = { ...emptyRefundPaid(today, false), reference: ' GCB-TRF-778 ' };
    expect(refundPaidForm(draft, '2026-11-18', today)).toEqual({
      input: { paidOn: today, reference: 'GCB-TRF-778', paidFrom: 'owner_account' },
      errors: {},
    });
    expect(
      refundPaidForm({ ...draft, paidOn: '2026-11-17' }, '2026-11-18', today).errors.paidOn,
    ).toBe('It cannot be paid before it was approved, on 18 Nov 2026');
    expect(refundPaidForm(emptyRefundPaid(today, true), null, today).errors).toEqual({
      reference: 'Enter the transfer or MoMo reference',
      paidFrom: 'Choose the account it was paid from',
    });
  });
});

describe('AR-04 early termination is offered once a move-out ends a lease before its end date', () => {
  const lease = (moveOutDate: string | null) => ({
    terms: { endDate: '2027-10-31' },
    lifecycle: { moveOutDate },
  });
  it('offers it for a move-out before the end, never at the end or without one', () => {
    expect(endedEarly(lease('2026-11-15'))).toBe(true);
    expect(endedEarly(lease('2027-10-31'))).toBe(false);
    expect(endedEarly(lease(null))).toBe(false);
  });
});

describe('AR-04 a request already made shows its figures as asked', () => {
  it('lists the last day, each charge, the credit, the prepayment applied, each deduction and the refund', () => {
    expect(
      requestSummary({
        lastDay: '2026-11-15',
        ...asked,
        chargesMinor: 50_000,
        unusedDaysCreditMinor: 75_000,
        appliedMinor: 50_000,
        deductionsMinor: 25_000,
        refundMinor: 1_050_000,
      }),
    ).toEqual([
      { label: 'Last day of the tenancy', value: '15 Nov 2026' },
      { label: 'Charge: Early termination fee', value: 'GH₵500.00' },
      { label: 'Unused days credited', value: 'GH₵750.00' },
      { label: 'Prepayment applied to open charges', value: 'GH₵500.00' },
      { label: 'Deduction: Broken window, agreed', value: 'GH₵250.00' },
      { label: 'Refund to the tenant', value: 'GH₵10,500.00' },
    ]);
  });
});
