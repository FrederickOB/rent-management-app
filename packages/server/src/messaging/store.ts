import { createHmac } from 'node:crypto';
import { and, asc, eq, inArray, isNull, schema, sql, type Tx } from '@rent/db';
import { instantFrom, type Instant } from '@rent/domain/dates';
import {
  applyConversationEvent,
  ConversationTransitionError,
  templateForPurpose,
  type Channel,
  type ConversationEvent,
  type ConversationFacts,
  type ConversationState,
  type MessagePurpose,
  type TemplateKey,
  type TemplateOnNumber,
  type TemplateStatus,
} from '@rent/domain/messaging';
import { maskPhone } from '@rent/domain/phone';
import { conflict } from '../core/errors';

/**
 * Messaging's own records, shared by the send job, the inbound pipeline, the bot and the inbox
 * (M6 plan 4.2): conversations and their state, each channel's activity, and the WhatsApp number
 * and template statuses read through the narrow system functions (ADR-002).
 */
export type ConversationRow = typeof schema.conversation.$inferSelect;

/**
 * Lower-case base32 (RFC 4648 alphabet, no padding), for tokens in email addresses (CM-10). Mail
 * systems lower-case addresses, so a reply token must mean the same in any case; 32 random bytes
 * make 52 characters, which with `reply+` fits the 64-character limit on an address's local part.
 */
export function base32Lower(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * WhatsApp's limits on choice titles: 20 characters on reply buttons (three or fewer choices), 24
 * on list rows. Titles are cut to fit, so a long company or option name never fails the send.
 */
export function fitChoices<T extends { readonly id: string; readonly title: string }>(
  choices: readonly T[],
): { id: string; title: string }[] {
  const limit = choices.length > 3 ? 24 : 20;
  return choices.map((c) => ({
    id: c.id,
    title: c.title.slice(0, limit).trim() || c.title.slice(0, limit),
  }));
}

/**
 * The keyed hash an unsubscribe link carries of the email it was sent to (M6 review L3): the page
 * compares it with the address on record, so a link never stops a changed address's email.
 */
export function unsubscribeAddressHash(
  config: {
    readonly BLIND_INDEX_MASTER_KEY?: string | undefined;
    readonly BETTER_AUTH_SECRET: string;
  },
  email: string,
): string {
  const key = config.BLIND_INDEX_MASTER_KEY
    ? Buffer.from(config.BLIND_INDEX_MASTER_KEY, 'base64')
    : Buffer.from(config.BETTER_AUTH_SECRET, 'utf8');
  return createHmac('sha256', key)
    .update(`unsubscribe:${email.trim().toLowerCase()}`)
    .digest('hex');
}

export const maskEmail = (email: string): string => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};

/** A phone or email as staff and logs may see it. */
export const maskAddress = (channel: Channel, address: string): string =>
  channel === 'email'
    ? maskEmail(address)
    : channel === 'whatsapp' || channel === 'sms'
      ? maskPhone(address)
      : '';

export interface SendingAccount {
  readonly accountId: string;
  readonly phoneNumberId: string;
  readonly kind: 'shared' | 'company';
  readonly displayPhone: string;
  readonly displayName: string;
}

/** The WhatsApp number the company sends from: its own, or the shared one (decision 3). */
export async function sendingAccount(tx: Tx, companyId: string): Promise<SendingAccount | null> {
  const rows = await tx.execute<{
    account_id: string;
    phone_number_id: string;
    kind: 'shared' | 'company';
    display_phone: string;
    display_name: string;
  }>(sql`select * from app.whatsapp_sending_account(${companyId}::uuid)`);
  const r = rows.rows[0];
  return r
    ? {
        accountId: r.account_id,
        phoneNumberId: r.phone_number_id,
        kind: r.kind,
        displayPhone: r.display_phone,
        displayName: r.display_name,
      }
    : null;
}

/** Every number the company may send from: its own first, then the shared one (M4). */
export async function companyAccounts(tx: Tx, companyId: string): Promise<SendingAccount[]> {
  const rows = await tx.execute<{
    account_id: string;
    phone_number_id: string;
    kind: 'shared' | 'company';
    display_phone: string;
    display_name: string;
  }>(sql`select * from app.whatsapp_company_accounts(${companyId}::uuid)`);
  return rows.rows.map((r) => ({
    accountId: r.account_id,
    phoneNumberId: r.phone_number_id,
    kind: r.kind,
    displayPhone: r.display_phone,
    displayName: r.display_name,
  }));
}

