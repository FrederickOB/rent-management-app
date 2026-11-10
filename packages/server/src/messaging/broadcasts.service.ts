import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import { instantFrom } from '@rent/domain/dates';
import {
  CONSENT_CHANNELS,
  NO_CONSENT,
  planOutbound,
  type ConsentChannel,
  type ConsentFacts,
} from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import { v7 as uuidv7 } from 'uuid';
import { staffActor, type StaffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { conflict, invalid, notFound } from '../core/errors';
import { queueMessage, storedBody } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { subscriptionEnded } from '../core/subscription-ended';
import { PolicyService, staffContext } from '../policy/policy.service';
import { TenantsService } from '../tenancy/tenants.service';
import { sendingAccount, templateOnSendingNumber } from './store';

export const BROADCAST_FANOUT_JOB = 'messaging.broadcast-fanout';
/** Plan 4.7: messages are queued 50 at a time, one batch after another. */
export const BROADCAST_BATCH = 50;
/** How long a broadcast preview may be confirmed (M6 review W3): a product choice. */
export const PREVIEW_MINUTES = 30;
const HOLDING = `('signed', 'active', 'ending', 'holding_over')`;

export type BroadcastAudience =
  | { readonly kind: 'property'; readonly propertyId: string }
  | { readonly kind: 'blocks'; readonly propertyId: string; readonly blockIds: readonly string[] }
  | { readonly kind: 'group'; readonly groupId: string };

interface Planned {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly name: string;
  readonly unitCode: string | null;
  readonly channel: ConsentChannel | null;
  readonly reason: 'no_consent' | 'no_address' | 'opted_out' | null;
}

type Counts = {
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  notSent: number;
};
const zero = (): Counts => ({ queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, notSent: 0 });

/**
 * Broadcasts (CM-08; plan 4.7) and tenant groups. A broadcast reaches the current tenants of a
 * property, some of its blocks or a group, within the sender's scope (Row Level Security), each on
 * the first channel they can be reached on (decision 5), WhatsApp outside the window with the
 * approved building-notice template. A preview says who can be reached and who cannot; the
 * confirmation must match it. No approval step.
 */
@Injectable()
export class BroadcastsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  private async staff(
    actor: Actor | null,
    action: 'messaging.broadcast' | 'tenant_group.manage',
    feature: 'broadcasts' | 'tenant_groups',
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, action);
    await this.entitlements.assert(staff.companyId, feature);
    return staff;
  }

  // Broadcasts -----------------------------------------------------------------------------------

  async preview(
    actor: Actor | null,
    input: { audience: BroadcastAudience; topic: string; body: string },
  ) {
    const staff = await this.staff(actor, 'messaging.broadcast', 'broadcasts');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const planned = await this.plan(tx, staff.companyId, input.audience);
      return this.previewOf(staff, input, planned);
    });
  }

  private previewOf(
    staff: StaffActor,
    input: { audience: BroadcastAudience; topic: string; body: string },
    planned: readonly Planned[],
  ) {
    const byChannel = { push: 0, whatsapp: 0, sms: 0, email: 0 };
    for (const p of planned) if (p.channel) byChannel[p.channel] += 1;
    return {
      audienceCount: planned.length,
      reachableCount: planned.filter((p) => p.channel).length,
      byChannel,
      unreachable: planned
        .filter((p) => !p.channel)
        .map((p) => ({
          tenantId: p.tenantId,
          name: p.name,
          unitCode: p.unitCode,
          reason: p.reason ?? 'no_address',
        })),
      previewToken: this.token(staff, input, planned, this.clock.now().getTime()),
    };
  }

  /** What the sender saw: the audience, the words and who goes on which channel, signed. */
  private token(
    staff: StaffActor,
    input: { audience: BroadcastAudience; topic: string; body: string },
    planned: readonly Planned[],
    /** M6 review W3: when the preview was made, so the same words later are a new broadcast. */
    issuedAt: number,
  ): string {
    const facts = JSON.stringify({
      issuedAt,
      personId: staff.personId,
      companyId: staff.companyId,
      audience: input.audience,
      topic: input.topic,
      body: input.body,
      recipients: planned.map((p) => `${p.tenantId}:${p.channel ?? p.reason}`).sort(),
    });
    const mac = createHmac('sha256', this.config.BETTER_AUTH_SECRET)
      .update(`broadcast:${facts}`)
      .digest('base64url');
    return `${issuedAt.toString(36)}.${mac}`;
  }

  async create(
    actor: Actor | null,
    input: { audience: BroadcastAudience; topic: string; body: string; previewToken: string },
  ) {
    const staff = await this.staff(actor, 'messaging.broadcast', 'broadcasts');
    const tokenHash = createHash('sha256').update(input.previewToken).digest('hex');
    const issuedAt = Number.parseInt(input.previewToken.split('.')[0] ?? '', 36);
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      // The same confirmation twice is one broadcast.
      const [already] = await tx
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.previewTokenHash, tokenHash));
      if (already) {
        const same =
          already.topic === input.topic &&
          already.body === input.body &&
          already.audienceKind === input.audience.kind &&
          (input.audience.kind === 'group'
            ? already.groupId === input.audience.groupId
            : already.propertyId === input.audience.propertyId &&
              (input.audience.kind !== 'blocks' ||
                [...(already.blockIds ?? [])].sort().join() ===
                  [...input.audience.blockIds].sort().join()));
        if (!same)
          throw conflict(
            'preview_used',
            'That preview was confirmed for another broadcast: preview this one',
          );
        return already.id;
      }
      // A preview is good for its validity window; within it the same confirmation is one
      // broadcast (above), and after it the sender previews again.
      const age = this.clock.now().getTime() - issuedAt;
      if (!Number.isFinite(issuedAt) || age < -60_000 || age > PREVIEW_MINUTES * 60_000)
        throw conflict(
          'preview_expired',
          'The preview is out of date: preview the broadcast again',
        );
      const planned = await this.plan(tx, staff.companyId, input.audience);
      const expected = Buffer.from(this.token(staff, input, planned, issuedAt));
      const given = Buffer.from(input.previewToken);
      if (expected.length !== given.length || !timingSafeEqual(expected, given))
        throw conflict(
          'audience_changed',
          'Who this reaches has changed since the preview: preview it again',
        );
      const queued = planned.filter((p) => p.channel);
      const batches = Math.ceil(queued.length / BROADCAST_BATCH);
      const [row] = await tx
        .insert(schema.broadcast)
        .values({
          companyId: staff.companyId,
          audienceKind: input.audience.kind,
          propertyId: input.audience.kind === 'group' ? null : input.audience.propertyId,
          blockIds: input.audience.kind === 'blocks' ? [...input.audience.blockIds] : null,
          groupId: input.audience.kind === 'group' ? input.audience.groupId : null,
          topic: input.topic,
          body: input.body,
          status: batches === 0 ? 'sent' : 'sending',
          audienceCount: planned.length,
          queuedCount: queued.length,
          batches,
          createdBy: staff.personId,
          previewTokenHash: tokenHash,
          ...(batches === 0 ? { completedAt: this.clock.now() } : {}),
        })
        .returning({ id: schema.broadcast.id });
      let index = 0;
      const tests = new Map(
        (
          await tx
            .select({ id: schema.tenant.id, test: schema.tenant.isTestContact })
            .from(schema.tenant)
            .where(
              inArray(
                schema.tenant.id,
                planned.length ? planned.map((p) => p.tenantId) : [uuidv7()],
              ),
            )
        ).map((t) => [t.id, t.test]),
      );
      for (const p of planned) {
        // Each reachable tenant's message is recorded now, queued, so the recipients are fixed
        // with the confirmation; the fan-out hands them to the send job a batch at a time.
        const messageId = p.channel ? uuidv7() : null;
        if (messageId) {
          await tx.insert(schema.message).values({
            id: messageId,
            companyId: staff.companyId,
            propertyId: p.propertyId,
            tenantId: p.tenantId,
            recipientType: 'tenant',
            purpose: 'broadcast',
            subject: input.topic,
            body: storedBody(input.body),
            channels: [...CONSENT_CHANNELS],
            isTestContact: tests.get(p.tenantId) ?? false,
            relatedType: 'broadcast',
            relatedId: row!.id,
            requestedBy: staff.personId,
          });
          await tx
            .insert(schema.messageEvent)
            .values({ companyId: staff.companyId, messageId, status: 'queued' });
        }
        await tx.insert(schema.broadcastRecipient).values({
          companyId: staff.companyId,
          broadcastId: row!.id,
          propertyId: p.propertyId,
          tenantId: p.tenantId,
          messageId,
          plannedChannel: p.channel,
          outcome: p.channel ? 'queued' : 'not_sent',
          reason: p.channel ? null : (p.reason ?? 'no_address'),
          batch: p.channel ? Math.floor(index++ / BROADCAST_BATCH) : 0,
        });
      }
      if (batches > 0)
        await enqueueOutbox(tx, {
          companyId: staff.companyId,
          type: BROADCAST_FANOUT_JOB,
          payload: { broadcastId: row!.id, batch: 0 },
          idempotencyKey: `${BROADCAST_FANOUT_JOB}:${row!.id}:0`,
        });
      return row!.id;
    }).catch(async (error: unknown) => {
      // Two confirmations at once (a double click): the first made it; answer with that one.
      const code =
        (error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code;
      if (code !== '23505') throw error;
      const [made] = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .select({ id: schema.broadcast.id })
          .from(schema.broadcast)
          .where(eq(schema.broadcast.previewTokenHash, tokenHash)),
      );
      if (!made) throw error;
      return made.id;
    });
    return this.get(staff, id);
  }

  /**
   * `messaging.broadcast-fanout` (plan 4.13): one batch of 50 messages, then the next batch's job,
   * so batches go one after another. Idempotent by broadcast and batch: message ids are fixed.
   */
  async fanout(companyId: string, broadcastId: string, batch: number): Promise<number> {
    // M10 decision 12: a broadcast still to go stops once the subscription has ended.
    if (await subscriptionEnded(this.database, companyId)) return 0;
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [b] = await tx
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, broadcastId));
      if (!b || batch >= b.batches) return 0;
      const recipients = await tx
        .select()
        .from(schema.broadcastRecipient)
        .where(
          and(
            eq(schema.broadcastRecipient.broadcastId, broadcastId),
            eq(schema.broadcastRecipient.batch, batch),
            eq(schema.broadcastRecipient.outcome, 'queued'),
          ),
        );
      const [property] = b.propertyId
        ? await tx
            .select({ name: schema.property.name })
            .from(schema.property)
            .where(eq(schema.property.id, b.propertyId))
        : [];
      for (const r of recipients)
        await queueMessage(tx, companyId, {
          messageId: r.messageId!,
          recipient: { type: 'tenant', tenantId: r.tenantId },
          purpose: 'broadcast',
          subject: b.topic,
          body: b.body,
          channels: [...CONSENT_CHANNELS],
          propertyId: r.propertyId,
          related: { type: 'broadcast', id: b.id },
          requestedBy: b.createdBy,
          // WhatsApp template parameters are one line each.
          templateParams: {
            topic: (property?.name ? `${b.topic} at ${property.name}` : b.topic).slice(0, 120),
            notice: b.body.replace(/\s+/g, ' ').trim().slice(0, 500),
          },
        });
      const done = Math.max(b.batchesQueued, batch + 1);
      await tx
        .update(schema.broadcast)
        .set({
          batchesQueued: done,
          ...(done >= b.batches ? { status: 'sent', completedAt: this.clock.now() } : {}),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.broadcast.id, broadcastId));
      if (batch + 1 < b.batches)
        await enqueueOutbox(tx, {
          companyId,
          type: BROADCAST_FANOUT_JOB,
          payload: { broadcastId, batch: batch + 1 },
          idempotencyKey: `${BROADCAST_FANOUT_JOB}:${broadcastId}:${batch + 1}`,
        });
      return recipients.length;
    });
  }

  async list(actor: Actor | null, filter: { propertyId?: string; cursor?: string; limit: number }) {
    const staff = await this.staff(actor, 'messaging.broadcast', 'broadcasts');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.broadcast)
        .where(
          and(
            filter.propertyId ? eq(schema.broadcast.propertyId, filter.propertyId) : undefined,
            filter.cursor ? lt(schema.broadcast.id, filter.cursor) : undefined,
          ),
        )
        .orderBy(desc(schema.broadcast.id))
        .limit(filter.limit + 1);
      const page = rows.slice(0, filter.limit);
      const items = [];
      for (const b of page) {
        const { recipients: _recipients, ...summary } = await this.view(tx, b);
        items.push(summary);
      }
      return { items, nextCursor: rows.length > filter.limit ? page.at(-1)!.id : null };
    });
  }

  async get(actor: Actor | null, broadcastId: string) {
    const staff = await this.staff(actor, 'messaging.broadcast', 'broadcasts');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [b] = await tx
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, broadcastId));
      if (!b) throw notFound('Broadcast');
      return this.view(tx, b);
    });
  }

  private async view(tx: Tx, b: typeof schema.broadcast.$inferSelect) {
    const recipients = await tx.execute<{
      tenant_id: string;
      name: string;
      unit_code: string | null;
      outcome: string;
      reason: string | null;
      message_id: string | null;
      planned: string | null;
    }>(
      sql`select r.tenant_id, t.display_name as name, r.outcome, r.reason, r.message_id, r.planned_channel as planned,
                 (select u.code from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
                  where l.company_id = r.company_id and l.tenant_id = r.tenant_id and l.property_id = r.property_id
                  order by l.start_date desc limit 1) as unit_code
          from broadcast_recipient r join tenant t on t.company_id = r.company_id and t.id = r.tenant_id
          where r.broadcast_id = ${b.id}::uuid order by t.display_name`,
    );
    const messageIds = recipients.rows.flatMap((r) => (r.message_id ? [r.message_id] : []));
    const events = messageIds.length
      ? await tx
          .select()
          .from(schema.messageEvent)
          .where(inArray(schema.messageEvent.messageId, messageIds))
      : [];
    const rank = ['queued', 'not_sent', 'failed', 'sent', 'delivered', 'read'];
    const stats = {
      ...zero(),
      byChannel: { push: zero(), whatsapp: zero(), sms: zero(), email: zero() },
    };
    const rows = recipients.rows.map((r) => {
      if (!r.message_id) {
        stats.notSent += 1;
        return {
          tenantId: r.tenant_id,
          name: r.name,
          unitCode: r.unit_code,
          channel: null,
          status: 'not_sent' as const,
          reason: r.reason,
        };
      }
      const mine = events
        .filter((e) => e.messageId === r.message_id)
        .sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime());
      const sent = [...mine].reverse().find((e) => e.status === 'sent');
      const terminal = mine.find((e) => e.status === 'not_sent');
      const best =
        terminal ??
        mine
          .filter((e) => !sent || e.channel === sent.channel)
          .reduce<(typeof mine)[number] | undefined>(
            (acc, e) => (!acc || rank.indexOf(e.status) >= rank.indexOf(acc.status) ? e : acc),
            undefined,
          );
      const status = (best?.status ?? 'queued') as
        'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'not_sent';
      const key = status === 'not_sent' ? 'notSent' : status;
      stats[key] += 1;
      const channel = (sent?.channel ?? r.planned) as ConsentChannel | null;
      if (channel && channel in stats.byChannel)
        stats.byChannel[channel as ConsentChannel][key] += 1;
      return {
        tenantId: r.tenant_id,
        name: r.name,
        unitCode: r.unit_code,
        channel,
        status,
        reason: best?.reason ?? null,
      };
    });
    const [creator] = await tx
      .select({ name: schema.person.name })
      .from(schema.person)
      .where(eq(schema.person.id, b.createdBy));
    const audience: BroadcastAudience =
      b.audienceKind === 'group'
        ? { kind: 'group', groupId: b.groupId! }
        : b.audienceKind === 'blocks'
          ? { kind: 'blocks', propertyId: b.propertyId!, blockIds: b.blockIds ?? [] }
          : { kind: 'property', propertyId: b.propertyId! };
    return {
      id: b.id,
      audience,
      audienceLabel: await this.label(tx, audience),
      topic: b.topic,
      body: b.body,
      status: b.status as 'sending' | 'sent',
      audienceCount: b.audienceCount,
      queuedCount: b.queuedCount,
      createdBy: { personId: b.createdBy, name: creator?.name ?? '' },
      confirmedAt: b.confirmedAt,
      completedAt: b.completedAt,
      stats,
      recipients: rows,
    };
  }

  private async label(tx: Tx, audience: BroadcastAudience): Promise<string> {
    if (audience.kind === 'group') {
      const [g] = await tx
        .select({ name: schema.tenantGroup.name })
        .from(schema.tenantGroup)
        .where(eq(schema.tenantGroup.id, audience.groupId));
      return g?.name ?? 'A tenant group';
    }
    const [p] = await tx
      .select({ name: schema.property.name, code: schema.property.code })
      .from(schema.property)
      .where(eq(schema.property.id, audience.propertyId));
    if (audience.kind === 'property') return p ? `${p.name} (${p.code})` : 'A property';
    const blocks = await tx
      .select({ code: schema.block.code })
      .from(schema.block)
      .where(inArray(schema.block.id, [...audience.blockIds]));
    return `${p?.name ?? 'A property'}: blocks ${blocks
      .map((b) => b.code)
      .sort()
      .join(', ')}`;
  }

  /** The audience's current tenants in scope, each with the channel the message would take. */
  private async plan(tx: Tx, companyId: string, audience: BroadcastAudience): Promise<Planned[]> {
    if (audience.kind === 'blocks') {
      const blocks = await tx
        .select({ id: schema.block.id })
        .from(schema.block)
        .where(
          and(
            eq(schema.block.propertyId, audience.propertyId),
            inArray(schema.block.id, [...audience.blockIds]),
          ),
        );
      if (blocks.length !== new Set(audience.blockIds).size)
        throw invalid('unknown_block', 'Choose blocks of the property');
    }
    if (audience.kind === 'group') {
      const [g] = await tx
        .select({ id: schema.tenantGroup.id })
        .from(schema.tenantGroup)
        .where(
          and(eq(schema.tenantGroup.id, audience.groupId), isNull(schema.tenantGroup.archivedAt)),
        );
      if (!g) throw notFound('Tenant group');
    }
    const where =
      audience.kind === 'property'
        ? sql`l.property_id = ${audience.propertyId}::uuid`
        : audience.kind === 'blocks'
          ? sql`l.property_id = ${audience.propertyId}::uuid and u.block_id = any(${`{${audience.blockIds.join(',')}}`}::uuid[])`
          : sql`exists (select 1 from tenant_group_member g where g.company_id = l.company_id and g.group_id = ${audience.groupId}::uuid and g.tenant_id = l.tenant_id)`;
    const rows = await tx.execute<{
      tenant_id: string;
      property_id: string;
      name: string;
      code: string;
    }>(
      sql`select distinct on (l.tenant_id) l.tenant_id, l.property_id, t.display_name as name, u.code
          from lease l join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
          join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where l.status in ${sql.raw(HOLDING)} and t.archived_at is null and ${where}
          order by l.tenant_id, l.start_date desc`,
    );
    const account = await sendingAccount(tx, companyId);
    const template = await templateOnSendingNumber(tx, companyId, 'building_notice');
    const now = instantFrom(this.clock.now());
    const out: Planned[] = [];
    for (const r of rows.rows) {
      const point = await this.tenants.messagingPoint(tx, { tenantId: r.tenant_id });
      const tokens = point?.personId
        ? (
            await tx.execute<{ token: string }>(
              sql`select token from app.push_tokens_for_tenant(${r.tenant_id}::uuid)`,
            )
          ).rows
        : [];
      const facts = (c: ConsentChannel): ConsentFacts => {
        const e = point?.consent[c];
        return e ? { latest: { action: e.action, at: instantFrom(e.at) } } : NO_CONSENT;
      };
      const address = (c: ConsentChannel) =>
        c === 'push'
          ? tokens.length > 0
          : c === 'whatsapp'
            ? Boolean(point?.whatsappPhone) && account !== null
            : c === 'sms'
              ? Boolean(point?.phone)
              : Boolean(point?.email);
      const plan = planOutbound({
        purpose: 'broadcast',
        channels: [...CONSENT_CHANNELS],
        reach: Object.fromEntries(
          CONSENT_CHANNELS.map((c) => [
            c,
            { address: address(c), consent: facts(c), lastInboundAt: null },
          ]),
        ),
        whatsappTemplate: template,
        exhausted: new Set(),
        now,
      });
      const optedOut =
        !plan.send &&
        plan.skipped.some((s) => s.reason === 'opted_out') &&
        !plan.skipped.some((s) => s.reason === 'no_consent');
      out.push({
        tenantId: r.tenant_id,
        propertyId: r.property_id,
        name: r.name,
        unitCode: r.code,
        channel: plan.send ? plan.channel : null,
        reason: plan.send
          ? null
          : optedOut
            ? 'opted_out'
            : plan.reason === 'no_consent'
              ? 'no_consent'
              : 'no_address',
      });
    }
    return out.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  // Tenant groups -------------------------------------------------------------------------------

  async groups(actor: Actor | null, filter: { archived?: boolean }) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      // `archived=true`: only archived groups; otherwise only the active ones.
      const rows = await tx
        .select()
        .from(schema.tenantGroup)
        .where(
          filter.archived
            ? sql`${schema.tenantGroup.archivedAt} is not null`
            : isNull(schema.tenantGroup.archivedAt),
        )
        .orderBy(schema.tenantGroup.name);
      return Promise.all(rows.map((g) => this.groupView(tx, g)));
    });
  }

  async group(actor: Actor | null, groupId: string) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) =>
      this.groupView(tx, await this.groupOr404(tx, groupId)),
    );
  }

  private async groupOr404(tx: Tx, groupId: string) {
    const [g] = await tx
      .select()
      .from(schema.tenantGroup)
      .where(eq(schema.tenantGroup.id, groupId));
    if (!g) throw notFound('Tenant group');
    return g;
  }

  private async groupView(tx: Tx, g: typeof schema.tenantGroup.$inferSelect) {
    const [n] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.tenantGroupMember)
      .where(eq(schema.tenantGroupMember.groupId, g.id));
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      memberCount: n?.n ?? 0,
      archivedAt: g.archivedAt,
      createdAt: g.createdAt,
    };
  }

  async createGroup(actor: Actor | null, input: { name: string; description?: string | null }) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [g] = await tx
        .insert(schema.tenantGroup)
        .values({
          companyId: staff.companyId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          createdBy: staff.personId,
        })
        .onConflictDoNothing()
        .returning();
      if (!g) throw conflict('group_name_taken', 'A group with that name exists');
      return this.groupView(tx, g);
    });
  }

  async updateGroup(
    actor: Actor | null,
    groupId: string,
    input: { name?: string; description?: string | null },
  ) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await this.groupOr404(tx, groupId);
      const [g] = await tx
        .update(schema.tenantGroup)
        .set({
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.tenantGroup.id, groupId))
        .returning();
      return this.groupView(tx, g!);
    });
  }

  async archiveGroup(actor: Actor | null, groupId: string) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await this.groupOr404(tx, groupId);
      const [g] = await tx
        .update(schema.tenantGroup)
        .set({ archivedAt: this.clock.now(), updatedAt: this.clock.now() })
        .where(eq(schema.tenantGroup.id, groupId))
        .returning();
      return this.groupView(tx, g!);
    });
  }

  async members(actor: Actor | null, groupId: string) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await this.groupOr404(tx, groupId);
      const rows = await tx.execute<{
        tenant_id: string;
        name: string;
        added_at: Date;
        unit_id: string | null;
        code: string | null;
        property_id: string | null;
        property_name: string | null;
      }>(
        sql`select m.tenant_id, t.display_name as name, m.added_at, u.id as unit_id, u.code, p.id as property_id, p.name as property_name
            from tenant_group_member m join tenant t on t.company_id = m.company_id and t.id = m.tenant_id
            left join lease l on l.company_id = m.company_id and l.tenant_id = m.tenant_id and l.status in ${sql.raw(HOLDING)}
            left join unit u on u.company_id = l.company_id and u.id = l.unit_id
            left join property p on p.company_id = l.company_id and p.id = l.property_id
            where m.group_id = ${groupId}::uuid order by t.display_name`,
      );
      const byTenant = new Map<
        string,
        {
          tenantId: string;
          name: string;
          addedAt: Date;
          units: { unitId: string; unitCode: string; propertyId: string; propertyName: string }[];
        }
      >();
      for (const r of rows.rows) {
        const entry = byTenant.get(r.tenant_id) ?? {
          tenantId: r.tenant_id,
          name: r.name,
          addedAt: new Date(r.added_at),
          units: [],
        };
        if (r.unit_id && r.code && r.property_id && r.property_name)
          entry.units.push({
            unitId: r.unit_id,
            unitCode: r.code,
            propertyId: r.property_id,
            propertyName: r.property_name,
          });
        byTenant.set(r.tenant_id, entry);
      }
      return [...byTenant.values()];
    });
  }

  async addMembers(actor: Actor | null, groupId: string, tenantIds: readonly string[]) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const g = await this.groupOr404(tx, groupId);
      const visible = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(inArray(schema.tenant.id, [...tenantIds]));
      if (visible.length !== new Set(tenantIds).size) throw notFound('Tenant');
      for (const t of visible)
        await tx
          .insert(schema.tenantGroupMember)
          .values({ companyId: staff.companyId, groupId, tenantId: t.id, addedBy: staff.personId })
          .onConflictDoNothing();
      return this.groupView(tx, g);
    });
  }

  async removeMembers(actor: Actor | null, groupId: string, tenantIds: readonly string[]) {
    const staff = await this.staff(actor, 'tenant_group.manage', 'tenant_groups');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const g = await this.groupOr404(tx, groupId);
      await tx
        .delete(schema.tenantGroupMember)
        .where(
          and(
            eq(schema.tenantGroupMember.groupId, groupId),
            inArray(schema.tenantGroupMember.tenantId, [...tenantIds]),
          ),
        );
      return this.groupView(tx, g);
    });
  }
}
