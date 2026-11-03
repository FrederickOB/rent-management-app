import type { OwnerRow } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { ownerCreateInput, ownerDraftOf, ownerErrors, ownerPatch } from './owner-form';

const row: OwnerRow = {
  id: '019a3000-0000-7000-8000-00000000000b',
  reference: 'OWN-02',
  kind: 'individual',
  displayName: 'Nana Owner-Accra (demo)',
  legalName: null,
  phone: null,
  email: 'owner.accra@demo.invalid',
  residenceCountry: 'GH',
  timeZone: 'Africa/Accra',
  notes: null,
  lettingBusiness: false,
  vatRegistered: true,
  tinMasked: '*******5678',
  archived: false,
  createdAt: '2026-10-28T10:00:00.000Z',
};

describe('M3 plan 4.13 owner tax fields', () => {
  it('sends the letting-business and VAT flags and a TIN only when they are set', () => {
    const draft = { ...ownerDraftOf(), displayName: 'Kofi Owner' };
    expect(ownerCreateInput(draft)).not.toHaveProperty('lettingBusiness');
    expect(ownerCreateInput(draft)).not.toHaveProperty('tin');
    expect(
      ownerCreateInput({
        ...draft,
        lettingBusiness: true,
        vatRegistered: true,
        tin: 'c0012345678',
      }),
    ).toMatchObject({ lettingBusiness: true, vatRegistered: true, tin: 'C0012345678' });
  });

  it('starts an edit from the stored flags; the TIN is never filled in', () => {
    const draft = ownerDraftOf(row);
    expect(draft).toMatchObject({ lettingBusiness: false, vatRegistered: true, tin: '' });
    expect(ownerPatch(row, draft)).toEqual({});
    expect(ownerPatch(row, { ...draft, lettingBusiness: true, vatRegistered: false })).toEqual({
      lettingBusiness: true,
      vatRegistered: false,
    });
  });

  it('replaces or removes the TIN only when asked', () => {
    const draft = ownerDraftOf(row);
    expect(ownerPatch(row, { ...draft, tin: 'GHA-123456789-0' })).toEqual({
      tin: 'GHA-123456789-0',
    });
    expect(ownerPatch(row, { ...draft, removeTin: true })).toEqual({ tin: null });
    expect(ownerPatch({ ...row, tinMasked: null }, { ...draft, removeTin: true })).toEqual({});
  });

  it('checks a TIN before it is sent', () => {
    expect(ownerErrors({ ...ownerDraftOf(row), tin: 'abc' }).tin).toMatch(/6 to 20/);
    expect(ownerErrors({ ...ownerDraftOf(row), tin: 'C0012345678' }).tin).toBeUndefined();
  });
});