/**
 * The WhatsApp number a message to this address goes from, and the window on it (M6 review M4).
 * Each number has its own 24-hour window. A reply goes from the number the person last wrote to,
 * while the company may still use it; anything else from the company's sending number.
 */
export function whatsappRoute(input: {
  readonly accounts: readonly SendingAccount[];
  readonly activity: readonly {
    readonly channel: string;
    readonly address: string;
    readonly whatsappAccountId: string | null;
    readonly lastInboundAt: Date | null;
  }[];
  readonly address: string | null | undefined;
  readonly reply: boolean;
}): { account: SendingAccount | null; lastInboundAt: Date | null } {
  const rows = input.activity.filter(
    (a) => a.channel === 'whatsapp' && input.address && a.address === input.address,
  );
  let account = input.accounts[0] ?? null;
  if (input.reply) {
    const latest = rows
      .filter((a) => a.lastInboundAt)
      .sort((a, b) => b.lastInboundAt!.getTime() - a.lastInboundAt!.getTime())[0];
    const wrote = latest
      ? input.accounts.find((a) => a.accountId === latest.whatsappAccountId)
      : null;
    if (wrote) account = wrote;
  }
  const dates = rows
    .filter((a) => account && a.whatsappAccountId === account.accountId && a.lastInboundAt)
    .map((a) => a.lastInboundAt!.getTime());
  return { account, lastInboundAt: dates.length ? new Date(Math.max(...dates)) : null };
}

export interface TemplateOnAccount extends TemplateOnNumber {
  readonly whatsappName: string;
  readonly version: number;
  readonly body: string;
  readonly parameters: readonly string[];
}

/**
 * A template's latest version and its status on the company's sending number (CM-07). Null when
 * the template is not in the registry; status null when it was never submitted for the number.
 */
export async function templateOnSendingNumber(
  tx: Tx,
  companyId: string,
  key: TemplateKey,
  /** M4: the number the message will go from, when it is not the sending number. */
  accountId?: string | null,
): Promise<TemplateOnAccount | null> {
  const [template] = await tx
    .select()
    .from(schema.messageTemplate)
    .where(and(eq(schema.messageTemplate.key, key), eq(schema.messageTemplate.language, 'en')))
    .orderBy(sql`${schema.messageTemplate.version} desc`)
    .limit(1);
  if (!template) return null;
  const statuses = await tx.execute<{
    account_id: string;
    template_id: string;
    status: TemplateStatus;
    is_sending: boolean;
  }>(
    sql`select account_id, template_id, status, is_sending from app.whatsapp_template_statuses(${companyId}::uuid)`,
  );
  const status =
    statuses.rows.find(
      (s) =>
        s.template_id === template.id && (accountId ? s.account_id === accountId : s.is_sending),
    )?.status ?? null;
  return {
    key,
    language: template.language,
    status,
    whatsappName: template.whatsappName,
    version: template.version,
    body: template.body,
    parameters: template.parameters as string[],
  };
}

/** The purpose's template on the sending number, or null when the purpose has none. */
export async function purposeTemplate(
  tx: Tx,
  companyId: string,
  purpose: MessagePurpose,
  accountId?: string | null,
): Promise<TemplateOnAccount | null> {
  const key = templateForPurpose(purpose);
  return key ? templateOnSendingNumber(tx, companyId, key, accountId) : null;
}

/**
 * The property a tenant's message is filed under (M6 review MF-2): their current lease's, or else
 * their most recent issued lease's (pending signatures, ended, terminated), so the tenant's own
 * session and the staff of that property see it. Null only for a tenant with no lease at all.
 */
export async function messagePropertyOf(tx: Tx, tenantId: string): Promise<string | null> {
  const rows = await tx.execute<{ property_id: string }>(
    sql`select property_id from lease where tenant_id = ${tenantId}::uuid and status <> 'draft'
        order by (status in ('signed', 'active', 'ending', 'holding_over')) desc, start_date desc
        limit 1`,
  );
  return rows.rows[0]?.property_id ?? null;
}

export async function conversationOfTenant(
  tx: Tx,
  tenantId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(schema.conversation)
    .where(
      and(eq(schema.conversation.tenantId, tenantId), isNull(schema.conversation.mergedIntoId)),
    );
  return row ?? null;
}

