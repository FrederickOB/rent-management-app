import type { TenantDetailView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  consentChangeNotes,
  consentChanges,
  consentSummary,
  consentWording,
  CONSENT_VERSION,
  contactPatch,
  emptyContact,
  emptyTenantDraft,
  revealReasonProblem,
  tenantCreateInput,
  tenantDraftOf,
  tenantErrors,
  tenantPatch,
} from './tenant-form';

const saved: TenantDetailView = {
  access: 'full',
  id: '019a3000-0000-7000-8000-0000000000c1',
  kind: 'individual',
  displayName: 'Kwame Monthly (demo)',
  legalName: null,
  phone: '+233200000031',
  whatsappPhone: null,
  email: null,
  occupation: 'Teacher',
  businessType: null,
  registrationNumber: null,
  tinMasked: null,
  identity: {
    type: 'ghana_card',
    masked: 'GHA-*******89-0',
    status: 'not_started',
    verifiedAt: null,
  },
  notes: null,
  units: ['ACC-LEG-B1-01'],
  consent: { sms: true, email: false },
  archived: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  contacts: [],
  leases: [],
  idChecks: [],
};

describe('TL-01 and CM-09 a new tenant with consent per channel', () => {
  it('sends a person with an E.164 phone, the consent given and a guarantor', () => {
    const guarantor = {
      ...emptyContact('guarantor'),
      name: 'Yaa Guarantor',
      phone: '024 412 3456',
      consent: { sms: true, email: false },
    };
    const draft = {
      ...emptyTenantDraft('individual'),
      displayName: '  Ama Mensah ',
      phone: '020 000 0099',
      occupation: 'Nurse',
      // Typed on a person by mistake; registration details are for companies only.
      registrationNumber: 'CS1',
      consent: { sms: true, email: false },
      contacts: [guarantor],
    };
    expect(tenantErrors(draft)).toEqual({});
    expect(tenantCreateInput(draft)).toEqual({
      kind: 'individual',
      displayName: 'Ama Mensah',
      phone: '+233200000099',
      whatsappPhone: null,
      email: null,
      occupation: 'Nurse',
      notes: null,
      consent: { sms: true, email: false },
      contacts: [
        {
          kind: 'guarantor',
          name: 'Yaa Guarantor',
          phone: '+233244123456',
          email: null,
          relationship: null,
          organisation: null,
          position: null,
          consent: { sms: true, email: false },
        },
      ],
    });
  });

  it('refuses consent on a channel with no address to send to', () => {
    const errors = tenantErrors({
      ...emptyTenantDraft(),
      displayName: 'Ama Mensah',
      consent: { sms: true, email: true },
      contacts: [
        { ...emptyContact('next_of_kin'), name: 'Kofi', consent: { sms: false, email: true } },
      ],
    });
    expect(errors.phone).toMatch(/untick SMS consent/);
    expect(errors.email).toMatch(/untick email consent/);
    expect(Object.values(errors.contacts ?? {})[0]?.email).toMatch(/untick email consent/);
  });

  it('shows staff the versioned words they are recording', () => {
    expect(CONSENT_VERSION).toBe('messages.v1');
    expect(consentWording('sms')).toContain('by SMS');
    expect(consentWording('email')).toContain('by email');
    expect(consentSummary({ sms: true, email: true })).toBe('SMS and email');
    expect(consentSummary({ sms: false, email: false })).toBe('No channel');
  });

  it('turns consent changes into one grant or withdrawal per channel', () => {
    expect(consentChanges({ sms: true, email: false }, { sms: false, email: true })).toEqual([
      { channel: 'sms', action: 'withdraw' },
      { channel: 'email', action: 'grant' },
    ]);
    expect(consentChanges({ sms: true, email: false }, { sms: true, email: false })).toEqual([]);
  });
});

