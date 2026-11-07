import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import type { Channel } from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { conflict, forbidden, invalid, notFound } from '../core/errors';
import { keyReused } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import {
  DocumentsService,
  MESSAGE_PHOTO_UPLOAD,
  type StagedEvidence,
} from '../documents/documents.service';
import { PolicyService } from '../policy/policy.service';
import { tenancyCompanies } from './consent.service';
import { InboundService } from './inbound.service';
import { InboxService, type ThreadMessageView } from './inbox.service';
import type { ConversationRow } from './store';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;

/** A message the tenant wrote in the app: its id is the client message id it was sent with. */
function ownInApp(m: ThreadMessageView): boolean {
  switch (m.authorType) {
    case 'tenant':
      return m.direction === 'inbound' && m.channel === 'in_app';
    default:
      return false;
  }
}
const PREVIEW = 120;

export interface TenantMessageView {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly fromLandlord: boolean;
  readonly channel: Channel | null;
  readonly body: string;
  readonly attachments: ThreadMessageView['attachments'];
  readonly attachmentCount: number;
  readonly createdAt: Date;
  readonly clientMessageId: string | null;
  readonly deliveryStatus: 'sent' | 'delivered' | 'read' | null;
}

/**
 * The tenant app's conversations (CM-05; plan 4.10): one per landlord, read under that landlord's
 * company with the tenant scope (TL-12: nothing from another landlord), written through the same
 * inbound path as every channel. Photos are uploaded first and checked against their real bytes.
 */
