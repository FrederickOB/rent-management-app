import { describe, expect, it } from 'vitest';
import { instantFrom } from '../dates';
import { money } from '../money';
import {
  balanceReplyText,
  botStep,
  menuFor,
  newBotSession,
  repairLoggedText,
  seesAccount,
  type BotAction,
  type BotContext,
  type BotInput,
  type BotSession,
  type BotState,
} from './bot';

const NOW = instantFrom('2026-11-04T08:00:00Z');
const later = (minutes: number) => NOW.add({ minutes });

const LEASE_A = { id: 'lease-a', label: 'ACC-LEG-B1-04, Legon' };
const LEASE_B = { id: 'lease-b', label: 'ACC-OSU-G-02, Osu' };

const context = (overrides: Partial<BotContext> = {}): BotContext => ({
  plan: 'growth',
  companyName: 'Osu Properties',
  sender: { kind: 'tenant_phone' },
  leases: [LEASE_A],
  receipts: {
    'lease-a': [
      { id: 'r3', number: 'RCT-000003', issuedOn: '2026-11-01' },
      { id: 'r2', number: 'RCT-000002', issuedOn: '2026-10-01' },
      { id: 'r1', number: 'RCT-000001', issuedOn: '2026-09-01' },
    ],
  },
  now: NOW,
  ...overrides,
});

let n = 0;
const text = (t: string): BotInput => ({ kind: 'text', text: t, messageId: `m${++n}` });
const choice = (id: string): BotInput => ({ kind: 'choice', id, messageId: `m${++n}` });
const media = (caption: string | null = null): BotInput => ({
  kind: 'media',
  caption,
  messageId: `m${++n}`,
});
const at = (state: BotState, lastActivityAt: string | null = NOW.toString()): BotSession => ({
  state,
  lastActivityAt,
});
const menu = at({ name: 'menu', misses: 0 });
const replyOf = (action: BotAction | undefined) => {
  if (action?.type !== 'reply') throw new Error(`Expected a reply, got ${action?.type}`);
  return action;
};

describe('CM-03 menu bot: the menu', () => {
  it('shows the full menu on Growth and the short one on Starter (decision 9)', () => {
    expect(menuFor('growth')).toEqual([
      'balance',
      'receipt',
      'statement',
      'pay',
      'repair',
      'person',
    ]);
    expect(menuFor('starter')).toEqual(['balance', 'receipt', 'pay']);
    const growth = botStep(newBotSession(), context(), text('hi'));
    expect(growth.actions).toHaveLength(1);
    expect(growth.actions[0]).toMatchObject({ type: 'reply' });
    const reply = replyOf(growth.actions[0]);
    expect(reply.text).toContain('6 Talk to a person');
    expect(reply.choices.map((c) => c.id)).toEqual(menuFor('growth'));
    const starter = botStep(newBotSession(), context({ plan: 'starter' }), text('menu'));
    const short = replyOf(starter.actions[0]);
    expect(short.text).toContain('3 Pay rent');
    expect(short.text).not.toContain('Report a repair');
    expect(short.text).toContain('we will pass it to Osu Properties');
  });

  it('answers balance from the billing reads, by number, word or button', () => {
    for (const input of [text('1'), text('Balance'), choice('balance')]) {
      const step = botStep(menu, context(), input);
      expect(step.actions).toEqual([{ type: 'send_balance', leaseId: 'lease-a' }]);
      expect(step.session.state).toEqual({ name: 'menu', misses: 0 });
    }
  });

  it('sends the statement and the pay link for the lease', () => {
    expect(botStep(menu, context(), text('3')).actions).toEqual([
      { type: 'send_statement', leaseId: 'lease-a' },
    ]);
    expect(botStep(menu, context(), text('4')).actions).toEqual([
      { type: 'send_pay_link', leaseId: 'lease-a' },
    ]);
  });

  it('uses the plan’s own numbering: 3 is pay on Starter', () => {
    expect(botStep(menu, context({ plan: 'starter' }), text('3')).actions).toEqual([
      { type: 'send_pay_link', leaseId: 'lease-a' },
    ]);
  });

  it('hands over at once when the tenant asks for a person (Growth)', () => {
    const step = botStep(menu, context(), text('6'));
    expect(step.session.state).toEqual({ name: 'handed_over' });
    expect(step.actions).toContainEqual({ type: 'handover', reason: 'asked_for_person' });
  });

  it('asks again once, then hands over, when it does not understand (Growth)', () => {
    const first = botStep(menu, context(), text('my tap is leaking badly'));
    expect(first.session.state).toEqual({ name: 'menu', misses: 1 });
    expect(replyOf(first.actions[0]).text).toContain('did not understand');
    const second = botStep(first.session, context(), text('hello?? anyone'));
    expect(second.session.state).toEqual({ name: 'handed_over' });
    expect(second.actions).toContainEqual({ type: 'handover', reason: 'bot_cannot_help' });
  });

  it('forwards anything else to the landlord on Starter: free text, a repair, a person (decision 9)', () => {
    const starter = context({ plan: 'starter' });
    for (const input of [text('the roof leaks'), text('repair'), text('person'), text('6')]) {
      const step = botStep(menu, starter, input);
      expect(step.actions[0]).toEqual({
        type: 'forward_to_landlord',
        messageIds: [(input as { messageId: string }).messageId],
      });
      expect(step.session.state).toEqual({ name: 'menu', misses: 0 });
      expect(step.actions.some((a) => a.type === 'handover')).toBe(false);
    }
  });

  it('hands media sent from the menu to a person (proof of payment, a photo)', () => {
    const step = botStep(menu, context(), media('proof of payment'));
    expect(step.actions).toContainEqual({ type: 'handover', reason: 'media_received' });
  });
});

