import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instantFrom } from '../dates';
import { formatTicketNumber, parseTicketNumber } from '../maintenance';
import {
  applyConversationEvent,
  ConversationTransitionError,
  isOverdue,
  overdueAlertKey,
  overdueAlertRecipients,
  type ConversationEvent,
  type ConversationFacts,
} from './inbox';
import { defaultReplyChannel } from './outbound';

const T0 = instantFrom('2026-11-04T08:00:00Z');
const at = (minutes: number) => T0.add({ minutes });
const TARGET = 240;
const step = (facts: ConversationFacts | null, event: ConversationEvent, minute = 0) =>
  applyConversationEvent(facts, event, at(minute), TARGET);

describe('CM-05 conversation states (architecture section 7)', () => {
  it('starts in triage for an unknown number, with the bot on WhatsApp, and open on other channels', () => {
    expect(step(null, { type: 'unknown_message', channel: 'whatsapp' }).state).toBe('triage');
    expect(step(null, { type: 'tenant_message', channel: 'whatsapp' })).toEqual({
      state: 'bot',
      assigneeId: null,
      firstResponseDueAt: null,
    });
    for (const channel of ['sms', 'email', 'in_app'] as const)
      expect(step(null, { type: 'tenant_message', channel }).state).toBe('open');
    expect(step(null, { type: 'staff_started' }).state).toBe('open');
  });

  it('goes from the bot to a person on handover, then through assigned, awaiting tenant and resolved', () => {
    const bot = step(null, { type: 'tenant_message', channel: 'whatsapp' });
    expect(step(bot, { type: 'bot_served' })).toEqual(bot);
    const open = step(bot, { type: 'handover' }, 5);
    expect(open.state).toBe('open');
    const assigned = step(open, { type: 'assigned', assigneeId: 'p1' }, 6);
    expect(assigned).toMatchObject({ state: 'assigned', assigneeId: 'p1' });
    const waiting = step(assigned, { type: 'staff_reply' }, 7);
    expect(waiting).toEqual({
      state: 'awaiting_tenant',
      assigneeId: 'p1',
      firstResponseDueAt: null,
    });
    const back = step(waiting, { type: 'tenant_message', channel: 'sms' }, 8);
    expect(back.state).toBe('assigned');
    const resolved = step(back, { type: 'resolved' }, 9);
    expect(resolved.state).toBe('resolved');
    // A tenant who writes again starts with the bot on WhatsApp, with a person elsewhere.
    expect(step(resolved, { type: 'tenant_message', channel: 'whatsapp' }).state).toBe('bot');
    expect(step(resolved, { type: 'tenant_message', channel: 'email' }).state).toBe('assigned');
    expect(step(resolved, { type: 'reopened' }).state).toBe('assigned');
  });

  it('moves a linked triage conversation to a person, timed from the unanswered message', () => {
    const triage = step(null, { type: 'unknown_message', channel: 'whatsapp' });
    const linked = step(triage, { type: 'linked', messageAt: at(0).toString() }, 30);
    expect(linked).toEqual({
      state: 'open',
      assigneeId: null,
      firstResponseDueAt: at(TARGET).toString(),
    });
  });

  it('closes a conversation waiting on the tenant after the quiet period', () => {
    const waiting: ConversationFacts = {
      state: 'awaiting_tenant',
      assigneeId: 'p1',
      firstResponseDueAt: null,
    };
    expect(step(waiting, { type: 'no_reply_timeout' }).state).toBe('resolved');
    const open: ConversationFacts = { state: 'open', assigneeId: null, firstResponseDueAt: null };
    expect(step(open, { type: 'no_reply_timeout' })).toEqual(open);
  });

  it('refuses transitions the machine does not have', () => {
    const triage: ConversationFacts = {
      state: 'triage',
      assigneeId: null,
      firstResponseDueAt: null,
    };
    expect(() => step(triage, { type: 'staff_reply' })).toThrow(ConversationTransitionError);
    expect(() => step(triage, { type: 'assigned', assigneeId: 'p1' })).toThrow(
      ConversationTransitionError,
    );
    expect(() => step(null, { type: 'handover' })).toThrow(ConversationTransitionError);
    const resolved: ConversationFacts = {
      state: 'resolved',
      assigneeId: null,
      firstResponseDueAt: null,
    };
    expect(() => step(resolved, { type: 'staff_reply' })).toThrow(ConversationTransitionError);
    const open: ConversationFacts = { state: 'open', assigneeId: null, firstResponseDueAt: null };
    expect(() => step(open, { type: 'linked', messageAt: at(0).toString() })).toThrow(
      ConversationTransitionError,
    );
  });
});

