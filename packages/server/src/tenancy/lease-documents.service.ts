import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, schema, withCompany, type Database, type Tx } from '@rent/db';
import { leaseV1, renderTemplateHtml } from '@rent/documents';
import type { SignerRole } from '@rent/domain/esign';
import type { Actor } from '@rent/domain/policy';
import { UNIT_TYPE_LABELS, type UnitType } from '@rent/domain/portfolio';
import {
  buildLeaseDocument,
  STARTER_TEMPLATE_NAMES,
  type LeaseDocument,
  type TemplateContent,
} from '@rent/domain/tenancy';
import { staffActor } from '../companies/companies.service';
import { conflict, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { propertyOwnerName, unitPlace } from '../portfolio/register-read.service';
import { companyFacts, leaseRow, termsOf } from './lease-records';
import { LeaseTemplatesService } from './lease-templates.service';

/** The lease document template in packages/documents (TL-05, TL-07). */
export const LEASE_DOCUMENT_TEMPLATE = { key: leaseV1.key, version: leaseV1.version } as const;

export interface LeaseSnapshot {
  readonly data: LeaseDocument;
  readonly templateVersionId: string;
  readonly counselReviewed: boolean;
}

/**
 * A lease's document (TL-05; M3 plan 4.5): the template version's clauses filled from the
 * lease's data, rendered to HTML for previews and to PDF through `documents.render-pdf`. The
 * e-signing phase freezes the same snapshot, so signers read exactly what was rendered.
 */
@Injectable()
export class LeaseDocumentsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(LeaseTemplatesService) private readonly templates: LeaseTemplatesService,
  ) {}

  /** The snapshot of a lease built from a template, in the caller's transaction. */
  async snapshot(tx: Tx, leaseId: string): Promise<LeaseSnapshot> {
    const lease = await leaseRow(tx, leaseId);
    if (!lease.templateVersionId)
      throw conflict(
        'lease_without_template',
        'This lease was recorded from paper and has no template',
      );
    const { version, template } = await this.templates.version(tx, lease.templateVersionId);
    const company = await companyFacts(tx, lease.companyId);
    const terms = await termsOf(tx, lease);
    const where = await unitPlace(tx, lease.unitId);
    if (!where) throw notFound('Unit');
    // The landlord is the property's owner today, whatever owners the person drafting may see
    // (review finding 5): a manager scoped to the property must not make the agency the landlord.
    const ownerName = await propertyOwnerName(tx, lease.companyId, lease.propertyId);
    if (!ownerName && company.kind === 'agency')
      throw conflict(
        'property_without_owner',
        'This property has no owner on record today. Record its owner in the register before preparing the lease.',
      );
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, lease.tenantId));
    if (!tenant) throw notFound('Tenant');
    const signatories = await tx
      .select({ name: schema.tenantContact.name })
      .from(schema.tenantContact)
      .where(
        and(
          eq(schema.tenantContact.tenantId, tenant.id),
          eq(schema.tenantContact.kind, 'signatory'),
          isNull(schema.tenantContact.archivedAt),
        ),
      )
      .orderBy(asc(schema.tenantContact.createdAt));
    const parties = await tx
      .select({ partyRole: schema.leaseParty.partyRole, name: schema.leaseParty.name })
      .from(schema.leaseParty)
      .where(eq(schema.leaseParty.leaseId, lease.id))
      .orderBy(asc(schema.leaseParty.position));
    const guarantor = parties.find((p) => p.partyRole === 'guarantor')?.name ?? null;
    const unitDescription = [
      UNIT_TYPE_LABELS[where.unitType as UnitType],
      where.bedrooms ? `${where.bedrooms} bedroom${where.bedrooms === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const data = buildLeaseDocument(version.content as TemplateContent, {
      title: documentTitle(template.name, template.starterKind),
      reference: `L-${lease.id}`,
      landlordName: ownerName ?? company.legalName,
      agentName: company.kind === 'agency' ? company.displayName : null,
      tenantName: tenant.legalName ?? tenant.displayName,
      tenantPhone: tenant.phone,
      tenantEmail: tenant.email,
      signatoryNames: signatories.map((s) => s.name),
      guarantorName: guarantor,
      propertyName: where.propertyName,
      propertyAddress: [
        where.address.street,
        where.address.town,
        where.address.district,
        where.address.region,
        where.address.ghanapostGps,
      ]
        .filter(Boolean)
        .join(', '),
      unitCode: where.code,
      unitDescription,
      terms,
      servicePhones: lease.servicePhones,
      serviceEmails: lease.serviceEmails,
      parties: parties.map((p) => ({ role: p.partyRole as SignerRole, name: p.name })),
    });
    // The signature block needs at least one signer; a draft without parties shows the tenant.
    const withSigners =
      data.signers.length > 0
        ? data
        : { ...data, signers: [{ role: 'Tenant', name: tenant.displayName }] };
    return {
      data: withSigners,
      templateVersionId: version.id,
      counselReviewed: version.counselReviewedAt !== null,
    };
  }

  /** The lease as HTML, exactly as the PDF would show it, with the builder's warnings. */
  async preview(
    actor: Actor | null,
    leaseId: string,
  ): Promise<{ html: string; document: LeaseDocument; warnings: string[] }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view_terms');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const snapshot = await this.snapshot(tx, leaseId);
      const company = await companyFacts(tx, staff.companyId);
      const html = renderTemplateHtml(
        LEASE_DOCUMENT_TEMPLATE.key,
        LEASE_DOCUMENT_TEMPLATE.version,
        snapshot.data,
        {
          senderName: company.senderName,
          primaryColour: company.primaryColour,
          accentColour: company.accentColour,
        },
      );
      const warnings = snapshot.counselReviewed
        ? []
        : [
            'This template version has not been reviewed by your lawyer. Its legal clauses may still read “Wording to be supplied by your lawyer.” (OQ-53)',
          ];
      return { html, document: snapshot.data, warnings };
    });
  }

  /**
   * Queues the PDF of a lease's snapshot through `documents.render-pdf` (ADR-006), in the
   * caller's transaction. The worker renders it, fingerprints it and stores it write-once; the
   * e-signing phase opens the signing request once that document exists.
   */
  async requestPdf(
    tx: Tx,
    leaseId: string,
    requestedBy: string | null,
  ): Promise<{ renderRequestId: string; snapshot: LeaseSnapshot }> {
    const snapshot = await this.snapshot(tx, leaseId);
    const lease = await leaseRow(tx, leaseId);
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: lease.companyId,
      templateKey: LEASE_DOCUMENT_TEMPLATE.key,
      templateVersion: LEASE_DOCUMENT_TEMPLATE.version,
      data: snapshot.data as unknown as Record<string, unknown>,
      requestedBy,
    });
    return { renderRequestId, snapshot };
  }
}

function documentTitle(name: string, starterKind: string | null): string {
  if (
    starterKind &&
    name === STARTER_TEMPLATE_NAMES[starterKind as keyof typeof STARTER_TEMPLATE_NAMES]
  )
    return name.replace(/\s*\(starter\)$/, '');
  return name;
}