describe('TL-02 and TL-04 ID numbers and TINs on the tenant form', () => {
  it('checks a Ghana Card number and a passport before anything is sent', () => {
    const person = { ...emptyTenantDraft(), displayName: 'Ama Mensah' };
    expect(
      tenantErrors({ ...person, idType: 'ghana_card', idNumber: 'GHA-12345' }).idNumber,
    ).toMatch(/GHA-123456789-0/);
    expect(tenantErrors({ ...person, idType: 'ghana_card', idNumber: 'gha 123456789 0' })).toEqual(
      {},
    );
    expect(tenantErrors({ ...person, idType: 'passport', idNumber: 'A1234567' }).idCountry).toMatch(
      /two letters/,
    );
    expect(
      tenantCreateInput({ ...person, idType: 'passport', idNumber: 'A1234567', idCountry: 'ng' }),
    ).toMatchObject({ idType: 'passport', idNumber: 'A1234567', idCountry: 'NG' });
  });

  it('sends a TIN only for a company, and an ID number only for a person', () => {
    const company = {
      ...emptyTenantDraft('company'),
      displayName: 'Osu Pharmacy Ltd',
      tin: 'C0012345678',
      idType: 'ghana_card' as const,
      idNumber: 'GHA-123456789-0',
    };
    const input = tenantCreateInput(company);
    expect(input).toMatchObject({ kind: 'company', tin: 'C0012345678' });
    expect(input).not.toHaveProperty('idNumber');
    expect(
      tenantCreateInput({ ...emptyTenantDraft(), displayName: 'Ama', tin: 'C001234' }),
    ).not.toHaveProperty('tin');
  });

  it('edits send only what changed; a blank number keeps the stored one', () => {
    const draft = tenantDraftOf(saved);
    expect(draft.idNumber).toBe('');
    expect(tenantPatch(saved, draft)).toEqual({});
    expect(
      tenantPatch(saved, { ...draft, occupation: 'Head teacher', email: 'kwame@example.com' }),
    ).toEqual({
      occupation: 'Head teacher',
      email: 'kwame@example.com',
    });
    expect(tenantPatch(saved, { ...draft, idNumber: 'GHA-987654321-0' })).toEqual({
      idType: 'ghana_card',
      idNumber: 'GHA-987654321-0',
    });
    expect(tenantPatch(saved, draft, { removeId: true })).toEqual({ idType: null, idNumber: null });
  });

  it('needs a real reason to reveal a number', () => {
    expect(revealReasonProblem('check')).toMatch(/at least 10 characters/);
    expect(revealReasonProblem('Checking the ID against the signed lease')).toBeNull();
  });
});

describe('TL-03 contacts', () => {
  it('sends only the contact fields that changed', () => {
    const row = {
      id: '019a3000-0000-7000-8000-0000000000d1',
      kind: 'guarantor' as const,
      name: 'Yaa Guarantor',
      phone: '+233244123456',
      email: null,
      relationship: 'Aunt',
      organisation: null,
      position: null,
      notes: null,
      consent: { sms: true, email: false },
      archived: false,
    };
    expect(
      contactPatch(row, {
        key: row.id,
        kind: 'guarantor',
        name: 'Yaa Guarantor',
        phone: '024 412 3456',
        email: 'yaa@example.com',
        relationship: 'Aunt',
        organisation: '',
        position: '',
        consent: { sms: false, email: false },
      }),
    ).toEqual({ email: 'yaa@example.com' });
  });
});

describe('CM-09 consent stays with a changed phone or email', () => {
  const stored = {
    phone: '+233200000031',
    email: 'kwame@example.com',
    consent: { sms: true, email: true },
  };

  it('asks staff to check the person agreed at the new number or address', () => {
    expect(
      consentChangeNotes(
        stored,
        { phone: '024 412 3456', email: 'kwame@example.com' },
        'the tenant',
      ),
    ).toEqual([
      'The SMS consent on record stays with the new phone number. Make sure the tenant agreed to messages at that number.',
    ]);
    expect(
      consentChangeNotes(
        stored,
        { phone: '020 000 0031', email: 'k@example.com' },
        'Yaa Guarantor',
      ),
    ).toEqual([
      'The email consent on record stays with the new email address. Make sure Yaa Guarantor agreed to messages at that address.',
    ]);
  });

  it('says nothing when the number is the same, removed, or has no consent on record', () => {
    // The same number typed the Ghanaian way, and the same address in capitals.
    expect(
      consentChangeNotes(stored, { phone: '020 000 0031', email: 'KWAME@example.com ' }, 'x'),
    ).toEqual([]);
    expect(consentChangeNotes(stored, { phone: '', email: '' }, 'x')).toEqual([]);
    expect(
      consentChangeNotes(
        { ...stored, consent: { sms: false, email: false } },
        { phone: '024 412 3456', email: 'new@example.com' },
        'x',
      ),
    ).toEqual([]);
  });
});
