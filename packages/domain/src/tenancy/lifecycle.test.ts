import { describe, expect, it } from 'vitest';
import { defaultCompanySettings, mergeCompanySettings, tenancySettingsOf } from '../settings';
import { isKnownRuleKey, parseRuleValue } from '../rules';
import {
  buildLeaseDocument,
  leasePlaceholderValues,
  type LeaseDocumentFacts,
} from './lease-document';
import { checkLeaseTerms } from './lease-terms';
import {
  holdingOverSchedule,
  leaseTrackers,
  reminderToSend,
  renewalStartDate,
  scheduledTransition,
} from './lifecycle';
import { rentSchedule } from './schedule';
import { STARTER_TEMPLATES } from './starter-templates';

describe('TL-09 lease transitions as the days pass', () => {
  const lease = { startDate: '2026-11-01', endDate: '2027-10-31', renewalStart: null };

  it('starts a signed lease on its start date, not before', () => {
    expect(scheduledTransition({ ...lease, status: 'signed' }, '2026-10-31')).toBeNull();
    expect(scheduledTransition({ ...lease, status: 'signed' }, '2026-11-01')).toEqual({
      to: 'active',
      activatedOn: '2026-11-01',
    });
  });

  it('holds a lease over after its end date when no renewal has started (OQ-12)', () => {
    expect(scheduledTransition({ ...lease, status: 'active' }, '2027-10-31')).toBeNull();
    expect(scheduledTransition({ ...lease, status: 'active' }, '2027-11-01')).toEqual({
      to: 'holding_over',
      holdingOverSince: '2027-11-01',
    });
  });

  it('ends a lease on its end date once its renewal has started, so there is no gap', () => {
    const renewed = { ...lease, renewalStart: '2027-11-01' };
    expect(scheduledTransition({ ...renewed, status: 'active' }, '2027-11-01')).toEqual({
      to: 'ended',
      endReason: 'renewed',
      endedOn: '2027-10-31',
    });
    // Held over first, then renewed from the next rent period.
    const late = { ...lease, renewalStart: '2028-01-01' };
    expect(scheduledTransition({ ...late, status: 'holding_over' }, '2027-12-15')).toBeNull();
    expect(scheduledTransition({ ...late, status: 'holding_over' }, '2028-01-01')).toEqual({
      to: 'ended',
      endReason: 'renewed',
      endedOn: '2027-12-31',
    });
  });

  it('starts a renewal the day after the old lease ends, or at the next rent period once it is held over', () => {
    expect(renewalStartDate(lease, '2027-08-01')).toBe('2027-11-01');
    expect(renewalStartDate({ startDate: '2026-01-31', endDate: '2027-01-30' }, '2027-03-05')).toBe(
      '2027-03-31',
    );
  });

  it('sends only the latest due reminder, once', () => {
    const due = [{ key: 'before-90' }, { key: 'before-60' }];
    expect(reminderToSend(due, new Set())).toEqual({
      send: { key: 'before-60' },
      skip: [{ key: 'before-90' }],
    });
    expect(reminderToSend(due, new Set(['before-90', 'before-60']))).toEqual({
      send: null,
      skip: [],
    });
  });
});

describe('TX-05, OQ-45 and OQ-44 trackers', () => {
  const rules = { rentControlDays: 14, stampDutyMonths: 2, writingExemptionMaxYears: 3 };

  it('counts the Rent Control and stamping deadlines from signing, from the rules', () => {
    const trackers = leaseTrackers(
      { signedOn: '2026-12-31', use: 'residential', periodCount: 12, rentControlCommercial: false },
      rules,
    );
    expect(trackers).toEqual({
      rentControl: { applies: true, deadline: '2027-01-14' },
      stamping: { deadline: '2027-02-28' },
      formalLease: { required: false },
    });
  });

  it('tracks commercial Rent Control only when the company chooses, and the formal path over three years', () => {
    const commercial = { signedOn: '2026-11-01', use: 'commercial' as const, periodCount: 37 };
    expect(
      leaseTrackers({ ...commercial, rentControlCommercial: false }, rules).rentControl,
    ).toEqual({ applies: false, deadline: null });
    expect(
      leaseTrackers({ ...commercial, rentControlCommercial: true }, rules).rentControl.applies,
    ).toBe(true);
    expect(
      leaseTrackers({ ...commercial, rentControlCommercial: false }, rules).formalLease,
    ).toEqual({ required: true });
    expect(
      leaseTrackers({ ...commercial, periodCount: 36, rentControlCommercial: false }, rules)
        .formalLease.required,
    ).toBe(false);
    // A missing rule leaves the deadline empty rather than inventing one.
    expect(
      leaseTrackers(
        { ...commercial, rentControlCommercial: true },
        { rentControlDays: null, stampDutyMonths: null, writingExemptionMaxYears: null },
      ),
    ).toEqual({
      rentControl: { applies: true, deadline: null },
      stamping: { deadline: null },
      formalLease: { required: false },
    });
  });

  it('knows the two M3 rule keys', () => {
    expect(isKnownRuleKey('stamp_duty.deadline_months')).toBe(true);
    expect(parseRuleValue('stamp_duty.deadline_months', { months: 2 })).toEqual({ months: 2 });
    expect(parseRuleValue('lease.writing_exemption_max_years', { years: 3 })).toEqual({ years: 3 });
    expect(() => parseRuleValue('lease.writing_exemption_max_years', { months: 3 })).toThrow();
  });

  it('applies the M3 setting defaults without changing stored settings', () => {
    expect(tenancySettingsOf(defaultCompanySettings())).toEqual({
      witnessRequired: true,
      rentControlCommercial: false,
      renewalReminderDays: [90, 60, 30],
      rentControlReminderDaysBefore: [7, 2, 0],
      stampingReminderDaysBefore: [30, 14, 7],
      advanceRentPolicy: 'off',
    });
    const changed = mergeCompanySettings(defaultCompanySettings(), { witnessRequired: false });
    expect(tenancySettingsOf(changed).witnessRequired).toBe(false);
  });
});

