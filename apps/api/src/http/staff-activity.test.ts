import type { Actor } from '@rent/domain/policy';
import { describe, expect, it, vi } from 'vitest';
import { noteStaffActivity, type StaffActivityRecorder } from './staff-activity';

const staff: Actor = {
  kind: 'staff',
  personId: '019a3000-0000-7000-8000-000000000101',
  companyId: '019a3000-0000-7000-8000-000000000201',
  companyKind: 'agency',
  membershipId: '019a3000-0000-7000-8000-000000000301',
  role: 'property_manager',
  nominatedApprover: false,
  scope: {},
  authMethod: 'password_totp',
};

describe('DA-01 Gate 1 weekly active managers: a staff request is noted in the background (M11 decision 4)', () => {
  it('notes staff only, never tenants, platform admins or anonymous requests', () => {
    const recorder = { record: vi.fn().mockResolvedValue(true) };
    noteStaffActivity(recorder, staff);
    noteStaffActivity(recorder, {
      kind: 'tenant',
      personId: staff.personId,
      authMethod: 'phone_otp',
    });
    noteStaffActivity(recorder, {
      kind: 'platform_admin',
      personId: staff.personId,
      companyId: staff.companyId,
      membershipId: staff.membershipId,
      authMethod: 'password_totp',
    });
    noteStaffActivity(recorder, null);
    noteStaffActivity(null, staff);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(staff);
  });

  it('never fails or waits for the request: a failing write is dropped', async () => {
    const rejected: StaffActivityRecorder = {
      record: vi.fn().mockRejectedValue(new Error('database down')),
    };
    const thrown: StaffActivityRecorder = {
      record: vi.fn(() => {
        throw new Error('pool closed');
      }),
    };
    const never: StaffActivityRecorder = { record: vi.fn(() => new Promise(() => undefined)) };
    expect(noteStaffActivity(rejected, staff)).toBeUndefined();
    expect(noteStaffActivity(thrown, staff)).toBeUndefined();
    expect(noteStaffActivity(never, staff)).toBeUndefined();
    // The rejection is handled: nothing surfaces as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejected.record).toHaveBeenCalledTimes(1);
  });
});
