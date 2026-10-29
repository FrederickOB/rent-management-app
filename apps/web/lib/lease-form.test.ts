import { describe, expect, it } from 'vitest';
import {
  amountInput,
  emptyParty,
  emptyTerms,
  endAfterMonths,
  partiesInput,
  partyErrors,
  projectedSchedule,
  serviceContacts,
  termsFromDraft,
  type TermsDraft,
} from './lease-form';

const terms = (overrides: Partial<TermsDraft> = {}): TermsDraft => ({
  ...emptyTerms('2026-11-01'),
  monthlyRent: '1,500.50',
  ...overrides,
});

describe('TL-06 lease terms in the builder', () => {
  it('sends cedis typed by a person as integer pesewas', () => {
    const { input, errors } = termsFromDraft(
      terms({ deposit: '3001', serviceCharge: 'GH₵ 120', initialAdvanceMonths: '' }),
    );
    expect(errors).toEqual({});
    expect(input).toEqual({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      monthlyRentMinor: 150_050,
      cycle: 'monthly',
      initialAdvanceMonths: null,
      depositMinor: 300_100,
      serviceChargeMonthlyMinor: 12_000,
      steps: [],
      breakClause: null,
      noticeDays: 30,
    });
  });

  it('refuses what the domain refuses, on the field it belongs to', () => {
    expect(termsFromDraft(terms({ endDate: '2026-10-01' })).errors.endDate).toMatch(/end after/);
    expect(termsFromDraft(terms({ endDate: '2027-01-31', cycle: 'annual' })).errors.cycle).toMatch(
      /longer than the lease/,
    );
    expect(
      termsFromDraft(terms({ initialAdvanceMonths: '24' })).errors.initialAdvanceMonths,
    ).toMatch(/1 to 12 months/);
    expect(
      termsFromDraft(
        terms({ steps: [{ key: 's1', effectiveFrom: '2027-03-15', monthlyRent: '1800' }] }),
      ).errors.steps,
    ).toMatch(/later rent period/);
    expect(termsFromDraft(terms({ monthlyRent: '15.555' })).errors.monthlyRent).toMatch(/cedis/);
    expect(termsFromDraft(terms({ monthlyRent: '' })).errors.monthlyRent).toBe(
      'Enter the monthly rent',
    );
    expect(termsFromDraft(terms({ noticeDays: 'a month' })).errors.noticeDays).toBeDefined();
  });

  it('takes a rent change on a period start and a break clause', () => {
    const { input, errors } = termsFromDraft(
      terms({
        steps: [{ key: 's1', effectiveFrom: '2027-05-01', monthlyRent: '1800' }],
        breakClause: {
          fromDate: '2027-05-01',
          party: 'either',
          noticeDays: '60',
          creditUnusedDays: true,
        },
      }),
    );
    expect(errors).toEqual({});
    expect(input?.steps).toEqual([{ effectiveFrom: '2027-05-01', monthlyRentMinor: 180_000 }]);
    expect(input?.breakClause).toEqual({
      fromDate: '2027-05-01',
      party: 'either',
      noticeDays: 60,
      creditUnusedDays: true,
    });
  });

  it('projects the monthly schedule anchored on the start, whatever the cycle', () => {
    const { terms: checked } = termsFromDraft(terms({ cycle: 'quarterly' }));
    const rows = projectedSchedule(checked);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    expect(rows.every((r) => r.amountMinor === 150_050)).toBe(true);
    expect(projectedSchedule(null)).toEqual([]);
  });

  it('works out the last day of a term, and shows stored pesewas for editing', () => {
    expect(endAfterMonths('2026-11-01', 12)).toBe('2027-10-31');
    expect(endAfterMonths('2026-01-31', 1)).toBe('2026-02-27');
    expect(endAfterMonths('not a date', 12)).toBe('');
    expect(amountInput(150_000)).toBe('1500.00');
    expect(amountInput(5)).toBe('0.05');
    expect(amountInput(1_234_567_89)).toBe('1234567.89');
    expect(amountInput(null)).toBe('');
  });
});

describe('TL-07 and decision 7 the people who sign', () => {
  it('needs a name, and a valid phone or email when one is given', () => {
    const ok = { ...emptyParty('tenant', 'Ama Mensah'), phone: '020 000 0099' };
    const noName = emptyParty('witness');
    const badPhone = { ...emptyParty('guarantor', 'Yaa'), phone: '12' };
    const errors = partyErrors([ok, noName, badPhone]);
    expect(errors[ok.key]).toBeUndefined();
    expect(errors[noName.key]).toMatch(/name/);
    expect(errors[badPhone.key]).toMatch(/phone/);
    expect(partiesInput([ok])).toEqual([
      {
        role: 'tenant',
        name: 'Ama Mensah',
        phone: '+233200000099',
        email: null,
        tenantContactId: null,
        staffPersonId: null,
        required: true,
      },
    ]);
  });

  it('records when each person signed a paper lease, never in the future', () => {
    const signed = { ...emptyParty('tenant', 'Ama Mensah'), paperSignedOn: '2026-10-30' };
    expect(partyErrors([signed], { paper: true, today: '2026-10-29' })[signed.key]).toMatch(
      /future/,
    );
    expect(partiesInput([{ ...signed, paperSignedOn: '' }], { paper: true })[0]).toMatchObject({
      paperSignedOn: null,
    });
  });
});

describe('prd-issues 25 electronic-service contacts', () => {
  it('takes up to five phones and emails, one per line or separated by commas', () => {
    expect(serviceContacts('020 000 0099, +233244123456', 'ama@example.com')).toEqual({
      phones: ['+233200000099', '+233244123456'],
      emails: ['ama@example.com'],
      problem: null,
    });
    expect(serviceContacts('12', '').problem).toMatch(/not a phone number/);
    expect(serviceContacts('', 'not-an-email').problem).toMatch(/not an email/);
  });
});
