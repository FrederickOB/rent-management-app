import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { isRecurring, lineBalance, paymentShares } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { certificateLines, withholdingWriteOffLines } from '@rent/domain/ledger';
import { format, money, multiplyBps } from '@rent/domain/money';
import type { ApprovalStatus } from '@rent/domain/approvals';
import type { Actor, CertificateResource, StaffRole } from '@rent/domain/policy';
import {
  certificateDebitFor,
  openingCertificateDebit,
  checkWithholding,
  type WithholdingTaxTreatment,
} from '@rent/domain/tax';
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
import { RentTaxService, treatmentOf } from './rent-tax.service';

export const WITHHOLDING_WRITE_OFF_ACTION = 'withholding.write_off';
/** Decision 7: a single-user company's uploader confirms their certificate through this. */
export const CERTIFICATE_SELF_CONFIRM_ACTION = 'withholding.certificate_confirm';
/** Review 4: the same, to withdraw it instead (rejected, nothing posted). */
export const CERTIFICATE_SELF_WITHDRAW_ACTION = 'withholding.certificate_withdraw';
const SELF_ACTIONS = [CERTIFICATE_SELF_CONFIRM_ACTION, CERTIFICATE_SELF_WITHDRAW_ACTION] as const;
type SelfDecision = 'confirm' | 'withdraw';

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

