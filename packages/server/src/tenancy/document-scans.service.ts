import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { forbidden, notAuthenticated, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { PolicyService } from '../policy/policy.service';
import { DocumentsService, type DocumentScanStatus } from '../documents/documents.service';

export interface DocumentScanView {
  readonly documentId: string;
  readonly status: DocumentScanStatus;
  readonly scannedAt: Date | null;
}

/**
 * An upload's scan status (M11 decision 6; documentsContract.scanStatus), for the person who
 * uploaded it or anyone who may see the document: staff holding `document.view` in its company,
 * and a tenant session that sees the document under its own tenant scope (the document table's
 * tenant policy). Anyone else, or a document of another company, is not found.
 */
@Injectable()
export class DocumentScansService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async status(actor: Actor | null, documentId: string): Promise<DocumentScanView> {
    if (!actor) throw notAuthenticated();
    switch (actor.kind) {
      case 'tenant':
        if (!this.policy.can(actor, 'tenancy.view_own').allowed) throw forbidden();
        return this.forTenant(actor.personId, documentId);
      default:
        return this.forStaff(actor, documentId);
    }
  }

  private async forStaff(actor: Actor, documentId: string): Promise<DocumentScanView> {
    const staff = staffActor(actor);
    const state = await this.documents.scanState(staff.companyId, documentId);
    const allowed =
      state !== null &&
      (state.createdBy === staff.personId || this.policy.can(staff, 'document.view').allowed);
    if (!state || !allowed) throw notFound('Document');
    return { documentId, status: state.status, scannedAt: state.scannedAt };
  }

  /** Each company where the person is a tenant (TL-12), read in that company only. */
  private async forTenant(personId: string, documentId: string): Promise<DocumentScanView> {
    const tenancies = await withSystem(this.database, { personId, actorKind: 'tenant' }, (tx) =>
      tx.execute<{ company_id: string; tenant_id: string }>(
        sql`select company_id, tenant_id from app.tenancies_for_person(${personId}::uuid)`,
      ),
    );
    const byCompany = new Map<string, string[]>();
    for (const r of tenancies.rows)
      byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r.tenant_id]);
    for (const [companyId, tenantIds] of byCompany) {
      const state = await this.documents.scanState(companyId, documentId);
      if (!state) continue;
      const visible =
        state.createdBy === personId ||
        (await withCompany(
          this.database,
          { companyId, personId, actorKind: 'tenant', tenantScope: { tenantIds } },
          async (tx) =>
            (await tx.execute(sql`select 1 from document where id = ${documentId}`)).rows.length >
            0,
        ));
      if (visible) return { documentId, status: state.status, scannedAt: state.scannedAt };
    }
    throw notFound('Document');
  }
}
