import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { SIGNER_ROLE_LABELS, type SignerRole } from '@rent/domain/esign';
import type { InspectionCondition } from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import { InspectionsService } from '../maintenance/inspections.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { LeaseSigningService } from '../tenancy/lease-signing.service';

export const MOVE_IN_REPORT_TEMPLATE = { key: 'inspection.move-in', version: 1 } as const;
/** Offered from lease signing until this many days after the start; later, with a warning. */
export const MOVE_IN_REPORT_DAYS = 14;

export interface MoveInReportView {
  readonly inspectionId: string;
  readonly leaseId: string;
  readonly status: 'rendering' | 'pending' | 'completed' | 'cancelled';
  readonly sha256: string | null;
  readonly signedSha256: string | null;
  readonly signers: readonly {
    readonly id: string;
    readonly name: string;
    readonly roleLabel: string;
    readonly status: 'pending' | 'signed' | 'declined';
    readonly signedAt: Date | null;
  }[];
  readonly late: boolean;
}

/**
 * The move-in report (TL-08; M8 decision 11 and plan 4.7): a submitted move-in inspection frozen
 * as a PDF, with photo thumbnails the renderer reads by document id, and signed by every tenant
 * party and the landlord's representative on the e-sign engine (subject `move_in_report`,
 * `all_required`, consent `move_in_report.v1`). The full photos stay linked by fingerprint.
 */
