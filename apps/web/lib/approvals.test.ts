import { describe, expect, it } from 'vitest';
import {
  approvalActionLabel,
  approvalMoves,
  closeReasonLabel,
  payloadReason,
  personName,
  subjectHref,
  type ApprovalRow,
} from './approvals';

const INITIATOR = '019a3000-0000-7000-8000-0000000000a1';
const OTHER = '019a3000-0000-7000-8000-0000000000a2';
const now = new Date('2026-10-29T12:00:00Z');

const request = (overrides: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: '019a3000-0000-7000-8000-0000000000e1',
  actionType: 'lease.cancel_signed',
  subjectType: 'lease',
  subjectId: '019a3000-0000-7000-8000-0000000000e2',
  payload: { leaseId: '019a3000-0000-7000-8000-0000000000e2', reason: 'The tenant withdrew' },
  initiatedBy: INITIATOR,
  mode: 'two_person',
  status: 'pending',
  coolingOffUntil: null,
  expiresAt: '2026-11-05T12:00:00.000Z',
  closeReason: null,
  createdAt: '2026-10-29T11:00:00.000Z',
  decisions: [],
  ...overrides,
});

describe('AD-05 and decision 6 the approvals screen', () => {
  it('never offers the initiator the decision, only withdrawal', () => {
    expect(approvalMoves(request(), INITIATOR, now)).toEqual({
      decide: false,
      withdraw: true,
      selfConfirm: false,
      waiting: 'second_person',
    });
  });

  it('offers a second person the decision once', () => {
    expect(approvalMoves(request(), OTHER, now)).toMatchObject({ decide: true, withdraw: false });
    const decided = request({
      decisions: [
        { decidedBy: OTHER, kind: 'approve', reason: null, decidedAt: now.toISOString() },
      ],
    });
    expect(approvalMoves(decided, OTHER, now).decide).toBe(false);
  });

  it('lets a landlord who works alone confirm only after the cooling-off', () => {
    const single = request({
      mode: 'single_user',
      status: 'cooling_off',
      coolingOffUntil: '2026-10-30T11:00:00.000Z',
    });
    expect(approvalMoves(single, INITIATOR, now)).toMatchObject({
      selfConfirm: false,
      waiting: 'cooling_off',
    });
    expect(approvalMoves(single, INITIATOR, new Date('2026-10-30T11:00:00Z')).selfConfirm).toBe(
      true,
    );
    expect(approvalMoves(single, OTHER, now).decide).toBe(false);
  });

  it('offers nothing on a closed or expired request', () => {
    const none = { decide: false, withdraw: false, selfConfirm: false, waiting: null };
    expect(approvalMoves(request({ status: 'approved' }), OTHER, now)).toEqual(none);
    expect(approvalMoves(request({ expiresAt: '2026-10-29T11:59:00.000Z' }), OTHER, now)).toEqual(
      none,
    );
  });

  it('says what the request is about and who asked', () => {
    expect(approvalActionLabel('lease.cancel_signed')).toBe(
      'Cancel a signed lease before it starts',
    );
    expect(payloadReason(request().payload)).toBe('The tenant withdrew');
    expect(payloadReason(null)).toBeNull();
    expect(subjectHref(request())).toBe('/leases/019a3000-0000-7000-8000-0000000000e2');
    expect(closeReasonLabel('withdrawn')).toBe('Withdrawn by the person who asked');
    const names = new Map([[OTHER, 'Akosua Manager (demo)']]);
    expect(personName(INITIATOR, { personId: INITIATOR }, names)).toBe('You');
    expect(personName(OTHER, { personId: INITIATOR }, names)).toBe('Akosua Manager (demo)');
    expect(personName('someone', { personId: INITIATOR }, names)).toBe(
      'Another person in your company',
    );
  });
});
