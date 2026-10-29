import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../dates';
import {
  buildLeaseDocument,
  leasePlaceholderValues,
  type LeaseDocumentFacts,
} from './lease-document';
import { checkLeaseTerms, formatTerm, termLength } from './lease-terms';
import { STARTER_TEMPLATES } from './starter-templates';
import type { TemplateContent } from './templates';

const facts = (startDate: string, endDate: string): LeaseDocumentFacts => ({
  title: 'Residential tenancy agreement',
  reference: 'L-0001',
  landlordName: 'Ama Owner',
  agentName: null,
  tenantName: 'Kofi Tenant',
  tenantPhone: null,
  tenantEmail: null,
  signatoryNames: [],
  guarantorName: null,
  propertyName: 'East Legon flats',
  propertyAddress: 'East Legon, Greater Accra',
  unitCode: 'ACC-ELG-B1-04',
  unitDescription: 'Apartment',
  terms: checkLeaseTerms({
    startDate,
    endDate,
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    use: 'residential',
  }),
  servicePhones: [],
  serviceEmails: [],
  parties: [{ role: 'tenant', name: 'Kofi Tenant' }],
});

describe('TL-05 the lease prints its term exactly', () => {
  it('counts whole months anchored on the start, then the days left', () => {
    expect(termLength('2026-11-01', '2027-10-31')).toEqual({ months: 12, days: 0 });
    expect(termLength('2026-11-01', '2027-11-06')).toEqual({ months: 12, days: 6 });
    expect(termLength('2026-01-31', '2026-02-27')).toEqual({ months: 1, days: 0 });
    expect(termLength('2026-11-01', '2026-11-20')).toEqual({ months: 0, days: 20 });
    expect(formatTerm({ months: 12, days: 0 })).toBe('12 months');
    expect(formatTerm({ months: 12, days: 6 })).toBe('12 months and 6 days');
    expect(formatTerm({ months: 1, days: 1 })).toBe('1 month and 1 day');
    expect(formatTerm({ months: 0, days: 20 })).toBe('20 days');
  });

  it('writes a lease of 12 months and 6 days as such, never as 13 months', () => {
    const values = leasePlaceholderValues(facts('2026-11-01', '2027-11-06'));
    expect(values['lease.term']).toBe('12 months and 6 days');
    const text = buildLeaseDocument(
      STARTER_TEMPLATES.residential,
      facts('2026-11-01', '2027-11-06'),
    )
      .sections.flatMap((s) => s.clauses.map((c) => c.text))
      .join('\n');
    expect(text).toContain('(12 months and 6 days)');
    expect(text).not.toContain('13 months');
    expect(text).not.toContain('months months');
  });

  it('reads the wording of earlier template versions, "{{lease.term}} months", exactly too', () => {
    const legacy: TemplateContent = {
      sections: [
        {
          key: 'agreement',
          heading: 'Tenancy agreement',
          clauses: STARTER_TEMPLATES.residential.sections[0]!.clauses.map((c) =>
            c.key === 'term'
              ? {
                  ...c,
                  body: 'The tenancy starts on {{lease.startDate}} and ends on {{lease.endDate}} ({{lease.term}} months).',
                }
              : c,
          ),
        },
      ],
    };
    const term = (start: string, end: string) =>
      buildLeaseDocument(legacy, facts(start, end))
        .sections.flatMap((s) => s.clauses)
        .find((c) => c.title === 'The term')!.text;
    expect(term('2026-11-01', '2027-11-06')).toBe(
      'The tenancy starts on 1 November 2026 and ends on 6 November 2027 (12 months and 6 days).',
    );
    expect(term('2026-11-01', '2027-10-31')).toBe(
      'The tenancy starts on 1 November 2026 and ends on 31 October 2027 (12 months).',
    );
  });

  it('adds up exactly to the dates, and agrees with the rent periods (property-based)', () => {
    const day = (n: number) => toIsoDate(addDays(parseBusinessDate('2020-01-01'), n));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (startOffset, length) => {
          const startDate = day(startOffset);
          const endDate = day(startOffset + length);
          const { months, days } = termLength(startDate, endDate);
          const start = parseBusinessDate(startDate);
          // `months` whole months from the start, then `days` more days, end on the end date.
          const afterMonths = addMonths(start, months);
          expect(toIsoDate(addDays(afterMonths, days - 1))).toBe(endDate);
          // The days left are fewer than a whole month more.
          expect(toIsoDate(addDays(addMonths(start, months + 1), -1)) > endDate).toBe(true);
          const terms = checkLeaseTerms({
            startDate,
            endDate,
            monthlyRentMinor: 100_000,
            cycle: 'monthly',
            noticeDays: 0,
            use: 'residential',
          });
          expect(terms.periodCount).toBe(months + (days > 0 ? 1 : 0));
          const text = formatTerm({ months, days });
          expect(text).toMatch(/^(\d+ months?)?( and )?(\d+ days?)?$/);
          if (months > 0) expect(text).toContain(`${months} month`);
          if (days > 0) expect(text).toContain(`${days} day`);
        },
      ),
    );
  });
});
