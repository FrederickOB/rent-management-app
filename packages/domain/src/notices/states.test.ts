import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import {
  applyNoticeEvent,
  checkLadderControl,
  checkNoticeClose,
  checkNoticeCorrection,
  checkNoticeEditable,
  checkNoticeTransition,
  isLive,
  NOTICE_OUTCOMES,
  noticeCompletionFor,
  noticeLadderFlags,
  noticeProgress,
  STAFF_NOTICE_OUTCOMES,
  supersededClosure,
  type NoticeCompletion,
  type NoticeEventFact,
  type NoticeEventKind,
  type NoticeRecipientRef,
  type NoticeStatus,
} from './states';
import type { NoticeType } from './types';

const one: NoticeRecipientRef[] = [{ recipientId: 'r1' }];
const two: NoticeRecipientRef[] = [{ recipientId: 'r1' }, { recipientId: 'r2' }];

/** Applies events one by one through the rules, as the service does. */
function run(
  events: readonly NoticeEventFact[],
  options: {
    type?: NoticeType;
    recipients?: readonly NoticeRecipientRef[];
    completion?: NoticeCompletion;
  } = {},
) {
  const type = options.type ?? 'rent_demand';
  const recipients = options.recipients ?? one;
  const completion = options.completion ?? 'each';
  const done: NoticeEventFact[] = [];
  let progress = noticeProgress([], recipients, completion);
  for (const event of events) {
    progress = applyNoticeEvent({ type, events: done, recipients, completion, event });
    done.push(event);
  }
  return progress;
}

const ev = (kind: NoticeEventKind, recipientId: string | null = null): NoticeEventFact => ({
  kind,
  recipientId,
});
const issued = [ev('submitted'), ev('approved'), ev('sent')];

