import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  parseBusinessDate,
  startOfDay,
  instantToDate,
  toIsoDate,
} from '@rent/domain/dates';
import { checkBillingStart, firstPeriodStartOnOrAfter } from '@rent/domain/billing';
import { DomainError } from '@rent/domain/errors';
import { SIGNER_ROLES, type SignerRole } from '@rent/domain/esign';
import { normalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import { verificationWarning } from '@rent/domain/rules';
import {
  advanceOutcome,
  checkAdvance,
  checkLeaseTerms,
  renewalStartDate,
  rentOn,
  type LeaseEndReason,
  type LeaseStatus,
  type LeaseTerms,
  type LeaseUse,
  type RentCycle,
  type StarterTemplateKind,
} from '@rent/domain/tenancy';
import { z } from 'zod';
import { ApprovalsService, type ApprovalView } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { staffActor, type StaffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { sqlStateOf } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, LEASE_FILE_UPLOAD } from '../documents/documents.service';
import { activeMemberIds } from '../identity/memberships';
import { PolicyService, staffContext } from '../policy/policy.service';
import { unitPlace } from '../portfolio/register-read.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import { LEASE_CANCELLED_EVENT, LeaseLifecycleService } from './lease-lifecycle.service';
import {
  assertStaffParties,
  companyFacts,
  lastChargedDay,
  leaseRow,
  leaseWriteError,
  termsOf,
  todayIn,
  type CompanyFacts,
  type LeaseRow,
} from './lease-records';
import { LeaseTemplatesService } from './lease-templates.service';
import type {
  ChargePeriodView,
  ExpiringLease,
  LeaseDraftInput,
  LeaseDraftPatch,
  LeaseLimitedView,
  LeaseListRow,
  LeaseTermsInput,
  LeaseView,
  PaperLeaseInput,
  PartyInput,
  PartyView,
  RuleRef,
  TenantKind,
} from './tenancy.types';

export const CANCEL_SIGNED_ACTION = 'lease.cancel_signed';
export const CANCEL_REASON_MIN_LENGTH = 10;

const cancelSignedPayload = z
  .object({
    leaseId: z.string().uuid(),
    reason: z.string().min(CANCEL_REASON_MIN_LENGTH).max(500),
    status: z.string(),
    startDate: z.string(),
  })
  .strict();
type CancelSignedPayload = z.infer<typeof cancelSignedPayload>;

/** States after signing: the trackers apply from here (plan 4.11). */
const SIGNED_STATES: readonly LeaseStatus[] = [
  'signed',
  'active',
  'ending',
  'holding_over',
  'ended',
];

const ruleRef = (rule: typeof schema.rule.$inferSelect | undefined): RuleRef | null =>
  rule
    ? {
        ruleId: rule.id,
        verificationStatus: rule.verificationStatus as RuleRef['verificationStatus'],
        source: rule.source,
        warning: rule.verificationStatus !== 'verified',
      }
    : null;

/** Who a lease signer is (the e-signature engine's roles, not staff roles). */
const SIGNER_ROLE_SET: ReadonlySet<string> = new Set(SIGNER_ROLES);

function checkParties(parties: readonly PartyInput[]): PartyInput[] {
  if (parties.length > 20) throw invalid('parties_too_many', 'A lease has at most 20 signers');
  return parties.map((p) => {
    if (!SIGNER_ROLE_SET.has(p.role)) throw invalid('party_role', 'Choose who this signer is');
    const name = p.name.trim();
    if (name.length < 2 || name.length > 160)
      throw invalid('party_name', 'Enter the signer’s name');
    const email = p.email?.trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw invalid('email_invalid', 'Enter a valid email address');
    if (p.paperSignedOn) parseBusinessDate(p.paperSignedOn);
    return {
      ...p,
      name,
      phone: p.phone?.trim() ? normalisePhone(p.phone) : null,
      email,
    };
  });
}

/**
 * Leases (TL-06, TL-09, PB-09, TX-05, AR-05; M3 plan 4.6 to 4.13): drafts with validated terms
 * and the advance check on every save, paper leases, renewals, the trackers, and cancelling a
 * signed lease with two-person approval. Issuing for e-signature is the e-signing phase's; it
 * ends in LeaseLifecycleService.markSigned, as paper leases do.
 */
@Injectable()
export class LeasesService {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(LeaseTemplatesService) private readonly templates: LeaseTemplatesService,
    @Inject(LeaseLifecycleService) private readonly lifecycle: LeaseLifecycleService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers `lease.cancel_signed` with the approvals engine (decision 6). Once per process. */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register<CancelSignedPayload>({
      actionType: CANCEL_SIGNED_ACTION,
      eligibleRoles: ['owner', 'agency_admin', 'property_manager'],
      schema: cancelSignedPayload,
      // One cancellation waits at a time for a lease; a second would only ask the same question.
      onePerSubject: true,
      // The lease row first, before the decision is audited: the transitions job takes the lease
      // before the audit chain head too, so the two never wait on each other (review 3).
      prepare: async (tx, request) => {
        await leaseRow(tx, (request.payload as CancelSignedPayload).leaseId, { lock: true });
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as CancelSignedPayload;
        const row = await leaseRow(tx, proposed.leaseId);
        return {
          leaseId: row.id,
          reason: proposed.reason,
          status: row.status,
          startDate: row.startDate,
        };
      },
      execute: async (tx, request, payload) => {
        const row = await leaseRow(tx, payload.leaseId, { lock: true });
        const company = await companyFacts(tx, row.companyId);
        if (row.status !== 'signed' || todayIn(this.clock, company.timeZone) >= row.startDate)
          throw conflict(
            'lease_started',
            'Only a signed lease that has not started can be cancelled',
          );
        await this.lifecycle.statusReason(tx, 'Signed lease cancelled with approval');
        const updated = await tx
          .update(schema.lease)
          .set({
            status: 'cancelled',
            cancelledAt: this.clock.now(),
            cancelReason: payload.reason,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(schema.lease.id, row.id), eq(schema.lease.status, 'signed')))
          .returning({ id: schema.lease.id });
        if (updated.length === 0) throw notFound('Lease');
        await this.audit.append(tx, {
          companyId: row.companyId,
          action: 'lease.cancelled_after_signing',
          recordType: 'lease',
          recordId: row.id,
          data: { approvalRequestId: request.id },
        });
        // Billing cancels the lease's invoices (M4a plan 4.4); money paid stays as credit.
        await enqueueOutbox(tx, {
          companyId: row.companyId,
          type: LEASE_CANCELLED_EVENT,
          payload: { leaseId: row.id },
          idempotencyKey: `${LEASE_CANCELLED_EVENT}:${row.id}`,
        });
      },
    });
  }

  // Reading --------------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filters: {
      readonly status?: readonly LeaseStatus[];
      readonly unitId?: string;
      readonly tenantId?: string;
      readonly propertyId?: string;
      readonly search?: string;
    } = {},
  ): Promise<(LeaseListRow | LeaseLimitedView)[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    const detailed = this.policy.can(staff, 'lease.view_terms').allowed;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const where = [sql`true`];
      if (filters.status?.length)
        where.push(
          sql`l.status in (${sql.join(
            filters.status.map((s) => sql`${s}`),
            sql`, `,
          )})`,
        );
      if (filters.unitId) where.push(sql`l.unit_id = ${filters.unitId}`);
      if (filters.tenantId) where.push(sql`l.tenant_id = ${filters.tenantId}`);
      if (filters.propertyId) where.push(sql`l.property_id = ${filters.propertyId}`);
      if (filters.search?.trim()) {
        const q = `%${filters.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(sql`(u.code ilike ${q} or t.display_name ilike ${q})`);
      }
      const rows = await tx.execute<{
        id: string;
        status: LeaseStatus;
        unit_id: string;
        unit_code: string;
        property_name: string;
        tenant_id: string;
        tenant_name: string;
        start_date: string;
        end_date: string;
        monthly_rent_minor: number;
        rent_cycle: RentCycle;
        signing_method: string | null;
        advance_flagged: boolean;
      }>(
        sql`select l.id, l.status, l.unit_id, u.code as unit_code, p.name as property_name, l.tenant_id,
              t.display_name as tenant_name, l.start_date, l.end_date, l.monthly_rent_minor, l.rent_cycle,
              l.signing_method, l.advance_flagged
            from lease l
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            join property p on p.company_id = l.company_id and p.id = l.property_id
            left join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
            where ${sql.join(where, sql` and `)}
            order by l.start_date desc, u.code limit 500`,
      );
      return rows.rows.map((r) =>
        detailed
          ? {
              access: 'full' as const,
              id: r.id,
              status: r.status,
              unit: { id: r.unit_id, code: r.unit_code },
              propertyName: r.property_name,
              // A scoped person may see a lease without its tenant record; show no name then.
              tenant: { id: r.tenant_id, displayName: r.tenant_name ?? '' },
              startDate: r.start_date,
              endDate: r.end_date,
              monthlyRentMinor: Number(r.monthly_rent_minor),
              cycle: r.rent_cycle,
              signedOnPaper: r.signing_method === 'paper',
              advanceFlagged: r.advance_flagged,
            }
          : {
              access: 'limited' as const,
              id: r.id,
              status: r.status,
              unit: { id: r.unit_id, code: r.unit_code },
              startDate: r.start_date,
              endDate: r.end_date,
            },
      );
    });
  }

  async get(actor: Actor | null, leaseId: string): Promise<LeaseView | LeaseLimitedView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    const detailed = this.policy.can(staff, 'lease.view_terms').allowed;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId);
      if (!detailed) {
        const unit = await unitPlace(tx, row.unitId);
        return {
          access: 'limited',
          id: row.id,
          status: row.status as LeaseStatus,
          unit: { id: row.unitId, code: unit?.code ?? '' },
          startDate: row.startDate,
          endDate: row.endDate,
        };
      }
      return this.view(tx, row);
    });
  }

  async schedule(actor: Actor | null, leaseId: string): Promise<ChargePeriodView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view_terms');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await leaseRow(tx, leaseId);
      const rows = await tx
        .select()
        .from(schema.chargePeriod)
        .where(eq(schema.chargePeriod.leaseId, leaseId))
        .orderBy(asc(schema.chargePeriod.sequence), asc(schema.chargePeriod.chargeType));
      return rows.map((r) => ({
        sequence: r.sequence,
        chargeType: r.chargeType as ChargePeriodView['chargeType'],
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        amountMinor: r.amountMinor,
        currency: 'GHS' as const,
        prorated: r.prorated,
        source: r.source as ChargePeriodView['source'],
      }));
    });
  }

  /** Leases ending in the next `days` days (TL-09): the home page and its own list. */
  async expiring(actor: Actor | null, days = 90): Promise<ExpiringLease[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    const window = Math.min(Math.max(Math.trunc(days), 1), 366);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyFacts(tx, staff.companyId);
      const today = todayIn(this.clock, company.timeZone);
      const until = toIsoDate(addDays(parseBusinessDate(today), window));
      const rows = await tx.execute<{
        id: string;
        status: LeaseStatus;
        unit_code: string;
        property_name: string;
        tenant_name: string | null;
        end_date: string;
        renewal_id: string | null;
        renewal_status: LeaseStatus | null;
      }>(
        sql`select l.id, l.status, u.code as unit_code, p.name as property_name, t.display_name as tenant_name,
              l.end_date, r.id as renewal_id, r.status as renewal_status
            from lease l
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            join property p on p.company_id = l.company_id and p.id = l.property_id
            left join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
            left join lease r on r.company_id = l.company_id and r.renews_lease_id = l.id and r.status <> 'cancelled'
            where l.status in ('active', 'ending') and l.end_date between ${today}::date and ${until}::date
            order by l.end_date, u.code`,
      );
      return rows.rows.map((r) => ({
        id: r.id,
        status: r.status,
        unitCode: r.unit_code,
        propertyName: r.property_name,
        tenantName: r.tenant_name ?? '',
        endDate: r.end_date,
        daysLeft: daysBetween(parseBusinessDate(today), parseBusinessDate(r.end_date)),
        renewal: r.renewal_id ? { id: r.renewal_id, status: r.renewal_status! } : null,
      }));
    });
  }

  // Drafts ---------------------------------------------------------------------------------------

  async createDraft(actor: Actor | null, input: LeaseDraftInput): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const id = await withCompany(this.database, staffContext(staff), (tx) =>
      this.insertDraft(tx, staff, input),
    );
    return this.view(staff, id);
  }

  async updateDraft(
    actor: Actor | null,
    leaseId: string,
    patch: LeaseDraftPatch,
  ): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (row.status !== 'draft')
        throw conflict('lease_not_draft', 'Only a draft lease can be changed');
      const company = await companyFacts(tx, row.companyId);
      const current = await termsOf(tx, row);
      const termsInput: LeaseTermsInput = {
        startDate: patch.startDate ?? current.startDate,
        endDate: patch.endDate ?? current.endDate,
        monthlyRentMinor: patch.monthlyRentMinor ?? current.monthlyRentMinor,
        cycle: patch.cycle ?? current.cycle,
        initialAdvanceMonths:
          patch.initialAdvanceMonths !== undefined
            ? patch.initialAdvanceMonths
            : current.initialAdvanceMonths,
        depositMinor: patch.depositMinor !== undefined ? patch.depositMinor : current.depositMinor,
        serviceChargeMonthlyMinor:
          patch.serviceChargeMonthlyMinor !== undefined
            ? patch.serviceChargeMonthlyMinor
            : current.serviceChargeMonthlyMinor,
        steps: patch.steps ?? current.steps,
        breakClause: patch.breakClause !== undefined ? patch.breakClause : current.breakClause,
        noticeDays: patch.noticeDays ?? current.noticeDays,
        use: patch.use ?? current.use,
      };
      const terms = checkLeaseTerms({ ...termsInput, use: termsInput.use ?? current.use });
      const advance = await this.advanceCheck(company, terms);
      let templateVersionId = row.templateVersionId;
      if (patch.templateId !== undefined && patch.templateId !== null) {
        const latest = await this.templates.latestVersion(tx, patch.templateId);
        if (!latest) throw notFound('Template');
        templateVersionId = latest.id;
      }
      const parties = patch.parties ? checkParties(patch.parties) : null;
      if (parties) await assertStaffParties(tx, parties);
      try {
        await tx
          .update(schema.lease)
          .set({
            ...this.termColumns(terms),
            ...advance.columns,
            templateVersionId,
            ...(patch.servicePhones
              ? { servicePhones: patch.servicePhones.map((p) => normalisePhone(p)) }
              : {}),
            ...(patch.serviceEmails ? { serviceEmails: checkEmails(patch.serviceEmails) } : {}),
            ...(patch.witnessRequired !== undefined
              ? { witnessRequired: patch.witnessRequired }
              : {}),
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.lease.id, leaseId));
        await this.replaceChildren(tx, row, terms, parties);
      } catch (error) {
        throw leaseWriteError(error);
      }
    });
    return this.view(staff, leaseId);
  }

  /** Cancels a draft (plan 4.7). A signed lease needs an approval instead (cancel-signed). */
  async cancelDraft(actor: Actor | null, leaseId: string, reason: string): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const why = reason.trim();
    if (why.length < 3) throw invalid('reason_required', 'Give a reason for cancelling');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (row.status !== 'draft')
        throw conflict('lease_not_draft', 'Only a draft is cancelled this way');
      await tx
        .update(schema.lease)
        .set({
          status: 'cancelled',
          cancelledAt: this.clock.now(),
          cancelReason: why.slice(0, 500),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.lease.id, leaseId));
    });
    return this.view(staff, leaseId);
  }

  /**
   * Records a lease already signed on paper (decision 7): the terms, who signed and when, and
   * the signed scan, stored write-once. It is marked signed ("signed on paper", claiming no
   * e-signature evidence), its schedule generated, and it starts at once if its start has come.
   */
  async recordPaper(actor: Actor | null, input: PaperLeaseInput): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    if (!input.parties?.length)
      throw invalid('parties_required', 'Say who signed the lease and when');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.scanUploadId,
      LEASE_FILE_UPLOAD,
    );
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyFacts(tx, staff.companyId);
      const signedOn = parseBusinessDate(input.signedOn);
      if (compareDates(signedOn, parseBusinessDate(todayIn(this.clock, company.timeZone))) > 0)
        throw invalid('signed_on_future', 'The signing date cannot be in the future');
      const billingStartDate = this.paperBillingStart(input, todayIn(this.clock, company.timeZone));
      const leaseId = await this.insertDraft(
        tx,
        staff,
        {
          ...input,
          templateId: null,
          parties: input.parties!.map((p) => ({
            ...p,
            paperSignedOn: p.paperSignedOn ?? input.signedOn,
          })),
        },
        { paper: true },
      );
      const documentId = await this.documents.recordStagedEvidence(tx, staged, 'lease_scan');
      try {
        await this.lifecycle.markSigned(tx, {
          leaseId,
          signedAt: instantToDate(startOfDay(signedOn, company.timeZone)),
          source: 'paper',
          signedDocumentId: documentId,
          billingStartDate,
        });
      } catch (error) {
        throw leaseWriteError(error);
      }
      return leaseId;
    });
    // The scan's plain copy goes only now, so a refused or failed write can be sent again.
    await this.documents.discardStagedUpload(staged);
    return this.view(staff, id);
  }

  /**
   * Offers a renewal (TL-09, plan 4.10): a draft copied from the lease, linked to it, starting
   * the day after it ends, at the last rate. Staff set the new terms; the signing link that the
   * e-signing phase sends is the offer. Steps and the break clause belong to the old term.
   */
  async offerRenewal(actor: Actor | null, leaseId: string): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      const old = await leaseRow(tx, leaseId, { lock: true });
      if (old.status !== 'active' && old.status !== 'holding_over')
        throw conflict('lease_not_renewable', 'Only an active or held-over lease can be renewed');
      const existing = await tx
        .select({ id: schema.lease.id })
        .from(schema.lease)
        .where(
          and(eq(schema.lease.renewsLeaseId, leaseId), sql`${schema.lease.status} <> 'cancelled'`),
        );
      if (existing.length > 0) throw conflict('renewal_exists', 'This lease already has a renewal');
      const company = await companyFacts(tx, old.companyId);
      const terms = await termsOf(tx, old);
      // After the last day already charged, so a renewal of a lease held over never charges a
      // day twice (review finding 3).
      const start = renewalStartDate(
        terms,
        todayIn(this.clock, company.timeZone),
        await lastChargedDay(tx, old.id),
      );
      const end = toIsoDate(addDays(addMonths(parseBusinessDate(start), terms.periodCount), -1));
      const all = await tx
        .select()
        .from(schema.leaseParty)
        .where(eq(schema.leaseParty.leaseId, leaseId))
        .orderBy(asc(schema.leaseParty.position));
      // A staff signer who has since left the company is not copied; staff choose another.
      const members = await activeMemberIds(
        tx,
        all.flatMap((p) => (p.staffPersonId ? [p.staffPersonId] : [])),
      );
      const parties = all.filter((p) => !p.staffPersonId || members.has(p.staffPersonId));
      let templateId: string | null = null;
      if (old.templateVersionId) {
        const { template } = await this.templates.version(tx, old.templateVersionId);
        templateId = template.id;
      }
      return this.insertDraft(
        tx,
        staff,
        {
          unitId: old.unitId,
          tenantId: old.tenantId,
          templateId,
          startDate: start,
          endDate: end,
          monthlyRentMinor: rentOn(terms, terms.endDate),
          cycle: terms.cycle,
          initialAdvanceMonths: null,
          depositMinor: terms.depositMinor,
          serviceChargeMonthlyMinor: terms.serviceChargeMonthlyMinor,
          steps: [],
          breakClause: null,
          noticeDays: terms.noticeDays,
          use: terms.use,
          servicePhones: old.servicePhones,
          serviceEmails: old.serviceEmails,
          witnessRequired: old.witnessRequired,
          parties: parties.map((p) => ({
            role: p.partyRole as SignerRole,
            name: p.name,
            phone: p.phone,
            email: p.email,
            tenantContactId: p.tenantContactId,
            staffPersonId: p.staffPersonId,
            required: p.required,
          })),
        },
        { renewsLeaseId: leaseId },
      );
    });
    return this.view(staff, id);
  }

  // Trackers (TX-05, OQ-45, OQ-44) ----------------------------------------------------------------

  async recordRentControl(
    actor: Actor | null,
    leaseId: string,
    input: { readonly registrationNumber: string; readonly registeredOn: string },
  ): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const number = input.registrationNumber.trim();
    if (number.length < 2 || number.length > 40)
      throw invalid('registration_number', 'Enter the Rent Control registration number');
    await this.updateTracker(staff, leaseId, input.registeredOn, () => ({
      rentControlNumber: number,
      rentControlRegisteredOn: input.registeredOn,
    }));
    return this.view(staff, leaseId);
  }

  async recordStamping(
    actor: Actor | null,
    leaseId: string,
    input: { readonly stampedOn: string; readonly uploadId: string },
  ): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.uploadId,
      LEASE_FILE_UPLOAD,
    );
    await this.updateTracker(staff, leaseId, input.stampedOn, async (tx) => ({
      stampedOn: input.stampedOn,
      stampedDocumentId: await this.documents.recordStagedEvidence(
        tx,
        staged,
        'lease_stamped_copy',
      ),
    }));
    await this.documents.discardStagedUpload(staged);
    return this.view(staff, leaseId);
  }

  async recordFormalLease(
    actor: Actor | null,
    leaseId: string,
    input: {
      readonly practitioner?: string | null;
      readonly wetSignedUploadId?: string | null;
      readonly registeredOn?: string | null;
      readonly registrationNumber?: string | null;
    },
  ): Promise<LeaseView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    const staged = input.wetSignedUploadId
      ? await this.documents.stageEvidenceUpload(
          { companyId: staff.companyId, personId: staff.personId },
          input.wetSignedUploadId,
          LEASE_FILE_UPLOAD,
        )
      : null;
    await this.updateTracker(staff, leaseId, input.registeredOn ?? null, async (tx) => ({
      ...(input.practitioner !== undefined
        ? { formalPractitioner: input.practitioner?.trim().slice(0, 160) || null }
        : {}),
      ...(input.registeredOn !== undefined ? { formalRegisteredOn: input.registeredOn } : {}),
      ...(input.registrationNumber !== undefined
        ? { formalRegistrationNumber: input.registrationNumber?.trim().slice(0, 60) || null }
        : {}),
      ...(staged
        ? {
            formalWetSignedDocumentId: await this.documents.recordStagedEvidence(
              tx,
              staged,
              'lease_formal_copy',
            ),
          }
        : {}),
    }));
    if (staged) await this.documents.discardStagedUpload(staged);
    return this.view(staff, leaseId);
  }

  /** A presigned upload for a lease paper: the paper scan, a stamped copy or a formal lease. */
  async createUpload(
    actor: Actor | null,
    input: {
      readonly leaseId?: string | null;
      readonly contentType: string;
      readonly sizeBytes: number;
    },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    if (input.leaseId)
      await withCompany(this.database, staffContext(staff), (tx) => leaseRow(tx, input.leaseId!));
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      LEASE_FILE_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  /** A 5-minute link to a lease's paper: the signed copy, the stamped copy or the formal lease. */
  async fileUrl(
    actor: Actor | null,
    leaseId: string,
    which: 'signed' | 'stamped' | 'formal',
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view_terms');
    const row = await withCompany(this.database, staffContext(staff), (tx) =>
      leaseRow(tx, leaseId),
    );
    const documentId =
      which === 'signed'
        ? row.signedDocumentId
        : which === 'stamped'
          ? row.stampedDocumentId
          : row.formalWetSignedDocumentId;
    if (!documentId) throw notFound('Document');
    const url = await this.documents.downloadUrl(staff.companyId, documentId);
    if (!url) throw notFound('Document');
    return url;
  }

  /**
   * Asks to cancel a signed lease before its start date (decision 6): a second eligible person
   * approves through the approvals engine, and the database refuses the cancellation otherwise.
   */
  async requestCancelSigned(
    actor: Actor | null,
    leaseId: string,
    reason: string,
  ): Promise<ApprovalView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.cancel_signed');
    const why = reason.trim();
    if (why.length < CANCEL_REASON_MIN_LENGTH)
      throw invalid(
        'reason_required',
        `Give a reason of at least ${CANCEL_REASON_MIN_LENGTH} characters`,
      );
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await leaseRow(tx, leaseId);
      const company = await companyFacts(tx, found.companyId);
      if (found.status !== 'signed' || todayIn(this.clock, company.timeZone) >= found.startDate)
        throw conflict(
          'lease_started',
          'Only a signed lease that has not started can be cancelled',
        );
      return found;
    });
    return this.approvals.create(staff, {
      actionType: CANCEL_SIGNED_ACTION,
      subjectType: 'lease',
      subjectId: row.id,
      propertyId: row.propertyId,
      payload: {
        leaseId: row.id,
        reason: why.slice(0, 500),
        status: row.status,
        startDate: row.startDate,
      },
    });
  }

  // Internals ------------------------------------------------------------------------------------

  /**
   * Where a paper lease's billing starts (M4a decision 1): the first rent period that starts on
   * or after the day it is recorded, unless staff choose another period start (an earlier one
   * brings recent arrears in; a later one leaves out months paid before the platform).
   */
  private paperBillingStart(input: PaperLeaseInput, today: string): string {
    const terms = checkLeaseTerms({ ...input, use: input.use ?? 'residential' });
    if (!input.billingStartDate) return firstPeriodStartOnOrAfter(terms, today);
    try {
      return checkBillingStart(terms, input.billingStartDate);
    } catch (error) {
      if (error instanceof DomainError) throw invalid('billing_start', error.message);
      throw error;
    }
  }

  private async insertDraft(
    tx: Tx,
    staff: StaffActor,
    input: LeaseDraftInput,
    options: { readonly paper?: boolean; readonly renewsLeaseId?: string } = {},
  ): Promise<string> {
    const company = await companyFacts(tx, staff.companyId);
    const unit = await unitPlace(tx, input.unitId);
    if (!unit || unit.archived) throw notFound('Unit');
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(and(eq(schema.tenant.id, input.tenantId), isNull(schema.tenant.archivedAt)));
    if (!tenant) throw notFound('Tenant');
    const use: LeaseUse =
      input.use ?? (unit.billingBand === 'commercial' ? 'commercial' : 'residential');
    const terms = checkLeaseTerms({ ...input, use });
    const advance = await this.advanceCheck(company, terms);
    let templateVersionId: string | null = null;
    if (!options.paper) {
      await this.templates.ensureStarters(tx, staff.companyId, staff.personId);
      const starter: StarterTemplateKind = use === 'commercial' ? 'commercial' : 'residential';
      const templateId =
        input.templateId ?? (await this.templates.starterFor(tx, staff.companyId, starter));
      const latest = await this.templates.latestVersion(tx, templateId);
      if (!latest) throw notFound('Template');
      templateVersionId = latest.id;
    }
    const parties = checkParties(input.parties ?? (await this.defaultParties(tx, staff, tenant)));
    await assertStaffParties(tx, parties);
    const servicePhones = (input.servicePhones ?? (tenant.phone ? [tenant.phone] : [])).map((p) =>
      normalisePhone(p),
    );
    const serviceEmails = checkEmails(input.serviceEmails ?? (tenant.email ? [tenant.email] : []));
    try {
      const [row] = await tx
        .insert(schema.lease)
        .values({
          companyId: staff.companyId,
          propertyId: unit.propertyId,
          unitId: unit.id,
          tenantId: tenant.id,
          templateVersionId,
          ...this.termColumns(terms),
          ...advance.columns,
          servicePhones,
          serviceEmails,
          witnessRequired: input.witnessRequired ?? company.settings.witnessRequired,
          renewsLeaseId: options.renewsLeaseId ?? null,
          createdBy: staff.personId,
        })
        .returning();
      await this.replaceChildren(tx, row!, terms, parties);
      return row!.id;
    } catch (error) {
      if (sqlStateOf(error) === '23503')
        throw invalid('party_contact', 'A signer’s contact must be one of this tenant’s contacts');
      throw leaseWriteError(error);
    }
  }

  private termColumns(terms: LeaseTerms) {
    return {
      startDate: terms.startDate,
      endDate: terms.endDate,
      monthlyRentMinor: terms.monthlyRentMinor,
      rentCycle: terms.cycle,
      initialAdvanceMonths: terms.initialAdvanceMonths,
      depositMinor: terms.depositMinor,
      noticeDays: terms.noticeDays,
      use: terms.use,
      breakFromDate: terms.breakClause?.fromDate ?? null,
      breakParty: terms.breakClause?.party ?? null,
      breakNoticeDays: terms.breakClause?.noticeDays ?? null,
      breakCreditUnusedDays: terms.breakClause ? terms.breakClause.creditUnusedDays : null,
    };
  }

  /** Rewrites a draft's steps, service charge and (when given) parties. */
  private async replaceChildren(
    tx: Tx,
    row: LeaseRow,
    terms: LeaseTerms,
    parties: readonly PartyInput[] | null,
  ): Promise<void> {
    const ref = {
      companyId: row.companyId,
      propertyId: row.propertyId,
      tenantId: row.tenantId,
      leaseId: row.id,
    };
    await tx.delete(schema.rentStep).where(eq(schema.rentStep.leaseId, row.id));
    if (terms.steps.length > 0)
      await tx.insert(schema.rentStep).values(
        terms.steps.map((s) => ({
          ...ref,
          effectiveFrom: s.effectiveFrom,
          monthlyRentMinor: s.monthlyRentMinor,
        })),
      );
    await tx.delete(schema.leaseCharge).where(eq(schema.leaseCharge.leaseId, row.id));
    if (terms.serviceChargeMonthlyMinor)
      await tx.insert(schema.leaseCharge).values({
        ...ref,
        chargeType: 'service_charge',
        monthlyAmountMinor: terms.serviceChargeMonthlyMinor,
      });
    if (parties) {
      await tx.delete(schema.leaseParty).where(eq(schema.leaseParty.leaseId, row.id));
      if (parties.length > 0)
        await tx.insert(schema.leaseParty).values(
          parties.map((p, i) => ({
            ...ref,
            partyRole: p.role,
            name: p.name,
            phone: p.phone ?? null,
            email: p.email ?? null,
            tenantContactId: p.tenantContactId ?? null,
            staffPersonId: p.staffPersonId ?? null,
            required: p.required ?? true,
            position: i + 1,
            paperSignedOn: p.paperSignedOn ?? null,
          })),
        );
    }
  }

  /**
   * Who signs by default (plan 4.8): the tenant, or a company tenant's signatories; the guarantor;
   * and, for the landlord, the person drafting the lease. Staff add the witness.
   */
  private async defaultParties(
    tx: Tx,
    staff: StaffActor,
    tenant: typeof schema.tenant.$inferSelect,
  ): Promise<PartyInput[]> {
    const contacts = await tx
      .select()
      .from(schema.tenantContact)
      .where(
        and(
          eq(schema.tenantContact.tenantId, tenant.id),
          inArray(schema.tenantContact.kind, ['signatory', 'guarantor']),
          isNull(schema.tenantContact.archivedAt),
        ),
      )
      .orderBy(asc(schema.tenantContact.createdAt));
    const parties: PartyInput[] =
      (tenant.kind as TenantKind) === 'individual'
        ? [{ role: 'tenant', name: tenant.displayName, phone: tenant.phone, email: tenant.email }]
        : contacts
            .filter((c) => c.kind === 'signatory')
            .map((c) => ({
              role: 'signatory',
              name: c.name,
              phone: c.phone,
              email: c.email,
              tenantContactId: c.id,
            }));
    for (const c of contacts.filter((c) => c.kind === 'guarantor'))
      parties.push({
        role: 'guarantor',
        name: c.name,
        phone: c.phone,
        email: c.email,
        tenantContactId: c.id,
      });
    const [person] = await tx
      .select({
        name: schema.person.name,
        email: schema.person.email,
        phone: schema.person.phoneNumber,
      })
      .from(schema.person)
      .where(eq(schema.person.id, staff.personId));
    if (person)
      parties.push({
        role: 'landlord',
        name: person.name,
        email: person.email.endsWith('@users.invalid') ? null : person.email,
        phone: person.phone,
        staffPersonId: staff.personId,
      });
    return parties;
  }

  /**
   * The advance rent check on every save (AR-05; plan 4.12): the months the terms demand,
   * against the Act 220 s.25(5) rule for the term (unverified), with the rule version recorded.
   * `off` records only, `warn` flags, `block` refuses. Nothing calls an advance compliant.
   */
  private async advanceCheck(company: CompanyFacts, terms: LeaseTerms) {
    const asOf = parseBusinessDate(todayIn(this.clock, company.timeZone));
    const find = async (key: string): Promise<ResolvedRule | null> => {
      try {
        return await this.rules.resolve(company.countryCode, key, asOf);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'rule.missing') return null;
        throw error;
      }
    };
    const short = await find('advance_rent.max_months.monthly_or_shorter');
    const long = await find('advance_rent.max_months.over_six_months');
    const months = (rule: ResolvedRule | null) => {
      const value = (rule?.value as { months?: unknown } | null | undefined)?.months;
      return typeof value === 'number' ? value : null;
    };
    const check = checkAdvance(terms, {
      monthlyOrShorter: months(short),
      overSixMonths: months(long),
    });
    const policy = company.settings.advanceRentPolicy;
    const outcome = advanceOutcome(check, policy);
    const rule =
      check.rule === 'monthly_or_shorter' ? short : check.rule === 'over_six_months' ? long : null;
    if (outcome.refuse) {
      // The warning comes from the rule version used, never assumed (CLAUDE.md section 7).
      const warning = rule ? verificationWarning(rule.verificationStatus) : null;
      throw new AppError(
        422,
        'advance_over_limit',
        `These terms ask for ${check.monthsDemanded} months’ rent in advance; your company’s setting refuses more than ${check.limitMonths} for a lease of this length (Act 220 s.25(5)${warning ? `, ${warning}` : ''}).`,
      );
    }
    return {
      columns: {
        advanceMonthsDemanded: check.monthsDemanded,
        advanceRule: check.rule,
        advanceLimitMonths: check.limitMonths,
        advanceExceedsLimit: check.exceedsLimit,
        advanceRuleId: rule?.ruleId ?? null,
        advancePolicy: policy,
        advanceFlagged: outcome.flag,
        advanceCheckedAt: this.clock.now(),
      },
    };
  }

  private async updateTracker(
    staff: StaffActor,
    leaseId: string,
    doneOn: string | null,
    values: (
      tx: Tx,
    ) =>
      | Partial<typeof schema.lease.$inferInsert>
      | Promise<Partial<typeof schema.lease.$inferInsert>>,
  ): Promise<void> {
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (!SIGNED_STATES.includes(row.status as LeaseStatus))
        throw conflict('lease_not_signed', 'Trackers start once the lease is signed');
      const company = await companyFacts(tx, row.companyId);
      if (doneOn && doneOn > todayIn(this.clock, company.timeZone))
        throw invalid('date_in_future', 'The date cannot be in the future');
      if (doneOn) parseBusinessDate(doneOn);
      await tx
        .update(schema.lease)
        .set({ ...(await values(tx)), updatedAt: this.clock.now() })
        .where(eq(schema.lease.id, leaseId));
    });
  }

  private async view(target: StaffActor | Tx, leaseIdOrRow: string | LeaseRow): Promise<LeaseView> {
    if (typeof leaseIdOrRow === 'string') {
      const staff = target as StaffActor;
      return withCompany(this.database, staffContext(staff), async (tx) =>
        this.view(tx, await leaseRow(tx, leaseIdOrRow)),
      );
    }
    const tx = target as Tx;
    const row = leaseIdOrRow;
    const terms = await termsOf(tx, row);
    const place = await unitPlace(tx, row.unitId);
    const [tenant] = await tx
      .select({ displayName: schema.tenant.displayName, kind: schema.tenant.kind })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, row.tenantId));
    const parties = await tx
      .select()
      .from(schema.leaseParty)
      .where(eq(schema.leaseParty.leaseId, row.id))
      .orderBy(asc(schema.leaseParty.position));
    const [renewal] = await tx
      .select({
        id: schema.lease.id,
        status: schema.lease.status,
        startDate: schema.lease.startDate,
      })
      .from(schema.lease)
      .where(
        and(eq(schema.lease.renewsLeaseId, row.id), sql`${schema.lease.status} <> 'cancelled'`),
      );
    let template: LeaseView['template'] = null;
    if (row.templateVersionId) {
      const { version, template: t } = await this.templates.version(tx, row.templateVersionId);
      template = {
        templateId: t.id,
        versionId: version.id,
        name: t.name,
        version: version.version,
        counselReviewed: version.counselReviewedAt !== null,
      };
    }
    const ruleIds = [
      row.advanceRuleId,
      row.rentControlRuleId,
      row.stampRuleId,
      row.formalRuleId,
    ].filter((r): r is string => r !== null);
    const rules = ruleIds.length
      ? await tx.select().from(schema.rule).where(inArray(schema.rule.id, ruleIds))
      : [];
    const rule = (id: string | null) => ruleRef(rules.find((r) => r.id === id));
    return {
      access: 'full',
      id: row.id,
      status: row.status as LeaseStatus,
      use: row.use as LeaseUse,
      unit: {
        id: row.unitId,
        code: place?.code ?? '',
        propertyId: row.propertyId,
        propertyName: place?.propertyName ?? '',
      },
      tenant: {
        id: row.tenantId,
        displayName: tenant?.displayName ?? '',
        kind: (tenant?.kind as TenantKind | undefined) ?? 'individual',
      },
      template,
      terms: {
        startDate: terms.startDate,
        endDate: terms.endDate,
        monthlyRentMinor: terms.monthlyRentMinor,
        currency: 'GHS',
        cycle: terms.cycle,
        initialAdvanceMonths: terms.initialAdvanceMonths,
        depositMinor: terms.depositMinor,
        serviceChargeMonthlyMinor: terms.serviceChargeMonthlyMinor,
        steps: terms.steps,
        breakClause: terms.breakClause,
        noticeDays: terms.noticeDays,
        periodCount: terms.periodCount,
      },
      servicePhones: row.servicePhones,
      serviceEmails: row.serviceEmails,
      witnessRequired: row.witnessRequired,
      parties: parties.map((p): PartyView => ({
        id: p.id,
        role: p.partyRole as SignerRole,
        name: p.name,
        phone: p.phone,
        email: p.email,
        tenantContactId: p.tenantContactId,
        staffPersonId: p.staffPersonId,
        required: p.required,
        position: p.position,
        paperSignedOn: p.paperSignedOn,
      })),
      advanceFlag:
        row.advanceFlagged && row.advanceMonthsDemanded !== null && row.advanceLimitMonths !== null
          ? {
              monthsDemanded: row.advanceMonthsDemanded,
              limitMonths: row.advanceLimitMonths,
              rule: rule(row.advanceRuleId),
            }
          : null,
      signing: {
        signedAt: row.signedAt,
        method: (row.signingMethod as 'esign' | 'paper' | null) ?? null,
        signedOnPaper: row.signingMethod === 'paper',
        signedDocument: row.signedDocumentId !== null,
      },
      lifecycle: {
        activatedOn: row.activatedOn,
        holdingOverSince: row.holdingOverSince,
        endingReason: (row.endingReason as 'non_renewal' | 'notice' | null) ?? null,
        endingNote: row.endingNote,
        moveOutDate: row.moveOutDate,
        endedOn: row.endedOn,
        endReason: (row.endReason as LeaseEndReason | null) ?? null,
        cancelledAt: row.cancelledAt,
        cancelReason: row.cancelReason,
      },
      renewsLeaseId: row.renewsLeaseId,
      renewal: renewal
        ? { id: renewal.id, status: renewal.status as LeaseStatus, startDate: renewal.startDate }
        : null,
      trackers: {
        rentControl: {
          applies: row.rentControlApplies === true,
          deadline: row.rentControlDeadline,
          registrationNumber: row.rentControlNumber,
          registeredOn: row.rentControlRegisteredOn,
          done: row.rentControlRegisteredOn !== null,
          rule: rule(row.rentControlRuleId),
        },
        stamping: {
          deadline: row.stampDeadline,
          stampedOn: row.stampedOn,
          stampedCopy: row.stampedDocumentId !== null,
          done: row.stampedOn !== null && row.stampedDocumentId !== null,
          rule: rule(row.stampRuleId),
        },
        formalLease: {
          required: row.formalRequired === true,
          practitioner: row.formalPractitioner,
          wetSignedCopy: row.formalWetSignedDocumentId !== null,
          registeredOn: row.formalRegisteredOn,
          registrationNumber: row.formalRegistrationNumber,
          done:
            row.formalPractitioner !== null &&
            row.formalWetSignedDocumentId !== null &&
            row.formalRegisteredOn !== null,
          rule: rule(row.formalRuleId),
        },
      },
      counselReviewWarning: template !== null && !template.counselReviewed,
      createdAt: row.createdAt,
    };
  }
}

function checkEmails(emails: readonly string[]): string[] {
  return emails.map((e) => {
    const v = e.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
      throw invalid('email_invalid', 'Enter a valid email address');
    return v;
  });
}
