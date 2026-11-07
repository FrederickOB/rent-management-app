import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { instantFrom } from '@rent/domain/dates';
import {
  defaultReplyChannel,
  INBOX_VIEWS,
  isOverdue,
  planReply,
  SYSTEM_PROMPT_PURPOSES,
  whatsAppWindowClosesAt,
  type Channel,
  type ConsentSource,
  type ConversationState,
  type HandoverReason,
  type MessagePurpose,
  type TemplateKey,
  type InboundChannel,
  type InboxView,
} from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import { messagingSettingsOf, parseCompanySettings } from '@rent/domain/settings';
import { v7 as uuidv7 } from 'uuid';
import { staffActor, type StaffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { conflict, forbidden, invalid, notFound } from '../core/errors';
import { keyReused } from '../core/idempotency';
import { queueMessage, storedBody } from '../core/messages';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { memberActors } from '../policy/members';
import { PolicyService, staffContext } from '../policy/policy.service';
import { TenantsService } from '../tenancy/tenants.service';
import {
  applyEvent,
  companyAccounts,
  maskAddress,
  messagePropertyOf,
  templateOnSendingNumber,
  threadConversationIds,
  whatsappRoute,
  type ConversationRow,
} from './store';

const ASSISTANT = 'Assistant';
const PREVIEW = 120;

export interface ConversationSummaryView {
  readonly id: string;
  readonly state: ConversationState;
  readonly tenant: { readonly id: string; readonly name: string } | null;
  readonly triage: {
    readonly channel: 'whatsapp' | 'sms' | 'email';
    readonly addressMasked: string;
  } | null;
  readonly assignee: { readonly personId: string; readonly name: string } | null;
  readonly tags: string[];
  readonly handoverReason: HandoverReason | null;
  readonly units: { unitId: string; unitCode: string; propertyId: string; propertyName: string }[];
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
  readonly lastInboundChannel: Channel | null;
  readonly firstResponseDueAt: Date | null;
  readonly overdue: boolean;
  readonly unansweredCount: number;
}

export interface ThreadMessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly channel: Channel | null;
  readonly authorType: 'staff' | 'bot' | 'system' | 'tenant' | 'contact' | 'unknown';
  readonly authorName: string | null;
  readonly purpose: MessagePurpose;
  readonly subject: string | null;
  readonly body: string;
  readonly templateKey: TemplateKey | null;
  readonly status: 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'not_sent';
  readonly statusReason: string | null;
  readonly statusAt: Date;
  readonly attachments: {
    id: string;
    kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    contentType: string;
    sizeBytes: number | null;
    filename: string | null;
    caption: string | null;
    status: 'stored' | 'rejected';
    rejectReason: string | null;
  }[];
  readonly attachmentCount: number;
  readonly costMinor: number | null;
  readonly currency: string | null;
  readonly createdAt: Date;
}