describe('TL-05 lease document snapshot', () => {
  const facts = (over: Partial<LeaseDocumentFacts> = {}): LeaseDocumentFacts => ({
    title: 'Residential tenancy agreement',
    reference: 'L-0001',
    landlordName: 'Ama Owner-London',
    agentName: 'Osu Ridge Property Managers',
    tenantName: 'Kofi Tenant',
    tenantPhone: '+233200000021',
    tenantEmail: null,
    signatoryNames: [],
    guarantorName: null,
    propertyName: 'East Legon flats',
    propertyAddress: 'East Legon, Greater Accra',
    unitCode: 'ACC-ELG-B1-04',
    unitDescription: 'Apartment, 2 bedrooms',
    terms: checkLeaseTerms({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      monthlyRentMinor: 250_000,
      cycle: 'annual',
      noticeDays: 30,
      use: 'residential',
      steps: [{ effectiveFrom: '2027-05-01', monthlyRentMinor: 275_000 }],
    }),
    servicePhones: ['+233200000021'],
    serviceEmails: ['kofi@example.org'],
    parties: [
      { role: 'tenant', name: 'Kofi Tenant' },
      { role: 'witness', name: 'Esi Witness' },
    ],
    ...over,
  });

  it('fills every placeholder from the lease, in plain words', () => {
    const values = leasePlaceholderValues(facts());
    expect(values['rent.monthly']).toBe('GH₵2,500.00');
    expect(values['rent.cycle']).toBe('annually');
    expect(values['lease.startDate']).toBe('1 November 2026');
    expect(values['rent.steps']).toBe('From 1 May 2027 the rent is GH₵2,750.00 a month.');
    expect(values['electronicService.contacts']).toBe('+233200000021 and kofi@example.org');
    expect(values['break.summary']).toBe('There is no break clause.');
  });

  it('builds the document from the starter, leaving out clauses about terms the lease does not have', () => {
    const doc = buildLeaseDocument(STARTER_TEMPLATES.residential, facts());
    const keys = doc.sections.flatMap((s) => s.clauses.map((c) => c.title));
    expect(keys).not.toContain('Security deposit');
    expect(keys).not.toContain('Service charge');
    expect(keys).toContain('Electronic service');
    const text = doc.sections.flatMap((s) => s.clauses.map((c) => c.text)).join('\n');
    expect(text).toContain('unit ACC-ELG-B1-04 (Apartment, 2 bedrooms)');
    expect(text).not.toContain('{{');
    expect(text).not.toMatch(/compliant/i);
    expect(doc.signers).toEqual([
      { role: 'Tenant', name: 'Kofi Tenant' },
      { role: 'Witness', name: 'Esi Witness' },
    ]);
    const withDeposit = buildLeaseDocument(
      STARTER_TEMPLATES.residential,
      facts({
        terms: { ...facts().terms, depositMinor: 500_000 },
      }),
    );
    expect(withDeposit.sections[0]!.clauses.map((c) => c.text)).toContain(
      'The security deposit is GH₵5,000.00.',
    );
  });
});

describe('TL-06 rent schedule while holding over (OQ-12)', () => {
  it('adds a whole month at the last rate as each month starts', () => {
    const terms = checkLeaseTerms({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      use: 'residential',
      serviceChargeMonthlyMinor: 20_000,
      steps: [{ effectiveFrom: '2027-05-01', monthlyRentMinor: 160_000 }],
    });
    expect(holdingOverSchedule(terms, '2027-10-31')).toEqual([]);
    const rows = holdingOverSchedule(terms, '2027-12-01');
    expect(rows.map((r) => [r.sequence, r.chargeType, r.periodStart, r.amountMinor])).toEqual([
      [12, 'rent', '2027-11-01', 160_000],
      [12, 'service_charge', '2027-11-01', 20_000],
      [13, 'rent', '2027-12-01', 160_000],
      [13, 'service_charge', '2027-12-01', 20_000],
    ]);
  });

  it('charges the rest of a short final month first, so the two parts make one month exactly', () => {
    const terms = checkLeaseTerms({
      startDate: '2027-01-01',
      endDate: '2027-03-15',
      monthlyRentMinor: 100_001,
      cycle: 'monthly',
      noticeDays: 30,
      use: 'residential',
    });
    const last = rentSchedule(terms).at(-1)!;
    expect(last).toMatchObject({
      periodStart: '2027-03-01',
      periodEnd: '2027-03-15',
      prorated: true,
    });
    const rows = holdingOverSchedule(terms, '2027-04-02');
    expect(rows.map((r) => [r.sequence, r.periodStart, r.periodEnd])).toEqual([
      [3, '2027-03-16', '2027-03-31'],
      [4, '2027-04-01', '2027-04-30'],
    ]);
    expect(last.amountMinor + rows[0]!.amountMinor).toBe(100_001);
    // The rows do not depend on the day the job runs.
    expect(holdingOverSchedule(terms, '2027-05-20').slice(0, 2)).toEqual(rows);
  });
});
