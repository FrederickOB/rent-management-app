import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  ne,
  schema,
  sql,
  withSystem,
  type Database,
  type SQL,
} from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { platformAdminFor } from '../admin/platform-admin';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { conflict, notFound } from '../core/errors';
import { scrubString } from '../core/logging/redact';
import { MESSAGING_INBOUND_JOB, MESSAGING_WEBHOOK_PREFIX } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { PROCESS_WEBHOOK_JOB } from '../payments/webhooks.service';
import { PolicyService } from '../policy/policy.service';
import { platformCompanyId, withPlatform } from '../subscription/platform';
import { OPS_CLI_MAX, OPS_LIST_LIMIT } from './constants';
import { consoleOperator, isUuid, operatorData, opsReason, type OpsOperator } from './operator';

type InboxRow = typeof schema.webhookInbox.$inferSelect;

/** A stored webhook as the console shows it (the contract's `opsWebhookSchema`): no body, ever. */
export interface OpsWebhookView {
  readonly id: string;
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string | null;
  readonly receivedAt: Date;
  readonly status: 'failed' | 'dead_lettered' | 'processed' | 'pending';
  readonly lastError: string | null;
  readonly replayCount: number;
  readonly lastReplayedAt: Date | null;
  readonly lastReplayedByName: string | null;
}

/** Which stored webhooks an incident command replays (`pnpm ops:replay-webhooks`). */
export interface WebhookSelection {
  readonly ids?: readonly string[];
  readonly provider?: string;
  /** Received at or after. */
  readonly from?: Date;
  /** Received before. */
  readonly to?: Date;
  /** `failed`: failed and dead-lettered rows only; `all`: every row that can be replayed. */
  readonly include: 'failed' | 'all';
  readonly limit?: number;
}

/** The console's status of a row: dead-lettered, failed otherwise, waiting, or done. */
export function webhookStatusOf(
  row: Pick<InboxRow, 'status' | 'outcome'>,
): OpsWebhookView['status'] {
  if (row.status === 'failed') return row.outcome === 'dead_lettered' ? 'dead_lettered' : 'failed';
  if (row.status === 'received') return 'pending';
  return 'processed';
}

/**
 * Why a row cannot be replayed, or null: a rejected request kept no body; an unreadable one has no
 * event; a payments event without a reference has nothing to verify with the provider.
 */
export function notReplayable(
  row: Pick<
    InboxRow,
    'signatureValid' | 'status' | 'rawBody' | 'outcome' | 'provider' | 'reference'
  >,
): string | null {
  if (!row.signatureValid || row.status === 'rejected' || row.rawBody === null)
    return 'A rejected webhook (bad signature or too large) kept no body, so there is nothing to replay';
  if (row.outcome === 'unparsed')
    return 'This webhook could not be read when it came, so there is nothing to process';
  if (!row.provider.startsWith(MESSAGING_WEBHOOK_PREFIX) && !row.reference)
    return 'This webhook carries no reference to verify with the provider';
  return null;
}

/** The job that processes a stored row: the one the inbox relay queues for it. */
export const processingJobOf = (provider: string): string =>
  provider.startsWith(MESSAGING_WEBHOOK_PREFIX) ? MESSAGING_INBOUND_JOB : PROCESS_WEBHOOK_JOB;

/** Rows a replay can run: signed, with a body, read when they came, and with what they need. */
const replayableWhere = sql`${schema.webhookInbox.signatureValid}
  and ${schema.webhookInbox.status} <> 'rejected'
  and ${schema.webhookInbox.rawBody} is not null
  and ${schema.webhookInbox.outcome} is distinct from 'unparsed'
  and (${schema.webhookInbox.provider} like 'messaging.%' or ${schema.webhookInbox.reference} is not null)`;

/**
 * Failed and dead-lettered webhooks, and their replay (M11 decision 9; plan 4.7). A replay sets the
 * stored row to be processed again and queues the same job the inbox relay queues for it
 * (`payments.process-webhook` or `messaging.process-inbound`, with `{ inboxId }`), so it runs the
 * normal, idempotent processing: replaying twice, or a whole day, changes nothing that was done.
 * Each replay takes a reason and is recorded as an ops_action in the platform company with a
 * semantic event in the platform's audit chain (`ops.webhook_replayed`), in one transaction with
 * the queued job; the row counts its replays and who made the last. The inbox is read and written
 * only in system transactions (review R2 F6). Errors are codes and short messages, never a body.
 */
