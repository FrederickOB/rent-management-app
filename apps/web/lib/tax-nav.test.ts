import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { activeNavHref } from './nav-match';
import { allowed } from './policy';

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const LEGON = '019a3000-0000-7000-8000-0000000000c1';
const OWNER = '019a3000-0000-7000-8000-0000000000d1';

function member(
  role: string,
  options: {
    readonly kind?: 'agency' | 'landlord';
    readonly phone?: boolean;
    readonly scope?: { owners?: string[]; properties?: string[] };
  } = {},
): Me {
  return {
    personId: '019a3000-0000-7000-8000-0000000000aa',
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: options.phone ? 'phone_otp' : 'password_totp',
    sessionExpiresAt: '2026-11-03T13:00:00.000Z',
    actorKind: 'staff',
    activeCompanyId: AGENCY,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId: AGENCY,
        companyName: 'Osu Ridge Property Managers',
        companyKind: options.kind ?? 'agency',
        role,
        nominatedApprover: false,
        ...(options.scope ? { scope: options.scope } : {}),
      },
    ],
  };
}

const M5 = ['Rent tax', 'VAT returns', 'Advance rent report'];
const labels = (me: Me) =>
  navFor(me)
    .map((item) => item.label)
    .filter((l) => M5.includes(l));

describe('TX-03, P33 and AR-05 the tax screens follow the policy (plan 5.8, decision 5)', () => {
  it('shows people who see billing the rent tax, VAT and advance rent screens', () => {
    for (const role of ['agency_admin', 'property_manager', 'accountant', 'adviser'])
      expect(labels(member(role))).toEqual(M5);
    expect(labels(member('owner', { kind: 'landlord' }))).toEqual(M5);
  });

  it('lets accountants and admins pay GRA, and not managers or advisers', () => {
    expect(allowed(member('accountant'), 'tax.manage')).toBe(true);
    expect(allowed(member('agency_admin'), 'tax.manage')).toBe(true);
    expect(allowed(member('owner', { kind: 'landlord' }), 'tax.manage')).toBe(true);
    expect(allowed(member('property_manager'), 'tax.manage')).toBe(false);
    expect(allowed(member('adviser'), 'tax.manage')).toBe(false);
  });

  it('offers certificate confirmation to owners and agency admins, never to managers', () => {
    expect(
      allowed(
        member('owner', { kind: 'agency', scope: { owners: [OWNER] } }),
        'withholding.confirm',
      ),
    ).toBe(true);
    expect(allowed(member('agency_admin'), 'withholding.confirm')).toBe(true);
    expect(allowed(member('property_manager'), 'withholding.confirm')).toBe(false);
    expect(allowed(member('accountant'), 'withholding.confirm')).toBe(false);
  });

  it('shows a caretaker none of it', () => {
    expect(labels(member('caretaker', { phone: true, scope: { properties: [LEGON] } }))).toEqual(
      [],
    );
  });

  it('marks the right section on each tax page', () => {
    const hrefs = navFor(member('accountant')).map((item) => item.href);
    expect(activeNavHref('/tax/rent', hrefs)).toBe('/tax/rent');
    expect(activeNavHref('/tax/rent/payments/new', hrefs)).toBe('/tax/rent');
    expect(activeNavHref('/tax/vat/payments/new', hrefs)).toBe('/tax/vat');
    expect(activeNavHref('/compliance/advance-rent', hrefs)).toBe('/compliance/advance-rent');
  });
});
