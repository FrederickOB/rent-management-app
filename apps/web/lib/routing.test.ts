import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { homeFor, PHONE_NO_ACCESS_PATH, phoneSessionWithoutCompany } from './routing';

const AGENCY = '019a3000-0000-7000-8000-000000000001';

const me = (overrides: Partial<Me>): Me => ({
  personId: '019a3000-0000-7000-8000-0000000000aa',
  name: 'Kojo Caretaker (demo)',
  state: 'ready',
  authMethod: 'phone_otp',
  sessionExpiresAt: '2026-10-29T13:00:00.000Z',
  actorKind: 'staff',
  activeCompanyId: AGENCY,
  role: 'caretaker',
  memberships: [
    {
      membershipId: '019a3000-0000-7000-8000-0000000000bb',
      companyId: AGENCY,
      companyName: 'Osu Ridge Property Managers',
      companyKind: 'agency',
      role: 'caretaker',
      nominatedApprover: false,
    },
  ],
  ...overrides,
});

describe('AD-06 where a session goes', () => {
  it('takes a caretaker signed in by phone into the app', () => {
    expect(homeFor(me({}))).toBe('/');
    expect(phoneSessionWithoutCompany(me({}))).toBe(false);
  });

  it('explains, rather than opening an empty app, when a phone sign-in has no company', () => {
    // The API gives a phone session only phone roles: a tenant, or staff whose roles all need a
    // password, arrive with no memberships.
    const nobody = me({ actorKind: 'tenant', activeCompanyId: null, role: null, memberships: [] });
    expect(phoneSessionWithoutCompany(nobody)).toBe(true);
    expect(homeFor(nobody)).toBe(PHONE_NO_ACCESS_PATH);
  });

  it('keeps the other states where they were', () => {
    expect(
      homeFor(me({ authMethod: 'password', state: 'enrolment_required', memberships: [] })),
    ).toBe('/enrol');
    expect(homeFor(me({ authMethod: 'password_totp', state: 'company_required' }))).toBe(
      '/choose-company',
    );
    // A password session with no company yet still reaches the app's own "not a member" note.
    expect(
      homeFor(me({ authMethod: 'password_totp', memberships: [], activeCompanyId: null })),
    ).toBe('/');
  });
});
