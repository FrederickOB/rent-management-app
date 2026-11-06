import { describe, expect, it } from 'vitest';
import {
  checkNoticeFields,
  checkNoticeSubtype,
  LADDER_NOTICE_TYPES,
  NOTICE_FIELD_SCHEMAS,
  NOTICE_REQUIRED_FIELDS,
  NOTICE_SUBTYPES,
  NOTICE_TYPE_RULES,
  NOTICE_TYPES,
  NoticeFieldError,
  noticeKeyDate,
  type NoticeType,
} from './types';

/** A valid set of fields for every type. */
const VALID: Record<NoticeType, Record<string, unknown>> = {
  rent_demand: {
    arrearsMinor: 450_000,
    arrearsAsOf: '2026-11-01',
    invoiceIds: ['inv-1', 'inv-2'],
    payBy: '2026-11-18',
  },
  rent_review: {
    currentRentMinor: 150_000,
    newRentMinor: 165_000,
    effectiveDate: '2027-01-01',
    reason: 'Annual review under clause 4',
  },
  notice_to_quit: { particulars: 'Rent unpaid since August 2026', effectiveDate: '2026-12-31' },
  entry: { entryDate: '2026-11-12', windowFrom: '09:00', windowTo: '12:00' },
  breach: { particulars: 'Loud music after midnight', remedyBy: '2026-11-20' },
  non_renewal: { leaseEndDate: '2027-03-31', effectiveDate: '2027-03-31' },
  building_wide: {
    propertyId: 'prop-osu',
    title: 'Fire drill',
    particulars: 'All occupants assemble at the car park',
    startDate: '2026-11-15',
  },
  tenant_originated: { receivedOn: '2026-11-03', receivedVia: 'in_person', documentId: 'doc-9' },
};

const fieldError = (run: () => unknown): NoticeFieldError => {
  try {
    run();
  } catch (error) {
    if (error instanceof NoticeFieldError) return error;
    throw error;
  }
  throw new Error('expected a NoticeFieldError');
};

