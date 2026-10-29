import type { OwnerRow } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  countryLabel,
  ownerCreateInput,
  ownerDraftOf,
  ownerErrors,
  ownerPatch,
} from './owner-form';

const row: OwnerRow = {
  id: '019a3000-0000-7000-8000-00000000000a',
  reference: 'OWN-01',
  kind: 'individual',
  displayName: 'Ama Owner-London (demo)',
  legalName: null,
  phone: null,
  email: 'owner.london@demo.invalid',
  residenceCountry: 'GB',
  timeZone: 'Europe/London',
  notes: null,
  archived: false,
  createdAt: '2026-10-28T10:00:00.000Z',
};

describe('AD-02 owner records', () => {
  it('starts a new owner in Accra and lets the API choose the reference', () => {
    const draft = { ...ownerDraftOf(), displayName: '  Kofi Owner  ', residenceCountry: 'gh' };
    expect(draft.timeZone).toBe('Africa/Accra');
    expect(ownerErrors(draft)).toEqual({});
    expect(ownerCreateInput(draft)).toEqual({
      kind: 'individual',
      displayName: 'Kofi Owner',
      legalName: null,
      phone: null,
      email: null,
      residenceCountry: 'GH',
      timeZone: 'Africa/Accra',
      notes: null,
    });
    expect(ownerCreateInput({ ...draft, reference: 'own-07' })).toMatchObject({
      reference: 'OWN-07',
    });
  });

  it('checks the fields the API would refuse', () => {
    const errors = ownerErrors({
      ...ownerDraftOf(),
      displayName: 'K',
      email: 'not-an-email',
      residenceCountry: 'GBR',
      timeZone: 'Mars/Olympus',
      reference: 'A',
    });
    expect(Object.keys(errors).sort()).toEqual([
      'displayName',
      'email',
      'reference',
      'residenceCountry',
      'timeZone',
    ]);
  });

  it('sends only what changed when an owner is edited', () => {
    expect(ownerPatch(row, ownerDraftOf(row))).toEqual({});
    expect(ownerPatch(row, { ...ownerDraftOf(row), phone: '+44 20 7946 0000', email: '' })).toEqual(
      {
        phone: '+44 20 7946 0000',
        email: null,
      },
    );
    expect(ownerPatch(row, { ...ownerDraftOf(row), reference: 'own-09' })).toEqual({
      reference: 'OWN-09',
    });
  });

  it('names the country of residence', () => {
    expect(countryLabel('GB')).toBe('United Kingdom (GB)');
    expect(countryLabel(null)).toBeNull();
  });
});
