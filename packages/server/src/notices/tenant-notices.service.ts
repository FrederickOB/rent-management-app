import { Inject, Injectable } from '@nestjs/common';
import {
  desc,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { formatNoticeNumber, NOTICE_TYPE_LABELS, type NoticeType } from '@rent/domain/notices';
import type { Actor } from '@rent/domain/policy';
import { companyRecord } from '../companies/companies.service';
import { forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { signsAsTenant } from '../esign/records';
import { PolicyService } from '../policy/policy.service';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;

export interface TenantNoticeView {
  readonly noticeId: string;
  readonly number: string;
  readonly typeLabel: string;
  readonly issuedAt: Date;
  readonly effectiveDate: string | null;
  readonly leaseId: string | null;
  readonly unitCode: string | null;
  readonly acknowledged: boolean;
  readonly acknowledgedAt: Date | null;
  readonly superseded: boolean;
  readonly closed: boolean;
  readonly signerId: string | null;
}

export interface TenantSigningNotice {
  readonly noticeId: string;
  readonly number: string;
  readonly typeLabel: string;
  readonly issuedAt: Date;
  readonly effectiveDate: string | null;
  readonly statement: string;
}

/**
 * The tenant app's notices (M7 plan 4.10): each landlord's read under that landlord's own company
 * context with the tenant scope set, so Row Level Security shows only the notices the person
 * received, never a draft. Acknowledging opens the apps/links page with a fresh link.
 */
@Injectable()
export class TenantNoticesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async notices(actor: Actor | null) {
    const tenant = this.tenantActor(actor);
    const groups: { landlord: { companyId: string; name: string }; notices: TenantNoticeView[] }[] =
      [];
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const group = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const name = (await companyRecord(tx, companyId))?.displayName ?? '';
        return { landlord: { companyId, name }, notices: await this.viewsIn(tx) };
      });
      if (group.notices.length > 0) groups.push(group);
    }
    return groups;
  }

  async documentUrl(actor: Actor | null, noticeId: string): Promise<string> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const documentId = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const [notice] = await tx
          .select()
          .from(schema.notice)
          .where(eq(schema.notice.id, noticeId));
        if (!notice) return null;
        const [own] = await tx
          .select()
          .from(schema.noticeRecipient)
          .where(eq(schema.noticeRecipient.noticeId, noticeId))
          .limit(1);
        if (!own) return null;
        if (own.signingRequestId) {
          const [request] = await tx
            .select({ finalDocumentId: schema.signingRequest.finalDocumentId })
            .from(schema.signingRequest)
            .where(eq(schema.signingRequest.id, own.signingRequestId));
          if (request?.finalDocumentId) return request.finalDocumentId;
        }
        return notice.documentId;
      });
      if (!documentId) continue;
      const url = await this.documents.downloadUrl(companyId, documentId, 'notice.pdf');
      if (url) return url;
    }
    throw notFound('Notice');
  }

  /** The notice behind each of the tenant's signing requests, for the To sign list. */
  async signingNotices(actor: Actor | null): Promise<Map<string, TenantSigningNotice>> {
    const tenant = this.tenantActor(actor);
    const out = new Map<string, TenantSigningNotice>();
    for (const [companyId, tenantIds] of await this.companies(tenant))
      await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const rows = await tx
          .select({ request: schema.signingRequest.id, notice: schema.notice })
          .from(schema.signingRequest)
          .innerJoin(
            schema.notice,
            sql`${schema.notice.companyId} = ${schema.signingRequest.companyId} and ${schema.notice.id} = ${schema.signingRequest.noticeId}`,
          )
          .where(eq(schema.signingRequest.subjectType, 'notice'));
        for (const { request, notice } of rows)
          if (notice.number !== null && notice.issuedAt)
            out.set(request, {
              noticeId: notice.id,
              number: formatNoticeNumber(notice.number),
              typeLabel: NOTICE_TYPE_LABELS[notice.type as NoticeType],
              issuedAt: notice.issuedAt,
              effectiveDate: notice.effectiveDate,
              statement: NOTICE_SIGNING_STATEMENT,
            });
      });
    return out;
  }

  private async viewsIn(tx: Tx): Promise<TenantNoticeView[]> {
    const notices = await tx.select().from(schema.notice).orderBy(desc(schema.notice.issuedAt));
    if (notices.length === 0) return [];
    const recipients = await tx
      .select()
      .from(schema.noticeRecipient)
      .where(
        inArray(
          schema.noticeRecipient.noticeId,
          notices.map((n) => n.id),
        ),
      );
    const requestIds = [
      ...new Set(recipients.flatMap((r) => (r.signingRequestId ? [r.signingRequestId] : []))),
    ];
    const requests = requestIds.length
      ? await tx
          .select()
          .from(schema.signingRequest)
          .where(inArray(schema.signingRequest.id, requestIds))
      : [];
    const signerIds = recipients.flatMap((r) => (r.signerId ? [r.signerId] : []));
    const signers = signerIds.length
      ? await tx.select().from(schema.signer).where(inArray(schema.signer.id, signerIds))
      : [];
    const unitIds = [...new Set(recipients.flatMap((r) => (r.unitId ? [r.unitId] : [])))];
    const units = unitIds.length
      ? await tx
          .select({ id: schema.unit.id, code: schema.unit.code })
          .from(schema.unit)
          .where(inArray(schema.unit.id, unitIds))
      : [];
    const out: TenantNoticeView[] = [];
    for (const n of notices) {
      if (n.number === null || !n.issuedAt) continue;
      const own = recipients.find((r) => r.noticeId === n.id);
      if (!own) continue;
      const request = requests.find((q) => q.id === own.signingRequestId);
      const signer = signers.find((s) => s.id === own.signerId);
      const acknowledged = signer?.status === 'signed' || request?.status === 'completed';
      out.push({
        noticeId: n.id,
        number: formatNoticeNumber(n.number),
        typeLabel: NOTICE_TYPE_LABELS[n.type as NoticeType],
        issuedAt: n.issuedAt,
        effectiveDate: n.effectiveDate,
        leaseId: own.leaseId,
        unitCode: units.find((u) => u.id === own.unitId)?.code ?? null,
        acknowledged,
        acknowledgedAt: signer?.signedAt ?? request?.completedAt ?? null,
        superseded: n.outcome === 'superseded',
        closed: n.status === 'closed',
        signerId:
          !acknowledged &&
          request?.status === 'pending' &&
          signer?.status === 'pending' &&
          signsAsTenant(signer.subjectType)
            ? signer.id
            : null,
      });
    }
    return out;
  }

  private tenantActor(actor: Actor | null): TenantActor {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'tenancy.view_own');
    switch (actor.kind) {
      case 'tenant':
        return actor;
      default:
        throw forbidden();
    }
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
  ) {
    return withCompany(
      this.database,
      { companyId, personId: tenant.personId, actorKind: 'tenant', tenantScope: { tenantIds } },
      fn,
    );
  }
}