@Injectable()
export class TenantMessagingService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(InboundService) private readonly inbound: InboundService,
  ) {}

  private tenantActor(actor: Actor | null): TenantActor {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'messaging.own');
    switch (actor.kind) {
      case 'tenant':
        return actor;
      default:
        throw forbidden();
    }
  }

  private inCompany<T>(
    tenant: TenantActor,
    companyId: string,
    tenantIds: readonly string[],
    fn: (tx: Tx) => Promise<T>,
  ) {
    return withCompany(
      this.database,
      { companyId, personId: tenant.personId, actorKind: 'tenant', tenantScope: { tenantIds } },
      fn,
    );
  }

  private async tenantIdsIn(tenant: TenantActor, companyId: string): Promise<string[]> {
    const ids = (await tenancyCompanies(this.database, tenant.personId)).get(companyId);
    if (!ids?.length) throw notFound('Landlord');
    return ids;
  }

  /** The person's conversation with a landlord: the one of their tenant records written to last. */
  private async conversationIn(
    tx: Tx,
    tenantIds: readonly string[],
  ): Promise<ConversationRow | null> {
    const [row] = await tx
      .select()
      .from(schema.conversation)
      .where(
        and(
          inArray(schema.conversation.tenantId, [...tenantIds]),
          isNull(schema.conversation.mergedIntoId),
        ),
      )
      .orderBy(
        sql`${schema.conversation.lastMessageAt} desc nulls last`,
        desc(schema.conversation.id),
      )
      .limit(1);
    return row ?? null;
  }

  async conversations(actor: Actor | null) {
    const tenant = this.tenantActor(actor);
    const out: {
      companyId: string;
      landlordName: string;
      conversationId: string | null;
      lastMessageAt: Date | null;
      lastMessagePreview: string | null;
      unreadCount: number;
      tenantId: string | null;
    }[] = [];
    for (const [companyId, tenantIds] of await tenancyCompanies(this.database, tenant.personId)) {
      out.push(
        await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
          const landlordName = (await companyRecord(tx, companyId))?.displayName ?? '';
          const row = await this.conversationIn(tx, tenantIds);
          if (!row)
            return {
              companyId,
              landlordName,
              conversationId: null,
              lastMessageAt: null,
              lastMessagePreview: null,
              unreadCount: 0,
              tenantId: null as string | null,
            };
          // The preview is the last real message, never an automatic prompt (M8 review).
          const latest = await this.inbox.thread(
            tx,
            row,
            { limit: 1 },
            { forTenant: true, withoutSystemPrompts: true },
          );
          return {
            companyId,
            landlordName,
            conversationId: row.id,
            lastMessageAt: row.lastMessageAt,
            lastMessagePreview: latest.items[0]?.body.slice(0, PREVIEW) ?? null,
            unreadCount: 0,
            tenantId: row.tenantId,
          };
        }),
      );
    }
    // Message events are staff-only to tenant sessions (M3), so the read state is counted in the
    // system's name, for the conversation the tenant session just found as its own.
    for (const c of out) {
      if (!c.conversationId || !c.tenantId) continue;
      const unread = await withCompany(
        this.database,
        { companyId: c.companyId, actorKind: 'system' },
        (tx) =>
          tx.execute<{ n: number }>(
            sql`select count(*)::int as n from message m
              where m.direction = 'outbound' and m.tenant_id = ${c.tenantId}::uuid and m.recipient_type = 'tenant'
                and (m.conversation_id = ${c.conversationId}::uuid or (m.conversation_id is null and m.recipient_type = 'tenant'))
                and not exists (select 1 from message_event e where e.company_id = m.company_id and e.message_id = m.id
                                and e.status = 'read' and e.channel = 'in_app')`,
          ),
      );
      c.unreadCount = unread.rows[0]?.n ?? 0;
    }
    return out
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
      .map(({ tenantId: _tenantId, ...c }) => c);
  }

  async messages(
    actor: Actor | null,
    companyId: string,
    filter: { cursor?: string; limit: number },
  ) {
    const tenant = this.tenantActor(actor);
    const tenantIds = await this.tenantIdsIn(tenant, companyId);
    const page = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
      const row = await this.conversationIn(tx, tenantIds);
      if (!row) return { row: null, items: [] as ThreadMessageView[], nextCursor: null };
      const thread = await this.inbox.thread(tx, row, filter, { forTenant: true });
      return { row, ...thread };
    });
    if (!page.row) return { items: [], nextCursor: null };
    // Opening the conversation marks the landlord's messages read, on the in-app channel.
    const unread = page.items.filter((m) => m.direction === 'outbound').map((m) => m.id);
    if (unread.length)
      await withCompany(
        this.database,
        { companyId, personId: tenant.personId, actorKind: 'system' },
        async (tx) => {
          for (const messageId of unread)
            await tx
              .insert(schema.messageEvent)
              .values({
                companyId,
                messageId,
                status: 'read',
                channel: 'in_app',
                provider: 'in_app',
                destinationMasked: 'app',
              })
              .onConflictDoNothing();
        },
      );
    const statuses = await this.inCompany(tenant, companyId, tenantIds, (tx) =>
      this.ownStatuses(tx, page.row!, page.items),
    );
    return {
      items: page.items.map((m) => this.view(m, statuses.get(m.id) ?? null)),
      nextCursor: page.nextCursor,
    };
  }

  /** The tenant's own messages: read once the landlord's side has answered after them. */
  private async ownStatuses(tx: Tx, row: ConversationRow, items: readonly ThreadMessageView[]) {
    const out = new Map<string, 'sent' | 'read'>();
    const own = items.filter((m) => m.direction === 'inbound');
    if (own.length === 0) return out;
    const [answered] = (
      await tx.execute<{ at: Date | null }>(
        sql`select max(created_at) as at from message where conversation_id = ${row.id}::uuid
            and direction = 'outbound' and author_type in ('staff', 'bot')`,
      )
    ).rows;
    const at = answered?.at ? new Date(answered.at).getTime() : null;
    for (const m of own)
      out.set(m.id, at !== null && at >= m.createdAt.getTime() ? 'read' : 'sent');
    return out;
  }

  private view(m: ThreadMessageView, own: 'sent' | 'read' | null): TenantMessageView {
    return {
      id: m.id,
      direction: m.direction,
      fromLandlord: m.direction === 'outbound',
      channel: m.channel,
      body: m.body,
      attachments: m.attachments,
      attachmentCount: m.attachmentCount,
      createdAt: m.createdAt,
      clientMessageId: ownInApp(m) ? m.id : null,
      deliveryStatus: m.direction === 'inbound' ? own : null,
    };
  }

  async createPhotoUpload(
    actor: Actor | null,
    companyId: string,
    input: { contentType: string; sizeBytes: number },
  ) {
    const tenant = this.tenantActor(actor);
    await this.tenantIdsIn(tenant, companyId);
    return this.documents.createUpload(
      { companyId, personId: tenant.personId, actorKind: 'system' },
      MESSAGE_PHOTO_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  /**
   * Writes to a landlord in the app. Each photo upload must be this person's, for this landlord,
   * and its stored bytes the declared image within the size limit; then the message and its
   * photos are recorded in one transaction. A repeated client message id makes one message.
   */
  async send(
    actor: Actor | null,
    companyId: string,
    input: { clientMessageId: string; body: string; uploadIds: readonly string[] },
  ) {
    const tenant = this.tenantActor(actor);
    const tenantIds = await this.tenantIdsIn(tenant, companyId);
    const repeated = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
      const [m] = await tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, input.clientMessageId));
      if (!m) return null;
      const photos = await tx
        .select({ upload: schema.messageAttachment.providerMediaId })
        .from(schema.messageAttachment)
        .where(eq(schema.messageAttachment.messageId, m.id));
      return { message: m, uploads: photos.map((p) => p.upload ?? '').sort() };
    });
    // M6 review C5: the same client id with another body or other photos is refused.
    if (repeated && repeated.message.direction !== 'inbound')
      throw conflict('message_id_taken', 'Send it again with a new id');
    if (
      repeated &&
      (repeated.message.body !== input.body ||
        repeated.uploads.join() !== [...new Set(input.uploadIds)].sort().join())
    )
      throw keyReused();
    if (!repeated) {
      const tenantId = await this.inCompany(
        tenant,
        companyId,
        tenantIds,
        async (tx) => (await this.conversationIn(tx, tenantIds))?.tenantId ?? tenantIds[0]!,
      );
      const staged: StagedEvidence[] = [];
      try {
        for (const uploadId of new Set(input.uploadIds))
          staged.push(
            await this.documents.stageEvidenceUpload(
              { companyId, personId: tenant.personId, actorKind: 'system' },
              uploadId,
              MESSAGE_PHOTO_UPLOAD,
            ),
          );
      } catch (error) {
        for (const s of staged) await this.documents.discardStagedUpload(s);
        throw error;
      }
      const result = await this.inbound.recordInApp(companyId, {
        tenantId,
        personId: tenant.personId,
        messageId: input.clientMessageId,
        body: input.body,
        staged,
        record: (tx, s) => this.documents.recordStagedEvidence(tx, s, 'message_media'),
      });
      for (const s of staged) await this.documents.discardStagedUpload(s);
      if (!result.created) {
        // The id is someone else's message: refuse rather than say anything about it.
        const mine = await this.inCompany(
          tenant,
          companyId,
          tenantIds,
          async (tx) =>
            (
              await tx
                .select({ id: schema.message.id })
                .from(schema.message)
                .where(eq(schema.message.id, input.clientMessageId))
            ).length > 0,
        );
        if (!mine) throw conflict('message_id_taken', 'Send it again with a new id');
      }
    }
    return this.inCompany(tenant, companyId, tenantIds, async (tx) => {
      const row = await this.conversationIn(tx, tenantIds);
      const [m] = await tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, input.clientMessageId));
      if (!row || !m || m.direction !== 'inbound')
        throw conflict('message_id_taken', 'Send it again with a new id');
      const [view] = await this.inbox.messageViews(tx, row, [m], { forTenant: true });
      const statuses = await this.ownStatuses(tx, row, [view!]);
      return this.view(view!, statuses.get(m.id) ?? 'sent');
    });
  }

  /** A 5-minute link to an attachment of a message in the person's own conversation (TL-12). */
  async attachmentDownload(
    actor: Actor | null,
    companyId: string,
    messageId: string,
    attachmentId: string,
  ) {
    const tenant = this.tenantActor(actor);
    const tenantIds = await this.tenantIdsIn(tenant, companyId);
    const documentId = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
      const row = await this.conversationIn(tx, tenantIds);
      if (!row) return null;
      const [a] = await tx
        .select({
          documentId: schema.messageAttachment.documentId,
          status: schema.messageAttachment.status,
        })
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
            eq(schema.message.id, messageId),
            inArray(schema.message.tenantId, [...tenantIds]),
            sql`(${schema.message.conversationId} = ${row.id}::uuid or (${schema.message.conversationId} is null and ${schema.message.recipientType} = 'tenant'))`,
            // Review S10: the tenant's own messages and those sent to them, not their contacts'.
            sql`((${schema.message.direction} = 'inbound' and ${schema.message.tenantContactId} is null)
                 or (${schema.message.direction} = 'outbound' and ${schema.message.recipientType} = 'tenant'))`,
          ),
        );
      return a?.status === 'stored' ? a.documentId : null;
    });
    const url = documentId ? await this.documents.downloadUrl(companyId, documentId) : null;
    if (!url) throw notFound('Attachment');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  // Push devices (decision 5) --------------------------------------------------------------------

  async registerPushDevice(
    actor: Actor | null,
    sessionId: string | null,
    input: { token: string; platform: 'ios' | 'android' | 'web'; deviceName?: string | null },
  ) {
    const tenant = this.tenantActor(actor);
    if (!sessionId) throw forbidden();
    const rows = await withSystem(
      this.database,
      { personId: tenant.personId, actorKind: 'tenant' },
      (tx) =>
        tx.execute<{ id: string }>(
          sql`select app.register_push_device(${sessionId}::uuid, ${input.token}, ${input.platform}, ${input.deviceName ?? null}) as id`,
        ),
    );
    const id = rows.rows[0]?.id;
    if (!id) throw invalid('push_device', 'The device could not be registered');
    return { deviceId: id };
  }

  async unregisterPushDevice(actor: Actor | null, token: string) {
    const tenant = this.tenantActor(actor);
    await withSystem(this.database, { personId: tenant.personId, actorKind: 'tenant' }, (tx) =>
      tx.execute(sql`select app.unregister_push_device(${token})`),
    );
    return { ok: true as const };
  }
}