describe('LN-01 notice types and fields', () => {
  it('covers every type in PRD section 8 with its mandatory fields (plan 4.2)', () => {
    expect(NOTICE_TYPES).toEqual([
      'rent_demand',
      'rent_review',
      'notice_to_quit',
      'entry',
      'breach',
      'non_renewal',
      'building_wide',
      'tenant_originated',
    ]);
    for (const type of NOTICE_TYPES) {
      expect(() => checkNoticeFields(type, VALID[type])).not.toThrow();
      for (const field of NOTICE_REQUIRED_FIELDS[type])
        expect(Object.keys(NOTICE_FIELD_SCHEMAS[type].shape)).toContain(field);
    }
  });

  it('names the missing field, for every mandatory field of every type', () => {
    for (const type of NOTICE_TYPES)
      for (const field of NOTICE_REQUIRED_FIELDS[type]) {
        const fields = { ...VALID[type] };
        delete fields[field];
        const error = fieldError(() => checkNoticeFields(type, fields));
        expect(error).toMatchObject({ code: 'notice.field_required', field });
        const blank = fieldError(() => checkNoticeFields(type, { ...VALID[type], [field]: '  ' }));
        expect(blank).toMatchObject({ code: 'notice.field_required', field });
      }
  });

  it('refuses unknown fields, bad formats and non-integer amounts', () => {
    expect(
      fieldError(() => checkNoticeFields('notice_to_quit', { ...VALID.notice_to_quit, rent: 1 })),
    ).toMatchObject({ code: 'notice.field_unknown', field: 'rent' });
    expect(
      fieldError(() =>
        checkNoticeFields('notice_to_quit', {
          ...VALID.notice_to_quit,
          effectiveDate: '31/12/2026',
        }),
      ),
    ).toMatchObject({ code: 'notice.field_invalid', field: 'effectiveDate' });
    expect(
      fieldError(() =>
        checkNoticeFields('rent_demand', { ...VALID.rent_demand, arrearsMinor: 4500.5 }),
      ),
    ).toMatchObject({ code: 'notice.field_invalid', field: 'arrearsMinor' });
    expect(
      fieldError(() => checkNoticeFields('rent_review', { ...VALID.rent_review, newRentMinor: 0 })),
    ).toMatchObject({ code: 'notice.field_invalid', field: 'newRentMinor' });
    expect(
      fieldError(() => checkNoticeFields('entry', { ...VALID.entry, windowFrom: '9am' })),
    ).toMatchObject({ code: 'notice.field_invalid', field: 'windowFrom' });
    expect(
      fieldError(() =>
        checkNoticeFields('tenant_originated', { ...VALID.tenant_originated, receivedVia: 'fax' }),
      ),
    ).toMatchObject({ code: 'notice.field_invalid', field: 'receivedVia' });
  });

  it('keeps dates and times in order', () => {
    expect(
      fieldError(() =>
        checkNoticeFields('rent_demand', { ...VALID.rent_demand, payBy: '2026-10-31' }),
      ),
    ).toMatchObject({ field: 'payBy' });
    expect(
      fieldError(() => checkNoticeFields('entry', { ...VALID.entry, windowTo: '09:00' })),
    ).toMatchObject({ field: 'windowTo' });
    expect(
      fieldError(() =>
        checkNoticeFields('building_wide', { ...VALID.building_wide, endDate: '2026-11-14' }),
      ),
    ).toMatchObject({ field: 'endDate' });
  });

  it('trims text and takes an optional details paragraph on every type (decision 1)', () => {
    const fields = checkNoticeFields('breach', {
      particulars: '  Loud music  ',
      remedyBy: '2026-11-20',
      details: ' Second complaint this month ',
    });
    expect(fields).toEqual({
      particulars: 'Loud music',
      remedyBy: '2026-11-20',
      details: 'Second complaint this month',
    });
    for (const type of NOTICE_TYPES)
      expect(Object.keys(NOTICE_FIELD_SCHEMAS[type].shape)).toContain('details');
  });

  it('checks subtypes: required where a type has them, absent otherwise', () => {
    expect(checkNoticeSubtype('notice_to_quit', 'arrears')).toBe('arrears');
    expect(NOTICE_SUBTYPES.notice_to_quit).toEqual([
      'arrears',
      'breach',
      'end_of_term',
      'own_use',
      'other',
    ]);
    expect(NOTICE_SUBTYPES.breach).toEqual([
      'noise',
      'unauthorised_occupants',
      'sub_letting',
      'damage',
      'other',
    ]);
    expect(() => checkNoticeSubtype('notice_to_quit', null)).toThrow(
      expect.objectContaining({ code: 'notice.subtype_required' }),
    );
    expect(() => checkNoticeSubtype('entry', 'noise')).toThrow(
      expect.objectContaining({ code: 'notice.subtype_invalid' }),
    );
    expect(checkNoticeSubtype('rent_demand', null)).toBeNull();
    expect(() => checkNoticeSubtype('rent_demand', 'arrears')).toThrow(
      expect.objectContaining({ code: 'notice.subtype_invalid' }),
    );
  });

  it('says which types use the contractual period, have a ladder or are posted on the premises', () => {
    const which = (pick: (r: (typeof NOTICE_TYPE_RULES)[NoticeType]) => boolean) =>
      NOTICE_TYPES.filter((t) => pick(NOTICE_TYPE_RULES[t]));
    expect(which((r) => r.usesContractualPeriod)).toEqual([
      'rent_review',
      'notice_to_quit',
      'non_renewal',
    ]);
    expect(which((r) => r.usesStatutoryMinimum)).toEqual(['notice_to_quit']);
    expect(which((r) => r.hasPeriod)).toEqual(['rent_review', 'notice_to_quit', 'non_renewal']);
    expect(which((r) => r.warnsNoPeriod)).toEqual(['entry', 'breach']);
    expect(which((r) => r.ladder === 'full')).toEqual([
      'rent_demand',
      'rent_review',
      'notice_to_quit',
      'breach',
      'non_renewal',
    ]);
    expect(which((r) => r.ladder === 'reminders_only')).toEqual(['entry', 'building_wide']);
    expect(which((r) => r.ladder === 'none')).toEqual(['tenant_originated']);
    expect(which((r) => r.postOnPremises)).toEqual(['notice_to_quit']);
    expect(which((r) => r.twoPersonApproval)).toEqual(['notice_to_quit']);
    expect(which((r) => r.needsQuitAcknowledgement)).toEqual(['notice_to_quit']);
    expect(which((r) => r.checksAssessmentBar)).toEqual(['notice_to_quit']);
    expect(which((r) => !r.issuable)).toEqual(['tenant_originated']);
    expect(which((r) => !r.needsLease)).toEqual(['building_wide']);
    expect([...LADDER_NOTICE_TYPES]).toEqual(which((r) => r.ladder !== 'none'));
  });

  it('finds the date each type is checked against', () => {
    expect(noticeKeyDate('rent_demand', VALID.rent_demand)).toBe('2026-11-18');
    expect(noticeKeyDate('notice_to_quit', VALID.notice_to_quit)).toBe('2026-12-31');
    expect(noticeKeyDate('entry', VALID.entry)).toBe('2026-11-12');
    expect(noticeKeyDate('breach', VALID.breach)).toBe('2026-11-20');
    expect(noticeKeyDate('building_wide', VALID.building_wide)).toBeNull();
    expect(noticeKeyDate('tenant_originated', VALID.tenant_originated)).toBeNull();
  });
});
