import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { activeNavHref } from './nav-match';
import { allowed } from './policy';

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const LEGON = '019a3000-0000-7000-8000-0000000000c1';

function member(
  role: string,
  options: {
    readonly kind?: 'agency' | 'landlord';
    readonly phone?: boolean;
    readonly scope?: { properties?: string[] };
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

const M4B = ['Unmatched receipts', 'Reconciliation', 'Settlement accounts'];
const labels = (me: Me) =>
  navFor(me)
    .map((item) => item.label)
    .filter((l) => M4B.includes(l));

describe('BC-12, ADR-008 and plan 4.11 provider-payment screens follow the policy', () => {
  it('shows a manager the queue and reconciliation, and settlement accounts to read', () => {
    const manager = member('property_manager');
    expect(labels(manager)).toEqual(M4B);
    expect(allowed(manager, 'payments.match')).toBe(true);
    expect(allowed(manager, 'settlement_account.change')).toBe(false);
    expect(allowed(manager, 'payment.refund_unmatched')).toBe(false);
  });

  it('lets an agency admin ask to change settlement accounts and refunds', () => {
    const admin = member('agency_admin');
    expect(labels(admin)).toEqual(M4B);
    expect(allowed(admin, 'settlement_account.change')).toBe(true);
    expect(allowed(admin, 'payment.refund_unmatched')).toBe(true);
  });

  it('lets an accountant match and ask for refunds, but not redirect rent', () => {
    const accountant = member('accountant');
    expect(allowed(accountant, 'payments.match')).toBe(true);
    expect(allowed(accountant, 'payment.refund_unmatched')).toBe(true);
    expect(allowed(accountant, 'settlement_account.change')).toBe(false);
  });

  it('gives a self-managing landlord every control in their own company', () => {
    const landlord = member('owner', { kind: 'landlord' });
    expect(labels(landlord)).toEqual(M4B);
    expect(allowed(landlord, 'settlement_account.change')).toBe(true);
    expect(allowed(landlord, 'payment.refund_unmatched')).toBe(true);
  });

  it('shows an adviser the queue to read, and nothing of reconciliation or accounts', () => {
    expect(labels(member('adviser'))).toEqual(['Unmatched receipts']);
    expect(allowed(member('adviser'), 'payments.match')).toBe(false);
  });

  it('shows a caretaker none of it', () => {
    const caretaker = member('caretaker', { phone: true, scope: { properties: [LEGON] } });
    expect(labels(caretaker)).toEqual([]);
  });

  it('marks the right section on each new page', () => {
    const hrefs = navFor(member('agency_admin')).map((item) => item.href);
    expect(activeNavHref('/payments/reconciliation', hrefs)).toBe('/payments/reconciliation');
    expect(activeNavHref('/settings/settlement', hrefs)).toBe('/settings/settlement');
    expect(activeNavHref('/payments/unmatched', hrefs)).toBe('/payments/unmatched');
  });
});
