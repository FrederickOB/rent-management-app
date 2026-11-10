import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { forbidden, notAuthenticated, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { DocumentsService, type DocumentScanStatus } from '../documents/documents.service';

/**
 * M11 review round: the rows that hold a document of a property, a lease, a tenant or an owner,
 * read in a scoped person's own transaction, so the scope policies of those tables decide which
 * documents are theirs. Constant table and column names, never input. A document only the whole
 * company sees (an export, a render request, an upload not yet recorded) is not listed: a scoped
 * person reads its status only as its uploader.
 */
const SCOPED_DOCUMENT_REFERENCES: readonly (readonly [table: string, column: string])[] = [
  ['lease', 'signed_document_id'],
  ['lease', 'stamped_document_id'],
  ['lease', 'formal_wet_signed_document_id'],
  ['signing_request', 'document_id'],
  ['signing_request', 'html_document_id'],
  ['signing_request', 'final_document_id'],
  ['signature', 'drawing_document_id'],
  ['property_file', 'document_id'],
  ['property_file', 'thumbnail_document_id'],
  ['maintenance_job_attachment', 'document_id'],
  ['inspection_photo', 'document_id'],
  ['expense', 'receipt_document_id'],
  ['message_attachment', 'document_id'],
  ['cash_record', 'photo_document_id'],
  ['cash_banking', 'slip_document_id'],
  ['payment', 'proof_document_id'],
  ['direct_receipt', 'proof_document_id'],
  ['unmatched_refund', 'proof_document_id'],
  ['early_termination', 'proof_document_id'],
  ['move_out', 'proof_document_id'],
  ['move_out', 'statement_document_id'],
  ['notice', 'document_id'],
  ['notice', 'service_pack_document_id'],
  ['service_record', 'photo_document_id'],
  ['service_record', 'affidavit_document_id'],
  ['rent_assessment', 'document_id'],
  ['owner_statement', 'document_id'],
  ['owner_funding', 'proof_document_id'],
  ['remittance', 'proof_document_id'],
  ['gra_payment', 'receipt_document_id'],
  ['vat_payment', 'receipt_document_id'],
  ['withholding_certificate', 'document_id'],
];

const referencedInScope = (documentId: string) =>
  sql`select exists (${sql.join(
    SCOPED_DOCUMENT_REFERENCES.map(
      ([table, column]) =>
        sql`select 1 from ${sql.identifier(table)} where ${sql.identifier(column)} = ${documentId}::uuid`,
    ),
    sql` union all `,
  )}) as visible`;

export interface DocumentScanView {
  readonly documentId: string;
  readonly status: DocumentScanStatus;
  readonly scannedAt: Date | null;
}

/**
 * An upload's scan status (M11 decision 6; documentsContract.scanStatus), for the person who
 * uploaded it or anyone who may see the document: staff holding `document.view` in its company
 * (a scoped person only for a document of their properties or owners, AD-02), and a tenant
 * session that sees the document under its own tenant scope (the document table's tenant policy).
 * Anyone else, or a document of another company, is not found.
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
      (state.createdBy === staff.personId ||
        (this.policy.can(staff, 'document.view').allowed &&
          (this.policy.scopeFor(staff) === null ||
            (await withCompany(this.database, staffContext(staff), async (tx) => {
              const rows = await tx.execute<{ visible: boolean }>(referencedInScope(documentId));
              return rows.rows[0]?.visible === true;
            })))));
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
