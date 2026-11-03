import { describe, expect, it } from 'vitest';
import {
  amountInput,
  canAddTenant,
  contactChoices,
  contactParts,
  contactSigner,
  emptyParty,
  emptyTerms,
  endAfterMonths,
  mustSign,
  NO_RECORDS,
  ONE_TENANT_PROBLEM,
  partiesInput,
  partyErrors,
  partyLink,
  partyProblems,
  projectedSchedule,
  serviceContacts,
  signerContact,
  signerContactLine,
  signerRecordsOf,
  STAFF_PART_PROBLEM,
  STAFF_SIGNER_ROLES,
  staffChoices,
  staffSigner,
  tenantSigner,
  termsFromDraft,
  TYPED_SIGNER_ROLES,
  usualContactPart,
  type SignerRecords,
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

// Signers linked to records (TL-07; plan 4.8) ------------------------------------------------------

const ID = (n: number) => `019a3000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const records: SignerRecords = {
  tenant: { name: 'Ama Mensah', kind: 'individual', phone: '+233200000099', email: null },
  contacts: [
    { id: ID(1), kind: 'guarantor', name: 'Yaa Guarantor', phone: '+233244123456', email: null },
    { id: ID(2), kind: 'next_of_kin', name: 'Kojo Brother', phone: '+233244000001', email: null },
  ],
  staff: [
    {
      personId: ID(3),
      name: 'Kofi Manager',
      email: 'kofi@demo.invalid',
      phoneMasked: '+233 ** *** 0011',
      roleLabel: 'Property manager',
    },
    {
      personId: ID(4),
      name: 'Akosua Manager',
      email: 'akosua@demo.invalid',
      phoneMasked: null,
      roleLabel: 'Property manager',
    },
  ],
};

const tenantRow = { ...emptyParty('tenant', 'Ama Mensah'), phone: '+233209999999' };
const guarantorRow = { ...emptyParty('guarantor', 'Yaa Guarantor'), tenantContactId: ID(1) };
const landlordRow = { ...emptyParty('landlord', 'Kofi Manager'), staffPersonId: ID(3) };
const witnessRow = { ...emptyParty('witness', 'Esi Witness'), email: 'esi@example.com' };

describe('TL-07 a signer linked to a record gets their link and codes there', () => {
  it('links the tenant, a contact and a member of staff to their records, in the API’s order', () => {
    expect(partyLink(tenantRow)).toBe('tenant_record');
    expect(partyLink(guarantorRow)).toBe('contact');
    expect(partyLink(landlordRow)).toBe('staff');
    expect(partyLink(witnessRow)).toBeNull();
    // A contact's link wins over the part they sign in, as it does in the API.
    expect(partyLink({ ...guarantorRow, role: 'tenant' })).toBe('contact');
  });

  it('shows the record’s phone and email, not what the signer row holds', () => {
    // The tenant's record has a newer phone than the one copied onto the draft.
    expect(signerContact(tenantRow, records)).toEqual({
      from: 'record',
      phone: '+233200000099',
      email: null,
    });
    expect(signerContactLine(signerContact(tenantRow, records))).toBe(
      '+233200000099 (from their record)',
    );
    expect(signerContact(guarantorRow, records)).toMatchObject({ phone: '+233244123456' });
    // Staff phones are listed masked; the API reads the number on their record.
    expect(signerContactLine(signerContact(landlordRow, records))).toBe(
      '+233 ** *** 0011 · kofi@demo.invalid (from their record)',
    );
    expect(signerContact(witnessRow, records)).toEqual({
      from: 'typed',
      phone: null,
      email: 'esi@example.com',
    });
  });

  it('falls back to the signer’s own details where the record has none, as the API does', () => {
    const noPhone: SignerRecords = { ...records, tenant: { ...records.tenant!, phone: null } };
    expect(signerContact(tenantRow, noPhone)).toMatchObject({ phone: '+233209999999' });
    const empty: SignerRecords = {
      ...records,
      tenant: { ...records.tenant!, phone: null, email: null },
    };
    expect(signerContactLine(signerContact({ ...tenantRow, phone: '' }, empty))).toBe(
      'No phone or email on their record',
    );
  });

  it('says when a record could not be read, or is gone', () => {
    expect(signerContact(tenantRow, NO_RECORDS)).toEqual({ from: 'unknown' });
    expect(signerContactLine({ from: 'unknown' })).toBe('The phone and email on their record');
    const archived = { ...guarantorRow, tenantContactId: ID(9) };
    expect(signerContact(archived, records)).toEqual({ from: 'missing', link: 'contact' });
    const leftCompany = { ...landlordRow, staffPersonId: ID(9) };
    expect(signerContactLine(signerContact(leftCompany, records))).toBe(
      'No longer an active member of your company',
    );
  });

  it('reads the records from the API: archived contacts and inactive members are left out', () => {
    const built = signerRecordsOf(
      {
        displayName: 'Ama Mensah',
        kind: 'individual',
        phone: '+233200000099',
        email: 'ama@example.com',
        contacts: [
          {
            id: ID(1),
            kind: 'guarantor',
            name: 'Yaa Guarantor',
            phone: null,
            email: null,
            relationship: null,
            organisation: null,
            position: null,
            notes: null,
            consent: { sms: false, email: false },
            archived: false,
          },
          {
            id: ID(2),
            kind: 'guarantor',
            name: 'Old Guarantor',
            phone: null,
            email: null,
            relationship: null,
            organisation: null,
            position: null,
            notes: null,
            consent: { sms: false, email: false },
            archived: true,
          },
        ],
      },
      [
        {
          personId: ID(3),
          name: 'Kofi Manager',
          email: 'kofi@demo.invalid',
          phoneMasked: null,
          role: 'property_manager',
          status: 'active',
        },
        {
          personId: ID(5),
          name: 'Invited Person',
          email: 'new@demo.invalid',
          phoneMasked: null,
          role: 'property_manager',
          status: 'invited',
        },
      ],
    );
    expect(built.tenant).toEqual({
      name: 'Ama Mensah',
      kind: 'individual',
      phone: '+233200000099',
      email: 'ama@example.com',
    });
    expect(built.contacts?.map((c) => c.name)).toEqual(['Yaa Guarantor']);
    expect(built.staff).toEqual([
      {
        personId: ID(3),
        name: 'Kofi Manager',
        email: 'kofi@demo.invalid',
        phoneMasked: null,
        roleLabel: 'Property manager',
      },
    ]);
    expect(signerRecordsOf(null, null)).toEqual(NO_RECORDS);
  });
});

describe('TL-07 the rules the API enforces on who signs', () => {
  it('lets only one person sign as the tenant, and staff only for the landlord or as a witness', () => {
    const second = { ...emptyParty('tenant', 'Akos Spouse'), phone: '024 412 0000' };
    const staffGuarantor = { ...landlordRow, role: 'guarantor' as const };
    const problems = partyProblems([tenantRow, second, staffGuarantor]);
    expect(problems[tenantRow.key]).toBeUndefined();
    expect(problems[second.key]).toEqual({ field: 'role', message: ONE_TENANT_PROBLEM });
    expect(problems[second.key]?.message).toMatch(/one of the tenant’s contacts/);
    expect(problems[staffGuarantor.key]).toEqual({ field: 'role', message: STAFF_PART_PROBLEM });
    expect(partyProblems([landlordRow, { ...landlordRow, key: 'w', role: 'witness' }])).toEqual({});
    expect(STAFF_SIGNER_ROLES).toEqual(['landlord', 'witness']);
    // The tenant signs from their record, so nobody types the tenant in.
    expect(TYPED_SIGNER_ROLES).not.toContain('tenant');
    // A paper lease is a record of who signed, so two people can be recorded as the tenant.
    expect(partyProblems([tenantRow, second], { paper: true, today: '2026-10-29' })).toEqual({});
  });

  it('ties each problem to the field it is about', () => {
    expect(partyProblems([{ ...witnessRow, name: 'E' }])[witnessRow.key]?.field).toBe('name');
    expect(partyProblems([{ ...witnessRow, phone: '12' }])[witnessRow.key]?.field).toBe('phone');
    expect(partyProblems([{ ...witnessRow, email: 'esi' }])[witnessRow.key]?.field).toBe('email');
    expect(
      partyProblems([{ ...witnessRow, paperSignedOn: '2026-11-01' }], {
        paper: true,
        today: '2026-10-29',
      })[witnessRow.key]?.field,
    ).toBe('paperSignedOn');
  });

  it('flags a signer whose record is gone, once the records are read', () => {
    const archived = { ...guarantorRow, tenantContactId: ID(9) };
    const leftCompany = { ...landlordRow, staffPersonId: ID(9) };
    const problems = partyProblems([archived, leftCompany], { records });
    expect(problems[archived.key]).toMatchObject({ field: 'record' });
    expect(problems[archived.key]?.message).toMatch(/no longer one of the tenant’s contacts/);
    expect(problems[leftCompany.key]?.message).toMatch(/no longer an active member/);
    // Without the records, only the API can tell.
    expect(partyProblems([archived, leftCompany])).toEqual({});
  });

  it('always requires the tenant, a signatory, the landlord’s signer and a witness the lease asks for', () => {
    expect(mustSign({ role: 'tenant' }, false)).toBe(true);
    expect(mustSign({ role: 'signatory' }, false)).toBe(true);
    expect(mustSign({ role: 'landlord' }, false)).toBe(true);
    expect(mustSign({ role: 'guarantor' }, true)).toBe(false);
    expect(mustSign({ role: 'witness' }, false)).toBe(false);
    expect(mustSign({ role: 'witness' }, true)).toBe(true);
    // An older draft that carried one of them as optional is sent as required.
    const sent = partiesInput(
      [
        { ...landlordRow, required: false },
        { ...witnessRow, required: false },
        { ...emptyParty('guarantor', 'Yaw'), required: false },
      ],
      { witnessRequired: true },
    );
    expect(sent.map((p) => p.required)).toEqual([true, true, false]);
  });
});

describe('TL-07 adding signers from the tenant’s contacts and the company’s staff', () => {
  it('adds the tenant from their record, once, for a person', () => {
    expect(canAddTenant('individual', [])).toBe(true);
    expect(canAddTenant('individual', [tenantRow])).toBe(false);
    // A company signs through its authorised signatories.
    expect(canAddTenant('company', [])).toBe(false);
    expect(tenantSigner(records, 'Ama')).toMatchObject({
      role: 'tenant',
      name: 'Ama Mensah',
      phone: '+233200000099',
      tenantContactId: null,
      staffPersonId: null,
    });
  });

  it('offers the tenant’s contacts not signing yet, in the parts a contact may take', () => {
    expect(contactChoices(records, []).map((c) => c.name)).toEqual([
      'Yaa Guarantor',
      'Kojo Brother',
    ]);
    expect(contactChoices(records, [guarantorRow]).map((c) => c.name)).toEqual(['Kojo Brother']);
    expect(contactSigner(records.contacts![0]!, 'guarantor', 'individual')).toMatchObject({
      role: 'guarantor',
      name: 'Yaa Guarantor',
      phone: '+233244123456',
      tenantContactId: ID(1),
    });
    // A company's authorised signatory signs for it.
    expect(
      contactSigner(
        { id: ID(6), kind: 'signatory', name: 'Efo Director', phone: null, email: null },
        'signatory',
        'company',
      ),
    ).toMatchObject({ role: 'signatory', tenantContactId: ID(6) });
    // A contact never signs for the landlord, and a person's contact is not a signatory.
    expect(contactSigner(records.contacts![1]!, 'landlord', 'individual')).toBeNull();
    expect(contactSigner(records.contacts![1]!, 'signatory', 'individual')).toBeNull();
    expect(contactParts('individual')).toEqual(['tenant', 'guarantor', 'witness']);
    expect(contactParts('company')).toEqual(['signatory', 'guarantor', 'witness']);
  });

  it('offers each contact the usual part for their kind first', () => {
    expect(usualContactPart(records.contacts![0]!, 'individual')).toBe('guarantor');
    expect(usualContactPart(records.contacts![1]!, 'individual')).toBe('witness');
    expect(
      usualContactPart(
        { id: ID(6), kind: 'signatory', name: 'Efo Director', phone: null, email: null },
        'company',
      ),
    ).toBe('signatory');
  });

  it('lets someone else who lives there sign as the tenant from their own contact record', () => {
    const spouse = contactSigner(records.contacts![1]!, 'tenant', 'individual')!;
    expect(spouse).toMatchObject({
      role: 'tenant',
      name: 'Kojo Brother',
      phone: '+233244000001',
      tenantContactId: ID(2),
    });
    expect(partyLink(spouse)).toBe('contact');
    // The API counts only the tenant signing from the tenant's record, so this is no problem.
    expect(partyProblems([tenantRow, spouse], { records })).toEqual({});
    expect(signerContactLine(signerContact(spouse, records))).toBe(
      '+233244000001 (from their record)',
    );
  });

  it('offers active staff not signing yet, for the landlord or as a witness only', () => {
    expect(staffChoices(records, [landlordRow]).map((s) => s.name)).toEqual(['Akosua Manager']);
    expect(staffChoices(NO_RECORDS, [])).toEqual([]);
    const witness = staffSigner(records.staff![1]!, 'witness');
    expect(witness).toMatchObject({
      role: 'witness',
      name: 'Akosua Manager',
      email: 'akosua@demo.invalid',
      // The phone stays on their record; the API reads it when the lease is sent.
      phone: '',
      staffPersonId: ID(4),
    });
    expect(staffSigner(records.staff![1]!, 'guarantor')).toBeNull();
  });
});

describe('M4b decision 9 a lease billed every two years', () => {
  it('takes a two-yearly cycle on a two-year lease, billed 24 months at a time', () => {
    const {
      input,
      terms: checked,
      errors,
    } = termsFromDraft(terms({ endDate: endAfterMonths('2026-11-01', 24), cycle: 'two_yearly' }));
    expect(errors).toEqual({});
    expect(input?.cycle).toBe('two_yearly');
    // Rent periods stay monthly, anchored on the start, whatever the cycle.
    expect(projectedSchedule(checked)).toHaveLength(24);
  });

  it('refuses it on a lease shorter than two years, on the cycle field', () => {
    expect(termsFromDraft(terms({ cycle: 'two_yearly' })).errors.cycle).toMatch(
      /longer than the lease/,
    );
  });
});
