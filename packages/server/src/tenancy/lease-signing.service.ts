import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, schema, withCompany, type Database, type Tx } from '@rent/db';
import type { SignerRole } from '@rent/domain/esign';
import type { Actor } from '@rent/domain/policy';
import { AuditService } from '../audit/audit.service';
import { staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import type {
  IssuedLink,
  NewSigner,
  SignerSubject,
  SigningProgressView,
} from '../esign/esign.types';
import { personContact } from '../identity/person-directory';
import { PolicyService, staffContext } from '../policy/policy.service';
import { LeaseDocumentsService } from './lease-documents.service';
import { LeaseLifecycleService } from './lease-lifecycle.service';
import {
  assertStaffParties,
  assertUnitFree,
  companyFacts,
  leaseRow,
  leaseWriteError,
  lockUnit,
  todayIn,
  type LeaseRow,
} from './lease-records';
import { LeasesService } from './leases.service';
import type { LeaseLimitedView, LeaseView } from './tenancy.types';

/** The signer role of the tenant signing for themselves (a signer role, not a staff role). */
const TENANT_ITSELF: ReadonlySet<string> = new Set<SignerRole>(['tenant']);

/**
 * Who must sign, whatever the client sent (review finding 1): the tenant or the company tenant's
 * signatories, and the landlord's signer; the witness when the lease requires one. Other parties,
 * such as a guarantor, keep the flag the draft gives them.
 */
const ALWAYS_REQUIRED: ReadonlySet<string> = new Set<SignerRole>([
  'tenant',
  'signatory',
  'landlord',
]);
const WITNESS: ReadonlySet<string> = new Set<SignerRole>(['witness']);

/**
 * Sending a lease for e-signature (TL-07; M3 plan 4.7 and 4.8): issuing freezes the terms,
 * snapshots the document, asks for its PDF and opens the signing request with its signers, all
 * in one transaction; recalling closes the request in the e-signing engine and returns the lease
 * to draft in the same transaction. The engine's tables are its own: this service only calls it.
 */
/** M8 (plan 4.7): the signer roles that sign a move-in report (signing roles, not staff roles). */
const MOVE_IN_REPORT_ROLES: ReadonlySet<string> = new Set(['tenant', 'signatory', 'landlord']);
const LANDLORD_ROLE: ReadonlySet<string> = new Set(['landlord']);

@Injectable()
export class LeaseSigningService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(LeaseDocumentsService) private readonly leaseDocuments: LeaseDocumentsService,
    @Inject(LeasesService) private readonly leases: LeasesService,
    @Inject(LeaseLifecycleService) private readonly lifecycle: LeaseLifecycleService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `POST /leases/:id/issue`: the draft goes to pending signatures with its document frozen. The
   * signers are the lease's parties, each snapshotted with the phone and email on record now:
   * the tenant or the company tenant's signatories, the landlord's signatory, the guarantor if
   * there is one, and the witness when the company requires one (plan 4.8). Links go out once
   * the PDF is rendered.
   */
  async issue(actor: Actor | null, leaseId: string): Promise<LeaseView | LeaseLimitedView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      // The unit first, then the lease row: the order every path that holds a unit locks in.
      const found = await leaseRow(tx, leaseId);
      await lockUnit(tx, found.companyId, found.unitId);
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (row.status !== 'draft')
        throw conflict('lease_not_draft', 'Only a draft lease can be sent for signature');
      if (!row.templateVersionId)
        throw conflict(
          'lease_without_template',
          'This lease was recorded from paper and has no document to sign',
        );
      const company = await companyFacts(tx, row.companyId);
      await assertUnitFree(tx, row, {
        starting: true,
        today: todayIn(this.clock, company.timeZone),
      });
      const signers = await this.signersOf(tx, row);
      const { renderRequestId } = await this.leaseDocuments.requestPdf(tx, leaseId, staff.personId);
      try {
        await tx
          .update(schema.lease)
          .set({ status: 'pending_signatures', updatedAt: this.clock.now() })
          .where(and(eq(schema.lease.id, leaseId), eq(schema.lease.status, 'draft')));
      } catch (error) {
        throw leaseWriteError(error);
      }
      const signingRequestId = await this.esign.openRequest(tx, {
        companyId: row.companyId,
        propertyId: row.propertyId,
        tenantId: row.tenantId,
        leaseId,
        renderRequestId,
        createdBy: staff.personId,
        signers,
      });
      await this.audit.append(tx, {
        companyId: row.companyId,
        action: 'lease.issued',
        recordType: 'lease',
        recordId: leaseId,
        data: { signingRequestId, signers: signers.map((s) => s.role) },
      });
    });
    return this.leases.get(staff, leaseId);
  }

  /**
   * `POST /leases/:id/recall`: the request is cancelled and its links revoked, and the lease goes
   * back to draft, in one transaction. A lease everyone has signed cannot be recalled.
   */
  async recall(
    actor: Actor | null,
    leaseId: string,
    reason?: string | null,
  ): Promise<LeaseView | LeaseLimitedView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (row.status !== 'pending_signatures')
        throw conflict('lease_not_pending', 'Only a lease waiting for signatures can be recalled');
      await this.esign.cancelForLease(tx, leaseId, {
        reason: reason?.trim() || 'Recalled by staff',
        by: staff.personId,
      });
      await this.lifecycle.returnToDraft(tx, leaseId, 'recalled');
    });
    return this.leases.get(staff, leaseId);
  }

  /** `GET /leases/:id/signing`: the latest signing request and each signer's progress. */
  async progress(actor: Actor | null, leaseId: string): Promise<SigningProgressView | null> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view_terms');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await leaseRow(tx, leaseId);
      return this.esign.progressForLease(tx, leaseId);
    });
  }

  /**
   * `POST /signing-requests/:id/signers/:signerId/link` (decision 2): a single-use link that
   * staff show as a QR code or copy, for a signer with no consented channel. It revokes the
   * signer's earlier link; the token is never stored.
   */
  async handoverLink(
    actor: Actor | null,
    signingRequestId: string,
    signerId: string,
  ): Promise<IssuedLink> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.esign.issueLink(tx, { signingRequestId, signerId, createdBy: staff.personId }),
    );
  }

  /** A 5-minute link to the lease's frozen PDF, or to its signed copy once everyone has signed. */
  async documentUrl(
    actor: Actor | null,
    leaseId: string,
    which: 'frozen' | 'signed',
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view_terms');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      await leaseRow(tx, leaseId);
      return this.esign.leaseDocumentId(tx, leaseId, which);
    });
    if (!documentId) throw notFound('Document');
    const url = await this.documents.downloadUrl(
      staff.companyId,
      documentId,
      `${which === 'signed' ? 'signed-' : ''}lease-${leaseId}.pdf`,
    );
    if (!url) throw notFound('Document');
    return url;
  }

  /**
   * M8 (plan 4.7): who signs the move-in report: every tenant party and the landlord's
   * representative, as on the lease, all required, with the phone and email on record now.
   */
  async moveInReportSigners(
    tx: Tx,
    leaseId: string,
    /** Who signs for the landlord when the lease names nobody (a paper lease): the inspector. */
    representative: string | null,
  ): Promise<NewSigner[]> {
    const row = await leaseRow(tx, leaseId);
    const signers = (await this.signersOf(tx, row, { report: true }))
      .filter((s) => MOVE_IN_REPORT_ROLES.has(s.role))
      .map((s) => ({ ...s, required: true }));
    if (!signers.some((s) => LANDLORD_ROLE.has(s.role)) && representative) {
      const person = await personContact(tx, representative);
      if (person && (person.phone || person.email))
        signers.push({
          role: 'landlord',
          subject: { type: 'staff', personId: representative },
          leasePartyId: null,
          name: person.name,
          phone: person.phone,
          email: person.email,
          required: true,
          isTestContact: person.isTestContact,
        });
    }
    return signers;
  }

  /** The lease's parties as signers, with the phone and email on record now (plan 4.8). */
  private async signersOf(
    tx: Tx,
    row: LeaseRow,
    /** M8: the move-in report needs only the tenant's side; the landlord may be the inspector. */
    options: { readonly report?: boolean } = {},
  ): Promise<NewSigner[]> {
    const parties = await tx
      .select()
      .from(schema.leaseParty)
      .where(eq(schema.leaseParty.leaseId, row.id))
      .orderBy(asc(schema.leaseParty.position));
    if (parties.length === 0) throw invalid('parties_required', 'Add who signs the lease');
    const roles = new Set(parties.map((p) => p.partyRole as SignerRole));
    if (!roles.has('tenant') && !roles.has('signatory'))
      throw invalid(
        'tenant_signer_required',
        'Add the tenant, or the company tenant’s signatory, as a signer',
      );
    if (!roles.has('landlord') && !options.report)
      throw invalid('landlord_signer_required', 'Add who signs for the landlord');
    if (row.witnessRequired && !roles.has('witness') && !options.report)
      throw invalid(
        'witness_required',
        'Add the witness who will sign: your company asks for a witness on every lease',
      );
    // Only one party signs as the tenant itself; anyone else signing with them is on record as
    // one of the tenant's contacts, with their own phone and email (review finding 11).
    const asTenant = parties.filter(
      (p) => TENANT_ITSELF.has(p.partyRole) && !p.tenantContactId && !p.staffPersonId,
    );
    if (asTenant.length > 1)
      throw invalid(
        'tenant_signer_once',
        'Only one signer can sign as the tenant. Add co-occupants as the tenant’s contacts, then choose them as signers',
      );
    await assertStaffParties(
      tx,
      parties.map((p) => ({ role: p.partyRole, name: p.name, staffPersonId: p.staffPersonId })),
    );
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, row.tenantId));
    if (!tenant) throw notFound('Tenant');
    // A person who rents signs their own lease: anyone who lives there too signs with them, from
    // their contact record, never instead of them (review finding 1).
    if (tenant.kind === 'individual' && asTenant.length === 0)
      throw invalid(
        'tenant_signer_required',
        'Add the tenant as a signer: a person who rents signs their own lease, and anyone who lives there too signs with them',
      );
    const signers: NewSigner[] = [];
    for (const p of parties) {
      let subject: SignerSubject = { type: 'other' };
      let phone = p.phone;
      let email = p.email;
      let isTestContact = tenant.isTestContact;
      if (p.tenantContactId) {
        const [contact] = await tx
          .select()
          .from(schema.tenantContact)
          .where(
            and(
              eq(schema.tenantContact.id, p.tenantContactId),
              eq(schema.tenantContact.tenantId, row.tenantId),
              isNull(schema.tenantContact.archivedAt),
            ),
          );
        if (!contact)
          throw invalid('party_contact', `${p.name} is no longer one of this tenant’s contacts`);
        subject = { type: 'tenant_contact', contactId: contact.id };
        phone = contact.phone ?? p.phone;
        email = contact.email ?? p.email;
        isTestContact = contact.isTestContact;
      } else if (p.staffPersonId) {
        const person = await personContact(tx, p.staffPersonId);
        subject = { type: 'staff', personId: p.staffPersonId };
        phone = person?.phone ?? p.phone;
        email = person?.email ?? p.email;
        isTestContact = person?.isTestContact ?? false;
      } else if (TENANT_ITSELF.has(p.partyRole)) {
        subject = { type: 'tenant' };
        phone = tenant.phone ?? p.phone;
        email = tenant.email ?? p.email;
      }
      if (!phone && !email)
        throw invalid(
          'signer_contact',
          `${p.name} has no phone number or email on record; add one so they can get their link and code`,
        );
      signers.push({
        role: p.partyRole as SignerRole,
        subject,
        leasePartyId: p.id,
        name: p.name,
        phone,
        email,
        required:
          ALWAYS_REQUIRED.has(p.partyRole) ||
          (WITNESS.has(p.partyRole) && row.witnessRequired) ||
          p.required,
        isTestContact,
      });
    }
    return signers;
  }
}
