import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { UPLOADS_SCAN_JOB } from '@rent/server/documents';
import { z } from 'zod';
import type { WorkerDeps } from './jobs';

/** Outbox event types the upload jobs consume (M11 decision 6). */
export const UPLOADS_EVENT_TYPES = [UPLOADS_SCAN_JOB] as const;

const uuid = z.string().uuid();

/**
 * M11 decision 6 (plan 4.14): every upload is scanned for malware before anyone but its uploader
 * may open it. Queued through the outbox in the transaction that records the upload, keyed by
 * document: a document already scanned (as it was staged, or by an earlier run) is not scanned
 * again. An infected one is quarantined (kept, never served) and raises a critical alert with ids
 * only. While the scanner cannot say, the job retries with backoff and then dead-letters, which
 * alerts too; the file stays pending, so it is never served meanwhile.
 */
export function uploadsJobs(deps: WorkerDeps): JobDefinition<never>[] {
  return [
    defineJob({
      name: UPLOADS_SCAN_JOB,
      // A bulk import or a burst of photos fills this queue: no pause between jobs.
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, documentId: uuid }).passthrough(),
      retry: { limit: 8, delaySeconds: 30, backoff: true },
      async handle({ companyId, documentId }, ctx) {
        const result = await deps.documents.scanUpload(companyId, documentId);
        if (!result) return;
        if (result.status === 'infected')
          await deps.alerts.raise({
            severity: 'critical',
            code: 'uploads.infected',
            message:
              'An upload was found to contain malware. It is quarantined: kept, and never served to anyone.',
            context: { companyId, documentId, kind: result.kind, engine: result.engine },
          });
        if (result.scanned)
          ctx.logger.info({ documentId, status: result.status }, 'upload scanned');
      },
    }),
  ] as JobDefinition<never>[];
}