@Injectable()
export class MoveInReportService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(InspectionsService) private readonly inspections: InspectionsService,
    @Inject(LeaseSigningService) private readonly signing: LeaseSigningService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `inspection.render-report`: freezes the report and opens its signing request, once per
   * inspection however often the job runs. The e-sign engine sends the links once it is rendered.
   */
  async render(
    companyId: string,
    inspectionId: string,
    requestedBy: string | null,
  ): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [existing] = await tx
        .select({ id: schema.signingRequest.id })
        .from(schema.signingRequest)
        .where(
          and(
            eq(schema.signingRequest.inspectionId, inspectionId),
            ne(schema.signingRequest.status, 'cancelled'),
          ),
        );
      if (existing) return false;
      const { inspection, items, photos } = await this.inspections.contents(tx, inspectionId);
      if (inspection.kind !== 'move_in' || inspection.status !== 'submitted' || !inspection.leaseId)
        return false;
      const company = await companyRecord(tx, companyId);
      const [lease] = await tx
        .select({ startDate: schema.lease.startDate, tenantId: schema.lease.tenantId })
        .from(schema.lease)
        .where(eq(schema.lease.id, inspection.leaseId));
      const [facts] = await tx
        .select({ code: schema.unit.code, propertyName: schema.property.name })
        .from(schema.unit)
        .innerJoin(
          schema.property,
          and(
            eq(schema.property.companyId, schema.unit.companyId),
            eq(schema.property.id, schema.unit.propertyId),
          ),
        )
        .where(eq(schema.unit.id, inspection.unitId));
      const [tenant] = await tx
        .select({ name: schema.tenant.displayName })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, lease!.tenantId));
      const [inspector] = inspection.performedBy
        ? await tx
            .select({ name: schema.person.name })
            .from(schema.person)
            .where(eq(schema.person.id, inspection.performedBy))
        : [];
      const renderRequestId = await this.documents.requestRender(tx, {
        companyId,
        templateKey: MOVE_IN_REPORT_TEMPLATE.key,
        templateVersion: MOVE_IN_REPORT_TEMPLATE.version,
        data: {
          title: `Move-in report, ${facts!.code}`,
          reference: facts!.code,
          inspectionId,
          submittedAt: inspection.submittedAt!.toISOString(),
          timeZone: company?.timeZone ?? 'Africa/Accra',
          landlord: { name: company?.displayName ?? 'Landlord' },
          tenant: { name: tenant?.name ?? 'Tenant' },
          unit: { code: facts!.code, propertyName: facts!.propertyName },
          leaseStart: lease!.startDate,
          inspectedBy: inspector?.name ?? null,
          items: items.map((i) => ({
            roomLabel: i.roomLabel,
            itemLabel: i.itemLabel,
            condition: i.condition as InspectionCondition,
            note: i.note,
            photos: photos
              .filter((p) => p.itemId === i.id)
              .slice(0, 20)
              .map((p) => ({
                documentId: p.documentId,
                sha256: p.sha256,
                takenAt: p.takenAt.toISOString(),
              })),
          })),
        },
        requestedBy,
      });
      await this.esign.openMoveInReportRequest(tx, {
        companyId,
        propertyId: inspection.propertyId,
        tenantId: lease!.tenantId,
        leaseId: inspection.leaseId,
        inspectionId,
        renderRequestId,
        createdBy: requestedBy,
        signers: await this.signing.moveInReportSigners(
          tx,
          inspection.leaseId,
          inspection.performedBy ?? requestedBy,
        ),
      });
      return true;
    });
  }

  /** The report and its signing for an inspection, in the caller's transaction. */
  async forInspection(tx: Tx, inspectionId: string): Promise<MoveInReportView | null> {
    const [request] = await tx
      .select()
      .from(schema.signingRequest)
      .where(eq(schema.signingRequest.inspectionId, inspectionId))
      .orderBy(desc(schema.signingRequest.createdAt))
      .limit(1);
    const [inspection] = await tx
      .select({ leaseId: schema.inspection.leaseId, submittedAt: schema.inspection.submittedAt })
      .from(schema.inspection)
      .where(eq(schema.inspection.id, inspectionId));
    if (!inspection?.leaseId) return null;
    const [lease] = await tx
      .select({ startDate: schema.lease.startDate })
      .from(schema.lease)
      .where(eq(schema.lease.id, inspection.leaseId));
    const late =
      !!lease &&
      !!inspection.submittedAt &&
      inspection.submittedAt.toISOString().slice(0, 10) >
        toIsoDate(addDays(parseBusinessDate(lease.startDate), MOVE_IN_REPORT_DAYS));
    if (!request)
      return {
        inspectionId,
        leaseId: inspection.leaseId,
        status: 'rendering',
        sha256: null,
        signedSha256: null,
        signers: [],
        late,
      };
    const signers = await tx
      .select()
      .from(schema.signer)
      .where(eq(schema.signer.signingRequestId, request.id))
      .orderBy(schema.signer.position);
    const status =
      request.status === 'preparing'
        ? 'rendering'
        : request.status === 'completed'
          ? 'completed'
          : request.status === 'pending'
            ? 'pending'
            : 'cancelled';
    return {
      inspectionId,
      leaseId: inspection.leaseId,
      status,
      sha256: request.documentSha256,
      signedSha256: request.finalSha256,
      signers: signers.map((s) => ({
        id: s.id,
        name: s.name,
        roleLabel: SIGNER_ROLE_LABELS[s.signerRole as SignerRole],
        status: s.status as 'pending' | 'signed' | 'declined',
        signedAt: s.signedAt,
      })),
      late,
    };
  }

  /** GET /leases/{id}/move-in-report: the lease's latest move-in report. */
  async forLease(actor: Actor | null, leaseId: string): Promise<MoveInReportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.read');
    const view = await withCompany(this.database, staffContext(staff), async (tx) => {
      const inspection = await this.inspections.latestMoveIn(tx, leaseId);
      return inspection ? this.forInspection(tx, inspection.id) : null;
    });
    if (!view) throw notFound('Move-in report');
    return view;
  }

  /** A short-lived link: the signed copy once everyone signed, else the frozen report. */
  async downloadUrl(actor: Actor | null, leaseId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.read');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [request] = await tx
        .select({
          finalDocumentId: schema.signingRequest.finalDocumentId,
          documentId: schema.signingRequest.documentId,
        })
        .from(schema.signingRequest)
        .where(
          and(
            eq(schema.signingRequest.leaseId, leaseId),
            eq(schema.signingRequest.subjectType, 'move_in_report'),
            ne(schema.signingRequest.status, 'cancelled'),
          ),
        )
        .orderBy(desc(schema.signingRequest.createdAt))
        .limit(1);
      return request?.finalDocumentId ?? request?.documentId ?? null;
    });
    const url = documentId ? await this.documents.downloadUrl(staff.companyId, documentId) : null;
    if (!url) throw notFound('Move-in report');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  /** M8: a document the tenant may download: their signed move-in report or final statement. */
  async tenantOwns(tx: Tx, documentId: string): Promise<boolean> {
    const rows = await tx.execute<{ id: string }>(sql`
      select id from signing_request where subject_type = 'move_in_report' and status = 'completed'
        and final_document_id = ${documentId}
      union all
      select id from move_out where statement_document_id = ${documentId}
      limit 1`);
    return rows.rows.length > 0;
  }

  /**
   * GET /me/tenancies/{leaseId}/documents (M8 plan 4.11): the signed lease, the signed move-in
   * report and the final statement, in the tenant's own scoped transaction.
   */
  async tenantTenancyDocuments(
    tx: Tx,
    leaseId: string,
  ): Promise<
    | {
        kind: 'lease' | 'move_in_report' | 'final_statement';
        title: string;
        documentId: string;
        signed: boolean;
        createdAt: Date;
      }[]
    | null
  > {
    const [lease] = await tx
      .select({
        id: schema.lease.id,
        signedDocumentId: schema.lease.signedDocumentId,
        signedAt: schema.lease.signedAt,
      })
      .from(schema.lease)
      .where(eq(schema.lease.id, leaseId));
    if (!lease) return null;
    const out: {
      kind: 'lease' | 'move_in_report' | 'final_statement';
      title: string;
      documentId: string;
      signed: boolean;
      createdAt: Date;
    }[] = [];
    if (lease.signedDocumentId)
      out.push({
        kind: 'lease',
        title: 'Signed lease',
        documentId: lease.signedDocumentId,
        signed: true,
        createdAt: lease.signedAt ?? new Date(0),
      });
    for (const r of await this.tenantDocuments(tx, leaseId))
      if (r.documentId)
        out.push({
          kind: 'move_in_report',
          title: 'Move-in report',
          documentId: r.documentId,
          signed: true,
          createdAt: r.createdAt ?? new Date(0),
        });
    const statements = await tx
      .select({ documentId: schema.moveOut.statementDocumentId, at: schema.moveOut.approvedAt })
      .from(schema.moveOut)
      .where(eq(schema.moveOut.leaseId, leaseId));
    for (const r of statements)
      if (r.documentId)
        out.push({
          kind: 'final_statement',
          title: 'Final statement',
          documentId: r.documentId,
          signed: false,
          createdAt: r.at ?? new Date(0),
        });
    return out;
  }

  /** The tenancy's signed move-in report for the tenant app, in the tenant's scoped transaction. */
  async tenantDocuments(tx: Tx, leaseId: string) {
    return tx
      .select({
        documentId: schema.signingRequest.finalDocumentId,
        createdAt: schema.signingRequest.completedAt,
      })
      .from(schema.signingRequest)
      .where(
        and(
          eq(schema.signingRequest.leaseId, leaseId),
          eq(schema.signingRequest.subjectType, 'move_in_report'),
          eq(schema.signingRequest.status, 'completed'),
        ),
      );
  }
}
