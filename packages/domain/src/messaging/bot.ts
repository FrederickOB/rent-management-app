import { formatBusinessDate, instantFrom, type Instant } from '../dates';
import { format, type Money } from '../money';
import { planHas, type InterimPlan } from '../settings/entitlements';

/**
 * The WhatsApp menu bot (CM-03; M6 plan 4.5; decision 9). A pure state machine: (session,
 * context, input) to (session, actions). The messaging service carries the actions out: it reads
 * every figure from billing, sends documents and links, creates the repair ticket and hands the
 * conversation to a person. The bot itself never computes or states an amount.
 *
 * States: menu, choose lease (a tenant with several), receipts list, repair (collecting a
 * description and media until DONE or 10 minutes pass), handed over.
 */

/** A session idle this long starts again at the menu (plan 4.2: bot_session). */
export const BOT_SESSION_IDLE_MINUTES = 30;
/** A repair report is sent once DONE arrives, or this long after it began. */
export const REPAIR_COLLECT_MINUTES = 10;
/** Unrecognised messages in a row before the bot hands over (Growth). */
export const BOT_MISSES_BEFORE_HANDOVER = 2;

export const BOT_OPTIONS = ['balance', 'receipt', 'statement', 'pay', 'repair', 'person'] as const;
export type BotOption = (typeof BOT_OPTIONS)[number];
type LeaseOption = Exclude<BotOption, 'person'>;

/** Decision 9: Starter offers balance, receipt and pay; anything else goes to the landlord. */
export function menuFor(plan: InterimPlan): readonly BotOption[] {
  return planHas(plan, 'bot_full_menu') ? BOT_OPTIONS : ['balance', 'receipt', 'pay'];
}

const OPTION_TITLES: Record<BotOption, string> = {
  balance: 'Balance and paid-until',
  receipt: 'Receipt',
  statement: 'Statement',
  pay: 'Pay rent',
  repair: 'Report a repair',
  person: 'Talk to a person',
};

/** Words a tenant may type for an option, as well as its number. */
const OPTION_WORDS: Record<BotOption, readonly string[]> = {
  balance: ['BALANCE', 'PAID UNTIL', 'HOW MUCH'],
  receipt: ['RECEIPT', 'RECEIPTS'],
  statement: ['STATEMENT'],
  pay: ['PAY', 'PAY RENT', 'PAYMENT LINK'],
  repair: ['REPAIR', 'REPORT A REPAIR', 'FIX'],
  person: ['PERSON', 'TALK TO A PERSON', 'AGENT', 'HUMAN', 'MANAGER'],
};

const MENU_WORDS = new Set(['MENU', 'HI', 'HELLO', 'HELP', '0', 'START OVER']);

/** Contact kinds that see account figures for a company tenant (plan 4.5). */
const MONEY_CONTACT_KINDS = new Set(['signatory', 'finance']);

