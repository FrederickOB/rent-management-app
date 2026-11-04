import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  lt,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  formatTicketNumber,
  type MaintenanceSource,
  type MaintenanceAttachmentKind,
} from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import { notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';

export interface ReportedJob {
  readonly jobId: string;
  readonly ticketNumber: number;
  readonly ticket: string;
  /** False when this report had been recorded already (a retried job): no second ticket. */
  readonly created: boolean;
}

export interface MaintenanceJobView {
  readonly id: string;
  readonly ticket: string;
  readonly ticketNumber: number;
  readonly status: 'reported';
  readonly source: MaintenanceSource;
  readonly description: string;
  readonly property: { readonly id: string; readonly name: string };
  readonly unit: { readonly id: string; readonly code: string } | null;
  readonly tenant: { readonly id: string; readonly name: string } | null;
  readonly leaseId: string | null;
  readonly conversationId: string | null;
  readonly attachmentCount: number;
  readonly createdAt: Date;
}

/**
 * Maintenance jobs in their first state (CM-04 stub; M6 decision 12). `report` makes the job with
 * a ticket number per company and the media its messages carried; media copied later joins it as
 * it arrives. M8 builds triage, assignment and the board on the same table.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  /**
   * Records a reported repair in the caller's transaction. Idempotent by its first message: a
   * retried job answers the ticket it already made (plan section 6, CM-04).
   */
  async report(
    tx: Tx,
    companyId: string,
    input: {
      readonly propertyId: string;
      readonly unitId: string | null;
      readonly leaseId: string | null;
      readonly tenantId: string | null;
      readonly source: MaintenanceSource;
      readonly description: string;
      readonly conversationId: string | null;
      readonly messageIds: readonly string[];
      readonly reportedBy: string | null;
    },
  ): Promise<ReportedJob> {
    const first = input.messageIds[0] ?? null;
    const inserted = await tx
      .insert(schema.maintenanceJob)
      .values({
        companyId,
        propertyId: input.propertyId,
        unitId: input.unitId,
        leaseId: input.leaseId,
        tenantId: input.tenantId,
        source: input.source,
        description:
          input.description.trim().slice(0, 4000) || 'Reported with a photo, video or voice note',
        conversationId: input.conversationId,
        sourceMessageId: first,
        sourceMessageIds: [...input.messageIds],
        reportedBy: input.reportedBy,
      })
      .onConflictDoNothing()
      .returning({
        id: schema.maintenanceJob.id,
        ticketNumber: schema.maintenanceJob.ticketNumber,
      });
    const row =
      inserted[0] ??
      (
        await tx
          .select({
            id: schema.maintenanceJob.id,
            ticketNumber: schema.maintenanceJob.ticketNumber,
          })
          .from(schema.maintenanceJob)
          .where(
            eq(
              schema.maintenanceJob.sourceMessageId,
              first ?? '00000000-0000-0000-0000-000000000000',
            ),
          )
      )[0];
    if (!row) throw new Error('repair report not recorded');
    if (inserted[0] && input.messageIds.length > 0) {
      const stored = await tx
        .select()
        .from(schema.messageAttachment)
        .where(
          and(
            inArray(schema.messageAttachment.messageId, [...input.messageIds]),
            eq(schema.messageAttachment.status, 'stored'),
          ),
        );
      for (const a of stored) await this.attach(tx, companyId, row.id, input.propertyId, a);
    }
    return {
      jobId: row.id,
      ticketNumber: row.ticketNumber,
      ticket: formatTicketNumber(row.ticketNumber),
      created: inserted.length > 0,
    };
  }

  /** Media copied after the report was made joins the jobs made from its message. */
  async attachLate(
    tx: Tx,
    companyId: string,
    attachment: typeof schema.messageAttachment.$inferSelect,
  ): Promise<number> {
    if (attachment.status !== 'stored') return 0;
    const jobs = await tx
      .select({ id: schema.maintenanceJob.id, propertyId: schema.maintenanceJob.propertyId })
      .from(schema.maintenanceJob)
      .where(
        sql`${schema.maintenanceJob.sourceMessageIds} @> array[${attachment.messageId}]::uuid[]`,
      );
    for (const job of jobs) await this.attach(tx, companyId, job.id, job.propertyId, attachment);
    return jobs.length;
  }

  private async attach(
    tx: Tx,
    companyId: string,
    jobId: string,
    propertyId: string,
    a: typeof schema.messageAttachment.$inferSelect,
  ): Promise<void> {
    if (!a.documentId) return;
    const kind =
      a.kind === 'sticker' ? 'image' : (a.kind as 'image' | 'video' | 'audio' | 'document');
    await tx
      .insert(schema.maintenanceJobAttachment)
      .values({
        companyId,
        propertyId,
        jobId,
        documentId: a.documentId,
        kind,
        messageAttachmentId: a.id,
      })
      .onConflictDoNothing();
  }

  async list(
    actor: Actor | null,
    filter: { propertyId?: string; tenantId?: string; cursor?: string; limit: number },
  ): Promise<{ items: MaintenanceJobView[]; nextCursor: string | null }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.view');
    await this.entitlements.assert(staff.companyId, 'maintenance');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.maintenanceJob)
        .where(
          and(
            filter.propertyId ? eq(schema.maintenanceJob.propertyId, filter.propertyId) : undefined,
            filter.tenantId ? eq(schema.maintenanceJob.tenantId, filter.tenantId) : undefined,
            filter.cursor
              ? lt(schema.maintenanceJob.ticketNumber, Number(filter.cursor))
              : undefined,
          ),
        )
        .orderBy(desc(schema.maintenanceJob.ticketNumber))
        .limit(filter.limit + 1);
      const page = rows.slice(0, filter.limit);
      return {
        items: await this.views(tx, page),
        nextCursor: rows.length > filter.limit ? String(page.at(-1)!.ticketNumber) : null,
      };
    });
  }

  async get(actor: Actor | null, jobId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.view');
    await this.entitlements.assert(staff.companyId, 'maintenance');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.maintenanceJob)
        .where(eq(schema.maintenanceJob.id, jobId));
      if (!row) throw notFound('Repair');
      const [view] = await this.views(tx, [row]);
      const attachments = await tx
        .select({
          id: schema.maintenanceJobAttachment.id,
          kind: schema.maintenanceJobAttachment.kind,
          contentType: schema.document.contentType,
          createdAt: schema.maintenanceJobAttachment.createdAt,
        })
        .from(schema.maintenanceJobAttachment)
        .innerJoin(
          schema.document,
          and(
            eq(schema.document.companyId, schema.maintenanceJobAttachment.companyId),
            eq(schema.document.id, schema.maintenanceJobAttachment.documentId),
          ),
        )
        .where(eq(schema.maintenanceJobAttachment.jobId, jobId));
      return {
        ...view!,
        attachments: attachments.map((a) => ({ ...a, kind: a.kind as MaintenanceAttachmentKind })),
      };
    });
  }

  async attachmentDownload(actor: Actor | null, jobId: string, attachmentId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.view');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ documentId: schema.maintenanceJobAttachment.documentId })
        .from(schema.maintenanceJobAttachment)
        .where(
          and(
            eq(schema.maintenanceJobAttachment.id, attachmentId),
            eq(schema.maintenanceJobAttachment.jobId, jobId),
          ),
        );
      return row?.documentId ?? null;
    });
    const url = documentId ? await this.documents.downloadUrl(staff.companyId, documentId) : null;
    if (!url) throw notFound('Attachment');
    return { url, expiresAt: new Date(Date.now() + 300_000) };
  }

  private async views(
    tx: Tx,
    rows: (typeof schema.maintenanceJob.$inferSelect)[],
  ): Promise<MaintenanceJobView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const facts = await tx.execute<{
      id: string;
      property_name: string;
      unit_code: string | null;
      tenant_name: string | null;
      attachments: number;
    }>(sql`
      select j.id, p.name as property_name, u.code as unit_code, t.display_name as tenant_name,
             (select count(*)::int from maintenance_job_attachment a where a.company_id = j.company_id and a.job_id = j.id) as attachments
      from maintenance_job j
      join property p on p.company_id = j.company_id and p.id = j.property_id
      left join unit u on u.company_id = j.company_id and u.id = j.unit_id
      left join tenant t on t.company_id = j.company_id and t.id = j.tenant_id
      where j.id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const byId = new Map(facts.rows.map((f) => [f.id, f]));
    return rows.map((r) => {
      const f = byId.get(r.id);
      return {
        id: r.id,
        ticket: formatTicketNumber(r.ticketNumber),
        ticketNumber: r.ticketNumber,
        status: 'reported',
        source: r.source as MaintenanceSource,
        description: r.description,
        property: { id: r.propertyId, name: f?.property_name ?? '' },
        unit: r.unitId ? { id: r.unitId, code: f?.unit_code ?? '' } : null,
        tenant: r.tenantId ? { id: r.tenantId, name: f?.tenant_name ?? '' } : null,
        leaseId: r.leaseId,
        conversationId: r.conversationId,
        attachmentCount: f?.attachments ?? 0,
        createdAt: r.createdAt,
      };
    });
  }
}
