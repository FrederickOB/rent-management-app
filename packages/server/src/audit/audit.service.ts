import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  lt,
  lte,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import type { StoragePort } from '@rent/integrations';
import { createHash } from 'node:crypto';
import type { Clock } from '../core/clock';
import { CLOCK, DATABASE, STORAGE_PORT } from '../core/tokens';

export interface AuditEventInput {
  readonly companyId: string;
  readonly action: string;
  readonly recordType?: string | null;
  readonly recordId?: string | null;
  readonly data?: Record<string, unknown> | null;
}

export interface AuditSearch {
  readonly actorPersonId?: string;
  readonly recordType?: string;
  readonly recordId?: string;
  readonly action?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly before?: number;
  readonly limit: number;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly events: number;
  readonly firstBadSeq: number | null;
  readonly problem: string | null;
  readonly headSeq: number | null;
  readonly headHash: string | null;
}

export interface AnchorResult {
  readonly seq: number;
  readonly hash: string;
  readonly storageKey: string;
  /** False when an earlier anchor no longer matches the chain: rewritten history. */
  readonly earlierAnchorsMatch: boolean;
}

/**
 * The hash-chained audit log (AD-07, CLAUDE.md section 6). Events are written only through the
 * database function audit.append, which computes the chain; this service never writes rows.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Appends a semantic event inside the caller's transaction, which carries the company context. */
  async append(tx: Tx, event: AuditEventInput): Promise<number> {
    const result = await tx.execute<{ seq: number }>(
      sql`select audit.append(${event.companyId}::uuid, ${event.action}, ${event.recordType ?? null}, ${event.recordId ?? null}, ${JSON.stringify(event.data ?? {})}::jsonb) as seq`,
    );
    return Number(result.rows[0]!.seq);
  }

  async search(companyId: string, personId: string, filters: AuditSearch) {
    return withCompany(this.database, { companyId, personId, actorKind: 'staff' }, async (tx) => {
      const e = schema.auditEvent;
      const conditions = [
        filters.actorPersonId ? eq(e.actorPersonId, filters.actorPersonId) : undefined,
        filters.recordType ? eq(e.recordType, filters.recordType) : undefined,
        filters.recordId ? eq(e.recordId, filters.recordId) : undefined,
        filters.action ? eq(e.action, filters.action) : undefined,
        filters.from ? gte(e.occurredAt, filters.from) : undefined,
        filters.to ? lte(e.occurredAt, filters.to) : undefined,
        filters.before ? lt(e.seq, filters.before) : undefined,
      ].filter((c) => c !== undefined);
      const rows = await tx
        .select({
          seq: e.seq,
          occurredAt: e.occurredAt,
          actorPersonId: e.actorPersonId,
          actorName: schema.person.name,
          actorKind: e.actorKind,
          action: e.action,
          recordType: e.recordType,
          recordId: e.recordId,
          data: e.data,
        })
        .from(e)
        .leftJoin(schema.person, eq(schema.person.id, e.actorPersonId))
        .where(and(...conditions))
        .orderBy(desc(e.seq))
        .limit(filters.limit + 1);
      const page = rows.slice(0, filters.limit);
      return {
        events: page,
        nextBefore: rows.length > filters.limit ? (page.at(-1)?.seq ?? null) : null,
      };
    });
  }

  /**
   * The events about a set of records, newest first, in the caller's transaction (timelines,
   * M3). The caller has already decided which records the actor may see.
   */
  async forRecords(
    tx: Tx,
    records: readonly { readonly type: string; readonly id: string }[],
    limit: number,
  ): Promise<
    {
      occurredAt: Date;
      action: string;
      recordType: string | null;
      recordId: string | null;
      actorName: string | null;
      data: Record<string, unknown> | null;
    }[]
  > {
    if (records.length === 0) return [];
    const e = schema.auditEvent;
    const rows = await tx
      .select({
        occurredAt: e.occurredAt,
        action: e.action,
        recordType: e.recordType,
        recordId: e.recordId,
        actorName: schema.person.name,
        data: e.data,
      })
      .from(e)
      .leftJoin(schema.person, eq(schema.person.id, e.actorPersonId))
      .where(
        sql`(${e.recordType}, ${e.recordId}) in (${sql.join(
          records.map((r) => sql`(${r.type}, ${r.id})`),
          sql`, `,
        )})`,
      )
      .orderBy(desc(e.seq))
      .limit(limit);
    return rows.map((r) => ({ ...r, data: (r.data as Record<string, unknown> | null) ?? null }));
  }

  /** Recomputes a company's chain from its first event (nightly job, AD-07). */
  async verifyChain(companyId: string): Promise<ChainVerification> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const result = await tx.execute<{
        ok: boolean;
        events: number;
        first_bad_seq: number | null;
        problem: string | null;
        head_seq: number | null;
        head_hash: Buffer | null;
      }>(sql`select * from audit.verify_chain(${companyId}::uuid)`);
      const row = result.rows[0]!;
      return {
        ok: row.ok,
        events: Number(row.events),
        firstBadSeq: row.first_bad_seq === null ? null : Number(row.first_bad_seq),
        problem: row.problem,
        headSeq: row.head_seq === null ? null : Number(row.head_seq),
        headHash: row.head_hash ? row.head_hash.toString('hex') : null,
      };
    });
  }

  /**
   * Writes the chain head to write-once storage (daily job) and checks every earlier anchor
   * still matches the chain. Someone who rewrites rows and recomputes every hash passes
   * verify_chain, but not this check.
   */
  async anchorHead(
    companyId: string,
    anchorDate: string,
    options: { bucket: string; retainUntil: Date; mode: 'GOVERNANCE' | 'COMPLIANCE' },
  ): Promise<AnchorResult | null> {
    const head = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.auditChainHead)
          .where(eq(schema.auditChainHead.companyId, companyId));
        const existing = await tx
          .select({ id: schema.auditAnchor.id })
          .from(schema.auditAnchor)
          .where(
            and(
              eq(schema.auditAnchor.companyId, companyId),
              eq(schema.auditAnchor.anchorDate, anchorDate),
            ),
          );
        return { row, alreadyAnchored: existing.length > 0 };
      },
    );
    if (!head.row) return null;
    const earlierAnchorsMatch = await this.anchorsMatch(companyId);
    if (head.alreadyAnchored) {
      return {
        seq: head.row.lastSeq,
        hash: head.row.lastHash.toString('hex'),
        storageKey: '',
        earlierAnchorsMatch,
      };
    }

    const hash = head.row.lastHash.toString('hex');
    const body = Buffer.from(
      JSON.stringify({
        companyId,
        seq: head.row.lastSeq,
        hash,
        anchoredAt: this.clock.now().toISOString(),
        hashVersion: 1,
      }),
    );
    const storageKey = `audit-anchors/${anchorDate}/${companyId}.json`;
    const stored = await this.storage.putWriteOnce({
      bucket: options.bucket,
      key: storageKey,
      body,
      contentType: 'application/json',
      retainUntil: options.retainUntil,
      mode: options.mode,
    });
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      await tx.insert(schema.auditAnchor).values({
        companyId,
        anchorDate,
        seq: head.row!.lastSeq,
        hash: head.row!.lastHash,
        storageKey,
        storageVersionId: stored.versionId ?? null,
        objectSha256: createHash('sha256').update(body).digest('hex'),
      });
      await this.append(tx, {
        companyId,
        action: 'audit.head_anchored',
        recordType: 'audit_anchor',
        recordId: anchorDate,
        data: { seq: head.row!.lastSeq, storageKey },
      });
    });
    return { seq: head.row.lastSeq, hash, storageKey, earlierAnchorsMatch };
  }

  /** Every recorded anchor's hash must equal the event hash at its sequence number today. */
  async anchorsMatch(companyId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const result = await tx.execute<{ mismatches: number }>(sql`
        select count(*)::int as mismatches from audit_anchor a
        left join audit_event e on e.company_id = a.company_id and e.seq = a.seq
        where a.company_id = ${companyId}::uuid and (e.hash is null or e.hash <> a.hash)`);
      return Number(result.rows[0]!.mismatches) === 0;
    });
  }
}
