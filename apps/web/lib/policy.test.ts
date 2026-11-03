import type { Me } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { actorOf, allowed } from './policy';

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const OWNER_A = '019a3000-0000-7000-8000-00000000000a';

const accountant = (scope?: Me['memberships'][number]['scope']): Me => ({
  personId: '019a3000-0000-7000-8000-0000000000aa',
  name: 'Yaw Accountant (demo)',
  state: 'ready',
  authMethod: 'password_totp',
  sessionExpiresAt: '2026-10-29T13:00:00.000Z',
  actorKind: 'staff',
  activeCompanyId: AGENCY,
  role: 'accountant',
  memberships: [
    {
      membershipId: '019a3000-0000-7000-8000-0000000000bb',
      companyId: AGENCY,
      companyName: 'Osu Ridge Property Managers',
      companyKind: 'agency',
      role: 'accountant',
      nominatedApprover: false,
      ...(scope ? { scope } : {}),
    },
  ],
});

describe('AD-07 audit search scope (web)', () => {
  it('rebuilds the actor with the scope that GET /me sends', () => {
    const actor = actorOf(accountant({ owners: [OWNER_A] }));
    expect(actor).toMatchObject({ kind: 'staff', scope: { owners: [OWNER_A] } });
    // An API that sends no scope gives the whole company, as before.
    expect(actorOf(accountant())).toMatchObject({ scope: {} });
  });

  it('hides the audit log from an accountant limited to some owners, as the API refuses it', () => {
    const scoped = accountant({ owners: [OWNER_A] });
    expect(allowed(scoped, 'audit.search')).toBe(false);
    expect(navFor(scoped).map((item) => item.label)).not.toContain('Audit log');
    // Scope does not take away what a scoped session may do elsewhere.
    expect(allowed(scoped, 'tenant.view')).toBe(true);
  });

  it('keeps the audit log for an accountant who sees the whole company', () => {
    for (const me of [accountant({}), accountant()]) {
      expect(allowed(me, 'audit.search')).toBe(true);
      expect(navFor(me).map((item) => item.label)).toContain('Audit log');
    }
  });
});
