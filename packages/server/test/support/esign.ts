import { asc, eq, schema, sql, withCompany } from '@rent/db';
import type { PdfRender } from '../../src/documents/documents.service';
import { DOCUMENT_RENDERED_EVENT } from '../../src/documents/documents.service';
import {
  SIGNING_COMPLETED_EVENT,
  SIGNING_DECLINED_EVENT,
  SIGNING_FINALISE_JOB,
} from '../../src/esign/esign.service';
import type { ClientInfo } from '../../src/esign/esign.types';
import type { ServerTestContext } from './index';
import { deliverMessages, type TenancyServices } from './tenancy';

/** A phone's browser, as apps/links reports it to the links API. */
export const PHONE: ClientInfo = {
  ip: '203.0.113.10',
  userAgent: 'Mozilla/5.0 (Linux; Android 13; TECNO) Mobile Safari/537.36',
};

const TOKEN = /\/l\/([A-Za-z0-9_-]{43})/;

/** The link token in a message body or URL. */
export function tokenIn(text: string | undefined): string {
  const token = text ? TOKEN.exec(text)?.[1] : undefined;
  if (!token) throw new Error('no link in the message');
  return token;
}

/**
 * Does what the worker does for e-signing, in order, until nothing is left: renders the PDFs
 * asked for, opens requests on documents.rendered, finalises on esign.finalise, routes
 * signing.completed and signing.declined to the lease lifecycle, and sends queued messages.
 */
export class EsignWorker {
  private readonly done = new Set<string>();
  /** Every certificate HTML rendered, newest last. */
  readonly certificates: string[] = [];

  constructor(
    private readonly ctx: ServerTestContext,
    private readonly s: TenancyServices,
    private readonly renderPdf: PdfRender,
  ) {}

  private readonly render: PdfRender = async (html) => {
    if (html.includes('<title>Signing certificate</title>')) this.certificates.push(html);
    return this.renderPdf(html);
  };

  async run(companyId: string): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      let worked = false;
      const pending = await withCompany(
        this.ctx.database,
        { companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ id: schema.documentRenderRequest.id })
            .from(schema.documentRenderRequest)
            .where(eq(schema.documentRenderRequest.status, 'pending')),
      );
      for (const r of pending) {
        await this.s.documents.renderRequested(companyId, r.id, this.render);
        worked = true;
      }
      const events = await withCompany(
        this.ctx.database,
        { companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({
              id: schema.outboxEvent.id,
              type: schema.outboxEvent.type,
              payload: schema.outboxEvent.payload,
            })
            .from(schema.outboxEvent)
            .where(
              sql`${schema.outboxEvent.type} in (${DOCUMENT_RENDERED_EVENT}, ${SIGNING_FINALISE_JOB}, ${SIGNING_COMPLETED_EVENT}, ${SIGNING_DECLINED_EVENT})`,
            )
            .orderBy(asc(schema.outboxEvent.createdAt), asc(schema.outboxEvent.id)),
      );
      for (const e of events) {
        if (this.done.has(e.id)) continue;
        this.done.add(e.id);
        worked = true;
        const p = e.payload as Record<string, string>;
        switch (e.type) {
          case DOCUMENT_RENDERED_EVENT:
            await this.s.esign.onDocumentRendered(companyId, p.renderRequestId!);
            break;
          case SIGNING_FINALISE_JOB:
            await this.s.esign.finalise(companyId, p.signingRequestId!, this.render);
            break;
          case SIGNING_COMPLETED_EVENT:
            await this.s.lifecycle.onSigningCompleted(companyId, {
              leaseId: p.leaseId!,
              signingRequestId: p.signingRequestId!,
              completedAt: new Date(p.completedAt!),
              finalDocumentId: p.finalDocumentId!,
            });
            break;
          case SIGNING_DECLINED_EVENT:
            await this.s.lifecycle.onSigningDeclined(companyId, {
              leaseId: p.leaseId!,
              signingRequestId: p.signingRequestId!,
            });
            break;
        }
      }
      await deliverMessages(this.ctx, this.s, companyId);
      if (!worked) return;
    }
    throw new Error('the e-signing work did not settle');
  }

  /** Forgets that an event was handled, so a test can replay it as a late delivery. */
  forget(eventId: string): void {
    this.done.delete(eventId);
  }
}