describe('CM-03 menu bot: who sees money (plan 4.5)', () => {
  it('shows figures to the tenant and to signatory and finance contacts only', () => {
    expect(seesAccount({ kind: 'tenant_phone' })).toBe(true);
    expect(seesAccount({ kind: 'contact', contactKind: 'signatory' })).toBe(true);
    expect(seesAccount({ kind: 'contact', contactKind: 'finance' })).toBe(true);
    for (const kind of ['guarantor', 'next_of_kin', 'employer'])
      expect(seesAccount({ kind: 'contact', contactKind: kind })).toBe(false);
  });

  it('gives a contact without a billing role no figures, only a person', () => {
    const guarantor = context({ sender: { kind: 'contact', contactKind: 'guarantor' } });
    for (const input of [text('1'), choice('balance'), text('receipt')]) {
      const step = botStep(menu, guarantor, input);
      expect(step.actions.map((a) => a.type)).toEqual(['reply', 'handover']);
      expect(step.actions).toContainEqual({ type: 'handover', reason: 'contact_without_account' });
    }
    const starter = botStep(menu, { ...guarantor, plan: 'starter' }, text('1'));
    expect(starter.actions.map((a) => a.type)).toEqual(['forward_to_landlord', 'reply']);
  });

  it('hands over a tenant with no lease it can talk about', () => {
    const step = botStep(menu, context({ leases: [] }), text('1'));
    expect(step.actions).toContainEqual({ type: 'handover', reason: 'no_lease' });
  });
});

describe('CM-03 menu bot: choose lease', () => {
  const two = context({ leases: [LEASE_A, LEASE_B] });

  it('asks which home for a tenant with several leases, then carries on', () => {
    const asked = botStep(menu, two, text('1'));
    expect(asked.session.state).toEqual({ name: 'choose_lease', option: 'balance' });
    const list = replyOf(asked.actions[0]);
    expect(list.text).toContain('2 ACC-OSU-G-02, Osu');
    expect(list.choices.map((c) => c.id)).toEqual(['lease:lease-a', 'lease:lease-b']);
    expect(botStep(asked.session, two, text('2')).actions).toEqual([
      { type: 'send_balance', leaseId: 'lease-b' },
    ]);
    expect(botStep(asked.session, two, choice('lease:lease-a')).actions).toEqual([
      { type: 'send_balance', leaseId: 'lease-a' },
    ]);
  });

  it('asks again on a wrong answer, and goes back on MENU', () => {
    const asked = botStep(menu, two, text('4'));
    const wrong = botStep(asked.session, two, text('9'));
    expect(wrong.session.state).toEqual({ name: 'choose_lease', option: 'pay' });
    expect(botStep(asked.session, two, choice('lease:lease-z')).session.state).toEqual({
      name: 'choose_lease',
      option: 'pay',
    });
    expect(botStep(asked.session, two, text('menu')).session.state).toEqual({
      name: 'menu',
      misses: 0,
    });
  });
});

describe('CM-03 menu bot: receipts list', () => {
  it('lists the last three receipts and sends the one picked', () => {
    const listed = botStep(menu, context(), text('2'));
    expect(listed.session.state).toEqual({
      name: 'receipts',
      leaseId: 'lease-a',
      receiptIds: ['r3', 'r2', 'r1'],
    });
    expect(replyOf(listed.actions[0]).text).toContain('1 RCT-000003 of 1 November 2026');
    expect(botStep(listed.session, context(), text('2')).actions).toEqual([
      { type: 'send_receipt', leaseId: 'lease-a', receiptId: 'r2' },
    ]);
    expect(botStep(listed.session, context(), choice('receipt:r1')).actions).toEqual([
      { type: 'send_receipt', leaseId: 'lease-a', receiptId: 'r1' },
    ]);
  });

  it('sends a lone receipt at once, and says so when there is none', () => {
    const one = context({
      receipts: { 'lease-a': [{ id: 'r1', number: 'RCT-000001', issuedOn: '2026-09-01' }] },
    });
    expect(botStep(menu, one, text('2')).actions).toEqual([
      { type: 'send_receipt', leaseId: 'lease-a', receiptId: 'r1' },
    ]);
    const none = botStep(menu, context({ receipts: {} }), text('2'));
    expect(replyOf(none.actions[0]).text).toContain('no receipts yet');
    expect(none.session.state).toEqual({ name: 'menu', misses: 0 });
  });

  it('asks again on a number not in the list, and never sends another lease’s receipt', () => {
    const listed = botStep(menu, context(), text('2'));
    expect(botStep(listed.session, context(), text('4')).session.state.name).toBe('receipts');
    expect(botStep(listed.session, context(), choice('receipt:not-mine')).actions[0]).toMatchObject(
      {
        type: 'reply',
      },
    );
  });
});

