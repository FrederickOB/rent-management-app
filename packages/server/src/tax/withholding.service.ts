import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { isRecurring, lineBalance } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { certificateLines, withholdingWriteOffLines } from '@rent/domain/ledger';
import { money, multiplyBps } from '@rent/domain/money';
import type { Actor, CertificateResource, StaffRole } from '@rent/domain/policy';
import { certificateDebitAccount, checkWithholding } from '@rent/domain/tax';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { BillingEngine, type LeaseState } from '../billing/engine';
import { MONEY_APPROVERS } from '../billing/money.service';
import {
  dimsOf,
  formatInvoiceNumber,
  formatReceiptNumber,
  isoNow,
  leaseGroup,
  lockLeases,
  paymentsByIds,
  requireBook,
} from '../billing/records';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { queueMessage } from '../core/messages';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, WITHHOLDING_CERTIFICATE_UPLOAD } from '../documents/documents.service';
import { personContact } from '../identity/person-directory';
import { PostingService } from '../ledger/posting.service';
import { memberActors, membersWhoCan } from '../policy/members';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { billingLeaseOf } from '../tenancy/billing-facts';
import { RentTaxService } from './rent-tax.service';

export const WITHHOLDING_WRITE_OFF_ACTION = 'withholding.write_off';

const uuid = z.string().uuid();
const writeOffPayload = z
  .object({
    withholdingId: uuid,
    leaseId: uuid,
    unitCode: z.string(),
    tenantName: z.string().nullable(),
    amountMinor: z.number().int().positive(),
    valueDate: z.string(),
    reason: z.string().min(5).max(500),
    /** Decision facts, re-read at approval: a certificate confirmed since, or written off already. */
    open: z.boolean(),
  })
  .strict();

export interface WithholdingInput {
  readonly leaseId: string;
  /** The payment the tenant paid net with, when the withholding came with one. */
  readonly paymentId?: string | null;
  /** When the tenant withheld it: the payment's date, or the day it advised it. */
  readonly valueDate: string;
  readonly lines: readonly { readonly lineId: string; readonly amountMinor: number }[];
  readonly note?: string | null;
}

export interface WithholdingView {
  readonly id: string;
  readonly leaseId: string;
  readonly paymentId: string | null;
  readonly ownerId: string;
  readonly unitCode: string;
  readonly tenantName: string;
  readonly valueDate: string;
  readonly amountMinor: number;
  readonly rateBps: number;
  readonly rule: {
    readonly ruleId: string;
    readonly key: string;
    readonly verificationStatus: 'verified' | 'from_prd' | 'unverified';
  };
  readonly differsFromRate: boolean;
  readonly note: string | null;
  readonly lines: readonly {
    readonly lineId: string;
    readonly invoiceNumber: string;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly lineAmountMinor: number;
    readonly withheldMinor: number;
  }[];
  readonly status: 'awaiting_certificate' | 'certificate_uploaded' | 'certified' | 'written_off';
  readonly certificate: {
    readonly id: string;
    readonly status: 'awaiting_confirmation' | 'confirmed';
    readonly documentId: string;
    readonly certificateNumber: string | null;
    readonly issuedOn: string | null;
    readonly uploadedBy: string;
    readonly uploadedByName: string | null;
    readonly decidedBy: string | null;
    readonly decidedByName: string | null;
    readonly decidedAt: Date | null;
    readonly rejectReason: string | null;
    readonly debitAccount: '2200' | '1160' | null;
    /** Whether the person reading may confirm or reject it now (decision 3). */
    readonly mayDecide: boolean;
  } | null;
  readonly rejectedCertificates: number;
  readonly writeOff: {
    readonly id: string;
    readonly reason: string;
    readonly valueDate: string;
  } | null;
  readonly openWriteOffApprovalId: string | null;
  readonly createdAt: Date;
}