/**
 * The unified inbox (CM-05, CM-06; M6 plan 4.6): one thread per tenant across every channel,
 * replies on the tenant's channel within the rules (decision 6, CM-07), assignment, tags,
 * resolving and reopening, triage linking (CM-02) and the unit's conversations. Every route needs
 * its `messaging.*` permission, and the company a plan with the inbox (decision 9). Row Level
 * Security applies the person's scope: caretakers see their properties' tenants only.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  private async staff(
    actor: Actor | null,
    action: Parameters<PolicyService['assert']>[1],
  ): Promise<StaffActor> {
    const staff = staffActor(actor);
    this.policy.assert(staff, action);
    await this.entitlements.assert(staff.companyId, 'inbox');
    return staff;
  }

  private inScope<T>(staff: StaffActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withCompany(this.database, staffContext(staff), fn);
  }

  // Lists --------------------------------------------------------------------------------------

  private viewFilter(view: InboxView, personId: string, now: Date) {
    const c = schema.conversation;
    switch (view) {
      case 'all':
        return sql`${c.state} <> 'resolved'`;
      case 'mine':
        return sql`${c.assignedTo} = ${personId} and ${c.state} <> 'resolved'`;
      case 'unassigned':
        return sql`${c.assignedTo} is null and ${c.state} = 'open'`;
      case 'triage':
        return sql`${c.state} = 'triage'`;
      case 'overdue':
        return sql`${c.state} in ('open', 'assigned') and ${c.firstResponseDueAt} <= ${now}`;
      case 'bot':
        return sql`${c.state} = 'bot'`;
      case 'resolved':
        return sql`${c.state} = 'resolved' and ${c.lastInboundAt} is not null`;
    }
  }

  async conversations(
    actor: Actor | null,
    filter: {
      view: InboxView;
      tag?: string;
      propertyId?: string;
      q?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: ConversationSummaryView[]; nextCursor: string | null }> {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const c = schema.conversation;
      const [cursorAt, cursorId] = filter.cursor ? filter.cursor.split('|') : [];
      const rows = await tx
        .select()
        .from(c)
        .where(
          and(
            sql`${c.mergedIntoId} is null`,
            this.viewFilter(filter.view, staff.personId, now),
            filter.tag ? sql`${c.tags} @> array[${filter.tag}]::text[]` : undefined,
            filter.propertyId
              ? sql`exists (select 1 from lease l where l.company_id = ${c.companyId} and l.tenant_id = ${c.tenantId} and l.property_id = ${filter.propertyId}::uuid)`
              : undefined,
            filter.q
              ? sql`(exists (select 1 from tenant t where t.company_id = ${c.companyId} and t.id = ${c.tenantId} and t.display_name ilike ${`%${filter.q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`})
                     or exists (select 1 from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
                                where l.company_id = ${c.companyId} and l.tenant_id = ${c.tenantId} and u.code ilike ${`%${filter.q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`}))`
              : undefined,
            cursorAt && cursorId
              ? sql`(coalesce(${c.lastMessageAt}, ${c.createdAt}), ${c.id}) < (${new Date(cursorAt)}::timestamptz, ${cursorId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(sql`coalesce(${c.lastMessageAt}, ${c.createdAt}) desc`, desc(c.id))
        .limit(filter.limit + 1);
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        items: await this.summaries(tx, page, now),
        nextCursor:
          rows.length > filter.limit && last
            ? `${(last.lastMessageAt ?? last.createdAt).toISOString()}|${last.id}`
            : null,
      };
    });
  }

  async counts(actor: Actor | null): Promise<Record<InboxView, number>> {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const out = {} as Record<InboxView, number>;
      for (const view of INBOX_VIEWS) {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.conversation)
          .where(
            and(
              sql`${schema.conversation.mergedIntoId} is null`,
              this.viewFilter(view, staff.personId, now),
            ),
          );
        out[view] = row?.n ?? 0;
      }
      return out;
    });
  }

  private async summaries(
    tx: Tx,
    rows: ConversationRow[],
    now: Date,
  ): Promise<ConversationSummaryView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const tenantIds = rows.flatMap((r) => (r.tenantId ? [r.tenantId] : []));
    const tenants = tenantIds.length
      ? await tx
          .select({ id: schema.tenant.id, name: schema.tenant.displayName })
          .from(schema.tenant)
          .where(inArray(schema.tenant.id, tenantIds))
      : [];
    const units = tenantIds.length
      ? await tx.execute<{
          tenant_id: string;
          unit_id: string;
          code: string;
          property_id: string;
          name: string;
        }>(
          sql`select l.tenant_id, u.id as unit_id, u.code, p.id as property_id, p.name from lease l
              join unit u on u.company_id = l.company_id and u.id = l.unit_id
              join property p on p.company_id = l.company_id and p.id = l.property_id
              where l.tenant_id = any(${`{${tenantIds.join(',')}}`}::uuid[])
                and l.status in ('pending_signatures', 'signed', 'active', 'ending', 'holding_over')
              order by l.start_date`,
        )
      : { rows: [] };
    const assignees = rows.flatMap((r) => (r.assignedTo ? [r.assignedTo] : []));
    const people = assignees.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, assignees))
      : [];
    // The preview is the last real message: never an automatic prompt (M8 review).
    const latest = await tx.execute<{ conversation_id: string; body: string; direction: string }>(
      sql`select distinct on (coalesce(c.merged_into_id, c.id)) coalesce(c.merged_into_id, c.id) as conversation_id, m.body, m.direction
          from message m join conversation c on c.company_id = m.company_id and c.id = m.conversation_id
          where coalesce(c.merged_into_id, c.id) = any(${`{${ids.join(',')}}`}::uuid[])
            and m.purpose <> all(${`{${SYSTEM_PROMPT_PURPOSES.join(',')}}`}::text[])
          order by coalesce(c.merged_into_id, c.id), m.created_at desc, m.id desc`,
    );
    const unanswered = await tx.execute<{ conversation_id: string; n: number }>(
      sql`select coalesce(c.merged_into_id, c.id) as conversation_id, count(*)::int as n
          from message m join conversation c on c.company_id = m.company_id and c.id = m.conversation_id
          where coalesce(c.merged_into_id, c.id) = any(${`{${ids.join(',')}}`}::uuid[]) and m.direction = 'inbound'
            and m.created_at > coalesce((select max(o.created_at) from message o where o.company_id = m.company_id
                 and o.conversation_id = m.conversation_id and o.direction = 'outbound' and o.author_type = 'staff'), '-infinity')
          group by 1`,
    );
    return rows.map((r) => {
      const name = tenants.find((t) => t.id === r.tenantId)?.name;
      return {
        id: r.id,
        state: r.state as ConversationState,
        tenant: r.tenantId ? { id: r.tenantId, name: name ?? '' } : null,
        triage:
          !r.tenantId && r.triageChannel && r.triageAddress
            ? {
                channel: r.triageChannel as 'whatsapp' | 'sms' | 'email',
                addressMasked: maskAddress(r.triageChannel as 'sms', r.triageAddress),
              }
            : null,
        assignee: r.assignedTo
          ? { personId: r.assignedTo, name: people.find((p) => p.id === r.assignedTo)?.name ?? '' }
          : null,
        tags: r.tags,
        handoverReason: (r.handoverReason as HandoverReason | null) ?? null,
        units: units.rows
          .filter((u) => u.tenant_id === r.tenantId)
          .map((u) => ({
            unitId: u.unit_id,
            unitCode: u.code,
            propertyId: u.property_id,
            propertyName: u.name,
          })),
        lastMessageAt: r.lastMessageAt,
        lastMessagePreview:
          latest.rows.find((l) => l.conversation_id === r.id)?.body.slice(0, PREVIEW) ?? null,
        lastInboundChannel: r.lastInboundChannel as Channel | null,
        firstResponseDueAt: r.firstResponseDueAt,
        overdue: isOverdue(
          {
            state: r.state as ConversationState,
            assigneeId: r.assignedTo,
            firstResponseDueAt: r.firstResponseDueAt?.toISOString() ?? null,
          },
          instantFrom(now),
        ),
        unansweredCount: unanswered.rows.find((u) => u.conversation_id === r.id)?.n ?? 0,
      };
    });
  }

  private async conversationOr404(tx: Tx, conversationId: string): Promise<ConversationRow> {
    const [row] = await tx
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, conversationId));
    if (!row) throw notFound('Conversation');
    if (row.mergedIntoId) {
      const [into] = await tx
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.id, row.mergedIntoId));
      if (into) return into;
    }
    return row;
  }

  // One conversation -----------------------------------------------------------------------------

  async conversation(actor: Actor | null, conversationId: string) {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      const [summary] = await this.summaries(tx, [row], now);
      const channels = row.tenantId ? await this.replyChannels(tx, staff.companyId, row, now) : [];
      const reopen = await templateOnSendingNumber(tx, staff.companyId, 'conversation_reopen');
      const merged = await tx
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(eq(schema.conversation.mergedIntoId, row.id));
      const leases = row.tenantId
        ? await tx.execute<{
            id: string;
            status: string;
            start_date: string;
            end_date: string | null;
            unit_id: string;
            code: string;
            property_id: string;
            name: string;
          }>(
            sql`select l.id, l.status, l.start_date::text as start_date, l.end_date::text as end_date, u.id as unit_id, u.code, p.id as property_id, p.name
                from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
                join property p on p.company_id = l.company_id and p.id = l.property_id
                where l.tenant_id = ${row.tenantId} and l.status <> 'draft' order by l.start_date desc`,
          )
        : { rows: [] };
      const lastByChannel: Partial<Record<InboundChannel, ReturnType<typeof instantFrom> | null>> =
        {};
      for (const ch of channels)
        lastByChannel[ch.channel] = ch.lastInboundAt ? instantFrom(ch.lastInboundAt) : null;
      return {
        ...summary!,
        channels,
        defaultChannel: defaultReplyChannel(lastByChannel),
        reopenTemplate: reopen ? { status: reopen.status, text: reopen.body } : null,
        mergedFrom: merged.map((m) => m.id),
        leases: leases.rows.map((l) => ({
          leaseId: l.id,
          status: l.status,
          startDate: l.start_date,
          endDate: l.end_date,
          unitId: l.unit_id,
          unitCode: l.code,
          propertyId: l.property_id,
          propertyName: l.name,
        })),
        can: {
          reply: this.policy.can(staff, 'messaging.reply').allowed && row.tenantId !== null,
          assign: this.policy.can(staff, 'messaging.assign').allowed,
          triage: this.policy.can(staff, 'messaging.triage').allowed,
          // Tags go with assigning; resolving and reopening with replying (the routes check the same).
          tag: this.policy.can(staff, 'messaging.assign').allowed,
          resolve: this.policy.can(staff, 'messaging.reply').allowed,
        },
      };
    });
  }

  /** Each channel the composer may reply on, and whether a reply can go there now. */
  /**
   * Who a reply on a channel goes to (M6 review S9): whoever last wrote on it, the tenant or one
   * of their contacts; the tenant when nobody has. The composer's mode is worked out for them.
   */
  private async lastWriter(
    tx: Tx,
    row: ConversationRow,
    channel: InboundChannel,
  ): Promise<{ tenantId: string; contactId: string | null }> {
    const [last] = await tx
      .select({ contactId: schema.message.tenantContactId })
      .from(schema.message)
      .where(
        and(
          inArray(schema.message.conversationId, await threadConversationIds(tx, row.id)),
          eq(schema.message.direction, 'inbound'),
          eq(schema.message.channel, channel),
        ),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    return {
      tenantId: row.tenantId!,
      contactId: channel === 'in_app' ? null : (last?.contactId ?? null),
    };
  }

  private async replyChannels(tx: Tx, companyId: string, row: ConversationRow, now: Date) {
    const point = await this.tenants.messagingPoint(tx, { tenantId: row.tenantId! });
    const writers = new Map<
      InboundChannel,
      Awaited<ReturnType<TenantsService['messagingPoint']>>
    >();
    for (const channel of ['whatsapp', 'sms', 'email'] as const) {
      const who = await this.lastWriter(tx, row, channel);
      writers.set(channel, who.contactId ? await this.tenants.messagingPoint(tx, who) : point);
    }
    const pointFor = (channel: InboundChannel) =>
      channel === 'in_app' ? point : (writers.get(channel) ?? point);
    const activity = await tx
      .select()
      .from(schema.conversationChannel)
      .where(
        inArray(schema.conversationChannel.conversationId, await threadConversationIds(tx, row.id)),
      );
    const lastInbound = (channel: InboundChannel, address: string | null) => {
      const dates = activity
        .filter(
          (a) =>
            a.channel === channel &&
            (channel === 'in_app' || a.address === address) &&
            a.lastInboundAt,
        )
        .map((a) => a.lastInboundAt!.getTime());
      return dates.length ? new Date(Math.max(...dates)) : null;
    };
    // M6 review M4: WhatsApp's window is per number; a reply goes from the number the tenant
    // last wrote to, as the send job does (store.whatsappRoute).
    const whatsapp = whatsappRoute({
      accounts: await companyAccounts(tx, companyId),
      activity,
      address: pointFor('whatsapp')?.whatsappPhone ?? null,
      reply: true,
    });
    const reopen = await templateOnSendingNumber(
      tx,
      companyId,
      'conversation_reopen',
      whatsapp.account?.accountId,
    );
    const hasApp = point?.personId
      ? ((
          await tx.execute<{ yes: boolean }>(
            sql`select app.tenant_has_app(${row.tenantId}::uuid) as yes`,
          )
        ).rows[0]?.yes ?? false)
      : false;
    const out = [];
    const candidates: { channel: InboundChannel; address: string | null }[] = [
      { channel: 'whatsapp', address: pointFor('whatsapp')?.whatsappPhone ?? null },
      { channel: 'sms', address: pointFor('sms')?.phone ?? null },
      { channel: 'email', address: pointFor('email')?.email ?? null },
      {
        channel: 'in_app',
        address: hasApp || activity.some((a) => a.channel === 'in_app') ? 'app' : null,
      },
    ];
    for (const c of candidates) {
      const last =
        c.channel === 'whatsapp' ? whatsapp.lastInboundAt : lastInbound(c.channel, c.address);
      const consent =
        c.channel === 'in_app' ? null : (pointFor(c.channel)?.consent[c.channel] ?? null);
      const plan = planReply({
        purpose: 'conversation_reply',
        channel: c.channel,
        reach: {
          address: Boolean(c.address),
          consent: consent
            ? { latest: { action: consent.action, at: instantFrom(consent.at) } }
            : { latest: null },
          lastInboundAt: last ? instantFrom(last) : null,
        },
        whatsappTemplate: reopen,
        now: instantFrom(now),
      });
      const closes =
        c.channel === 'whatsapp'
          ? whatsAppWindowClosesAt(last ? instantFrom(last) : null, instantFrom(now))
          : null;
      out.push({
        channel: c.channel,
        addressMasked:
          c.address && c.channel !== 'in_app' ? maskAddress(c.channel, c.address) : null,
        consent:
          c.channel === 'in_app'
            ? null
            : {
                granted: consent?.action === 'grant',
                source: (consent?.source ?? null) as ConsentSource | null,
                recordedAt: consent?.at ?? null,
              },
        lastInboundAt: last,
        windowClosesAt: closes ? new Date(closes.epochMilliseconds) : null,
        mode: !plan.send
          ? ('unavailable' as const)
          : plan.whatsapp?.kind === 'template'
            ? ('template_only' as const)
            : ('free_text' as const),
        reason: plan.send ? null : plan.reason,
      });
    }
    return out;
  }

  async messages(
    actor: Actor | null,
    conversationId: string,
    filter: { since?: string; cursor?: string; limit: number },
  ): Promise<{ items: ThreadMessageView[]; nextCursor: string | null }> {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      return this.thread(tx, row, filter, { forTenant: false });
    });
  }

  /** The thread: the conversation's messages, those merged into it, and what was sent the tenant. */
  async thread(
    tx: Tx,
    row: ConversationRow,
    filter: { since?: string; cursor?: string; limit: number },
    options: { forTenant: boolean; withoutSystemPrompts?: boolean },
  ): Promise<{ items: ThreadMessageView[]; nextCursor: string | null }> {
    const ids = await threadConversationIds(tx, row.id);
    const m = schema.message;
    const [cursorAt, cursorId] = filter.cursor ? filter.cursor.split('|') : [];
    const rows = await tx
      .select()
      .from(m)
      .where(
        and(
          // What was sent the tenant outside the conversation (receipts, reminders) shows too; in
          // the tenant's own view, not what went to their contacts.
          row.tenantId
            ? sql`(${m.conversationId} = any(${`{${ids.join(',')}}`}::uuid[])
                   or (${m.conversationId} is null and ${m.tenantId} = ${row.tenantId} and ${m.direction} = 'outbound'
                       and ${m.recipientType} in ${options.forTenant ? sql`('tenant')` : sql`('tenant', 'tenant_contact')`}))`
            : sql`${m.conversationId} = any(${`{${ids.join(',')}}`}::uuid[])`,
          // M6 review S-5: the tenant sees what they wrote and what was sent to them, never their
          // contacts' messages (a guarantor's, a finance desk's) or the replies to those.
          options.forTenant
            ? sql`((${m.direction} = 'inbound' and ${m.tenantContactId} is null)
                   or (${m.direction} = 'outbound' and ${m.recipientType} = 'tenant'))`
            : undefined,
          // A lease's term starts on its start date in the company's own time zone.
          filter.since
            ? sql`${m.createdAt} >= (${filter.since}::date::timestamp at time zone (select c.time_zone from company c where c.id = ${m.companyId}))`
            : undefined,
          cursorAt && cursorId
            ? sql`(${m.createdAt}, ${m.id}) < (${new Date(cursorAt)}::timestamptz, ${cursorId}::uuid)`
            : undefined,
          // For a preview only: the thread itself always shows the prompts (M8 review).
          options.withoutSystemPrompts
            ? sql`${m.purpose} <> all(${`{${SYSTEM_PROMPT_PURPOSES.join(',')}}`}::text[])`
            : undefined,
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(filter.limit + 1);
    const page = rows.slice(0, filter.limit);
    const views = await this.messageViews(tx, row, page, options);
    const last = page.at(-1);
    return {
      items: views,
      nextCursor:
        rows.length > filter.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  async messageViews(
    tx: Tx,
    row: ConversationRow,
    page: (typeof schema.message.$inferSelect)[],
    options: { forTenant: boolean },
  ): Promise<ThreadMessageView[]> {
    if (page.length === 0) return [];
    const ids = page.map((p) => p.id);
    const events = options.forTenant
      ? []
      : await tx
          .select()
          .from(schema.messageEvent)
          .where(inArray(schema.messageEvent.messageId, ids));
    const attachments = await tx
      .select()
      .from(schema.messageAttachment)
      .where(inArray(schema.messageAttachment.messageId, ids));
    const staffIds = [
      ...new Set(page.flatMap((p) => (p.authorPersonId ? [p.authorPersonId] : []))),
    ];
    const people = staffIds.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, staffIds))
      : [];
    const tenant = row.tenantId
      ? (
          await tx
            .select({ name: schema.tenant.displayName })
            .from(schema.tenant)
            .where(eq(schema.tenant.id, row.tenantId))
        )[0]
      : undefined;
    const contactIds = [
      ...new Set(page.flatMap((p) => (p.tenantContactId ? [p.tenantContactId] : []))),
    ];
    const contacts = contactIds.length
      ? await tx
          .select({ id: schema.tenantContact.id, name: schema.tenantContact.name })
          .from(schema.tenantContact)
          .where(inArray(schema.tenantContact.id, contactIds))
      : [];
    const order = ['queued', 'not_sent', 'failed', 'sent', 'delivered', 'read'];
    return page.map((p) => {
      const mine = events
        .filter((e) => e.messageId === p.id)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      const sent = [...mine].reverse().find((e) => e.status === 'sent');
      const live = mine.filter(
        (e) =>
          !sent || e.channel === sent.channel || e.status === 'not_sent' || e.status === 'queued',
      );
      const best = live.reduce<(typeof mine)[number] | undefined>(
        (acc, e) =>
          !acc || order.indexOf(e.status) >= order.indexOf(acc.status) || e.status === 'not_sent'
            ? e
            : acc,
        undefined,
      );
      const cost = mine.reduce((sum, e) => sum + (e.costMinor ?? 0), 0);
      const authorType = p.authorType as ThreadMessageView['authorType'];
      const authorName = (() => {
        switch (authorType) {
          case 'staff':
            return people.find((x) => x.id === p.authorPersonId)?.name ?? null;
          case 'bot':
            return ASSISTANT;
          case 'tenant':
            return tenant?.name ?? null;
          case 'contact':
            return contacts.find((c) => c.id === p.tenantContactId)?.name ?? null;
          case 'unknown':
            return row.triageAddress && row.triageChannel
              ? maskAddress(row.triageChannel as 'sms', row.triageAddress)
              : null;
          default:
            return null;
        }
      })();
      return {
        id: p.id,
        conversationId: p.conversationId ?? row.id,
        direction: p.direction as 'inbound' | 'outbound',
        channel: (p.channel ?? sent?.channel ?? null) as Channel | null,
        authorType,
        authorName,
        purpose: p.purpose as MessagePurpose,
        subject: p.subject,
        body: p.body,
        templateKey: (p.templateKey ?? sent?.templateKey ?? null) as TemplateKey | null,
        status:
          p.direction === 'inbound'
            ? 'received'
            : ((best?.status ?? 'queued') as ThreadMessageView['status']),
        statusReason: p.direction === 'inbound' ? null : (best?.reason ?? null),
        statusAt: p.direction === 'inbound' ? p.createdAt : (best?.occurredAt ?? p.createdAt),
        attachments: attachments
          .filter((a) => a.messageId === p.id)
          .map((a) => ({
            id: a.id,
            kind: a.kind as ThreadMessageView['attachments'][number]['kind'],
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            filename: a.filename,
            caption: a.caption,
            status: a.status as 'stored' | 'rejected',
            rejectReason: a.rejectReason,
          })),
        attachmentCount: p.attachmentCount,
        costMinor: options.forTenant || cost === 0 ? null : cost,
        currency: options.forTenant || cost === 0 ? null : 'GHS',
        createdAt: p.createdAt,
      };
    });
  }

  // Staff actions --------------------------------------------------------------------------------

  /**
   * A staff reply on a channel (plan 4.6). Recorded at once so the thread shows it, then sent by
   * the send job; the same client id sends once. On WhatsApp outside the window only the reopen
   * template may go (CM-07). The conversation then waits on the tenant (section 7).
   */
  async reply(
    actor: Actor | null,
    conversationId: string,
    input: {
      clientMessageId: string;
      channel: InboundChannel;
      body?: string;
      subject?: string;
      template?: 'conversation_reopen';
    },
  ): Promise<ThreadMessageView> {
    const staff = await this.staff(actor, 'messaging.reply');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      if (!row.tenantId)
        throw conflict('link_first', 'Link this number to a tenant before replying');
      const [existing] = await tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, input.clientMessageId));
      const reopen = input.template === 'conversation_reopen';
      if (existing) {
        if (existing.conversationId !== row.id || existing.authorPersonId !== staff.personId)
          throw conflict('message_id_taken', 'That message id is in use');
        // M6 review C5: the same key with other content is a mistake, never a silent resend.
        const same =
          existing.channel === input.channel &&
          (existing.templateKey ?? null) === (reopen ? 'conversation_reopen' : null) &&
          (reopen || existing.body === storedBody(input.body ?? '')) &&
          (existing.subject ?? null) ===
            (input.channel === 'email' ? (input.subject ?? null) : null);
        if (!same) throw keyReused();
        return (await this.messageViews(tx, row, [existing], { forTenant: false }))[0]!;
      }
      // M6 review C4: a resolved conversation is reopened first; the reply never reopens it.
      if (row.state === 'resolved')
        throw conflict(
          'conversation_resolved',
          'This conversation is resolved: reopen it to reply',
        );
      const channels = await this.replyChannels(tx, staff.companyId, row, now);
      const target = channels.find((c) => c.channel === input.channel);
      if (!target || target.mode === 'unavailable')
        throw conflict(
          'channel_unavailable',
          target?.reason === 'window_closed'
            ? 'More than 24 hours have passed since the tenant wrote on WhatsApp: send the reopen template, or reply by SMS'
            : 'A reply cannot go on that channel now',
        );
      if (target.mode === 'template_only' && input.template !== 'conversation_reopen')
        throw conflict(
          'template_only',
          'Outside the 24-hour window, only the reopen template can go on WhatsApp',
        );
      const body = reopen
        ? ((await templateOnSendingNumber(tx, staff.companyId, 'conversation_reopen'))?.body ??
          'Reopen conversation')
        : input.body;
      if (!body) throw invalid('body_required', 'Write a reply');
      // Answer whoever last wrote on this channel, the one the composer's mode was worked out
      // for (review S9): the tenant, or the contact.
      const lastFrom = await this.lastWriter(tx, row, input.channel);
      const recipient = lastFrom.contactId
        ? ({
            type: 'tenant_contact',
            tenantId: row.tenantId,
            contactId: lastFrom.contactId,
          } as const)
        : ({ type: 'tenant', tenantId: row.tenantId } as const);
      const settings = messagingSettingsOf(
        parseCompanySettings(
          (
            await tx
              .select({ s: schema.company.settings })
              .from(schema.company)
              .where(eq(schema.company.id, staff.companyId))
          )[0]?.s,
        ),
      );
      const propertyId = await messagePropertyOf(tx, row.tenantId);
      await tx.insert(schema.message).values({
        id: input.clientMessageId,
        companyId: staff.companyId,
        propertyId,
        tenantId: row.tenantId,
        recipientType: recipient.type,
        tenantContactId: recipient.type === 'tenant_contact' ? recipient.contactId : null,
        purpose: 'conversation_reply',
        subject: input.channel === 'email' ? (input.subject ?? null) : null,
        body: storedBody(body),
        channels: [input.channel],
        direction: 'outbound',
        conversationId: row.id,
        authorType: 'staff',
        authorPersonId: staff.personId,
        channel: input.channel,
        requestedBy: staff.personId,
        ...(reopen ? { templateKey: 'conversation_reopen', templateVersion: 1 } : {}),
      });
      await tx
        .insert(schema.messageEvent)
        .values({ companyId: staff.companyId, messageId: input.clientMessageId, status: 'queued' });
      await queueMessage(tx, staff.companyId, {
        messageId: input.clientMessageId,
        recipient,
        purpose: 'conversation_reply',
        subject: input.channel === 'email' ? (input.subject ?? null) : null,
        body,
        propertyId,
        requestedBy: staff.personId,
        reply: {
          conversationId: row.id,
          channel: input.channel,
          authorType: 'staff',
          authorPersonId: staff.personId,
          template: reopen ? 'conversation_reopen' : null,
        },
      });
      const updated = await applyEvent(
        tx,
        row,
        { type: 'staff_reply' },
        instantFrom(now),
        settings.inboxFirstResponseMinutes,
        { lastMessageAt: now },
      );
      const [message] = await tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, input.clientMessageId));
      return (await this.messageViews(tx, updated, [message!], { forTenant: false }))[0]!;
    });
  }

  /** Staff in scope who may reply: who a conversation can be assigned to (CM-06). */
  async assignees(actor: Actor | null, conversationId: string) {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      return this.assigneesOf(tx, staff, row);
    });
  }

  private async assigneesOf(tx: Tx, staff: StaffActor, row: ConversationRow) {
    const [company] = await tx
      .select()
      .from(schema.company)
      .where(eq(schema.company.id, staff.companyId));
    // The tenant's properties and their owners today: a person scoped to an owner sees every
    // property that owner holds, new ones included (AD-02).
    const properties = row.tenantId
      ? (
          await tx.execute<{ property_id: string; owner_id: string | null }>(
            sql`select distinct l.property_id, o.owner_id from lease l
                left join property_current_ownership o on o.company_id = l.company_id and o.property_id = l.property_id
                where l.tenant_id = ${row.tenantId} and l.status <> 'draft'`,
          )
        ).rows
      : [];
    const actors = await memberActors(tx, company!);
    const allowed = actors.filter((a) => {
      if (!this.policy.can(a, 'messaging.reply').allowed) return false;
      const scope = this.policy.scopeFor(a);
      if (!scope) return true;
      if (!row.tenantId) return false;
      return properties.some(
        (p) =>
          scope.propertyIds.includes(p.property_id) ||
          (p.owner_id !== null && scope.ownerIds.includes(p.owner_id)),
      );
    });
    const people = allowed.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(
            inArray(
              schema.person.id,
              allowed.map((a) => a.personId),
            ),
          )
      : [];
    return allowed.map((a) => ({
      personId: a.personId,
      name: people.find((p) => p.id === a.personId)?.name ?? '',
      role: a.role,
    }));
  }

  async assign(actor: Actor | null, conversationId: string, personId: string | null) {
    const staff = await this.staff(actor, 'messaging.assign');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      if (
        personId &&
        !(await this.assigneesOf(tx, staff, row)).some((a) => a.personId === personId)
      )
        throw invalid('not_in_scope', 'That person cannot see this conversation');
      const settings = await this.settings(tx, staff.companyId);
      let updated: ConversationRow;
      try {
        updated = await applyEvent(
          tx,
          row,
          personId ? { type: 'assigned', assigneeId: personId } : { type: 'unassigned' },
          instantFrom(now),
          settings.inboxFirstResponseMinutes,
        );
      } catch {
        throw conflict('cannot_assign', 'This conversation cannot be assigned now');
      }
      return (await this.summaries(tx, [updated], now))[0]!;
    });
  }

  async setTags(actor: Actor | null, conversationId: string, tags: readonly string[]) {
    const staff = await this.staff(actor, 'messaging.assign');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      const settings = await this.settings(tx, staff.companyId);
      const unknown = tags.filter((t) => !settings.inboxTags.includes(t));
      if (unknown.length > 0) throw invalid('unknown_tag', 'Use the company’s tags');
      const [updated] = await tx
        .update(schema.conversation)
        .set({ tags: [...new Set(tags)], updatedAt: now })
        .where(eq(schema.conversation.id, row.id))
        .returning();
      return (await this.summaries(tx, [updated!], now))[0]!;
    });
  }

  async resolve(actor: Actor | null, conversationId: string) {
    return this.transition(actor, conversationId, 'resolved');
  }

  async reopen(actor: Actor | null, conversationId: string) {
    return this.transition(actor, conversationId, 'reopened');
  }

  private async transition(
    actor: Actor | null,
    conversationId: string,
    type: 'resolved' | 'reopened',
  ) {
    const staff = await this.staff(actor, 'messaging.reply');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      const settings = await this.settings(tx, staff.companyId);
      let updated: ConversationRow;
      try {
        updated = await applyEvent(
          tx,
          row,
          { type },
          instantFrom(now),
          settings.inboxFirstResponseMinutes,
          type === 'resolved' ? { resolvedBy: staff.personId } : {},
        );
      } catch {
        throw conflict(
          'cannot_change_state',
          type === 'resolved'
            ? 'This conversation is resolved already'
            : 'Only a resolved conversation can be reopened',
        );
      }
      return (await this.summaries(tx, [updated], now))[0]!;
    });
  }

  /**
   * Links a triage conversation to a tenant or contact (CM-02): the number or address is recorded
   * as theirs, with who did it and when, so later messages follow. If the tenant has a
   * conversation, the triage one is merged into it; otherwise it becomes theirs. Audited.
   */
  async linkTriage(
    actor: Actor | null,
    conversationId: string,
    tenantId: string,
    contactId: string | null,
  ) {
    const staff = await this.staff(actor, 'messaging.triage');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.id, conversationId));
      if (!row) throw notFound('Conversation');
      if (row.state !== 'triage' || row.tenantId || !row.triageChannel || !row.triageAddress)
        throw conflict('not_triage', 'Only a conversation in triage can be linked');
      const [tenant] = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
      if (!tenant) throw notFound('Tenant');
      if (contactId) {
        const [contact] = await tx
          .select({ id: schema.tenantContact.id })
          .from(schema.tenantContact)
          .where(
            and(
              eq(schema.tenantContact.id, contactId),
              eq(schema.tenantContact.tenantId, tenantId),
            ),
          );
        if (!contact) throw notFound('Contact');
      }
      await tx
        .insert(schema.channelIdentity)
        .values({
          companyId: staff.companyId,
          channel: row.triageChannel,
          address: row.triageAddress,
          tenantId,
          tenantContactId: contactId,
          conversationId: row.id,
          linkedBy: staff.personId,
        })
        .onConflictDoNothing();
      const settings = await this.settings(tx, staff.companyId);
      const messageAt = row.lastInboundAt ?? row.createdAt;
      const [own] = await tx
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.tenantId, tenantId),
            sql`${schema.conversation.mergedIntoId} is null`,
          ),
        );
      let target: ConversationRow;
      if (own) {
        await tx
          .update(schema.conversation)
          .set({
            tenantId,
            mergedIntoId: own.id,
            state: 'resolved',
            resolvedAt: now,
            linkedBy: staff.personId,
            linkedAt: now,
            firstResponseDueAt: null,
            updatedAt: now,
          })
          .where(eq(schema.conversation.id, row.id));
        target = await applyEvent(
          tx,
          own,
          { type: 'tenant_message', channel: row.triageChannel as InboundChannel },
          instantFrom(messageAt),
          settings.inboxFirstResponseMinutes,
          {
            lastMessageAt:
              own.lastMessageAt && own.lastMessageAt > messageAt ? own.lastMessageAt : messageAt,
            lastInboundAt: messageAt,
            lastInboundChannel: row.triageChannel as Channel | null,
          },
        );
        // The triage number's activity moves with it, so replies and the window work at once.
        await tx.execute(sql`
          insert into conversation_channel (company_id, conversation_id, channel, address, whatsapp_account_id, last_inbound_at, last_outbound_at)
          select company_id, ${own.id}::uuid, channel, address, whatsapp_account_id, last_inbound_at, last_outbound_at
          from conversation_channel where conversation_id = ${row.id}::uuid
          on conflict on constraint conversation_channel_key do update
            set last_inbound_at = greatest(conversation_channel.last_inbound_at, excluded.last_inbound_at), updated_at = now()`);
      } else {
        const [linked] = await tx
          .update(schema.conversation)
          .set({ tenantId, linkedBy: staff.personId, linkedAt: now, state: 'open', updatedAt: now })
          .where(eq(schema.conversation.id, row.id))
          .returning();
        target = await applyEvent(
          tx,
          { ...linked!, state: 'triage' },
          { type: 'linked', messageAt: messageAt.toISOString() },
          instantFrom(now),
          settings.inboxFirstResponseMinutes,
        );
      }
      return (await this.summaries(tx, [target], now))[0]!;
    });
  }

  async attachmentDownload(actor: Actor | null, conversationId: string, attachmentId: string) {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    const documentId = await this.inScope(staff, async (tx) => {
      const row = await this.conversationOr404(tx, conversationId);
      const ids = await threadConversationIds(tx, row.id);
      const [a] = await tx
        .select({ documentId: schema.messageAttachment.documentId })
        .from(schema.messageAttachment)
        .innerJoin(
          schema.message,
          and(
            eq(schema.message.companyId, schema.messageAttachment.companyId),
            eq(schema.message.id, schema.messageAttachment.messageId),
          ),
        )
        .where(
          and(
            eq(schema.messageAttachment.id, attachmentId),
            inArray(schema.message.conversationId, ids),
          ),
        );
      return a?.documentId ?? null;
    });
    const url = documentId ? await this.documents.downloadUrl(staff.companyId, documentId) : null;
    if (!url) throw notFound('Attachment');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  async tenantConversation(actor: Actor | null, tenantId: string) {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.tenantId, tenantId),
            sql`${schema.conversation.mergedIntoId} is null`,
          ),
        );
      return { conversation: row ? (await this.summaries(tx, [row], now))[0]! : null };
    });
  }

  async startConversation(actor: Actor | null, tenantId: string) {
    const staff = await this.staff(actor, 'messaging.reply');
    const now = this.clock.now();
    return this.inScope(staff, async (tx) => {
      const [tenant] = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
      if (!tenant) throw notFound('Tenant');
      await tx
        .insert(schema.conversation)
        .values({ companyId: staff.companyId, tenantId, state: 'open' })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.tenantId, tenantId),
            sql`${schema.conversation.mergedIntoId} is null`,
          ),
        );
      if (!row) throw forbidden();
      return (await this.summaries(tx, [row], now))[0]!;
    });
  }

  /** CM-05 acceptance: every conversation with the unit's tenants since each lease began. */
  async unitConversations(actor: Actor | null, unitId: string) {
    const staff = await this.staff(actor, 'messaging.inbox.read');
    return this.inScope(staff, async (tx) => {
      const leases = await tx.execute<{
        id: string;
        status: string;
        start_date: string;
        end_date: string | null;
        tenant_id: string;
        name: string;
        conversation_id: string | null;
      }>(sql`select l.id, l.status, l.start_date::text as start_date, l.end_date::text as end_date, l.tenant_id, t.display_name as name,
                    (select c.id from conversation c where c.company_id = l.company_id and c.tenant_id = l.tenant_id and c.merged_into_id is null) as conversation_id
             from lease l join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
             where l.unit_id = ${unitId}::uuid and l.status not in ('draft', 'cancelled')
             order by l.start_date desc`);
      const out = [];
      for (const l of leases.rows) {
        const counts = await tx.execute<{ n: number; last: Date | null }>(
          sql`select count(*)::int as n,
                max(m.created_at) filter (where m.purpose <> all(${`{${SYSTEM_PROMPT_PURPOSES.join(',')}}`}::text[])) as last
              from message m
              where m.created_at >= (${l.start_date}::date::timestamp at time zone (select c.time_zone from company c where c.id = m.company_id)) and (
                m.conversation_id in (select c.id from conversation c where c.tenant_id = ${l.tenant_id}::uuid)
                or (m.conversation_id is null and m.tenant_id = ${l.tenant_id}::uuid and m.direction = 'outbound'
                    and m.recipient_type in ('tenant', 'tenant_contact')))`,
        );
        out.push({
          leaseId: l.id,
          leaseStatus: l.status,
          startDate: l.start_date,
          endDate: l.end_date,
          tenant: { id: l.tenant_id, name: l.name },
          conversationId: l.conversation_id,
          since: l.start_date,
          messageCount: counts.rows[0]?.n ?? 0,
          lastMessageAt: counts.rows[0]?.last ? new Date(counts.rows[0].last) : null,
        });
      }
      return out;
    });
  }

  private async settings(tx: Tx, companyId: string) {
    const [row] = await tx
      .select({ s: schema.company.settings })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    return messagingSettingsOf(parseCompanySettings(row?.s));
  }
}

export const newClientMessageId = () => uuidv7();
