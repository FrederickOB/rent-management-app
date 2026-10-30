import type { MembershipRow } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { usersByOwner } from './owner-users';

const OWNER_A = '019a3000-0000-7000-8000-00000000000a';
const OWNER_B = '019a3000-0000-7000-8000-00000000000b';
const LEGON = '019a3000-0000-7000-8000-000000000101';

let next = 0;
const member = (
  name: string,
  role: MembershipRow['role'],
  scope: MembershipRow['scope'],
  status: MembershipRow['status'] = 'active',
): MembershipRow => {
  next += 1;
  return {
    membershipId: `019a3000-0000-7000-8000-${String(next).padStart(12, '0')}`,
    personId: `019a3000-0000-7000-9000-${String(next).padStart(12, '0')}`,
    name,
    email: null,
    phoneMasked: null,
    role,
    status,
    nominatedApprover: false,
    scope,
    createdAt: '2026-10-28T10:00:00.000Z',
  };
};

describe('AD-02 users linked to each owner', () => {
  it('lists the client owners and advisers whose access names the owner, by name', () => {
    const linked = usersByOwner(
      [
        member('Ama Owner-London (demo)', 'owner', { owners: [OWNER_A] }),
        member('Nana Owner-Accra (demo)', 'owner', { owners: [OWNER_B] }),
        member('Adjoa Adviser (demo)', 'adviser', { owners: [OWNER_A] }),
        member('Kofi Manager (demo)', 'property_manager', {}),
      ],
      'agency',
    );
    expect(linked[OWNER_A]?.map((u) => [u.name, u.role])).toEqual([
      ['Adjoa Adviser (demo)', 'Adviser'],
      ['Ama Owner-London (demo)', 'Owner'],
    ]);
    expect(linked[OWNER_B]?.map((u) => u.name)).toEqual(['Nana Owner-Accra (demo)']);
    expect(Object.keys(linked)).toHaveLength(2);
  });

  it('leaves out revoked people, keeps invited ones marked, and ignores lists the role does not use', () => {
    const linked = usersByOwner(
      [
        member('Gone Adviser', 'adviser', { owners: [OWNER_A] }, 'revoked'),
        member('New Adviser', 'adviser', { owners: [OWNER_A, OWNER_A] }, 'invited'),
        // A caretaker works by property; an owner left in an old scope does not link them.
        member('Kojo Caretaker (demo)', 'caretaker', { owners: [OWNER_A], properties: [LEGON] }),
      ],
      'agency',
    );
    expect(linked[OWNER_A]).toEqual([
      expect.objectContaining({ name: 'New Adviser', role: 'Adviser', invited: true }),
    ]);
  });
});