describe('LN-03 status', () => {
  it('moves a draft through approval to sent', () => {
    expect(run([]).status).toBe('draft');
    expect(run([ev('submitted')]).status).toBe('pending_approval');
    expect(run([ev('submitted'), ev('returned_to_draft')]).status).toBe('draft');
    expect(run([ev('submitted'), ev('approved')]).status).toBe('approved');
    expect(run(issued).status).toBe('sent');
    expect(run([ev('cancelled')]).status).toBe('cancelled');
  });

  it('lets an issuer approve their own draft, but never a notice to quit (decision 8)', () => {
    expect(run([ev('approved'), ev('sent')]).status).toBe('sent');
    expect(() => run([ev('approved')], { type: 'notice_to_quit' })).toThrow(
      expect.objectContaining({ code: 'notice.two_person_required' }),
    );
    expect(run(issued, { type: 'notice_to_quit' }).status).toBe('sent');
  });

  it('sends an approved notice back to draft when issue is refused (plan 4.3)', () => {
    expect(run([ev('submitted'), ev('approved'), ev('returned_to_draft')]).status).toBe('draft');
    expect(() => checkNoticeTransition('rent_demand', 'pending_approval', 'cancelled')).toThrow(
      expect.objectContaining({ code: 'notice.transition' }),
    );
    expect(() => checkNoticeTransition('rent_demand', 'draft', 'sent')).toThrow(DomainError);
    expect(() => checkNoticeTransition('rent_demand', 'sent', 'draft')).toThrow(DomainError);
  });

  it('follows the tenant’s journey to Signed and Closed', () => {
    expect(run([...issued, ev('delivered', 'r1')]).status).toBe('delivered');
    expect(run([...issued, ev('delivered', 'r1'), ev('opened', 'r1')]).status).toBe('opened');
    expect(run([...issued, ev('opened', 'r1'), ev('signed', 'r1'), ev('closed')]).status).toBe(
      'closed',
    );
  });

  it('shows the furthest point reached: an open outranks a reminder, a late delivery changes nothing', () => {
    expect(run([...issued, ev('reminded', 'r1')]).status).toBe('reminded');
    expect(run([...issued, ev('reminded', 'r1'), ev('opened', 'r1')]).status).toBe('opened');
    expect(run([...issued, ev('opened', 'r1'), ev('reminded', 'r1')]).status).toBe('opened');
    expect(run([...issued, ev('opened', 'r1'), ev('delivered', 'r1')]).status).toBe('opened');
  });

  it('records a late signature after escalation as Signed (plan 4.4)', () => {
    const escalated = [...issued, ev('reminded', 'r1'), ev('escalated')];
    expect(run(escalated).status).toBe('escalated');
    expect(run([...escalated, ev('served')]).status).toBe('served');
    expect(run([...escalated, ev('served'), ev('opened', 'r1'), ev('signed', 'r1')]).status).toBe(
      'signed',
    );
  });

  it('needs an open before a signature, and one signature per recipient', () => {
    expect(() => run([...issued, ev('signed', 'r1')])).toThrow(
      expect.objectContaining({ code: 'notice.not_opened' }),
    );
    expect(() =>
      run([...issued, ev('opened', 'r1'), ev('signed', 'r1'), ev('signed', 'r1')]),
    ).toThrow(expect.objectContaining({ code: 'notice.already_signed' }));
    expect(() => run([...issued, ev('opened')])).toThrow(
      expect.objectContaining({ code: 'notice.recipient_required' }),
    );
    expect(() => run([...issued, ev('opened', 'stranger')])).toThrow(
      expect.objectContaining({ code: 'notice.recipient_unknown' }),
    );
  });

  it('refuses tracking before issue', () => {
    for (const kind of ['delivered', 'opened', 'reminded', 'served', 'closed'] as const)
      expect(() => run([ev('submitted'), ev('approved'), ev(kind, 'r1')])).toThrow(DomainError);
    expect(() => run([ev('submitted'), ev('approved'), ev('escalated')])).toThrow(DomainError);
  });

  it('records facts after closing but stops its own actions', () => {
    const closed = [...issued, ev('closed')];
    expect(run([...closed, ev('opened', 'r1'), ev('signed', 'r1'), ev('served')]).status).toBe(
      'closed',
    );
    for (const kind of ['reminded', 'escalated', 'ladder_paused', 'closed'] as const)
      expect(() => run([...closed, ev(kind, kind === 'reminded' ? 'r1' : null)])).toThrow(
        DomainError,
      );
  });

  it('keeps each joint tenant on their own record and Signed waits for all (decision 7)', () => {
    const p = run(
      [...issued, ev('opened', 'r1'), ev('signed', 'r1'), ev('reminded', 'r2'), ev('escalated')],
      {
        recipients: two,
      },
    );
    expect(p.status).toBe('escalated');
    expect(p.signed).toBe(false);
    expect(p.signedRecipients).toBe(1);
    expect(p.recipients).toEqual([
      { recipientId: 'r1', status: 'signed', signed: true, acknowledged: true },
      { recipientId: 'r2', status: 'escalated', signed: false, acknowledged: false },
    ]);
    const both = run(
      [...issued, ev('opened', 'r1'), ev('signed', 'r1'), ev('opened', 'r2'), ev('signed', 'r2')],
      { recipients: two },
    );
    expect(both).toMatchObject({ status: 'signed', signed: true });
    const servedOne = run([...issued, ev('opened', 'r1'), ev('signed', 'r1'), ev('served', 'r2')], {
      recipients: two,
    });
    expect(servedOne.status).toBe('served');
  });

  it('is Signed when any authorised signatory signs (LN-07)', () => {
    const p = run([...issued, ev('opened', 'r2'), ev('signed', 'r2')], {
      recipients: two,
      completion: 'any_one',
    });
    expect(p.status).toBe('signed');
    expect(p.signed).toBe(true);
    expect(p.recipients.map((r) => r.acknowledged)).toEqual([true, true]);
    expect(() =>
      run([...issued, ev('opened', 'r2'), ev('signed', 'r2'), ev('reminded', 'r1')], {
        recipients: two,
        completion: 'any_one',
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.already_signed' }));
  });

  it('groups a company tenant’s signatories on a building-wide notice', () => {
    const recipients: NoticeRecipientRef[] = [
      { recipientId: 'shop-a-1', party: 'shop-a' },
      { recipientId: 'shop-a-2', party: 'shop-a' },
      { recipientId: 'flat-1' },
    ];
    const half = run([...issued, ev('opened', 'shop-a-2'), ev('signed', 'shop-a-2')], {
      type: 'building_wide',
      recipients,
    });
    expect(half.signed).toBe(false);
    expect(half.recipients.map((r) => r.acknowledged)).toEqual([true, true, false]);
    expect(half.status).toBe('opened');
    const all = run(
      [
        ...issued,
        ev('opened', 'shop-a-2'),
        ev('signed', 'shop-a-2'),
        ev('opened', 'flat-1'),
        ev('signed', 'flat-1'),
      ],
      { type: 'building_wide', recipients },
    );
    expect(all).toMatchObject({ status: 'signed', signed: true, signedRecipients: 2 });
  });

  it('chooses the completion rule from the lease (decision 7)', () => {
    expect(noticeCompletionFor({ type: 'notice_to_quit', leaseUse: 'commercial' })).toBe('any_one');
    expect(noticeCompletionFor({ type: 'notice_to_quit', leaseUse: 'residential' })).toBe('each');
    expect(noticeCompletionFor({ type: 'building_wide', leaseUse: null })).toBe('each');
  });

  it('records a tenant’s own notice as received, then closes it (decision 13)', () => {
    expect(run([ev('received')], { type: 'tenant_originated' }).status).toBe('received');
    expect(run([ev('received'), ev('closed')], { type: 'tenant_originated' }).status).toBe(
      'closed',
    );
    expect(() => run([ev('submitted')], { type: 'tenant_originated' })).toThrow(
      expect.objectContaining({ code: 'notice.not_issuable' }),
    );
    expect(() => run([ev('received')], { type: 'rent_demand' })).toThrow(DomainError);
  });

  it('never goes backwards after issue, whatever events arrive (property-based)', () => {
    const rank: Partial<Record<NoticeStatus, number>> = {
      sent: 1,
      delivered: 2,
      reminded: 3,
      opened: 4,
      escalated: 5,
      served: 6,
      signed: 7,
      closed: 8,
    };
    const kinds: NoticeEventKind[] = [
      'delivered',
      'opened',
      'reminded',
      'escalated',
      'served',
      'signed',
      'closed',
      'ladder_paused',
      'ladder_resumed',
    ];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...kinds), fc.constantFrom('r1', 'r2', null)), {
          maxLength: 30,
        }),
        fc.constantFrom<NoticeCompletion>('each', 'any_one'),
        (sequence, completion) => {
          const done: NoticeEventFact[] = [...issued];
          let last = 1;
          const lastPerRecipient: Record<string, number> = { r1: 1, r2: 1 };
          for (const [kind, recipientId] of sequence) {
            const event = ev(kind, recipientId);
            try {
              const p = applyNoticeEvent({
                type: 'rent_demand',
                events: done,
                recipients: two,
                completion,
                event,
              });
              done.push(event);
              const now = rank[p.status]!;
              expect(now).toBeGreaterThanOrEqual(last);
              last = now;
              for (const r of p.recipients) {
                const s = rank[r.status!]!;
                expect(s).toBeGreaterThanOrEqual(lastPerRecipient[r.recipientId]!);
                lastPerRecipient[r.recipientId] = s;
              }
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
            }
          }
          if (done.some((e) => e.kind === 'closed'))
            expect(noticeProgress(done, two, completion).status).toBe('closed');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('LN-05 ladder controls', () => {
  it('pauses, resumes and cancels as flags, with a reason', () => {
    const live = { status: 'sent' as const, flags: { paused: false, cancelled: false } };
    const paused = checkLadderControl({ ...live, action: 'pause', reason: 'Tenant in hospital' });
    expect(paused).toEqual({ paused: true, cancelled: false });
    expect(
      checkLadderControl({ status: 'sent', flags: paused, action: 'resume', reason: 'Back home' }),
    ).toEqual({ paused: false, cancelled: false });
    expect(checkLadderControl({ ...live, action: 'cancel', reason: 'Served by hand' })).toEqual({
      paused: false,
      cancelled: true,
    });
    expect(() => checkLadderControl({ ...live, action: 'pause', reason: '' })).toThrow(
      expect.objectContaining({ code: 'notice.ladder_reason_required' }),
    );
    expect(() => checkLadderControl({ ...live, action: 'resume', reason: 'why' })).toThrow(
      expect.objectContaining({ code: 'notice.ladder_running' }),
    );
    expect(() =>
      checkLadderControl({ status: 'sent', flags: paused, action: 'pause', reason: 'again' }),
    ).toThrow(expect.objectContaining({ code: 'notice.ladder_paused' }));
    expect(() =>
      checkLadderControl({
        status: 'sent',
        flags: { paused: false, cancelled: true },
        action: 'resume',
        reason: 'undo',
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.ladder_cancelled' }));
    expect(() =>
      checkLadderControl({ status: 'draft', flags: live.flags, action: 'pause', reason: 'early' }),
    ).toThrow(expect.objectContaining({ code: 'notice.ladder_not_live' }));
  });

  it('derives the flags from events and keeps the status unchanged', () => {
    const events = [...issued, ev('ladder_paused')];
    expect(noticeLadderFlags(events)).toEqual({ paused: true, cancelled: false });
    expect(run(events).status).toBe('sent');
    expect(noticeLadderFlags([...events, ev('ladder_resumed')])).toEqual({
      paused: false,
      cancelled: false,
    });
    expect(noticeLadderFlags([...events, ev('ladder_cancelled')])).toEqual({
      paused: false,
      cancelled: true,
    });
    expect(() => run([...events, ev('reminded', 'r1')])).toThrow(
      expect.objectContaining({ code: 'notice.ladder_stopped' }),
    );
    expect(() => run([...events, ev('escalated')])).toThrow(
      expect.objectContaining({ code: 'notice.ladder_stopped' }),
    );
    expect(run([...events, ev('served')]).status).toBe('served');
  });
});

describe('LN-03 closure, corrections and immutability (plan 4.8)', () => {
  it('closes with an outcome and a note, and never ends the lease (decision 12)', () => {
    expect(NOTICE_OUTCOMES).toEqual([
      'complied',
      'paid',
      'vacated',
      'disputed',
      'referred_rent_control',
      'referred_court',
      'superseded',
      'withdrawn',
    ]);
    for (const outcome of STAFF_NOTICE_OUTCOMES)
      expect(
        checkNoticeClose({ status: 'escalated', outcome, note: 'Recorded by the manager' }),
      ).toEqual({ outcome, note: 'Recorded by the manager', leaseAction: 'none' });
    expect(() => checkNoticeClose({ status: 'signed', outcome: 'paid', note: ' ' })).toThrow(
      expect.objectContaining({ code: 'notice.close_note_required' }),
    );
    expect(() => checkNoticeClose({ status: 'signed', outcome: 'evicted', note: 'No' })).toThrow(
      expect.objectContaining({ code: 'notice.outcome_invalid' }),
    );
    expect(() =>
      checkNoticeClose({ status: 'draft', outcome: 'paid', note: 'Paid in full' }),
    ).toThrow(expect.objectContaining({ code: 'notice.close_not_allowed' }));
    expect(() =>
      checkNoticeClose({ status: 'closed', outcome: 'paid', note: 'Paid in full' }),
    ).toThrow(expect.objectContaining({ code: 'notice.close_not_allowed' }));
    expect(
      checkNoticeClose({ status: 'received', outcome: 'complied', note: 'Acknowledged' }).outcome,
    ).toBe('complied');
  });

  it('closes as superseded only when a correction is issued', () => {
    expect(() =>
      checkNoticeClose({ status: 'sent', outcome: 'superseded', note: 'Replaced' }),
    ).toThrow(expect.objectContaining({ code: 'notice.outcome_invalid' }));
    expect(supersededClosure({ originalStatus: 'reminded', correctionNumber: 'N-000042' })).toEqual(
      {
        outcome: 'superseded',
        note: 'Replaced by notice N-000042',
        leaseAction: 'none',
      },
    );
    expect(
      supersededClosure({ originalStatus: 'closed', correctionNumber: 'N-000042' }),
    ).toBeNull();
  });

  it('starts a correction only from an issued, open notice of the same type and lease', () => {
    const original = {
      status: 'sent' as const,
      type: 'notice_to_quit' as const,
      leaseId: 'l1',
      propertyId: 'p1',
    };
    const correction = { type: 'notice_to_quit' as const, leaseId: 'l1', propertyId: 'p1' };
    expect(() => checkNoticeCorrection({ original, correction })).not.toThrow();
    expect(() =>
      checkNoticeCorrection({ original: { ...original, status: 'closed' }, correction }),
    ).toThrow(expect.objectContaining({ code: 'notice.correction_not_allowed' }));
    expect(() =>
      checkNoticeCorrection({ original: { ...original, status: 'draft' }, correction }),
    ).toThrow(expect.objectContaining({ code: 'notice.correction_not_allowed' }));
    expect(() =>
      checkNoticeCorrection({ original, correction: { ...correction, type: 'breach' } }),
    ).toThrow(expect.objectContaining({ code: 'notice.correction_type' }));
    expect(() =>
      checkNoticeCorrection({ original, correction: { ...correction, leaseId: 'l2' } }),
    ).toThrow(expect.objectContaining({ code: 'notice.correction_lease' }));
  });

  it('allows edits only to a draft', () => {
    expect(() => checkNoticeEditable('draft')).not.toThrow();
    expect(() => checkNoticeEditable('pending_approval')).toThrow(
      expect.objectContaining({ code: 'notice.in_approval' }),
    );
    expect(() => checkNoticeEditable('approved')).toThrow(
      expect.objectContaining({ code: 'notice.in_approval' }),
    );
    for (const status of ['sent', 'opened', 'signed', 'served', 'closed'] as const) {
      expect(isLive(status) || status === 'closed').toBe(true);
      expect(() => checkNoticeEditable(status)).toThrow(
        expect.objectContaining({ code: 'notice.frozen' }),
      );
    }
    expect(() => checkNoticeEditable('cancelled')).toThrow(
      expect.objectContaining({ code: 'notice.cancelled' }),
    );
  });
});