/**
 * The tenant's one conversation (CM-05), made when there is none yet. A conversation made for a
 * message the business sends owes nothing, so it starts resolved; the tenant's reply reopens it.
 */
export async function ensureTenantConversation(
  tx: Tx,
  companyId: string,
  tenantId: string,
  state: ConversationState = 'resolved',
): Promise<ConversationRow> {
  const existing = await conversationOfTenant(tx, tenantId);
  if (existing) return existing;
  await tx.insert(schema.conversation).values({ companyId, tenantId, state }).onConflictDoNothing();
  const row = await conversationOfTenant(tx, tenantId);
  if (!row) throw new Error('conversation not visible after insert');
  return row;
}

/** Applies a domain event to a conversation and stores the state, assignee and deadline. */
export async function applyEvent(
  tx: Tx,
  conversation: ConversationRow,
  event: ConversationEvent,
  at: Instant,
  firstResponseMinutes: number,
  extra: Partial<typeof schema.conversation.$inferInsert> = {},
): Promise<ConversationRow> {
  const facts: ConversationFacts = {
    state: conversation.state as ConversationState,
    assigneeId: conversation.assignedTo,
    firstResponseDueAt: conversation.firstResponseDueAt?.toISOString() ?? null,
  };
  let next: ConversationFacts;
  try {
    next = applyConversationEvent(facts, event, at, firstResponseMinutes);
  } catch (error) {
    // M6 review C4: a step the conversation cannot take now is a named conflict, never a 500.
    if (!(error instanceof ConversationTransitionError)) throw error;
    switch (facts.state) {
      case 'resolved':
        throw conflict('conversation_resolved', 'This conversation is resolved: reopen it first');
      case 'triage':
        throw conflict('link_first', 'Link this number to a tenant first');
      default:
        throw conflict('conversation_state', 'The conversation cannot do that now');
    }
  }
  const [row] = await tx
    .update(schema.conversation)
    .set({
      state: next.state,
      assignedTo: next.assigneeId,
      firstResponseDueAt: next.firstResponseDueAt ? new Date(next.firstResponseDueAt) : null,
      ...(next.state === 'resolved' && conversation.state !== 'resolved'
        ? { resolvedAt: new Date(at.epochMilliseconds) }
        : {}),
      ...(next.state !== 'resolved' && conversation.state === 'resolved'
        ? { resolvedAt: null, resolvedBy: null }
        : {}),
      ...extra,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversation.id, conversation.id))
    .returning();
  return row!;
}

/**
 * Records activity on a channel and address of a conversation (decisions 4 and 6): the last time
 * the tenant wrote, or we sent, there. Kept off the audited conversation row.
 */
export async function touchChannel(
  tx: Tx,
  input: {
    readonly companyId: string;
    readonly conversationId: string;
    readonly channel: Channel;
    readonly address: string;
    readonly whatsappAccountId: string | null;
    readonly direction: 'inbound' | 'outbound';
    readonly at: Date;
  },
): Promise<void> {
  const column = input.direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at';
  await tx.execute(sql`
    insert into conversation_channel (company_id, conversation_id, channel, address, whatsapp_account_id, ${sql.raw(column)})
    values (${input.companyId}, ${input.conversationId}, ${input.channel}, ${input.address},
            ${input.whatsappAccountId}, ${input.at})
    on conflict on constraint conversation_channel_key do update
      set ${sql.raw(column)} = greatest(conversation_channel.${sql.raw(column)}, excluded.${sql.raw(column)}),
          updated_at = now()`);
}

/** When each address of the conversations last wrote on each channel. */
export async function lastInbound(
  tx: Tx,
  conversationIds: readonly string[],
): Promise<{ channel: Channel; address: string; at: Instant | null }[]> {
  if (conversationIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(schema.conversationChannel)
    .where(inArray(schema.conversationChannel.conversationId, [...conversationIds]))
    .orderBy(asc(schema.conversationChannel.createdAt));
  return rows.map((r) => ({
    channel: r.channel as Channel,
    address: r.address,
    at: r.lastInboundAt ? instantFrom(r.lastInboundAt) : null,
  }));
}

/** The conversations whose messages make one thread: the tenant's and those merged into it. */
export async function threadConversationIds(tx: Tx, conversationId: string): Promise<string[]> {
  const merged = await tx
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(eq(schema.conversation.mergedIntoId, conversationId));
  return [conversationId, ...merged.map((m) => m.id)];
}