@Injectable()
export class WebhookReplayService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The console: failed and dead-lettered webhooks, newest first (`health.read`). */
  async list(
    actor: Actor | null,
    filter: { readonly status?: 'failed' | 'dead_lettered'; readonly provider?: string } = {},
  ): Promise<OpsWebhookView[]> {
    platformAdminFor(this.policy, actor, 'health.read');
    return this.failed(filter);
  }

  /** Failed and dead-lettered webhooks, newest first (the system path behind the console). */
  async failed(
    filter: { readonly status?: 'failed' | 'dead_lettered'; readonly provider?: string } = {},
  ): Promise<OpsWebhookView[]> {
    const w = schema.webhookInbox;
    const conditions: SQL[] = [eq(w.status, 'failed')];
    if (filter.status === 'dead_lettered') conditions.push(eq(w.outcome, 'dead_lettered'));
    if (filter.status === 'failed')
      conditions.push(sql`${w.outcome} is distinct from 'dead_lettered'`);
    if (filter.provider) conditions.push(eq(w.provider, filter.provider));
    return withSystem(this.database, {}, async (tx) => {
      const rows = await tx
        .select({ row: w, name: schema.person.name })
        .from(w)
        .leftJoin(schema.person, eq(schema.person.id, w.lastReplayedBy))
        .where(and(...conditions))
        .orderBy(desc(w.receivedAt), desc(w.id))
        .limit(OPS_LIST_LIMIT);
      return rows.map((r) => viewOf(r.row, r.name));
    });
  }

  /**
   * The console: one stored webhook, whatever its status (M11 review C6: a replay is followed
   * until it is processed). `health.read`; a rejected row is not shown (404), as it kept no body.
   */
  async get(actor: Actor | null, webhookId: string): Promise<OpsWebhookView> {
    platformAdminFor(this.policy, actor, 'health.read');
    if (!isUuid(webhookId)) throw notFound('Webhook');
    const w = schema.webhookInbox;
    const [found] = await withSystem(this.database, {}, (tx) =>
      tx
        .select({ row: w, name: schema.person.name })
        .from(w)
        .leftJoin(schema.person, eq(schema.person.id, w.lastReplayedBy))
        .where(and(eq(w.id, webhookId), ne(w.status, 'rejected'))),
    );
    if (!found) throw notFound('Webhook');
    return viewOf(found.row, found.name);
  }

  /** The console's replay (`platform.ops.replay`), with a reason of 5 to 500 characters. */
  async replay(
    actor: Actor | null,
    webhookId: string,
    reason: string,
    requestId?: string | null,
  ): Promise<OpsWebhookView> {
    return this.replayAs(
      consoleOperator(this.policy, actor, 'platform.ops.replay', requestId),
      webhookId,
      reason,
    );
  }

  /**
   * Replays one stored webhook for `operator` (the console, the incident command and the drills).
   * The row is locked, set to be processed again and counted; inside that, the platform
   * transaction records the ops_action and the audit event and queues the processing job, and
   * commits first. If it fails, the row is left as it was. Processing reads the row under its lock,
   * so a job that starts before the row's own commit waits for it.
   */
  async replayAs(
    operator: OpsOperator,
    webhookId: string,
    reason: string,
  ): Promise<OpsWebhookView> {
    const why = opsReason(reason);
    if (!isUuid(webhookId)) throw notFound('Webhook');
    // The platform company is needed for the record; refused (503) before anything changes.
    await platformCompanyId(this.database);
    const w = schema.webhookInbox;
    return withSystem(
      this.database,
      { personId: operator.personId, requestId: operator.requestId ?? null },
      async (tx) => {
        const [row] = await tx.select().from(w).where(eq(w.id, webhookId)).for('update');
        if (!row) throw notFound('Webhook');
        const problem = notReplayable(row);
        if (problem) throw conflict('webhook_not_replayable', problem);
        const [updated] = await tx
          .update(w)
          .set({
            status: 'received',
            outcome: null,
            processedAt: null,
            replayCount: sql`${w.replayCount} + 1`,
            // The database's clock, as pg-boss stamps jobs: a dead letter compares the two.
            lastReplayedAt: sql`now()`,
            lastReplayedBy: operator.personId,
          })
          .where(eq(w.id, webhookId))
          .returning();
        const [person] = await tx
          .select({ name: schema.person.name })
          .from(schema.person)
          .where(eq(schema.person.id, operator.personId));
        await withPlatform(
          this.database,
          {
            personId: operator.personId,
            requestId: operator.requestId ?? null,
            actorKind: operator.via === 'console' ? 'platform_admin' : 'system',
          },
          async (ptx, platformId) => {
            const [action] = await ptx
              .insert(schema.opsAction)
              .values({
                companyId: platformId,
                kind: 'webhook_replay',
                targetId: row.id,
                targetName: row.provider,
                reason: why,
                personId: operator.personId,
                outcome: 'queued',
              })
              .returning({ id: schema.opsAction.id });
            await this.audit.append(ptx, {
              companyId: platformId,
              action: 'ops.webhook_replayed',
              recordType: 'webhook_inbox',
              recordId: row.id,
              data: {
                opsActionId: action!.id,
                provider: row.provider,
                eventType: row.eventType,
                previousStatus: webhookStatusOf(row),
                replayCount: updated!.replayCount,
                via: operator.via,
                reason: why,
                ...operatorData(operator),
              },
            });
            await enqueueOutbox(ptx, {
              companyId: platformId,
              type: processingJobOf(row.provider),
              payload: { inboxId: row.id, opsActionId: action!.id },
              idempotencyKey: `ops:webhook_replay:${action!.id}`,
            });
          },
        );
        return viewOf(updated!, person?.name ?? null);
      },
    );
  }

  /**
   * The stored webhooks an incident command replays: by id, or by provider and time received;
   * failed ones only unless `include` is `all`. Oldest first, as they came; rows that cannot be
   * replayed are left out (an id asked for that cannot be is reported by `replayAs`).
   */
  async select(
    selection: WebhookSelection,
  ): Promise<{ id: string; provider: string; status: string }[]> {
    const w = schema.webhookInbox;
    const limit = Math.min(Math.max(1, selection.limit ?? 1_000), OPS_CLI_MAX);
    const conditions: SQL[] = [];
    if (selection.ids && selection.ids.length > 0) {
      const ids = selection.ids.filter(isUuid);
      if (ids.length === 0) return [];
      conditions.push(inArray(w.id, ids));
    } else conditions.push(replayableWhere);
    if (selection.include === 'failed') conditions.push(eq(w.status, 'failed'));
    else conditions.push(ne(w.status, 'rejected'));
    if (selection.provider) conditions.push(eq(w.provider, selection.provider));
    if (selection.from) conditions.push(gte(w.receivedAt, selection.from));
    if (selection.to) conditions.push(lt(w.receivedAt, selection.to));
    return withSystem(this.database, {}, async (tx) =>
      (
        await tx
          .select({ id: w.id, provider: w.provider, status: w.status, outcome: w.outcome })
          .from(w)
          .where(and(...conditions))
          .orderBy(w.receivedAt, w.id)
          .limit(limit)
      ).map((r) => ({ id: r.id, provider: r.provider, status: webhookStatusOf(r) })),
    );
  }
}

function viewOf(row: InboxRow, replayedByName: string | null): OpsWebhookView {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.eventId,
    eventType: row.eventType,
    receivedAt: new Date(row.receivedAt),
    status: webhookStatusOf(row),
    // M11 review: scrubbed again on the way out, whatever wrote it.
    lastError: row.lastError ? scrubString(row.lastError) : null,
    replayCount: row.replayCount,
    lastReplayedAt: row.lastReplayedAt ? new Date(row.lastReplayedAt) : null,
    lastReplayedByName: replayedByName,
  };
}
