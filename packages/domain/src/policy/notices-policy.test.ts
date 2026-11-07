import { describe, expect, it } from 'vitest';
import { can, scopeOf, taskAssigneeOrder, type Actor } from './policy';

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
const manager: Actor = { ...caretaker, personId: 'p-man', role: 'property_manager', scope: {} };
const adviser: Actor = {
  ...caretaker,
  personId: 'p-adv',
  role: 'adviser',
  scope: { owners: ['o1'] },
};
const tenant: Actor = { kind: 'tenant', personId: 't1', authMethod: 'phone_otp' };

describe('LN-05 and CF-06 notice and task permissions (plan 4.11)', () => {
  it('lets a caretaker read notices, record service and complete only their own tasks', () => {
    expect(can(caretaker, 'notices.read').allowed).toBe(true);
    expect(can(caretaker, 'notices.service.record').allowed).toBe(true);
    expect(can(caretaker, 'notices.issue').allowed).toBe(false);
    expect(can(caretaker, 'notices.close').allowed).toBe(false);
    expect(can(caretaker, 'tasks.read').allowed).toBe(true);
    expect(
      can(caretaker, 'tasks.complete', { kind: 'task', assigneePersonId: 'p-care' }).allowed,
    ).toBe(true);
    const other = can(caretaker, 'tasks.complete', { kind: 'task', assigneePersonId: 'p-other' });
    expect(other.allowed).toBe(false);
    expect(other.message).toBe('This task is assigned to someone else');
    expect(can(caretaker, 'tasks.complete', { kind: 'task', assigneePersonId: null }).allowed).toBe(
      false,
    );
    expect(scopeOf(caretaker)).toEqual({ ownerIds: [], propertyIds: ['prop-1'] });
  });

  it('lets a manager complete anyone’s task in scope, and an adviser only read notices', () => {
    expect(
      can(manager, 'tasks.complete', { kind: 'task', assigneePersonId: 'p-care' }).allowed,
    ).toBe(true);
    expect(can(adviser, 'notices.read').allowed).toBe(true);
    for (const action of [
      'notices.draft',
      'notices.issue',
      'notices.ladder.control',
      'notices.service.record',
      'notices.close',
      'tasks.read',
    ] as const)
      expect(can(adviser, action).allowed, action).toBe(false);
  });

  it('keeps notices and tasks away from tenants', () => {
    for (const action of ['notices.read', 'tasks.read', 'tasks.complete'] as const)
      expect(can(tenant, action).allowed, action).toBe(false);
  });
});

describe('CF-06 task assignee order', () => {
  it('gives a property’s task to its caretaker, else its manager, else an admin or the landlord', () => {
    expect(taskAssigneeOrder('caretaker', 'agency')).toBe(0);
    expect(taskAssigneeOrder('property_manager', 'agency')).toBe(1);
    expect(taskAssigneeOrder('agency_admin', 'agency')).toBe(2);
    expect(taskAssigneeOrder('owner', 'landlord')).toBe(3);
    expect(taskAssigneeOrder('owner', 'agency')).toBeNull();
    expect(taskAssigneeOrder('accountant', 'agency')).toBeNull();
    expect(taskAssigneeOrder('adviser', 'agency')).toBeNull();
  });
});
