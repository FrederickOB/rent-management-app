import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { eq, schema, withCompany, type Database, type withSystemClient } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { staffActor, type StaffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { AppLogger } from '../core/logging/logger';
import { DATABASE, LOGGER } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';

/** The named events the stream sends; each event's data is `{ kind, conversationId, messageId }`. */
export const INBOX_STREAM_KINDS = [
  'conversation',
  'message',
  'message_event',
  'message_attachment',
] as const;
export type InboxStreamKind = (typeof INBOX_STREAM_KINDS)[number];

export interface InboxStreamEvent {
  readonly kind: InboxStreamKind;
  readonly conversationId: string;
  readonly messageId: string | null;
}

interface Subscriber {
  readonly staff: StaffActor;
  readonly send: (event: InboxStreamEvent) => void;
  /** Conversations this person may see, checked once and kept a short while. */
  readonly visible: Map<string, { allowed: boolean; at: number }>;
}

/** A pooled connection held for LISTEN (the pg PoolClient type, through @rent/db). */
type ListenClient = Parameters<Parameters<typeof withSystemClient>[1]>[0];

const VISIBILITY_MS = 30_000;
const RECONNECT_MS = 5_000;

/**
 * The live inbox (plan 4.6): one LISTEN connection per API instance on the `inbox` channel, which
 * the database notifies with ids only, on commit. Each event goes to the subscribers of its
 * company who may see that conversation, checked under their own scope (RLS), so a caretaker hears
 * of their properties' tenants only. Clients then fetch what changed through the API.
 */
@Injectable()
export class InboxStreamService implements OnModuleDestroy {
  private readonly subscribers = new Set<Subscriber>();
  private client: ListenClient | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Whether this session may open the stream: the inbox permission and a plan with the inbox. */
  async authorize(actor: Actor | null): Promise<StaffActor> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'messaging.inbox.read');
    await this.entitlements.assert(staff.companyId, 'inbox');
    return staff;
  }

  /** Starts listening for a staff session; returns the function that stops it. */
  async subscribe(
    actor: Actor | null,
    send: (event: InboxStreamEvent) => void,
  ): Promise<() => void> {
    const staff = await this.authorize(actor);
    await this.listen();
    const subscriber: Subscriber = { staff, send, visible: new Map() };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * M6 review S-9: whether an open stream may go on, checked again on each heartbeat. The
   * membership must still be active with the same role and scope, and the plan still have the
   * inbox; otherwise the stream closes and the client signs in or reloads.
   */
  async stillAllowed(actor: Actor | null): Promise<boolean> {
    try {
      const staff = await this.authorize(actor);
      const [membership] = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .select({
            status: schema.membership.status,
            role: schema.membership.role,
            scope: schema.membership.scope,
          })
          .from(schema.membership)
          .where(eq(schema.membership.id, staff.membershipId)),
      );
      // The membership as the session was built from it: unchanged, or the stream closes.
      const grant = (m: { role: string; scope: unknown }) =>
        JSON.stringify([m.role, m.scope ?? {}]);
      return membership?.status === 'active' && grant(membership) === grant(staff);
    } catch {
      return false;
    }
  }

  get size(): number {
    return this.subscribers.size;
  }

  private listen(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= (async () => {
      const client = await this.database.pool.connect();
      client.on('notification', (n) => void this.dispatch(n.payload));
      client.on('error', (error) => {
        this.logger.warn({ err: error }, 'inbox stream connection lost');
        this.drop(client);
        if (!this.closed)
          setTimeout(() => void this.listen().catch(() => undefined), RECONNECT_MS).unref();
      });
      await client.query('LISTEN inbox');
      this.client = client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private drop(client: ListenClient) {
    if (this.client === client) this.client = null;
    try {
      client.release(true);
    } catch {
      // Released already.
    }
  }

  private async dispatch(payload: string | undefined) {
    if (!payload) return;
    let note: {
      companyId?: string;
      conversationId?: string;
      messageId?: string | null;
      kind?: string;
    };
    try {
      note = JSON.parse(payload) as typeof note;
    } catch {
      return;
    }
    const kind = INBOX_STREAM_KINDS.find((k) => k === note.kind);
    if (!kind || !note.companyId || !note.conversationId) return;
    const event: InboxStreamEvent = {
      kind,
      conversationId: note.conversationId,
      messageId: note.messageId ?? null,
    };
    for (const s of this.subscribers) {
      if (s.staff.companyId !== note.companyId) continue;
      if (await this.canSee(s, note.conversationId).catch(() => false)) s.send(event);
    }
  }

  private async canSee(s: Subscriber, conversationId: string): Promise<boolean> {
    const now = Date.now();
    const cached = s.visible.get(conversationId);
    if (cached && now - cached.at < VISIBILITY_MS) return cached.allowed;
    const rows = await withCompany(this.database, staffContext(s.staff), (tx) =>
      tx
        .select({ id: schema.conversation.id, tenantId: schema.conversation.tenantId })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, conversationId)),
    );
    // Triage (no tenant yet) only to those who may work it (review S-9).
    const allowed =
      rows.length > 0 &&
      (rows[0]!.tenantId !== null || this.policy.can(s.staff, 'messaging.triage').allowed);
    if (s.visible.size > 2_000) s.visible.clear();
    s.visible.set(conversationId, { allowed, at: now });
    return allowed;
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    const client = this.client;
    if (!client) return;
    this.client = null;
    await client.query('UNLISTEN inbox').catch(() => undefined);
    try {
      client.release();
    } catch {
      // Released already.
    }
  }
}
