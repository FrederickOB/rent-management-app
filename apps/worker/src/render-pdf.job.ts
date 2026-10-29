import { eq, schema } from '@rent/db';
import { renderTemplateHtml, sha256Hex, type Branding } from '@rent/documents';
import { PdfRenderer } from '@rent/documents/render';
import type { StoragePort } from '@rent/integrations';
import { RENDER_PDF_JOB } from '@rent/server/documents';
import { defineJob } from '@rent/server/jobs';
import { z } from 'zod';
import type { WorkerDeps } from './jobs';

let renderer: Promise<PdfRenderer> | null = null;
/** One warm Chromium pool per worker process (ADR-006). */
const pool = () => (renderer ??= PdfRenderer.launch({ poolSize: 2 }));

export async function closeRenderer(): Promise<void> {
  if (renderer) await (await renderer).close();
  renderer = null;
}

/**
 * Renders a frozen template and data snapshot to PDF, fingerprints the bytes, and stores them
 * write-once with the retention from the rules table (ADR-006, CLAUDE.md section 6).
 */
export function renderPdfJob(deps: WorkerDeps & { storage: StoragePort }) {
  return defineJob({
    name: RENDER_PDF_JOB,
    scope: 'company',
    schema: z
      .object({ companyId: z.string().uuid(), renderRequestId: z.string().uuid() })
      .passthrough(),
    retry: { limit: 5, delaySeconds: 30, backoff: true },
    async handle({ companyId, renderRequestId }, ctx) {
      const loaded = await ctx.withCompany(async (tx) => {
        const [request] = await tx
          .select()
          .from(schema.documentRenderRequest)
          .where(eq(schema.documentRenderRequest.id, renderRequestId));
        const [company] = await tx
          .select()
          .from(schema.company)
          .where(eq(schema.company.id, companyId));
        return { request, company };
      });
      const { request, company } = loaded;
      if (!request || !company) throw new Error('Render request or company not found');
      if (request.status === 'rendered') return; // a retry after success

      const branding: Branding = {
        senderName: company.senderName,
        primaryColour: company.primaryColour,
        accentColour: company.accentColour,
      };
      const html = renderTemplateHtml(
        request.templateKey,
        request.templateVersion,
        request.data,
        branding,
      );
      const pdf = await (await pool()).render(html);
      const sha256 = sha256Hex(pdf);
      const retention = await deps.documents.evidenceRetention(company.countryCode);
      const key = `documents/${companyId}/${renderRequestId}.pdf`;
      const stored = await deps.storage.putWriteOnce({
        bucket: deps.config.S3_BUCKET_EVIDENCE,
        key,
        body: pdf,
        contentType: 'application/pdf',
        retainUntil: retention.retainUntil,
        mode: retention.mode,
      });
      if (stored.sha256 !== sha256) throw new Error('Stored bytes do not match the rendered PDF');

      await ctx.withCompany(async (tx) => {
        const documentId = await deps.documents.insertDocument(tx, {
          companyId,
          kind: 'pdf',
          contentType: 'application/pdf',
          bytes: pdf,
          bucket: deps.config.S3_BUCKET_EVIDENCE,
          storageKey: key,
          storageVersionId: stored.versionId,
          writeOnce: true,
          retentionMode: retention.mode,
          retainUntil: retention.retainUntil,
          templateKey: request.templateKey,
          templateVersion: request.templateVersion,
          dataSnapshot: request.data as Record<string, unknown>,
          createdBy: request.requestedBy,
        });
        await tx
          .update(schema.documentRenderRequest)
          .set({
            status: 'rendered',
            documentId,
            attempts: request.attempts + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.documentRenderRequest.id, renderRequestId));
      });
    },
  });
}