/**
 * Withholding tax (TX-04; P19, P20, P24; M5 plan 5.2, decision 3). A corporate tenant pays net and
 * withholds tax on particular lines: staff record it with its payment or later, pinned to those
 * lines. A manager uploads the certificate and a user for the owner confirms it (an agency admin
 * when the owner has none), never the uploader; the database refuses that too. Confirming posts
 * P20: the withholding settles the owner's rent tax, or is a tax credit for a letting business.
 * A certificate that never comes is written off with two-person approval.
 */
@Injectable()
export class WithholdingService {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(RentTaxService) private readonly rentTax: RentTaxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private unscoped(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  /** Records tax a corporate tenant withheld on particular lines (P19), with its rent tax. */
  async record(
    actor: Actor | null,
    input: WithholdingInput,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    parseBusinessDate(input.valueDate);
    // Seen in the person's own scope first; then written for the whole company, as every posting.
    await withCompany(this.database, staffContext(staff), (tx) =>
      billingLeaseOf(tx, input.leaseId),
    );
    return withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, input.leaseId));
      const state = await this.engine.load(tx, staff.companyId, input.leaseId);
      const book = requireBook(state.book);
      if (input.paymentId) {
        const [payment] = await paymentsByIds(tx, [input.paymentId]);
        if (!payment || payment.leaseId !== state.lease.id)
          throw invalid('payment', 'That payment is not one of this lease’s');
        if (payment.reversedAccountingDate)
          throw conflict('payment_reversed', 'That payment was reversed');
      }
      const rule = await this.rules.resolveIn(
        tx,
        state.company.countryCode,
        `withholding_tax.rate.${state.lease.use}`,
        parseBusinessDate(input.valueDate),
      );
      const rateBps = (rule.value as { bps: number }).bps;
      // Brought up to date before the lines are judged: a month that started is owed.
      await this.engine.carryOverIfStarted(tx, state, this.engine.today(state));
      await this.engine.accrue(tx, state, this.engine.today(state));
      const check = this.check(state, input.lines, rateBps);
      const id = uuidv7();
      const posted = await this.engine.withhold(tx, state, {
        withholdingId: id,
        paymentId: input.paymentId ?? null,
        lines: input.lines,
        valueDate: input.valueDate,
        causedBy: staff.personId,
      });
      await tx.insert(schema.withholding).values({
        id,
        companyId: staff.companyId,
        propertyId: state.lease.propertyId,
        tenantId: state.lease.tenantId,
        leaseId: state.lease.id,
        unitId: state.lease.unitId,
        ownerId: book.ownerId,
        bookId: book.bookId,
        paymentId: input.paymentId ?? null,
        valueDate: input.valueDate,
        accountingDate: posted.accountingDate,
        amountMinor: check.totalMinor,
        rateBps,
        rateRuleId: rule.ruleId,
        differsFromRate: check.differsFromRate.length > 0,
        note: input.note?.trim().slice(0, 500) || null,
        entryId: posted.entryId,
        recordedBy: staff.personId,
      });
      await this.rentTax.onWithholding(tx, state, {
        id,
        paymentId: input.paymentId ?? null,
        valueDate: input.valueDate,
        lines: input.lines,
        rateBps,
        rateRuleId: rule.ruleId,
        causedBy: staff.personId,
      });
      await options.claim?.done(tx, { withholdingId: id });
      return id;
    });
  }

  private check(
    state: LeaseState,
    lines: WithholdingInput['lines'],
    rateBps: number,
  ): ReturnType<typeof checkWithholding> {
    try {
      return checkWithholding(
        lines.map((l) => {
          const line = state.lines.find((x) => x.id === l.lineId);
          if (!line) throw invalid('line_not_found', 'That invoice line is not on this lease');
          const b = lineBalance(line, state.allocations);
          return {
            lineId: l.lineId,
            netMinor: b.netMinor,
            outstandingMinor: b.outstandingMinor,
            withheldMinor: l.amountMinor,
          };
        }),
        rateBps,
      );
    } catch (error) {
      if (error instanceof DomainError) throw invalid(error.code, error.message);
      throw error;
    }
  }

  /**
   * What the withholding form needs for a lease: the rent and service-charge months that have
   * started and are still owed, with the rate the rule gives for the lease's use as of the day
   * (`withholding_tax.rate.*`, unverified) and what it would withhold on each, and the lease's
   * recent payments the tenant may have paid net with.
   */
  async options(actor: Actor | null, leaseId: string, valueDate?: string | null) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      const today = this.engine.today(state);
      const date = valueDate ?? today;
      parseBusinessDate(date);
      const rule = await this.rules.resolveIn(
        tx,
        state.company.countryCode,
        `withholding_tax.rate.${state.lease.use}`,
        parseBusinessDate(date),
      );
      const rateBps = (rule.value as { bps: number }).bps;
      const lines = state.lines
        .filter((l) => isRecurring(l.kind) && l.periodStart !== null && l.periodStart <= today)
        .map((l) => ({ line: l, balance: lineBalance(l, state.allocations) }))
        .filter((x) => x.balance.outstandingMinor > 0)
        .map(({ line, balance }) => ({
          lineId: line.id,
          invoiceId: line.invoiceId,
          invoiceNumber: formatInvoiceNumber(line.invoiceNumber),
          kind: line.kind as 'rent' | 'service_charge',
          periodStart: line.periodStart!,
          periodEnd: line.periodEnd!,
          netMinor: balance.netMinor,
          outstandingMinor: balance.outstandingMinor,
          suggestedMinor: Math.min(
            balance.outstandingMinor,
            multiplyBps(money(balance.netMinor), rateBps).amountMinor,
          ),
        }));
      const recent = await tx.execute<{ id: string }>(
        sql`select p.id from payment p
            left join payment_match m on m.company_id = p.company_id and m.payment_id = p.id
            where p.lease_id = ${leaseId} or m.lease_id = ${leaseId}
            order by p.received_on desc, p.created_at desc limit 20`,
      );
      const payments = (
        await paymentsByIds(
          tx,
          recent.rows.map((r) => r.id),
        )
      ).filter((p) => p.reversedAccountingDate === null);
      const receipts = payments.length
        ? await tx
            .select({ paymentId: schema.receipt.paymentId, number: schema.receipt.number })
            .from(schema.receipt)
            .where(
              and(
                inArray(
                  schema.receipt.paymentId,
                  payments.map((p) => p.id),
                ),
                eq(schema.receipt.kind, 'receipt'),
              ),
            )
        : [];
      return {
        leaseId,
        valueDate: date,
        rate: {
          bps: rateBps,
          ruleId: rule.ruleId,
          key: rule.key,
          verificationStatus: rule.verificationStatus,
          warning: rule.warning,
        },
        lines,
        payments: payments
          .sort((a, b) => (a.row.receivedOn < b.row.receivedOn ? 1 : -1))
          .map((p) => ({
            paymentId: p.id,
            receivedOn: p.row.receivedOn,
            amountMinor: p.row.amountMinor,
            receiptNumber: (() => {
              const r = receipts.find((x) => x.paymentId === p.id);
              return r ? formatReceiptNumber(r.number) : null;
            })(),
          })),
      };
    });
  }

  // Certificates (P20; decision 3) ------------------------------------------------------------------

  /** A presigned upload for a withholding certificate (PDF or image). */
  async createUpload(
    actor: Actor | null,
    input: { readonly contentType: string; readonly sizeBytes: number },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      WITHHOLDING_CERTIFICATE_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  /** A manager uploads the certificate; the owner's users (or an admin) are told it waits. */
  async uploadCertificate(
    actor: Actor | null,
    withholdingId: string,
    input: {
      readonly uploadId: string;
      readonly certificateNumber?: string | null;
      readonly issuedOn?: string | null;
    },
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    if (input.issuedOn) parseBusinessDate(input.issuedOn);
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.uploadId,
      WITHHOLDING_CERTIFICATE_UPLOAD,
    );
    const id = uuidv7();
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const w = await this.withholding(tx, withholdingId);
      await this.refuseClosed(tx, withholdingId);
      const documentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'withholding_certificate',
      );
      await tx.insert(schema.withholdingCertificate).values({
        id,
        companyId: staff.companyId,
        withholdingId,
        propertyId: w.propertyId,
        tenantId: w.tenantId,
        leaseId: w.leaseId,
        ownerId: w.ownerId,
        documentId,
        certificateNumber: input.certificateNumber?.trim().slice(0, 80) || null,
        issuedOn: input.issuedOn ?? null,
        amountMinor: w.amountMinor,
        uploadedBy: staff.personId,
      });
      const company = await companyRecord(tx, staff.companyId);
      const resource = await this.certificateResource(tx, company!, w.ownerId, staff.personId);
      for (const personId of await membersWhoCan(
        tx,
        this.policy,
        company!,
        'withholding.confirm',
        { propertyId: w.propertyId, ownerId: w.ownerId },
        resource,
      ))
        await queueMessage(tx, staff.companyId, {
          recipient: { type: 'staff', personId },
          purpose: 'staff_notice',
          subject: 'A withholding certificate is waiting for you to confirm it',
          body: `A withholding tax certificate for ${w.unitCode} has been uploaded. Confirm it, or reject it, in Rent tax: withholding.`,
          channels: ['email'],
          propertyId: w.propertyId,
          related: { type: 'withholding', id: withholdingId },
          requestedBy: staff.personId,
        });
      await options.claim?.done(tx, { certificateId: id });
    });
    await this.documents.discardStagedUpload(staged);
    return id;
  }

  /** Confirms a certificate (P20): a user for the owner, or an admin for an owner with none. */
  async confirmCertificate(
    actor: Actor | null,
    certificateId: string,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<void> {
    await this.decide(actor, certificateId, { decision: 'confirm' }, options);
  }

  async rejectCertificate(
    actor: Actor | null,
    certificateId: string,
    reason: string,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<void> {
    await this.decide(actor, certificateId, { decision: 'reject', reason }, options);
  }

  private async decide(
    actor: Actor | null,
    certificateId: string,
    input:
      { readonly decision: 'confirm' } | { readonly decision: 'reject'; readonly reason: string },
    options: { readonly claim?: IdempotencyClaim | null },
  ): Promise<void> {
    const staff = staffActor(actor);
    // The certificate is found in the person's own scope, judged by the policy, then posted.
    const found = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [c] = await tx
        .select()
        .from(schema.withholdingCertificate)
        .where(eq(schema.withholdingCertificate.id, certificateId));
      if (!c) throw notFound('Certificate');
      const company = await companyRecord(tx, staff.companyId);
      return { c, resource: await this.certificateResource(tx, company!, c.ownerId, c.uploadedBy) };
    });
    this.policy.assert(staff, 'withholding.confirm', found.resource);
    await withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, found.c.leaseId));
      const [c] = await tx
        .select()
        .from(schema.withholdingCertificate)
        .where(eq(schema.withholdingCertificate.id, certificateId))
        .for('update');
      if (!c || c.status !== 'awaiting_confirmation')
        throw conflict('certificate_decided', 'This certificate was already confirmed or rejected');
      const company = await companyRecord(tx, staff.companyId);
      const today = isoNow(this.clock, company!.timeZone);
      if (input.decision === 'reject') {
        await tx
          .update(schema.withholdingCertificate)
          .set({
            status: 'rejected',
            decidedBy: staff.personId,
            decidedAt: this.clock.now(),
            rejectReason: input.reason.trim().slice(0, 500),
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.withholdingCertificate.id, certificateId));
        await options.claim?.done(tx, { certificateId });
        return;
      }
      const w = await this.withholding(tx, c.withholdingId);
      await this.refuseClosed(tx, c.withholdingId, true);
      const owner = (await ownerFacts(tx, [w.ownerId])).get(w.ownerId);
      if (!owner) throw notFound('Owner');
      const debit = certificateDebitAccount(owner);
      const lease = await billingLeaseOf(tx, w.leaseId);
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P20',
        key: `P20:${certificateId}`,
        valueDate: today,
        lines: certificateLines({
          bookId: w.bookId,
          lease: dimsOf(lease),
          paymentId: w.paymentId,
          debit,
          amountMinor: w.amountMinor,
        }),
        record: { type: 'withholding_certificate', id: certificateId },
        causedBy: staff.personId,
      });
      await tx
        .update(schema.withholdingCertificate)
        .set({
          status: 'confirmed',
          decidedBy: staff.personId,
          decidedAt: this.clock.now(),
          debitAccount: debit,
          entryId: posted!.entryId,
          valueDate: today,
          accountingDate: posted!.accountingDate,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.withholdingCertificate.id, certificateId));
      await options.claim?.done(tx, { certificateId });
    });
  }

  /**
   * The certificate's facts for the policy (decision 3): its owner, its uploader, and whether the
   * owner has a user of their own in the company.
   */
  async certificateResource(
    tx: Tx,
    company: { readonly id: string; readonly kind: string },
    ownerId: string,
    uploadedBy: string,
  ): Promise<CertificateResource> {
    const people = await memberActors(tx, company);
    return {
      kind: 'certificate',
      ownerId,
      uploadedBy,
      ownerHasUser: people.some((p) => this.policy.actsForOwner(p, ownerId)),
    };
  }

  /**
   * A certificate cannot be added once one waits or is confirmed, nor confirmed once another is,
   * nor anything done once the withholding is written off; a write-off waits for none either.
   */
  private async refuseClosed(tx: Tx, withholdingId: string, allowWaiting = false): Promise<void> {
    const rows = await tx.execute<{ certified: boolean; written_off: boolean; waiting: boolean }>(
      sql`select
            exists (select 1 from withholding_certificate c where c.withholding_id = ${withholdingId} and c.status = 'confirmed') as certified,
            exists (select 1 from withholding_write_off o where o.withholding_id = ${withholdingId}) as written_off,
            exists (select 1 from withholding_certificate c where c.withholding_id = ${withholdingId}
                    and c.status = 'awaiting_confirmation') as waiting`,
    );
    const r = rows.rows[0]!;
    if (r.certified)
      throw conflict(
        'certificate_confirmed',
        'A certificate is already confirmed for this withholding',
      );
    if (r.written_off)
      throw conflict('withholding_written_off', 'This withholding was written off');
    if (r.waiting && !allowWaiting)
      throw conflict(
        'certificate_waiting',
        'A certificate is waiting to be confirmed; confirm or reject it first',
      );
  }

  private async withholding(tx: Tx, id: string) {
    const [w] = await tx.select().from(schema.withholding).where(eq(schema.withholding.id, id));
    if (!w) throw notFound('Withholding');
    const lease = await billingLeaseOf(tx, w.leaseId);
    return { ...w, unitCode: lease.unitCode, tenantName: lease.tenantName };
  }

  // Write-off (P24 on 1150) -------------------------------------------------------------------------

  /** Asks to write off withholding whose certificate never came; a second person approves (P24). */
  async requestWriteOff(
    actor: Actor | null,
    withholdingId: string,
    input: { readonly reason: string },
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const w = await this.withholding(tx, withholdingId);
      await this.refuseClosed(tx, withholdingId);
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: WITHHOLDING_WRITE_OFF_ACTION,
        subjectType: 'withholding',
        subjectId: withholdingId,
        propertyId: w.propertyId,
        payload: {
          withholdingId,
          leaseId: w.leaseId,
          unitCode: w.unitCode,
          tenantName: w.tenantName.slice(0, 200),
          amountMinor: w.amountMinor,
          valueDate: w.valueDate,
          reason: input.reason.trim(),
          open: true,
        },
      });
      await options.claim?.done(tx, id);
      return id;
    });
  }

  /** Registers the write-off with the approvals engine (two-person, P24). Once per process. */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register({
      actionType: WITHHOLDING_WRITE_OFF_ACTION,
      eligibleRoles: MONEY_APPROVERS as readonly StaffRole[],
      schema: writeOffPayload,
      onePerSubject: true,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string }).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof writeOffPayload>;
        let open = true;
        try {
          await this.refuseClosed(tx, proposed.withholdingId);
        } catch {
          open = false;
        }
        return { ...proposed, open };
      },
      execute: async (tx, request, payload) => {
        const w = await this.withholding(tx, payload.withholdingId);
        const lease = await billingLeaseOf(tx, w.leaseId);
        const company = await companyRecord(tx, request.companyId);
        const today = isoNow(this.clock, company!.timeZone);
        const id = uuidv7();
        const posted = await this.posting.post(tx, {
          companyId: request.companyId,
          rule: 'P24',
          key: `P24:${id}`,
          valueDate: today,
          lines: withholdingWriteOffLines({
            bookId: w.bookId,
            lease: dimsOf(lease),
            paymentId: w.paymentId,
            amountMinor: w.amountMinor,
          }),
          record: { type: 'withholding_write_off', id },
          causedBy: request.initiatedBy,
        });
        await tx.insert(schema.withholdingWriteOff).values({
          id,
          companyId: request.companyId,
          withholdingId: w.id,
          propertyId: w.propertyId,
          tenantId: w.tenantId,
          leaseId: w.leaseId,
          amountMinor: w.amountMinor,
          reason: payload.reason,
          approvalRequestId: request.id,
          entryId: posted!.entryId,
          valueDate: today,
          accountingDate: posted!.accountingDate,
          createdBy: request.initiatedBy,
        });
      },
    });
  }

  // Reading -----------------------------------------------------------------------------------------

  /** Withholding on a lease, a payment or an owner, with its lines, certificate and write-off. */
  async list(
    actor: Actor | null,
    filter: {
      readonly leaseId?: string;
      readonly paymentId?: string;
      readonly ownerId?: string;
      readonly status?: WithholdingView['status'];
    },
  ): Promise<WithholdingView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const conditions = [sql`true`];
      if (filter.leaseId) conditions.push(sql`w.lease_id = ${filter.leaseId}`);
      if (filter.paymentId) conditions.push(sql`w.payment_id = ${filter.paymentId}`);
      if (filter.ownerId) conditions.push(sql`w.owner_id = ${filter.ownerId}`);
      const rows = await tx.execute<{ id: string }>(
        sql`select w.id from withholding w where ${sql.join(conditions, sql` and `)}
            order by w.value_date desc, w.created_at desc limit 500`,
      );
      const company = await companyRecord(tx, staff.companyId);
      const out: WithholdingView[] = [];
      for (const { id } of rows.rows) {
        const view = await this.view(tx, staff, company!, id);
        if (!filter.status || view.status === filter.status) out.push(view);
      }
      return out;
    });
  }

  async get(actor: Actor | null, id: string): Promise<WithholdingView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyRecord(tx, staff.companyId);
      return this.view(tx, staff, company!, id);
    });
  }

  private async view(
    tx: Tx,
    staff: StaffActor,
    company: { readonly id: string; readonly kind: string },
    id: string,
  ): Promise<WithholdingView> {
    const w = await this.withholding(tx, id);
    const [rule] = await tx.select().from(schema.rule).where(eq(schema.rule.id, w.rateRuleId));
    const lines = await tx.execute<{
      line_id: string;
      invoice_number: string;
      period_start: string | null;
      period_end: string | null;
      line_amount: string;
      withheld: string;
    }>(
      sql`select a.invoice_line_id as line_id, i.number as invoice_number, il.period_start::text,
            il.period_end::text, il.amount_minor as line_amount, sum(a.amount_minor)::bigint as withheld
          from allocation a
          join invoice_line il on il.company_id = a.company_id and il.id = a.invoice_line_id
          join invoice i on i.company_id = il.company_id and i.id = il.invoice_id
          where a.record_type = 'withholding' and a.record_id = ${id}
          group by a.invoice_line_id, i.number, il.period_start, il.period_end, il.amount_minor
          order by il.period_start nulls last`,
    );
    const certificates = await tx
      .select()
      .from(schema.withholdingCertificate)
      .where(eq(schema.withholdingCertificate.withholdingId, id))
      .orderBy(schema.withholdingCertificate.createdAt);
    const live = certificates.find((c) => c.status !== 'rejected') ?? null;
    const [writeOff] = await tx
      .select()
      .from(schema.withholdingWriteOff)
      .where(eq(schema.withholdingWriteOff.withholdingId, id));
    const open = await this.approvals.openFor(tx, [id]);
    let mayDecide = false;
    if (live && live.status === 'awaiting_confirmation') {
      const resource = await this.certificateResource(tx, company, live.ownerId, live.uploadedBy);
      mayDecide = this.policy.can(staff, 'withholding.confirm', resource).allowed;
    }
    return {
      id: w.id,
      leaseId: w.leaseId,
      paymentId: w.paymentId,
      ownerId: w.ownerId,
      unitCode: w.unitCode,
      tenantName: w.tenantName,
      valueDate: w.valueDate,
      amountMinor: w.amountMinor,
      rateBps: w.rateBps,
      rule: {
        ruleId: w.rateRuleId,
        key: rule?.key ?? '',
        verificationStatus: (rule?.verificationStatus ?? 'unverified') as
          'verified' | 'from_prd' | 'unverified',
      },
      differsFromRate: w.differsFromRate,
      note: w.note,
      lines: lines.rows.map((l) => ({
        lineId: l.line_id,
        invoiceNumber: formatInvoiceNumber(Number(l.invoice_number)),
        periodStart: l.period_start,
        periodEnd: l.period_end,
        lineAmountMinor: Number(l.line_amount),
        withheldMinor: Number(l.withheld),
      })),
      status: writeOff
        ? 'written_off'
        : live?.status === 'confirmed'
          ? 'certified'
          : live
            ? 'certificate_uploaded'
            : 'awaiting_certificate',
      certificate: live
        ? {
            id: live.id,
            status: live.status as 'awaiting_confirmation' | 'confirmed',
            documentId: live.documentId,
            certificateNumber: live.certificateNumber,
            issuedOn: live.issuedOn,
            uploadedBy: live.uploadedBy,
            uploadedByName: (await personContact(tx, live.uploadedBy))?.name ?? null,
            decidedBy: live.decidedBy,
            decidedByName: live.decidedBy
              ? ((await personContact(tx, live.decidedBy))?.name ?? null)
              : null,
            decidedAt: live.decidedAt,
            rejectReason: live.rejectReason,
            debitAccount: live.debitAccount as '2200' | '1160' | null,
            mayDecide,
          }
        : null,
      rejectedCertificates: certificates.filter((c) => c.status === 'rejected').length,
      writeOff: writeOff
        ? { id: writeOff.id, reason: writeOff.reason, valueDate: writeOff.valueDate }
        : null,
      openWriteOffApprovalId: open.get(id) ?? null,
      createdAt: w.createdAt,
    };
  }

  /** The withholding a certificate belongs to, in the person's scope. */
  async withholdingOfCertificate(actor: Actor | null, certificateId: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [c] = await tx
        .select({ withholdingId: schema.withholdingCertificate.withholdingId })
        .from(schema.withholdingCertificate)
        .where(eq(schema.withholdingCertificate.id, certificateId));
      if (!c) throw notFound('Certificate');
      return c.withholdingId;
    });
  }

  /** An approval request's view, for the API's responses. */
  approval(actor: Actor | null, id: string) {
    return this.approvals.get(actor, id);
  }

  /** Whether a document is a certificate the person may see (for the download route). */
  async certificateDocumentVisible(tx: Tx, documentId: string): Promise<boolean> {
    const [c] = await tx
      .select({ id: schema.withholdingCertificate.id })
      .from(schema.withholdingCertificate)
      .where(and(eq(schema.withholdingCertificate.documentId, documentId)));
    return Boolean(c);
  }
}
