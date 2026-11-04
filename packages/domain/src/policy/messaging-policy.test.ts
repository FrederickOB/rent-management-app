import { describe, expect, it } from 'vitest';
import { can, scopeOf, type Actor } from './policy';

const tenant: Actor = { kind: 'tenant', personId: 't1', authMethod: 'phone_otp' };
const caretaker: Actor = {
  kind: 'staff',
  personId: 'p-care',
  companyId: 'c1',
  companyKind: 'agency',
  membershipId: 'm-care',
  role: 'caretaker',
  nominatedApprover: false,
  scope: { properties: ['prop-1'] },
  authMethod: 'phone_otp',
};
const accountant: Actor = {
  ...caretaker,
  role: 'accountant',
  scope: {},
  authMethod: 'password_totp',
};
const admin: Actor = {
  kind: 'platform_admin',
  personId: 'p-admin',
  companyId: 'c-platform',
  membershipId: 'm-admin',
  authMethod: 'password_totp',
};

describe('CM-05 and CM-06 inbox permissions (plan 4.12)', () => {
  it('lets a caretaker read and reply, within the assigned properties only, but not assign or triage', () => {
    expect(can(caretaker, 'messaging.inbox.read').allowed).toBe(true);
    expect(can(caretaker, 'messaging.reply').allowed).toBe(true);
    expect(can(caretaker, 'messaging.assign').allowed).toBe(false);
    expect(can(caretaker, 'messaging.triage').allowed).toBe(false);
    expect(can(caretaker, 'messaging.broadcast').allowed).toBe(false);
    // The scope the database applies to every conversation and message.
    expect(scopeOf(caretaker)).toEqual({ ownerIds: [], propertyIds: ['prop-1'] });
  });

  it('lets accountants read but never reply', () => {
    expect(can(accountant, 'messaging.inbox.read').allowed).toBe(true);
    expect(can(accountant, 'messaging.reply').allowed).toBe(false);
  });

  it('lets a tenant use only their own conversations, never the inbox', () => {
    expect(can(tenant, 'messaging.own').allowed).toBe(true);
    for (const action of [
      'messaging.inbox.read',
      'messaging.reply',
      'messaging.broadcast',
      'maintenance.view',
    ] as const)
      expect(can(tenant, action).allowed, action).toBe(false);
  });

  it('keeps WhatsApp numbers and plans with platform admins, and company data away from them', () => {
    expect(can(admin, 'whatsapp_account.manage').allowed).toBe(true);
    expect(can(admin, 'company.plan.manage').allowed).toBe(true);
    expect(can(admin, 'messaging.inbox.read').allowed).toBe(false);
    expect(can(accountant, 'whatsapp_account.manage').allowed).toBe(false);
    expect(can({ ...accountant, role: 'agency_admin' }, 'company.plan.manage').allowed).toBe(false);
  });
});