describe('CM-06 response target (decision 10)', () => {
  it('starts the clock at the tenant’s message, keeps its first time, and clears on a staff reply', () => {
    const open = step(null, { type: 'tenant_message', channel: 'sms' }, 0);
    expect(open.firstResponseDueAt).toBe(at(240).toString());
    const again = step(open, { type: 'tenant_message', channel: 'sms' }, 60);
    expect(again.firstResponseDueAt).toBe(at(240).toString());
    const replied = step(again, { type: 'staff_reply' }, 90);
    expect(replied.firstResponseDueAt).toBeNull();
    const next = step(replied, { type: 'tenant_message', channel: 'sms' }, 100);
    expect(next.firstResponseDueAt).toBe(at(340).toString());
  });

  it('starts the clock at the bot’s handover, and owes nothing while the bot has it', () => {
    const bot = step(null, { type: 'tenant_message', channel: 'whatsapp' }, 0);
    expect(
      step(bot, { type: 'tenant_message', channel: 'whatsapp' }, 10).firstResponseDueAt,
    ).toBeNull();
    expect(step(bot, { type: 'handover' }, 20).firstResponseDueAt).toBe(at(260).toString());
  });

  it('is overdue only while staff owe a reply and the target has passed (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'triage',
          'bot',
          'open',
          'assigned',
          'awaiting_tenant',
          'resolved' as const,
        ),
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
        fc.integer({ min: 0, max: 1000 }),
        (state, dueMinute, nowMinute) => {
          const facts: ConversationFacts = {
            state,
            assigneeId: null,
            firstResponseDueAt: dueMinute === null ? null : at(dueMinute).toString(),
          };
          expect(isOverdue(facts, at(nowMinute))).toBe(
            dueMinute !== null &&
              (state === 'open' || state === 'assigned') &&
              nowMinute >= dueMinute,
          );
        },
      ),
    );
  });

  it('alerts once per conversation and deadline: the assignee, or the managers when unassigned', () => {
    const due = at(240).toString();
    expect(overdueAlertKey('c1', due)).toBe(overdueAlertKey('c1', at(240).toString()));
    expect(overdueAlertKey('c1', due)).not.toBe(overdueAlertKey('c1', at(300).toString()));
    expect(overdueAlertRecipients({ assigneeId: 'p1', managerIds: ['m1', 'm2'] })).toEqual(['p1']);
    expect(overdueAlertRecipients({ assigneeId: null, managerIds: ['m2', 'm1', 'm2'] })).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('offers the channel the tenant last wrote on first in the composer', () => {
    expect(defaultReplyChannel({ sms: at(5), whatsapp: at(10), email: null })).toBe('whatsapp');
    expect(defaultReplyChannel({})).toBeNull();
  });
});

describe('CM-04 ticket numbers', () => {
  it('formats and reads ticket numbers', () => {
    expect(formatTicketNumber(42)).toBe('MT-0042');
    expect(formatTicketNumber(12345)).toBe('MT-12345');
    expect(parseTicketNumber('mt-0042')).toBe(42);
    expect(parseTicketNumber('MT-42')).toBeNull();
    expect(() => formatTicketNumber(0)).toThrow();
  });
});
