import { addMinutes, instantFrom, type Instant } from '../dates';
import type { Channel } from './channels';

/**
 * The conversation's working state (architecture section 7; CM-02 to CM-06; M6 plan 4.6 and
 * decision 10). One thread per tenant per company (CM-05); this tracks where the thread is, who
 * has it and when the first staff reply is due.
 */
export const CONVERSATION_STATES = [
  'triage',
  'bot',
  'open',
  'assigned',
  'awaiting_tenant',
  'resolved',
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** States in which staff owe a reply, so the response target runs and the overdue alert can fire. */
export const AWAITING_STAFF: readonly ConversationState[] = ['open', 'assigned'];

/** The views of the inbox list (plan 4.11). */
export const INBOX_VIEWS = [
  'all',
  'mine',
  'unassigned',
  'triage',
  'overdue',
  'bot',
  'resolved',
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export interface ConversationFacts {
  readonly state: ConversationState;
  readonly assigneeId: string | null;
  /** ISO instant, or null when no reply is owed. */
  readonly firstResponseDueAt: string | null;
}

export type ConversationEvent =
  /** A known tenant or contact wrote in, on a channel. */
  | { readonly type: 'tenant_message'; readonly channel: Channel }
  /** An unknown number or address wrote in. */
  | { readonly type: 'unknown_message'; readonly channel: Channel }
  /** Staff linked a triage conversation to a tenant; `messageAt` is the unanswered message's time. */
  | { readonly type: 'linked'; readonly messageAt: string }
  /** The bot answered something itself (balance, receipt, pay link, a ticket). */
  | { readonly type: 'bot_served' }
  /** The bot handed over: the tenant asked for a person or the bot could not help. */
  | { readonly type: 'handover' }
  /** Staff started a conversation with a tenant who had none. */
  | { readonly type: 'staff_started' }
  | { readonly type: 'assigned'; readonly assigneeId: string }
  | { readonly type: 'unassigned' }
  | { readonly type: 'staff_reply' }
  | { readonly type: 'resolved' }
  | { readonly type: 'reopened' }
  /** No tenant reply for N days while waiting for one (architecture section 7). */
  | { readonly type: 'no_reply_timeout' };

export class ConversationTransitionError extends Error {
  override readonly name = 'ConversationTransitionError';
}

const due = (from: Instant, minutes: number) => addMinutes(from, minutes).toString();

/**
 * The next state, assignee and response deadline (decision 10). The deadline starts at a tenant's
 * message (or the bot's handover) when no reply is owed yet, keeps its first time while more
 * messages arrive, and clears when staff reply or resolve. A conversation with the bot owes none.
 */
export function applyConversationEvent(
  current: ConversationFacts | null,
  event: ConversationEvent,
  at: Instant,
  firstResponseMinutes: number,
): ConversationFacts {
  const assigneeId = current?.assigneeId ?? null;
  const pending = current?.firstResponseDueAt ?? null;
  const staffState = (): ConversationState => (assigneeId ? 'assigned' : 'open');
  const owed = (): string => pending ?? due(at, firstResponseMinutes);
  const fail = (): never => {
    throw new ConversationTransitionError(
      `A conversation ${current ? `in ${current.state}` : 'not yet started'} cannot take ${event.type}`,
    );
  };

  if (!current) {
    switch (event.type) {
      case 'unknown_message':
        return { state: 'triage', assigneeId: null, firstResponseDueAt: null };
      case 'tenant_message':
        // The bot answers on WhatsApp; email, SMS and in-app messages go to a person (section 7).
        return event.channel === 'whatsapp'
          ? { state: 'bot', assigneeId: null, firstResponseDueAt: null }
          : { state: 'open', assigneeId: null, firstResponseDueAt: due(at, firstResponseMinutes) };
      case 'staff_started':
        return { state: 'open', assigneeId: null, firstResponseDueAt: null };
      default:
        return fail();
    }
  }

  switch (event.type) {
    case 'unknown_message':
      if (current.state === 'triage') return current;
      return fail();
    case 'tenant_message':
      switch (current.state) {
        case 'triage':
          return current;
        case 'bot':
          return event.channel === 'whatsapp'
            ? current
            : { state: staffState(), assigneeId, firstResponseDueAt: owed() };
        case 'resolved':
          return event.channel === 'whatsapp'
            ? { state: 'bot', assigneeId, firstResponseDueAt: null }
            : { state: staffState(), assigneeId, firstResponseDueAt: owed() };
        case 'open':
        case 'assigned':
        case 'awaiting_tenant':
          return { state: staffState(), assigneeId, firstResponseDueAt: owed() };
      }
      return fail();
    case 'linked':
      // The linked message is still unanswered, so a person picks it up (not the bot), and the
      // response target runs from when it arrived.
      if (current.state !== 'triage') return fail();
      return {
        state: 'open',
        assigneeId,
        firstResponseDueAt: due(instantFrom(event.messageAt), firstResponseMinutes),
      };
    case 'bot_served':
      if (current.state !== 'bot') return fail();
      return current;
    case 'handover':
      if (current.state !== 'bot') return fail();
      return { state: staffState(), assigneeId, firstResponseDueAt: owed() };
    case 'staff_started':
      return current;
    case 'assigned':
      if (current.state === 'triage' || current.state === 'resolved') return fail();
      return {
        state:
          current.state === 'awaiting_tenant' || current.state === 'bot'
            ? current.state
            : 'assigned',
        assigneeId: event.assigneeId,
        firstResponseDueAt: current.firstResponseDueAt,
      };
    case 'unassigned':
      if (!assigneeId) return current;
      return {
        state: current.state === 'assigned' ? 'open' : current.state,
        assigneeId: null,
        firstResponseDueAt: current.firstResponseDueAt,
      };
    case 'staff_reply':
      if (current.state === 'triage' || current.state === 'resolved') return fail();
      return { state: 'awaiting_tenant', assigneeId, firstResponseDueAt: null };
    case 'resolved':
      if (current.state === 'resolved') return current;
      return { state: 'resolved', assigneeId, firstResponseDueAt: null };
    case 'reopened':
      if (current.state !== 'resolved') return fail();
      return { state: staffState(), assigneeId, firstResponseDueAt: null };
    case 'no_reply_timeout':
      if (current.state !== 'awaiting_tenant') return current;
      return { state: 'resolved', assigneeId, firstResponseDueAt: null };
  }
}

/** Whether a conversation is past its response target now (CM-06). */
export function isOverdue(facts: ConversationFacts, now: Instant): boolean {
  if (!facts.firstResponseDueAt || !AWAITING_STAFF.includes(facts.state)) return false;
  return instantFrom(facts.firstResponseDueAt).epochMilliseconds <= now.epochMilliseconds;
}

/**
 * The overdue alert's idempotency key (plan 4.13): one alert per conversation and deadline, so a
 * retried check never alerts twice, and a new deadline alerts again.
 */
export const overdueAlertKey = (conversationId: string, dueAt: string): string =>
  `messaging.overdue:${conversationId}:${instantFrom(dueAt).toString()}`;

/** Who the overdue alert goes to (decision 10): the assignee, or the managers when unassigned. */
export function overdueAlertRecipients(input: {
  readonly assigneeId: string | null;
  readonly managerIds: readonly string[];
}): readonly string[] {
  if (input.assigneeId) return [input.assigneeId];
  return [...new Set(input.managerIds)].sort();
}