export const HANDOVER_REASONS = [
  'asked_for_person',
  'bot_cannot_help',
  'media_received',
  'contact_without_account',
  'no_lease',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export interface BotLease {
  readonly id: string;
  /** For people: the unit code and property, e.g. "ACC-LEG-B2-04, Legon". */
  readonly label: string;
}

export interface BotReceipt {
  readonly id: string;
  readonly number: string;
  /** When it was issued (ISO date). */
  readonly issuedOn: string;
}

export interface BotContext {
  readonly plan: InterimPlan;
  readonly companyName: string;
  /**
   * Who is writing: the tenant from their own phone or email (`tenant_phone`), or one of the
   * tenant's contacts, by contact kind.
   */
  readonly sender:
    { readonly kind: 'tenant_phone' } | { readonly kind: 'contact'; readonly contactKind: string };
  /** The leases the bot may talk about, in a stable order. */
  readonly leases: readonly BotLease[];
  /** The last three receipts per lease, newest first. */
  readonly receipts: Readonly<Record<string, readonly BotReceipt[]>>;
  readonly now: Instant;
}

export type BotState =
  | { readonly name: 'menu'; readonly misses: number }
  | { readonly name: 'choose_lease'; readonly option: LeaseOption }
  | { readonly name: 'receipts'; readonly leaseId: string; readonly receiptIds: readonly string[] }
  | {
      readonly name: 'repair';
      readonly leaseId: string;
      /** ISO instant. */
      readonly startedAt: string;
      readonly text: readonly string[];
      readonly messageIds: readonly string[];
    }
  | { readonly name: 'handed_over' };

/** What `bot_session` stores, as JSON. */
export interface BotSession {
  readonly state: BotState;
  /** ISO instant of the last input, or null for a new session. */
  readonly lastActivityAt: string | null;
}

export const newBotSession = (): BotSession => ({
  state: { name: 'menu', misses: 0 },
  lastActivityAt: null,
});

export type BotInput =
  | { readonly kind: 'text'; readonly text: string; readonly messageId: string }
  /** A WhatsApp reply button or list row, by its id. */
  | { readonly kind: 'choice'; readonly id: string; readonly messageId: string }
  /** A photo, video, voice note or document, with any caption. */
  | { readonly kind: 'media'; readonly caption: string | null; readonly messageId: string }
  /** A scheduled check: ends a repair report after 10 minutes. */
  | { readonly kind: 'tick' };

export interface BotChoice {
  readonly id: string;
  readonly title: string;
}

export type BotAction =
  /** Text, with WhatsApp buttons or list rows; the text also numbers them, for plain SMS-style replies. */
  | { readonly type: 'reply'; readonly text: string; readonly choices: readonly BotChoice[] }
  | { readonly type: 'send_balance'; readonly leaseId: string }
  | { readonly type: 'send_receipt'; readonly leaseId: string; readonly receiptId: string }
  | { readonly type: 'send_statement'; readonly leaseId: string }
  | { readonly type: 'send_pay_link'; readonly leaseId: string }
  | {
      readonly type: 'report_repair';
      readonly leaseId: string;
      readonly description: string;
      /** The inbound messages that make up the report, with their media (CM-04). */
      readonly messageIds: readonly string[];
    }
  | { readonly type: 'handover'; readonly reason: HandoverReason }
  /** Starter (decision 9): logged on the tenant's timeline and sent to the landlord. */
  | { readonly type: 'forward_to_landlord'; readonly messageIds: readonly string[] };

export interface BotStep {
  readonly session: BotSession;
  readonly actions: readonly BotAction[];
}

const menuState = (): BotState => ({ name: 'menu', misses: 0 });

const minutesSince = (iso: string, now: Instant) =>
  (now.epochMilliseconds - instantFrom(iso).epochMilliseconds) / 60_000;

/** Whether this sender may see balances, receipts, statements and pay links (plan 4.5). */
export function seesAccount(sender: BotContext['sender']): boolean {
  return sender.kind === 'tenant_phone' || MONEY_CONTACT_KINDS.has(sender.contactKind);
}

/** The menu for the plan, numbered, with matching buttons. */
export function menuReply(context: BotContext, prefix?: string): BotAction {
  const options = menuFor(context.plan);
  const lines = options.map((o, i) => `${i + 1} ${OPTION_TITLES[o]}`);
  const starterFooter = planHas(context.plan, 'bot_full_menu')
    ? ''
    : `\nOr type a message and we will pass it to ${context.companyName}.`;
  const head = prefix ? `${prefix}\n` : '';
  return {
    type: 'reply',
    text: `${head}Hello from ${context.companyName}. Reply with a number:\n${lines.join('\n')}${starterFooter}`,
    choices: options.map((o) => ({ id: o, title: OPTION_TITLES[o] })),
  };
}

const reply = (text: string, choices: readonly BotChoice[] = []): BotAction => ({
  type: 'reply',
  text,
  choices,
});

const upper = (text: string) =>
  text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The option an input names: a button id, the option's number in this plan's menu, or a word. */
function optionOf(input: BotInput, plan: InterimPlan): BotOption | null {
  const options = menuFor(plan);
  if (input.kind === 'choice')
    return (options as readonly string[]).includes(input.id) ? (input.id as BotOption) : null;
  if (input.kind !== 'text') return null;
  const words = upper(input.text);
  const n = Number.parseInt(words, 10);
  if (String(n) === words) return options[n - 1] ?? null;
  for (const option of options) if (OPTION_WORDS[option].includes(words)) return option;
  return null;
}

/** A numbered pick from a list: `<prefix>:<id>` from a list row, or its number. */
function pickFrom(input: BotInput, prefix: string, ids: readonly string[]): string | null {
  if (input.kind === 'choice' && input.id.startsWith(`${prefix}:`)) {
    const id = input.id.slice(prefix.length + 1);
    return ids.includes(id) ? id : null;
  }
  if (input.kind !== 'text') return null;
  const words = upper(input.text);
  const n = Number.parseInt(words, 10);
  return String(n) === words ? (ids[n - 1] ?? null) : null;
}

const isMenuWord = (input: BotInput) => input.kind === 'text' && MENU_WORDS.has(upper(input.text));
const isWord = (input: BotInput, word: string) =>
  input.kind === 'text' && upper(input.text) === word;
const messageIdOf = (input: BotInput): string | null =>
  'messageId' in input ? input.messageId : null;

/** Ends a repair report: sent if it has anything in it, otherwise dropped. */
function finishRepair(state: Extract<BotState, { name: 'repair' }>): BotAction[] {
  if (state.text.length === 0 && state.messageIds.length === 0) return [];
  return [
    {
      type: 'report_repair',
      leaseId: state.leaseId,
      description: state.text.join('\n').trim(),
      messageIds: state.messageIds,
    },
  ];
}

/** Hands the conversation to a person (Growth), or passes the message on (Starter). */
function toPerson(
  context: BotContext,
  input: BotInput,
  reason: HandoverReason,
  text: string,
): { state: BotState; actions: BotAction[] } {
  if (!planHas(context.plan, 'bot_full_menu')) {
    const id = messageIdOf(input);
    return {
      state: menuState(),
      actions: [
        { type: 'forward_to_landlord', messageIds: id ? [id] : [] },
        reply(`We have passed your message to ${context.companyName}. They will get back to you.`),
      ],
    };
  }
  return {
    state: { name: 'handed_over' },
    actions: [reply(text), { type: 'handover', reason }],
  };
}

function leaseList(context: BotContext): BotAction {
  const lines = context.leases.map((l, i) => `${i + 1} ${l.label}`);
  return reply(
    `Which home is this about? Reply with a number:\n${lines.join('\n')}`,
    context.leases.map((l) => ({ id: `lease:${l.id}`, title: l.label.slice(0, 24) })),
  );
}

/** What an option does for a chosen lease. */
function proceed(
  context: BotContext,
  option: LeaseOption,
  lease: BotLease,
  now: Instant,
): { state: BotState; actions: BotAction[] } {
  switch (option) {
    case 'balance':
      return { state: menuState(), actions: [{ type: 'send_balance', leaseId: lease.id }] };
    case 'statement':
      return { state: menuState(), actions: [{ type: 'send_statement', leaseId: lease.id }] };
    case 'pay':
      return { state: menuState(), actions: [{ type: 'send_pay_link', leaseId: lease.id }] };
    case 'receipt': {
      const receipts = (context.receipts[lease.id] ?? []).slice(0, 3);
      if (receipts.length === 0)
        return {
          state: menuState(),
          actions: [
            reply(`There are no receipts yet for ${lease.label}. Reply MENU for the menu.`),
          ],
        };
      if (receipts.length === 1)
        return {
          state: menuState(),
          actions: [{ type: 'send_receipt', leaseId: lease.id, receiptId: receipts[0]!.id }],
        };
      const lines = receipts.map(
        (r, i) => `${i + 1} ${r.number} of ${formatBusinessDate(r.issuedOn)}`,
      );
      return {
        state: { name: 'receipts', leaseId: lease.id, receiptIds: receipts.map((r) => r.id) },
        actions: [
          reply(
            `Which receipt? Reply with a number:\n${lines.join('\n')}`,
            receipts.map((r) => ({ id: `receipt:${r.id}`, title: r.number.slice(0, 24) })),
          ),
        ],
      };
    }
    case 'repair':
      return {
        state: {
          name: 'repair',
          leaseId: lease.id,
          startedAt: now.toString(),
          text: [],
          messageIds: [],
        },
        actions: [
          reply(
            'Tell us what needs fixing. You can send photos, a video or a voice note. Reply DONE when you have finished, or CANCEL to stop.',
          ),
        ],
      };
  }
}

/** One step of the bot. Pure: the same session, context and input always give the same step. */
export function botStep(session: BotSession, context: BotContext, input: BotInput): BotStep {
  const now = context.now;
  const actions: BotAction[] = [];
  let state = session.state;

  // A repair report ends after 10 minutes; a session idle for 30 starts again at the menu.
  if (state.name === 'repair' && minutesSince(state.startedAt, now) >= REPAIR_COLLECT_MINUTES) {
    actions.push(...finishRepair(state));
    state = menuState();
  }
  if (
    state.name !== 'handed_over' &&
    session.lastActivityAt !== null &&
    minutesSince(session.lastActivityAt, now) >= BOT_SESSION_IDLE_MINUTES
  )
    state = menuState();

  if (input.kind === 'tick')
    return { session: { state, lastActivityAt: session.lastActivityAt }, actions };

  const done = (next: BotState, more: readonly BotAction[]): BotStep => ({
    session: { state: next, lastActivityAt: now.toString() },
    actions: [...actions, ...more],
  });

  // Once a person has it, the inbox does (plan 4.4); the bot stays out of the way.
  if (state.name === 'handed_over') return done(state, []);

  if (!seesAccount(context.sender)) {
    const next = toPerson(
      context,
      input,
      'contact_without_account',
      `This number is not set up for account details. A member of the team at ${context.companyName} will reply here.`,
    );
    return done(next.state, next.actions);
  }
  if (context.leases.length === 0) {
    const next = toPerson(
      context,
      input,
      'no_lease',
      `Thank you. A member of the team at ${context.companyName} will reply here.`,
    );
    return done(next.state, next.actions);
  }

  switch (state.name) {
    case 'repair': {
      if (isWord(input, 'CANCEL'))
        return done(menuState(), [
          reply('Your repair report is cancelled. Reply MENU for the menu.'),
        ]);
      if (isWord(input, 'DONE')) {
        const report = finishRepair(state);
        if (report.length === 0)
          return done(state, [
            reply('Tell us what needs fixing first, or send a photo. Reply CANCEL to stop.'),
          ]);
        return done(menuState(), report);
      }
      const text =
        input.kind === 'text'
          ? input.text.trim()
          : input.kind === 'media'
            ? (input.caption ?? '').trim()
            : '';
      const id = messageIdOf(input);
      const first = state.text.length === 0 && state.messageIds.length === 0;
      const next: BotState = {
        ...state,
        text: text ? [...state.text, text] : state.text,
        messageIds: id ? [...state.messageIds, id] : state.messageIds,
      };
      return done(next, first ? [reply('Got it. Send more if you like, then reply DONE.')] : []);
    }
    case 'receipts': {
      if (isMenuWord(input)) return done(menuState(), [menuReply(context)]);
      const receiptId = pickFrom(input, 'receipt', state.receiptIds);
      if (receiptId)
        return done(menuState(), [{ type: 'send_receipt', leaseId: state.leaseId, receiptId }]);
      return done(state, [
        reply(`Reply with a number from 1 to ${state.receiptIds.length}, or MENU for the menu.`),
      ]);
    }
    case 'choose_lease': {
      if (isMenuWord(input)) return done(menuState(), [menuReply(context)]);
      const leaseId = pickFrom(
        input,
        'lease',
        context.leases.map((l) => l.id),
      );
      const lease = context.leases.find((l) => l.id === leaseId);
      if (lease) {
        const next = proceed(context, state.option, lease, now);
        return done(next.state, next.actions);
      }
      return done(state, [leaseList(context)]);
    }
    case 'menu': {
      if (isMenuWord(input)) return done(menuState(), [menuReply(context)]);
      const option = optionOf(input, context.plan);
      if (option === 'person') {
        const next = toPerson(
          context,
          input,
          'asked_for_person',
          `A member of the team at ${context.companyName} will reply here soon.`,
        );
        return done(next.state, next.actions);
      }
      if (option) {
        if (context.leases.length > 1)
          return done({ name: 'choose_lease', option }, [leaseList(context)]);
        const next = proceed(context, option, context.leases[0]!, now);
        return done(next.state, next.actions);
      }
      if (input.kind === 'media') {
        const next = toPerson(
          context,
          input,
          'media_received',
          `Thank you. A member of the team at ${context.companyName} will look at it and reply here.`,
        );
        return done(next.state, next.actions);
      }
      // Not understood. Starter passes it on at once; Growth asks again, then hands over.
      if (!planHas(context.plan, 'bot_full_menu')) {
        const next = toPerson(context, input, 'bot_cannot_help', '');
        return done(next.state, next.actions);
      }
      const misses = state.misses + 1;
      if (misses >= BOT_MISSES_BEFORE_HANDOVER) {
        const next = toPerson(
          context,
          input,
          'bot_cannot_help',
          `A member of the team at ${context.companyName} will reply here soon.`,
        );
        return done(next.state, next.actions);
      }
      return done({ name: 'menu', misses }, [
        menuReply(context, 'Sorry, I did not understand that.'),
      ]);
    }
  }
}

/**
 * The balance reply (plan 4.5): every figure comes from the billing reads the service passes in;
 * this only words them. Money is formatted at the edge, here.
 */
export function balanceReplyText(figures: {
  readonly leaseLabel: string;
  readonly amountDue: Money;
  /** ISO date, or null when nothing has been paid ahead. */
  readonly paidUntil: string | null;
  /** ISO date of the next charge, or null when none is scheduled. */
  readonly nextDueDate: string | null;
}): string {
  const due =
    figures.amountDue.amountMinor > 0
      ? `${format(figures.amountDue)} is due now.`
      : 'Nothing is due now.';
  const paid = figures.paidUntil
    ? ` Your rent is paid until ${formatBusinessDate(figures.paidUntil)}.`
    : '';
  const next = figures.nextDueDate
    ? ` The next rent is due on ${formatBusinessDate(figures.nextDueDate)}.`
    : '';
  return `${figures.leaseLabel}: ${due}${paid}${next} Reply MENU for the menu.`;
}

/** CM-04: the reply that carries the ticket number. */
export function repairLoggedText(ticket: string, companyName: string): string {
  return `Thank you. Your repair is logged as ticket ${ticket}. ${companyName} will be in touch about it. Reply MENU for the menu.`;
}