const selfConfirmPayload = z
  .object({
    certificateId: uuid,
    withholdingId: uuid,
    leaseId: uuid,
    unitCode: z.string(),
    tenantName: z.string().nullable(),
    amountMinor: z.number().int().positive(),
    /** Decision fact: the certificate still waits (not confirmed or rejected since). */
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
  /** How its rent tax was treated when recorded (review 1); null for rows before 0028. */
  readonly rentTaxTreatment: WithholdingTaxTreatment | null;
  /** N1: things a person must act on, such as rent tax it replaced that GRA was already paid. */
  readonly warnings: readonly string[];
  readonly lines: readonly {
    readonly lineId: string;
    readonly invoiceNumber: string;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly lineAmountMinor: number;
    readonly withheldMinor: number;
    /** Decision 8: the month has not started, so the withholding is held as its advance. */
    readonly heldAsAdvance: boolean;
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
    readonly debitAccount: '2200' | '1160' | '3900' | null;
    /** Whether the person reading may confirm or reject it now (decision 3). */
    readonly mayDecide: boolean;
    /**
     * Decision 7: in a single-user company, the request through which the uploader confirms it
     * after the cooling-off with a TOTP code (`approvals.decide`, `self_confirm`).
     */
    readonly selfConfirmation: {
      readonly approvalId: string;
      readonly status: ApprovalStatus;
      readonly coolingOffUntil: Date | null;
    } | null;
    /** Review 4: the uploader's request to withdraw it, when nobody else may decide it. */
    readonly selfWithdrawal: {
      readonly approvalId: string;
      readonly status: ApprovalStatus;
      readonly coolingOffUntil: Date | null;
    } | null;
    /**
     * Review 4: whether the person reading, its uploader with nobody else to decide it and no
     * request open, may raise a fresh request to confirm or withdraw it.
     */
    readonly mayRequestSelfDecision: boolean;
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
      // Review 1: how the rent tax treats it is decided now and recorded with it; P20 follows it.
      const assessment = await this.rentTax.assessment(tx, state, input.valueDate);
      const id = uuidv7();
      const { posted, released } = await this.engine.withhold(tx, state, {
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
        rentTaxTreatment: treatmentOf(assessment),
      });
      await this.rentTax.onWithholding(
        tx,
        state,
        {
          id,
          paymentId: input.paymentId ?? null,
          valueDate: input.valueDate,
          lines: input.lines,
          rateBps,
          rateRuleId: rule.ruleId,
          causedBy: staff.personId,
          released,
        },
        assessment,
      );
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
          let cash = 0;
          for (const share of paymentShares(line.id, state.allocations).values()) cash += share;
          return {
            lineId: l.lineId,
            netMinor: b.netMinor,
            outstandingMinor: b.outstandingMinor,
            releasableMinor: cash,
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
      // Every invoiced month still owed: started ones (P19 settles the receivable) and, under
      // decision 8, ones not yet started (held as their advance until each month starts).
      const owed = state.lines
        .filter((l) => isRecurring(l.kind) && l.periodStart !== null)
        .map((l) => ({ line: l, balance: lineBalance(l, state.allocations) }))
        .filter((x) => x.balance.outstandingMinor > 0)
        .map(({ line, balance }) => ({
          lineId: line.id,
          invoiceId: line.invoiceId,
          invoiceNumber: formatInvoiceNumber(line.invoiceNumber),
          kind: line.kind as 'rent' | 'service_charge',
          periodStart: line.periodStart!,
          periodEnd: line.periodEnd!,
          started: line.periodStart! <= today,
          netMinor: balance.netMinor,
          outstandingMinor: balance.outstandingMinor,
          suggestedMinor: Math.min(
            balance.outstandingMinor,
            multiplyBps(money(balance.netMinor), rateBps).amountMinor,
          ),
        }));
      const lines = owed.filter((l) => l.started);
      const advanceLines = owed.filter((l) => !l.started);

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
        advanceLines,
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
      const confirmers = await membersWhoCan(
        tx,
        this.policy,
        company!,
        'withholding.confirm',
        { propertyId: w.propertyId, ownerId: w.ownerId },
        resource,
      );
      // Decision 7 (OQ-29): nobody but the uploader may confirm it, so they confirm it themselves
      // through a single-user request: after its cooling-off, with a code from their app.
      if (confirmers.length === 0)
        await this.approvals.createInTx(tx, staff, {
          actionType: CERTIFICATE_SELF_CONFIRM_ACTION,
          subjectType: 'withholding_certificate',
          subjectId: id,
          propertyId: w.propertyId,
          payload: {
            certificateId: id,
            withholdingId,
            leaseId: w.leaseId,
            unitCode: w.unitCode,
            tenantName: w.tenantName.slice(0, 200),
            amountMinor: w.amountMinor,
            open: true,
          },
        });
      for (const personId of confirmers)
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
      return {
        c,
        resource: await this.certificateResource(tx, company!, c.ownerId, c.uploadedBy),
        selfConfirm: await this.selfConfirmation(tx, c.id),
      };
    });
    if (
      found.c.uploadedBy === staff.personId &&
      found.selfConfirm &&
      ['pending', 'cooling_off'].includes(found.selfConfirm.status)
    )
      throw conflict(
        'certificate_self_confirm',
        'Nobody else can confirm this certificate, so you confirm it yourself after the cooling-off, with a code from your authenticator app (OQ-29).',
        { approvalId: found.selfConfirm.approvalId },
      );
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
      await this.confirmIn(tx, staff.companyId, c, staff.personId, null, today);
      await options.claim?.done(tx, { certificateId });
    });
  }

  /**
   * Review 4: a fresh single-user request from the certificate's uploader, to confirm it (P20,
   * decision 7) or to withdraw it (rejected, nothing posted), when nobody else may decide it and
   * no request is open: the one raised at upload was cancelled or expired, or the only other
   * person who could confirm it has left. It is decided as decision 7's is: after the cooling-off,
   * with a code from their authenticator app.
   */
  async requestSelfDecision(
    actor: Actor | null,
    certificateId: string,
    decision: SelfDecision,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const [c] = await tx
        .select()
        .from(schema.withholdingCertificate)
        .where(eq(schema.withholdingCertificate.id, certificateId));
      if (!c) throw notFound('Certificate');
      if (c.uploadedBy !== staff.personId)
        throw conflict(
          'certificate_not_yours',
          'Only the person who uploaded a certificate asks to decide it themselves',
        );
      const company = await companyRecord(tx, staff.companyId);
      const refusal = await this.selfDecisionRefusal(tx, company!, c);
      if (refusal) throw refusal;
      const w = await this.withholding(tx, c.withholdingId);
      const requestId = await this.approvals.createInTx(tx, staff, {
        actionType:
          decision === 'confirm'
            ? CERTIFICATE_SELF_CONFIRM_ACTION
            : CERTIFICATE_SELF_WITHDRAW_ACTION,
        subjectType: 'withholding_certificate',
        subjectId: c.id,
        propertyId: w.propertyId,
        payload: {
          certificateId: c.id,
          withholdingId: w.id,
          leaseId: w.leaseId,
          unitCode: w.unitCode,
          tenantName: w.tenantName.slice(0, 200),
          amountMinor: w.amountMinor,
          open: true,
        },
      });
      await options.claim?.done(tx, { certificateId: c.id });
      return requestId;
    });
  }

  /** Why the uploader may not raise a fresh request to decide a certificate now, or null. */
  private async selfDecisionRefusal(
    tx: Tx,
    company: { readonly id: string; readonly kind: string },
    c: typeof schema.withholdingCertificate.$inferSelect,
  ) {
    if (c.status !== 'awaiting_confirmation')
      return conflict('certificate_decided', 'This certificate was already confirmed or rejected');
    const [open] = await tx
      .select({ id: schema.approvalRequest.id })
      .from(schema.approvalRequest)
      .where(
        and(
          inArray(schema.approvalRequest.actionType, [...SELF_ACTIONS]),
          eq(schema.approvalRequest.subjectType, 'withholding_certificate'),
          eq(schema.approvalRequest.subjectId, c.id),
          inArray(schema.approvalRequest.status, ['pending', 'cooling_off']),
          sql`${schema.approvalRequest.expiresAt} > ${this.clock.now()}`,
        ),
      )
      .limit(1);
    if (open)
      return conflict(
        'approval_open',
        'A request to decide this certificate is already waiting. Decide it, withdraw it or wait for it to expire.',
        { requestId: open.id },
      );
    const resource = await this.certificateResource(tx, company, c.ownerId, c.uploadedBy);
    const others = await membersWhoCan(
      tx,
      this.policy,
      company,
      'withholding.confirm',
      { propertyId: c.propertyId, ownerId: c.ownerId },
      resource,
    );
    if (others.length > 0)
      return conflict(
        'certificate_others_decide',
        'Someone else can confirm or reject this certificate, so they decide it (decision 3)',
      );
    return null;
  }

  /**
   * P20 for a certificate waiting for confirmation, decided by `decidedBy`, in the caller's
   * transaction: the withholding settles the owner's rent tax (2200), or is a tax credit for a
   * letting business (1160). `selfConfirmRequestId` names the single-user request when the
   * uploader confirms (decision 7); the database checks it.
   */
  private async confirmIn(
    tx: Tx,
    companyId: string,
    c: typeof schema.withholdingCertificate.$inferSelect,
    decidedBy: string,
    selfConfirmRequestId: string | null,
    today: string,
  ): Promise<void> {
    const w = await this.withholding(tx, c.withholdingId);
    await this.refuseClosed(tx, c.withholdingId, true);
    // Review 1: from what was recorded with the withholding, never the owner's flag today: 2200
    // only when P17 accrued the amount withheld to 2200 (an item of kind `withholding`).
    // M11 founder decision 4 (OQ-64): withholding brought in at the cut-over (its entry is P25) has
    // no P17 item; its debit follows the owner's letting-business flag recorded with it then.
    const facts = await tx.execute<{ accrued: boolean; opening: boolean }>(
      sql`select exists (select 1 from rent_tax_item i where i.withholding_id = ${w.id}
            and i.kind = 'withholding') as accrued,
          exists (select 1 from journal_entry e where e.company_id = ${companyId}
            and e.id = ${w.entryId} and e.rule = 'P25') as opening`,
    );
    const debit = facts.rows[0]!.opening
      ? openingCertificateDebit({ lettingBusiness: w.rentTaxTreatment === 'letting_business' })
      : certificateDebitFor({ accruedToRentTax: facts.rows[0]!.accrued });
    const lease = await billingLeaseOf(tx, w.leaseId);
    const posted = await this.posting.post(tx, {
      companyId,
      rule: 'P20',
      key: `P20:${c.id}`,
      valueDate: today,
      lines: certificateLines({
        bookId: w.bookId,
        lease: dimsOf(lease),
        paymentId: w.paymentId,
        debit,
        amountMinor: w.amountMinor,
      }),
      record: { type: 'withholding_certificate', id: c.id },
      causedBy: decidedBy,
    });
    await tx
      .update(schema.withholdingCertificate)
      .set({
        status: 'confirmed',
        decidedBy,
        decidedAt: this.clock.now(),
        debitAccount: debit,
        entryId: posted!.entryId,
        valueDate: today,
        accountingDate: posted!.accountingDate,
        selfConfirmRequestId,
        updatedAt: this.clock.now(),
      })
      .where(eq(schema.withholdingCertificate.id, c.id));
  }

  /**
   * The latest request through which a certificate's uploader may confirm it (decision 7), or
   * withdraw it (review 4).
   */
  async selfConfirmation(
    tx: Tx,
    certificateId: string,
    decision: SelfDecision = 'confirm',
  ): Promise<{
    approvalId: string;
    mode: 'single_user' | 'two_person';
    status: ApprovalStatus;
    coolingOffUntil: Date | null;
  } | null> {
    const [r] = await tx
      .select({
        id: schema.approvalRequest.id,
        mode: schema.approvalRequest.mode,
        status: schema.approvalRequest.status,
        coolingOffUntil: schema.approvalRequest.coolingOffUntil,
      })
      .from(schema.approvalRequest)
      .where(
        and(
          eq(
            schema.approvalRequest.actionType,
            decision === 'confirm'
              ? CERTIFICATE_SELF_CONFIRM_ACTION
              : CERTIFICATE_SELF_WITHDRAW_ACTION,
          ),
          eq(schema.approvalRequest.subjectType, 'withholding_certificate'),
          eq(schema.approvalRequest.subjectId, certificateId),
        ),
      )
      .orderBy(desc(schema.approvalRequest.createdAt))
      .limit(1);
    return r
      ? {
          approvalId: r.id,
          mode: r.mode as 'single_user' | 'two_person',
          status: r.status as ApprovalStatus,
          coolingOffUntil: r.coolingOffUntil,
        }
      : null;
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

  /**
   * Registers the write-off with the approvals engine (two-person, P24), and the certificate a
   * single-user company's uploader confirms after the cooling-off (decision 7). Once per process.
   */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register({
      actionType: CERTIFICATE_SELF_CONFIRM_ACTION,
      // Raised only when nobody but the uploader may confirm: no role decides it but a nominated
      // approver, so it is single-user unless one joins (then they decide it).
      eligibleRoles: [],
      schema: selfConfirmPayload,
      onePerSubject: true,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string }).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof selfConfirmPayload>;
        const [c] = await tx
          .select({ status: schema.withholdingCertificate.status })
          .from(schema.withholdingCertificate)
          .where(eq(schema.withholdingCertificate.id, proposed.certificateId));
        return { ...proposed, open: c?.status === 'awaiting_confirmation' };
      },
      execute: async (tx, request, payload) => {
        const [c] = await tx
          .select()
          .from(schema.withholdingCertificate)
          .where(eq(schema.withholdingCertificate.id, payload.certificateId))
          .for('update');
        if (!c || c.status !== 'awaiting_confirmation')
          throw conflict(
            'certificate_decided',
            'This certificate was already confirmed or rejected',
          );
        const company = await companyRecord(tx, request.companyId);
        const today = isoNow(this.clock, company!.timeZone);
        if (request.mode === 'single_user') {
          await this.confirmIn(tx, request.companyId, c, request.initiatedBy, request.id, today);
          return;
        }
        // A nominated approver who joined since decided it: they confirm, as anyone else would.
        const [decision] = await tx
          .select({ decidedBy: schema.approvalDecision.decidedBy })
          .from(schema.approvalDecision)
          .where(
            and(
              eq(schema.approvalDecision.requestId, request.id),
              eq(schema.approvalDecision.kind, 'approve'),
            ),
          )
          .orderBy(desc(schema.approvalDecision.decidedAt))
          .limit(1);
        await this.confirmIn(tx, request.companyId, c, decision!.decidedBy, null, today);
      },
    });
    this.approvals.register({
      actionType: CERTIFICATE_SELF_WITHDRAW_ACTION,
      // Review 4: as the confirmation above, to withdraw the upload instead (nothing posts).
      eligibleRoles: [],
      schema: selfConfirmPayload,
      onePerSubject: true,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string }).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof selfConfirmPayload>;
        const [c] = await tx
          .select({ status: schema.withholdingCertificate.status })
          .from(schema.withholdingCertificate)
          .where(eq(schema.withholdingCertificate.id, proposed.certificateId));
        return { ...proposed, open: c?.status === 'awaiting_confirmation' };
      },
      execute: async (tx, request, payload) => {
        const [c] = await tx
          .select()
          .from(schema.withholdingCertificate)
          .where(eq(schema.withholdingCertificate.id, payload.certificateId))
          .for('update');
        if (!c || c.status !== 'awaiting_confirmation')
          throw conflict(
            'certificate_decided',
            'This certificate was already confirmed or rejected',
          );
        let decidedBy = request.initiatedBy;
        let named: string | null = request.id;
        if (request.mode !== 'single_user') {
          // A nominated approver who joined since decided it: they reject it, as anyone would.
          const [decision] = await tx
            .select({ decidedBy: schema.approvalDecision.decidedBy })
            .from(schema.approvalDecision)
            .where(
              and(
                eq(schema.approvalDecision.requestId, request.id),
                eq(schema.approvalDecision.kind, 'approve'),
              ),
            )
            .orderBy(desc(schema.approvalDecision.decidedAt))
            .limit(1);
          decidedBy = decision!.decidedBy;
          named = null;
        }
        await tx
          .update(schema.withholdingCertificate)
          .set({
            status: 'rejected',
            decidedBy,
            decidedAt: this.clock.now(),
            rejectReason: 'Withdrawn by the person who uploaded it',
            selfConfirmRequestId: named,
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.withholdingCertificate.id, c.id));
      },
    });
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
      started: boolean;
    }>(
      sql`select a.invoice_line_id as line_id, i.number as invoice_number, il.period_start::text,
            il.period_end::text, il.amount_minor as line_amount, sum(a.amount_minor)::bigint as withheld,
            exists (select 1 from invoice_line_accrual x where x.company_id = il.company_id
                    and x.invoice_line_id = il.id) as started
          from allocation a
          join invoice_line il on il.company_id = a.company_id and il.id = a.invoice_line_id
          join invoice i on i.company_id = il.company_id and i.id = il.invoice_id
          where a.record_type = 'withholding' and a.record_id = ${id} and a.source = 'withholding'
          group by a.invoice_line_id, i.number, il.period_start, il.period_end, il.amount_minor, il.company_id, il.id
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
    let mayRequestSelfDecision = false;
    if (live && live.status === 'awaiting_confirmation') {
      const resource = await this.certificateResource(tx, company, live.ownerId, live.uploadedBy);
      mayDecide = this.policy.can(staff, 'withholding.confirm', resource).allowed;
      mayRequestSelfDecision =
        live.uploadedBy === staff.personId &&
        (await this.selfDecisionRefusal(tx, company, live)) === null;
    }
    const paidBefore = await tx.execute<{ overpaid: string }>(
      sql`select coalesce(sum(greatest(0, paid - greatest(0, net))), 0)::bigint as overpaid from (
            select (select coalesce(sum(p.amount_minor), 0) from gra_payment_item p
                      where p.company_id = i.company_id and p.item_id = i.id) as paid,
                   i.tax_minor + (select coalesce(sum(c.tax_minor), 0) from rent_tax_item c
                      where c.company_id = i.company_id and c.reverses_item_id = i.id) as net
            from rent_tax_item i
            where i.id in (select o.reverses_item_id from rent_tax_item o
                           where o.withholding_id = ${id} and o.kind = 'withholding_offset')) x`,
    );
    const overpaid = Number(paidBefore.rows[0]?.overpaid ?? 0);
    const warnings =
      overpaid > 0
        ? [
            `GRA was already paid ${format(money(overpaid))} of the rent tax this withholding replaced. The owner's rent tax is overpaid by that much: reclaim it from GRA or set it against later rent tax.`,
          ]
        : [];
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
      rentTaxTreatment: (w.rentTaxTreatment as WithholdingTaxTreatment | null) ?? null,
      warnings,
      lines: lines.rows.map((l) => ({
        lineId: l.line_id,
        invoiceNumber: formatInvoiceNumber(Number(l.invoice_number)),
        periodStart: l.period_start,
        periodEnd: l.period_end,
        lineAmountMinor: Number(l.line_amount),
        withheldMinor: Number(l.withheld),
        heldAsAdvance: !l.started,
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
            debitAccount: live.debitAccount as '2200' | '1160' | '3900' | null,
            mayDecide,
            selfConfirmation: await this.selfConfirmation(tx, live.id).then((r) =>
              r && r.mode === 'single_user'
                ? { approvalId: r.approvalId, status: r.status, coolingOffUntil: r.coolingOffUntil }
                : null,
            ),
            selfWithdrawal: await this.selfConfirmation(tx, live.id, 'withdraw').then((r) =>
              r && r.mode === 'single_user'
                ? { approvalId: r.approvalId, status: r.status, coolingOffUntil: r.coolingOffUntil }
                : null,
            ),
            mayRequestSelfDecision,
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