describe('CM-03 and CM-04 menu bot: repair', () => {
  it('collects a description and media until DONE, then reports one repair with every message', () => {
    const started = botStep(menu, context(), text('5'));
    expect(started.session.state).toMatchObject({ name: 'repair', leaseId: 'lease-a' });
    const words = text('The kitchen tap leaks');
    const photo = media('under the sink');
    const one = botStep(started.session, context(), words);
    expect(one.actions).toHaveLength(1); // "Got it", once
    const two = botStep(one.session, context(), photo);
    expect(two.actions).toEqual([]);
    const done = botStep(two.session, context(), text('done'));
    expect(done.actions).toEqual([
      {
        type: 'report_repair',
        leaseId: 'lease-a',
        description: 'The kitchen tap leaks\nunder the sink',
        messageIds: [
          (words as { messageId: string }).messageId,
          (photo as { messageId: string }).messageId,
        ],
      },
    ]);
    expect(done.session.state).toEqual({ name: 'menu', misses: 0 });
  });

  it('will not report an empty repair, and CANCEL drops it', () => {
    const started = botStep(menu, context(), text('repair'));
    const empty = botStep(started.session, context(), text('DONE'));
    expect(empty.session.state.name).toBe('repair');
    expect(empty.actions[0]).toMatchObject({ type: 'reply' });
    const cancelled = botStep(started.session, context(), text('cancel'));
    expect(cancelled.session.state).toEqual({ name: 'menu', misses: 0 });
    expect(cancelled.actions.some((a) => a.type === 'report_repair')).toBe(false);
  });

  it('reports what it has once 10 minutes pass, on a tick or the next message', () => {
    const started = botStep(menu, context(), text('5'));
    const described = botStep(started.session, context(), text('No water since morning'));
    const tick = botStep(described.session, context({ now: later(10) }), { kind: 'tick' });
    expect(tick.actions).toMatchObject([
      { type: 'report_repair', description: 'No water since morning' },
    ]);
    expect(tick.session.state).toEqual({ name: 'menu', misses: 0 });
    const early = botStep(described.session, context({ now: later(9) }), { kind: 'tick' });
    expect(early.actions).toEqual([]);
    const next = botStep(described.session, context({ now: later(12) }), text('1'));
    expect(next.actions.map((a) => a.type)).toEqual(['report_repair', 'send_balance']);
  });

  it('drops an empty repair after 10 minutes without reporting it', () => {
    const started = botStep(menu, context(), text('5'));
    expect(botStep(started.session, context({ now: later(11) }), { kind: 'tick' }).actions).toEqual(
      [],
    );
  });
});

describe('CM-03 menu bot: handed over and idle sessions', () => {
  it('stays out of a conversation a person has', () => {
    const handed = at({ name: 'handed_over' });
    for (const input of [text('1'), media(), text('menu')]) {
      const step = botStep(handed, context(), input);
      expect(step.actions).toEqual([]);
      expect(step.session.state).toEqual({ name: 'handed_over' });
    }
  });

  it('starts again at the menu after 30 idle minutes', () => {
    const waiting = at({ name: 'choose_lease', option: 'pay' });
    const step = botStep(waiting, context({ now: later(31) }), text('2'));
    // "2" is now read from the menu: the receipt list.
    expect(step.session.state.name).toBe('receipts');
  });

  it('is pure: the same step twice gives the same result', () => {
    const input = text('1');
    expect(botStep(menu, context(), input)).toEqual(botStep(menu, context(), input));
  });
});

describe('CM-03 bot replies carry billing figures, never computed ones', () => {
  it('words the figures it is given', () => {
    expect(
      balanceReplyText({
        leaseLabel: 'ACC-LEG-B1-04, Legon',
        amountDue: money(150_000),
        paidUntil: '2026-12-14',
        nextDueDate: '2026-12-15',
      }),
    ).toBe(
      'ACC-LEG-B1-04, Legon: GH₵1,500.00 is due now. Your rent is paid until 14 December 2026. The next rent is due on 15 December 2026. Reply MENU for the menu.',
    );
    expect(
      balanceReplyText({
        leaseLabel: 'X',
        amountDue: money(0),
        paidUntil: null,
        nextDueDate: null,
      }),
    ).toBe('X: Nothing is due now. Reply MENU for the menu.');
    expect(repairLoggedText('MT-0042', 'Osu Properties')).toContain('ticket MT-0042');
  });
});
