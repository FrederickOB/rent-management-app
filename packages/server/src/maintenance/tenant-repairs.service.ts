import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import type { MaintenanceCategory } from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import { companyRecord } from '../companies/companies.service';
import { AppError, forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import {
  DocumentsService,
  JOB_MEDIA_UPLOAD,
  type StagedMedia,
} from '../documents/documents.service';
import { PolicyService } from '../policy/policy.service';
import { MaintenanceService, type TenantRepairView } from './maintenance.service';
import { TENANT_KIND } from './kinds';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;

/** F2: no files on Starter, refused before anything is stored. */
const filesNotOnPlan = () =>
  new AppError(
    403,
    'repair_files_not_on_plan',
    'Describe the problem in words; your landlord will be in touch about it.',
  );

/**
 * The tenant app's repairs (MI-01, CM-04; decision 3), by landlord (TL-12: never another
 * landlord's). Reads run in the tenant's own scoped transaction; writes check ownership there and
 * then run in the company's system context as the tenant (MaintenanceService).
 */
@Injectable()
export class TenantRepairsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
  ) {}

  async list(actor: Actor | null) {
    const tenant = this.tenantActor(actor);
    const out: {
      landlord: { companyId: string; name: string; timeZone: string };
      filesAllowed: boolean;
      repairs: TenantRepairView[];
    }[] = [];
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const group = await this.inCompany(tenant, companyId, tenantIds, async (tx) => ({
        landlord: await (async () => {
          const company = await companyRecord(tx, companyId);
          return {
            companyId,
            name: company?.displayName ?? '',
            timeZone: company?.timeZone ?? 'Africa/Accra',
          };
        })(),
        repairs: await this.maintenance.tenantRepairs(tx),
      }));
      out.push({
        landlord: group.landlord,
        filesAllowed: await this.maintenance.repairFilesAllowed(companyId),
        repairs: group.repairs,
      });
    }
    return out;
  }

  async createUpload(
    actor: Actor | null,
    input: {
      leaseId: string;
      contentType: string;
      sizeBytes: number;
      durationSeconds?: number | null;
    },
  ) {
    const tenant = this.tenantActor(actor);
    const { companyId } = await this.ownLease(tenant, input.leaseId);
    if (!(await this.maintenance.repairFilesAllowed(companyId))) throw filesNotOnPlan();
    return this.documents.createMediaUpload(
      { companyId, personId: null, actorKind: 'system' },
      tenant.personId,
      JOB_MEDIA_UPLOAD,
      input,
    );
  }

  async report(
    actor: Actor | null,
    input: {
      leaseId: string;
      clientId: string;
      category: MaintenanceCategory;
      description: string;
      emergency: boolean;
      uploadIds: readonly string[];
    },
  ): Promise<TenantRepairView> {
    const tenant = this.tenantActor(actor);
    const { companyId, tenantId } = await this.ownLease(tenant, input.leaseId);
    // A retry with the same client id answers the request it already made (offline queue).
    const existing = await this.inCompany(tenant, companyId, [tenantId], async (tx) => {
      const [row] = await tx
        .select({ id: schema.maintenanceJob.id })
        .from(schema.maintenanceJob)
        .where(
          and(
            eq(schema.maintenanceJob.tenantId, tenantId),
            eq(schema.maintenanceJob.clientId, input.clientId),
          ),
        );
      return row ? (await this.maintenance.tenantViews(tx, [row.id]))[0] : undefined;
    });
    if (existing) return existing;
    // Every state check comes before a file is staged: staged files are kept write-once.
    await this.maintenance.checkTenantReport(companyId, input.leaseId, tenantId);
    if (input.uploadIds.length > 0 && !(await this.maintenance.repairFilesAllowed(companyId)))
      throw filesNotOnPlan();
    const media: StagedMedia[] = [];
    for (const id of new Set(input.uploadIds))
      media.push(
        await this.documents.stageMediaUpload(
          { companyId, personId: null, actorKind: 'system' },
          tenant.personId,
          id,
          JOB_MEDIA_UPLOAD,
        ),
      );
    const view = await this.maintenance.tenantReport(companyId, {
      leaseId: input.leaseId,
      tenantId,
      personId: tenant.personId,
      clientId: input.clientId,
      category: input.category,
      description: input.description,
      emergency: input.emergency,
      media,
    });
    for (const m of media) await this.documents.discardStagedMedia(m);
    return view;
  }

  async respond(
    actor: Actor | null,
    jobId: string,
    input: { response: 'confirmed' | 'disputed'; reason?: string | null },
  ): Promise<TenantRepairView> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const own = await this.inCompany(tenant, companyId, tenantIds, (tx) =>
        this.ownJob(tx, jobId),
      );
      if (!own) continue;
      const view = await this.maintenance.tenantRespond(
        companyId,
        jobId,
        own.tenantId,
        tenant.personId,
        input,
      );
      if (view) return view;
    }
    throw notFound('Repair');
  }

  async attachmentUrl(actor: Actor | null, jobId: string, attachmentId: string) {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const documentId = await this.inCompany(tenant, companyId, tenantIds, async (tx) =>
        (await this.ownJob(tx, jobId))
          ? this.maintenance.tenantAttachmentDocument(tx, jobId, attachmentId)
          : null,
      );
      if (!documentId) continue;
      const url = await this.documents.downloadUrl(companyId, documentId);
      if (url) return { url };
    }
    throw notFound('File');
  }

  private async ownJob(tx: Tx, jobId: string) {
    const [row] = await tx
      .select({ tenantId: schema.maintenanceJob.tenantId })
      .from(schema.maintenanceJob)
      .where(eq(schema.maintenanceJob.id, jobId));
    return row?.tenantId ? { tenantId: row.tenantId } : null;
  }

  private async ownLease(
    tenant: TenantActor,
    leaseId: string,
  ): Promise<{ companyId: string; tenantId: string }> {
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const lease = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const [row] = await tx
          .select({ tenantId: schema.lease.tenantId, status: schema.lease.status })
          .from(schema.lease)
          .where(eq(schema.lease.id, leaseId));
        return row;
      });
      if (lease && !['draft', 'cancelled'].includes(lease.status))
        return { companyId, tenantId: lease.tenantId };
    }
    throw notFound('Tenancy');
  }

  private tenantActor(actor: Actor | null): TenantActor {
    if (!actor || actor.kind !== TENANT_KIND) throw forbidden();
    this.policy.assert(actor, 'tenancy.view_own');
    return actor;
  }

  private async companies(tenant: TenantActor): Promise<Map<string, string[]>> {
    const rows = await withSystem(
      this.database,
      { personId: tenant.personId, actorKind: 'tenant' },
      (tx) =>
        tx.execute<{ company_id: string; tenant_id: string }>(
          sql`select company_id, tenant_id from app.tenancies_for_person(${tenant.personId}::uuid)`,
        ),
    );
    const byCompany = new Map<string, string[]>();
    for (const r of rows.rows)
      byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r.tenant_id]);
    return byCompany;
  }

  private inCompany<T>(
    tenant: TenantActor,
    companyId: string,
    tenantIds: readonly string[],
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return withCompany(
      this.database,
      { companyId, personId: tenant.personId, actorKind: 'tenant', tenantScope: { tenantIds } },
      fn,
    );
  }
}
