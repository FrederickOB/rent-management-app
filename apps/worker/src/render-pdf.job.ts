import { PdfRenderer } from '@rent/documents/render';
import type { StoragePort } from '@rent/integrations';
import { RENDER_PDF_JOB, type PdfRender } from '@rent/server/documents';
import { defineJob } from '@rent/server/jobs';
import { z } from 'zod';
import type { WorkerDeps } from './jobs';

let renderer: Promise<PdfRenderer> | null = null;
/** One warm Chromium pool per worker process (ADR-006). */
const pool = () => (renderer ??= PdfRenderer.launch({ poolSize: 2 }));

/** Renders HTML to PDF on the worker's pool: the render job's and the signing certificate's. */
export const renderOnPool: PdfRender = async (html) => (await pool()).render(html);

export async function closeRenderer(): Promise<void> {
  if (renderer) await (await renderer).close();
  renderer = null;
}

/**
 * Renders a frozen template and data snapshot to PDF, fingerprints the bytes, and stores them
 * write-once with the retention from the rules table (ADR-006, CLAUDE.md section 6). The work is
 * DocumentsService.renderRequested, which also emits documents.rendered for whoever asked.
 */
export function renderPdfJob(deps: WorkerDeps & { storage: StoragePort }) {
  return defineJob({
    name: RENDER_PDF_JOB,
    // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
    drain: true,
    scope: 'company',
    schema: z
      .object({ companyId: z.string().uuid(), renderRequestId: z.string().uuid() })
      .passthrough(),
    retry: { limit: 5, delaySeconds: 30, backoff: true },
    async handle({ companyId, renderRequestId }, ctx) {
      await deps.documents.renderRequested(
        companyId,
        renderRequestId,
        renderOnPool,
        `job:${ctx.jobId}`,
      );
    },
  });
}
