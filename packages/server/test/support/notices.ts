import { asc, schema, sql, withCompany } from '@rent/db';
import type { PdfRender } from '../../src/documents/documents.service';
import { DOCUMENT_RENDERED_EVENT } from '../../src/documents/documents.service';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { NOTICE_SIGNING_EVENT, SIGNING_FINALISE_JOB } from '../../src/esign/esign.service';
import {
  MESSAGE_NOT_SENT_EVENT,
  NOTICE_DELIVERY_STATUS_JOB,
} from '../../src/messaging/messaging.service';
import { NoticeAcknowledgementsService } from '../../src/notices/acknowledgements.service';
import { NoticesService } from '../../src/notices/notices.service';
import { NOTICE_ESCALATE_JOB } from '../../src/notices/records';
import { TenantNoticesService } from '../../src/notices/tenant-notices.service';
import { NoticeTrackingService } from '../../src/notices/tracking.service';
import { TasksService } from '../../src/tasks/tasks.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import type { TenancyServices } from './tenancy';

/** The M7 services wired as Nest wires them, on the test database (CLAUDE.md section 12). */
export function noticesServices(ctx: ServerTestContext, s: TenancyServices, b: BillingServices) {
  const entitlements = new EntitlementsService(ctx.database, s.policy);
  const tasks = new TasksService(ctx.database, s.policy, ctx.clock);
  const notices = new NoticesService(
    ctx.database,
    ctx.clock,
    ctx.config,
    s.policy,
    entitlements,
    s.approvals,
    s.rules,
    s.documents,
    s.esign,
    tasks,
    s.tenants,
    b.read,
    ctx.audit,
  );
  notices.onModuleInit();
  const tracking = new NoticeTrackingService(
    ctx.database,
    ctx.clock,
    s.documents,
    s.esign,
    tasks,
    s.approvals,
    ctx.audit,
  );
  const acks = new NoticeAcknowledgementsService(
    ctx.database,
    ctx.clock,
    s.policy,
    entitlements,
    s.documents,
    s.rules,
    ctx.audit,
  );
  const tenantNotices = new TenantNoticesService(ctx.database, s.policy, s.documents);
  return { entitlements, tasks, notices, tracking, acks, tenantNotices };
}

export type NoticesServices = ReturnType<typeof noticesServices>;

/**
 * Does what the worker does for notices, in order, until nothing is left: renders the PDFs asked
 * for, opens the requests and sends the links on documents.rendered, records the engine's notice
 * events, finalises acknowledgements, escalates, records delivery reports and withheld channels,
 * and sends queued messages.
 */
export class NoticesWorker {
  private readonly done = new Set<string>();
  /**
   * The `messaging.send` events this worker has run. Each runs once, as the job queue runs it:
   * `deliver` settles every message it is given (sent, not sent or failed) or throws, so running
   * an event again does nothing but cost a transaction. deliverMessages() runs every event of the
   * company on every call, which grows with each test in a file (the M7 review's timing finding).
   */
  private readonly sent = new Set<string>();

  constructor(
    private readonly ctx: ServerTestContext,
    private readonly s: TenancyServices,
    private readonly n: NoticesServices,
    private readonly render: PdfRender,
  ) {}

  async run(companyId: string): Promise<void> {
    for (let round = 0; round < 30; round += 1) {
      let worked = false;
      const pending = await withCompany(
        this.ctx.database,
        { companyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ id: schema.documentRenderRequest.id })
            .from(schema.documentRenderRequest)
            .where(sql`${schema.documentRenderRequest.status} = 'pending'`),
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
              sql`${schema.outboxEvent.type} in (${DOCUMENT_RENDERED_EVENT}, ${SIGNING_FINALISE_JOB}, ${NOTICE_SIGNING_EVENT}, ${NOTICE_ESCALATE_JOB}, ${NOTICE_DELIVERY_STATUS_JOB}, ${MESSAGE_NOT_SENT_EVENT})`,
            )
            .orderBy(asc(schema.outboxEvent.createdAt), asc(schema.outboxEvent.id)),
      );
      for (const e of events) {
        if (this.done.has(e.id)) continue;
        this.done.add(e.id);
        worked = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = e.payload as any;
        switch (e.type) {
          case DOCUMENT_RENDERED_EVENT:
            await this.s.esign.onDocumentRendered(companyId, p.renderRequestId);
            await this.n.tracking.onDocumentRendered(companyId, p.renderRequestId);
            break;
          case SIGNING_FINALISE_JOB:
            await this.s.esign.finalise(companyId, p.signingRequestId, this.render);
            break;
          case NOTICE_SIGNING_EVENT:
            await this.n.tracking.onSigningEvent(companyId, p);
            break;
          case NOTICE_ESCALATE_JOB:
            await this.n.tracking.escalate(companyId, p.noticeId);
            break;
          case NOTICE_DELIVERY_STATUS_JOB:
            await this.n.tracking.onDeliveryStatus(companyId, p);
            break;
          case MESSAGE_NOT_SENT_EVENT:
            await this.n.tracking.onMessageNotSent(companyId, p);
            break;
        }
      }
      // Sending can record new outbox events (a channel not sent), so a round that sent more goes on.
      const sends = await withCompany(this.ctx.database, { companyId, actorKind: 'system' }, (tx) =>
        tx
          .select({ id: schema.outboxEvent.id, payload: schema.outboxEvent.payload })
          .from(schema.outboxEvent)
          .where(sql`${schema.outboxEvent.type} = ${MESSAGE_SEND_JOB}`)
          .orderBy(asc(schema.outboxEvent.createdAt), asc(schema.outboxEvent.id)),
      );
      for (const e of sends) {
        if (this.sent.has(e.id)) continue;
        // A throw is a failed send: it propagates, and the event runs again next time, as a retry.
        await this.s.messaging.deliver(companyId, messageRequestSchema.parse(e.payload));
        this.sent.add(e.id);
        worked = true;
      }
      if (!worked) return;
    }
    throw new Error('the notices work did not settle');
  }
}
