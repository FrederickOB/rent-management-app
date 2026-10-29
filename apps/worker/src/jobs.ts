import { sql, withCompany, withSystem, type Database } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { AlertPort } from '@rent/integrations';
import type { ApprovalsService } from '@rent/server/approvals';
import type { AuditService } from '@rent/server/audit';
import type { AppConfig, Clock } from '@rent/server/core';
import type { DocumentsService } from '@rent/server/documents';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { z } from 'zod';

export interface WorkerDeps {
  readonly database: Database;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly alerts: AlertPort;
  readonly audit: AuditService;
  readonly approvals: ApprovalsService;
  readonly documents: DocumentsService;
}

const companyDay = z.object({
  companyId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const nothing = z.object({}).passthrough();

const today = (clock: Clock) => toIsoDate(businessDateOf(instantFrom(clock.now())));

async function companyIds(database: Database): Promise<string[]> {
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ id: string }>(sql`select id from app.company_ids() as id`),
  );
  return result.rows.map((r) => r.id);
}

async function platformCompanyId(database: Database): Promise<string | null> {
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
  );
  return result.rows[0]?.id ?? null;
}

/** A scheduler that enqueues one company job per company (ADR-002 system path). */
export function fanOut(
  name: string,
  cron: string,
  target: string,
  deps: WorkerDeps,
): JobDefinition<Record<string, unknown>> {
  return defineJob({
    name,
    scope: 'system',
    cron,
    schema: nothing,
    retry: { limit: 3, delaySeconds: 60, backoff: true },
    async handle(_payload, ctx) {
      const date = today(deps.clock);
      for (const companyId of await companyIds(deps.database)) {
        await ctx.enqueue(
          target,
          { companyId, date },
          { singletonKey: `${target}:${companyId}:${date}` },
        );
      }
    },
  });
}

/** The M1 job catalogue (architecture section 10). */
export function workerJobs(deps: WorkerDeps): JobDefinition<never>[] {
  const jobs: JobDefinition<never>[] = [
    fanOut('audit.verify-chains', '0 1 * * *', 'audit.verify-chain', deps),
    defineJob({
      name: 'audit.verify-chain',
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }, ctx) {
        const result = await deps.audit.verifyChain(companyId);
        const anchorsMatch = await deps.audit.anchorsMatch(companyId);
        const ok = result.ok && anchorsMatch;
        if (!ok) {
          await deps.alerts.raise({
            severity: 'critical',
            code: 'audit.chain_broken',
            message: 'An audit chain failed verification',
            context: {
              companyId,
              firstBadSeq: result.firstBadSeq,
              problem:
                result.problem ?? (anchorsMatch ? null : 'an anchored head no longer matches'),
            },
          });
        }
        // Each run is itself evidence, recorded in the platform company's chain.
        const platform = await platformCompanyId(deps.database);
        if (platform) {
          await withCompany(
            deps.database,
            { companyId: platform, actorKind: 'system', requestId: `job:${ctx.jobId}` },
            (tx) =>
              deps.audit.append(tx, {
                companyId: platform,
                action: 'audit.chain_verified',
                recordType: 'company',
                recordId: companyId,
                data: { date, ok, events: result.events, firstBadSeq: result.firstBadSeq },
              }),
          );
        }
      },
    }),
    fanOut('audit.anchor-heads', '30 1 * * *', 'audit.anchor-head', deps),
    defineJob({
      name: 'audit.anchor-head',
      scope: 'company',
      schema: companyDay,
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }) {
        const retention = await deps.documents.evidenceRetention('GH');
        const result = await deps.audit.anchorHead(companyId, date, {
          bucket: deps.config.S3_BUCKET_EVIDENCE,
          retainUntil: retention.retainUntil,
          mode: retention.mode,
        });
        if (result && !result.earlierAnchorsMatch) {
          await deps.alerts.raise({
            severity: 'critical',
            code: 'audit.anchor_mismatch',
            message: 'An anchored audit head no longer matches the chain',
            context: { companyId },
          });
        }
      },
    }),
    fanOut('approvals.expire-requests', '5 * * * *', 'approvals.expire-company', deps),
    defineJob({
      name: 'approvals.expire-company',
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      async handle(_payload, ctx) {
        const closed = await ctx.withCompany((tx) => deps.approvals.expireDue(tx));
        if (closed > 0) ctx.logger.info({ closed }, 'approval requests expired');
      },
    }),
  ] as JobDefinition<never>[];
  return jobs;
}
