import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { activeNavHref } from './nav-match';
import { allowed } from './policy';

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const LEGON = '019a3000-0000-7000-8000-0000000000c1';

function member(
  role: string,
  options: { readonly phone?: boolean; readonly scope?: { properties?: string[] } } = {},
): Me {
  return {
    personId: '019a3000-0000-7000-8000-0000000000aa',
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: options.phone ? 'phone_otp' : 'password_totp',
    sessionExpiresAt: '2026-10-30T13:00:00.000Z',
    actorKind: 'staff',
    activeCompanyId: AGENCY,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId: AGENCY,
        companyName: 'Osu Ridge Property Managers',
        companyKind: 'agency',
        role,
        nominatedApprover: false,
        ...(options.scope ? { scope: options.scope } : {}),
      },
    ],
  };
}

const BILLING = [
  'Invoices',
  'Payments',
  'Cash on hand',
  'Unmatched receipts',
  'Arrears',
  'Receipts',
];
const labels = (me: Me) => navFor(me).map((item) => item.label);

describe('BC-05 and plan 4.17 billing navigation follows the policy', () => {
  it('shows a caretaker their cash on hand and nothing else of billing', () => {
    const caretaker = member('caretaker', { phone: true, scope: { properties: [LEGON] } });
    expect(labels(caretaker).filter((label) => BILLING.includes(label))).toEqual(['Cash on hand']);
    expect(allowed(caretaker, 'payment.record')).toBe(true);
    expect(allowed(caretaker, 'cash.bank')).toBe(true);
    expect(allowed(caretaker, 'billing.view')).toBe(false);
  });

  it('shows a manager every billing section', () => {
    const manager = member('property_manager');
    expect(labels(manager).filter((label) => BILLING.includes(label))).toEqual(BILLING);
    expect(allowed(manager, 'billing.manage')).toBe(true);
    expect(allowed(manager, 'payment.record_transfer')).toBe(true);
  });

  it('lets an adviser read billing but record nothing', () => {
    const adviser = member('adviser');
    expect(labels(adviser)).toEqual(expect.arrayContaining(['Invoices', 'Arrears', 'Receipts']));
    expect(allowed(adviser, 'payment.record')).toBe(false);
    expect(allowed(adviser, 'billing.manage')).toBe(false);
  });

  it('marks Unmatched receipts, not Payments, on its own page, and Payments on a payment', () => {
    const hrefs = navFor(member('accountant')).map((item) => item.href);
    expect(activeNavHref('/payments/unmatched', hrefs)).toBe('/payments/unmatched');
    expect(activeNavHref('/payments/019a3000-0000-7000-8000-0000000000e3', hrefs)).toBe(
      '/payments',
    );
    expect(activeNavHref('/cash/banking', hrefs)).toBe('/cash');
    expect(activeNavHref('/invoices/019a3000-0000-7000-8000-0000000000e4', hrefs)).toBe(
      '/invoices',
    );
  });
});
