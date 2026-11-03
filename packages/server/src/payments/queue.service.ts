import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { unmatchedRefundLines, type CashAccount } from '@rent/domain/ledger';
import { suggestMatches, type MatchCandidate, type MatchReason } from '@rent/domain/payments';
import { moneySummary } from '@rent/domain/billing';
import { creditPools } from '@rent/domain/billing';
import { tryNormalisePhone } from '@rent/domain/phone';
import type { Actor, StaffRole } from '@rent/domain/policy';
import { ProviderError, type AlertPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { BillingEngine } from '../billing/engine';
import { companyRecord, staffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { conflict, invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, DATABASE, FIELD_CIPHER, PAYMENT_PROVIDERS } from '../core/tokens';
import type { Clock } from '../core/clock';
import { CLOCK } from '../core/tokens';
import { DocumentsService, TRANSFER_PROOF_UPLOAD } from '../documents/documents.service';
import { isoNow, lockPayment, paymentsByIds } from '../billing/records';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';

export const REFUND_ACTION = 'payment.refund_unmatched';
/** The job that makes an approved provider refund and posts P31 once the provider accepts it. */
export const REFUND_JOB = 'payments.refund-unmatched';

const APPROVERS: readonly StaffRole[] = ['owner', 'agency_admin', 'accountant'];
const PAYABLE = ['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated'];

const uuid = z.string().uuid();
const refundPayload = z
  .object({
    refundId: uuid,
    paymentId: uuid,
    amountMinor: z.number().int().positive(),
    receivedOn: z.string(),
    method: z.string(),
    receivedInto: z.enum(['provider', 'owner_account', 'agency_account']),
    ownerName: z.string().nullable(),
    payerName: z.string().nullable(),
    payerPhoneMasked: z.string().nullable(),
    reason: z.string().min(5).max(500),
    /** The transfer refund's proof, for the approver; absent for a provider refund. */
    evidenceDocumentId: uuid.nullable(),
    /** Still unmatched, unreversed and not refunded. */
    refundable: z.boolean(),
  })
  .strict();

export interface SuggestionView {
  readonly leaseId: string;
  readonly tenantName: string;
  readonly unitCode: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

export type ExceptionKind =
  | 'missing_here'
  | 'missing_at_provider'
  | 'amount_differs'
  | 'not_successful_at_provider'
  | 'settlement_difference'
  | 'verified_amount_differs'
  | 'receipt_late';

export interface ExceptionView {
  readonly id: string;
  readonly kind: ExceptionKind;
  readonly provider: string;
  readonly reference: string | null;
  readonly settlementId: string | null;
  readonly detail: string;
  readonly amountMinor: number | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
}

/**
 * The unmatched queue (BC-12; M4b plan 4.5): ranked suggestions for money no lease claimed, a
 * person's confirmation of each match (MoneyService.match, P23), refunds of money that belongs
 * to no one (P31, two people), and the exceptions reconciliation raised.
 */
@Injectable()
export class QueueService {
  private registered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Leases this money may belong to, ranked (BC-12): an exact open amount, the paying phone
   * against the tenant's phones (compared as keyed hashes), earlier payments from the same phone,
   * a date near a due date, and the payer's name. Money in an owner's account is suggested only
   * that owner's leases. A person still confirms every match.
   */
  async suggestions(actor: Actor | null, paymentId: string): Promise<SuggestionView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [payment] = await paymentsByIds(tx, [paymentId]);
      if (!payment || payment.leaseId || payment.reversedAccountingDate)
        throw notFound('Unmatched receipt');
      const leases = await tx.execute<{
        id: string;
        tenant_id: string;
        tenant_name: string;
        unit_code: string;
        phone: string | null;
        owner_id: string | null;
      }>(
        sql`select l.id, l.tenant_id, coalesce(t.legal_name, t.display_name) as tenant_name, u.code as unit_code,
              t.phone,
              (select po.owner_id from property_current_ownership po where po.company_id = l.company_id
                 and po.property_id = l.property_id order by po.share_bps desc limit 1) as owner_id
            from lease l
            join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            where l.status in ('signed', 'active', 'ending', 'holding_over', 'ended')`,
      );
      const candidates: MatchCandidate[] = [];
      const names = new Map<string, { tenantName: string; unitCode: string }>();
      for (const lease of leases.rows) {
        if (payment.row.ownerId && lease.owner_id !== payment.row.ownerId) continue;
        const state = await this.engine.load(tx, staff.companyId, lease.id);
        if (!PAYABLE.includes(state.lease.status)) continue;
        const walk = this.engine.walk(state);
        const today = this.engine.today(state);
        const summary = moneySummary({
          lines: state.lines,
          allocations: state.allocations,
          pools: creditPools(state.payments, state.allocations),
          walk,
          today,
        });
        const invoices = new Map<string, number>();
        for (const line of state.lines) {
          const walked = walk.lines.find((w) => w.lineId === line.id);
          const left = walked ? walked.remainingMinor : 0;
          invoices.set(line.invoiceId, (invoices.get(line.invoiceId) ?? 0) + Math.max(0, left));
        }
        const contacts = await tx
          .select({ phone: schema.tenantContact.phone })
          .from(schema.tenantContact)
          .where(
            and(
              eq(schema.tenantContact.tenantId, lease.tenant_id),
              isNull(schema.tenantContact.archivedAt),
            ),
          );
        const phones = [lease.phone, ...contacts.map((c) => c.phone)]
          .flatMap((p) => (p ? [tryNormalisePhone(p)] : []))
          .flatMap((p) => (p ? [this.cipher.blindIndex(staff.companyId, `phone:${p}`)] : []));
        const previous = await tx
          .selectDistinct({ index: schema.payment.payerPhoneIndex })
          .from(schema.payment)
          .where(
            and(
              eq(schema.payment.leaseId, lease.id),
              sql`${schema.payment.payerPhoneIndex} is not null`,
            ),
          );
        const monthly = state.schedule
          .filter((s) => s.periodStart <= today)
          .slice(-2)
          .reduce((sum, s) => sum + s.amountMinor, 0);
        candidates.push({
          leaseId: lease.id,
          tenantName: lease.tenant_name,
          dueNowMinor: summary.dueNowMinor,
          openInvoiceMinor: [...invoices.values()].filter((v) => v > 0),
          monthlyMinor: monthly,
          phones,
          dueDates: [...new Set(state.lines.map((l) => l.dueDate))],
          previousPayerPhones: previous.flatMap((p) => (p.index ? [p.index] : [])),
        });
        names.set(lease.id, { tenantName: lease.tenant_name, unitCode: lease.unit_code });
      }
      const ranked = suggestMatches(
        {
          amountMinor: payment.amountMinor,
          receivedOn: payment.row.receivedOn,
          payerPhone: payment.row.payerPhoneIndex,
          payerName: payment.row.payerName ?? payment.row.senderReference,
        },
        candidates,
      );
      return ranked.map((r) => ({ ...r, ...names.get(r.leaseId)! }));
    });
  }

  /**
   * Asks to refund money that belongs to no lease to its payer (P31; plan 4.5). Provider money is
   * refunded through the provider once a second person approves; a transfer is refunded outside
   * the platform and recorded with its proof.
   */
  async requestRefund(
    actor: Actor | null,
    paymentId: string,
    input: { readonly reason: string; readonly proofUploadId?: string | null },
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payment.refund_unmatched');
    const [payment] = await withCompany(this.database, staffContext(staff), (tx) =>
      paymentsByIds(tx, [paymentId]),
    );
    if (!payment) throw notFound('Unmatched receipt');
    const provider = payment.row.cashAccount === '1050';
    if (!provider && !input.proofUploadId)
      throw invalid('proof_required', 'Attach proof of the transfer refunded to the payer');
    const staged = input.proofUploadId
      ? await this.documents.stageEvidenceUpload(
          { companyId: staff.companyId, personId: staff.personId },
          input.proofUploadId,
          TRANSFER_PROOF_UPLOAD,
        )
      : null;
    const refundId = uuidv7();
    const approvalId = await withCompany(
      this.database,
      { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
      async (tx) => {
        await lockPayment(tx, staff.companyId, paymentId);
        // A refund whose request was rejected, withdrawn or expired never happened: it stops
        // holding the payment's place, so another may be asked for.
        await this.closeStaleRefunds(tx, paymentId);
        const [fresh] = await paymentsByIds(tx, [paymentId]);
        if (!fresh || fresh.leaseId || fresh.reversedAccountingDate)
          throw conflict(
            'payment_not_unmatched',
            'Only money that belongs to no lease is refunded this way',
          );
        const proofId = staged
          ? await this.documents.recordStagedEvidence(tx, staged, 'transfer_proof')
          : null;
        const owner = fresh.row.ownerId
          ? (await ownerFacts(tx, [fresh.row.ownerId])).get(fresh.row.ownerId)
          : null;
        const id = await this.approvals.createInTx(tx, staff, {
          actionType: REFUND_ACTION,
          subjectType: 'payment',
          subjectId: paymentId,
          propertyId: null,
          payload: {
            refundId,
            paymentId,
            amountMinor: fresh.amountMinor,
            receivedOn: fresh.row.receivedOn,
            method: fresh.row.method,
            receivedInto: provider
              ? 'provider'
              : fresh.row.cashAccount === '1070'
                ? 'agency_account'
                : 'owner_account',
            ownerName: owner?.name.slice(0, 200) ?? null,
            payerName: fresh.row.payerName,
            payerPhoneMasked: fresh.row.payerPhoneMasked,
            reason: input.reason.trim().slice(0, 500),
            evidenceDocumentId: proofId,
            refundable: true,
          },
        });
        await tx.insert(schema.unmatchedRefund).values({
          id: refundId,
          companyId: staff.companyId,
          paymentId,
          ownerId: fresh.row.ownerId,
          amountMinor: fresh.amountMinor,
          reason: input.reason.trim().slice(0, 500),
          proofDocumentId: proofId,
          approvalRequestId: id,
          requestedBy: staff.personId,
        });
        return id;
      },
    );
    if (staged) await this.documents.discardStagedUpload(staged);
    return approvalId;
  }

  /**
   * The refund job (plan 4.12): makes an approved provider refund outside any transaction, then
   * posts P31 (Dr 2090, Cr 1050) in the book holding the suspense. Idempotent: a refund already
   * made is not made again (the provider keys it on the charge).
   */
  async refundWithProvider(companyId: string, refundId: string): Promise<'refunded' | 'skipped'> {
    const ctx = { companyId, actorKind: 'system' as const };
    const loaded = await withCompany(this.database, ctx, async (tx) => {
      const [refund] = await tx
        .select()
        .from(schema.unmatchedRefund)
        .where(eq(schema.unmatchedRefund.id, refundId));
      if (!refund || refund.status !== 'approved') return null;
      const [payment] = await paymentsByIds(tx, [refund.paymentId]);
      return payment ? { refund, payment } : null;
    });
    if (!loaded) return 'skipped';
    const { refund, payment } = loaded;
    if (!payment.row.provider || !payment.row.providerReference) return 'skipped';
    let result;
    try {
      result = await this.providers.get(payment.row.provider).refund({
        reference: payment.row.providerReference,
        amountMinor: refund.amountMinor,
      });
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable) {
        await withCompany(this.database, ctx, (tx) =>
          tx
            .update(schema.unmatchedRefund)
            .set({
              status: 'failed',
              failureReason: 'provider_refused',
              updatedAt: this.clock.now(),
            })
            .where(
              and(
                eq(schema.unmatchedRefund.id, refundId),
                eq(schema.unmatchedRefund.status, 'approved'),
              ),
            ),
        );
        await this.alerts.raise({
          severity: 'warning',
          code: 'payments.refund_refused',
          message: 'The provider refused a refund of unmatched money',
          context: { companyId, refundId },
        });
        return 'skipped';
      }
      throw error;
    }
    await withCompany(this.database, ctx, async (tx) => {
      await lockPayment(tx, companyId, payment.id);
      const [current] = await tx
        .select()
        .from(schema.unmatchedRefund)
        .where(eq(schema.unmatchedRefund.id, refundId))
        .for('update');
      if (current?.status !== 'approved') return;
      await this.postRefund(tx, companyId, refundId, payment, '1050', result.refundReference);
    });
    return 'refunded';
  }

  async closeStaleRefunds(tx: Tx, paymentId: string): Promise<void> {
    const waiting = await tx
      .select({
        id: schema.unmatchedRefund.id,
        approvalId: schema.unmatchedRefund.approvalRequestId,
      })
      .from(schema.unmatchedRefund)
      .where(
        and(
          eq(schema.unmatchedRefund.paymentId, paymentId),
          eq(schema.unmatchedRefund.status, 'awaiting_approval'),
        ),
      );
    if (waiting.length === 0) return;
    const requests = await this.approvals.requestsIn(
      tx,
      waiting.map((w) => w.approvalId),
    );
    for (const w of waiting) {
      const status = requests.get(w.approvalId)?.status;
      if (status && ['rejected', 'cancelled', 'expired'].includes(status))
        await tx
          .update(schema.unmatchedRefund)
          .set({ status: 'rejected', updatedAt: this.clock.now() })
          .where(eq(schema.unmatchedRefund.id, w.id));
    }
  }

  private async postRefund(
    tx: Tx,
    companyId: string,
    refundId: string,
    payment: Awaited<ReturnType<typeof paymentsByIds>>[number],
    account: CashAccount,
    providerRefundRef: string | null,
  ): Promise<void> {
    const company = await companyRecord(tx, companyId);
    const posted = await this.posting.post(tx, {
      companyId,
      rule: 'P31',
      key: `P31:${refundId}`,
      valueDate: isoNow(this.clock, company!.timeZone),
      lines: unmatchedRefundLines({
        from: {
          bookId: payment.row.bookId,
          account,
          provider: account === '1050' ? payment.row.provider : null,
          settlementAccountId: account === '1050' ? payment.row.settlementAccountId : null,
        },
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
      }),
      record: { type: 'unmatched_refund', id: refundId },
      causedBy: null,
    });
    await tx
      .update(schema.unmatchedRefund)
      .set({
        status: 'refunded',
        entryId: posted!.entryId,
        providerRefundRef,
        updatedAt: this.clock.now(),
      })
      .where(eq(schema.unmatchedRefund.id, refundId));
  }

  /** What reconciliation could not explain (CLAUDE.md section 8), newest first. */
  async exceptions(actor: Actor | null, open?: boolean): Promise<ExceptionView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.reconciliationException)
        .where(
          open === undefined
            ? undefined
            : open
              ? isNull(schema.reconciliationException.resolvedAt)
              : sql`${schema.reconciliationException.resolvedAt} is not null`,
        )
        .orderBy(desc(schema.reconciliationException.createdAt));
      return rows.map(exceptionView);
    });
  }

  async resolveException(
    actor: Actor | null,
    exceptionId: string,
    note: string,
  ): Promise<ExceptionView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.match');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.reconciliationException)
        .where(eq(schema.reconciliationException.id, exceptionId))
        .for('update');
      if (!row) throw notFound('Exception');
      if (row.resolvedAt) return exceptionView(row);
      const [updated] = await tx
        .update(schema.reconciliationException)
        .set({
          resolvedAt: this.clock.now(),
          resolvedBy: staff.personId,
          resolutionNote: note.trim().slice(0, 500),
        })
        .where(eq(schema.reconciliationException.id, exceptionId))
        .returning();
      return exceptionView(updated!);
    });
  }

  registerApprovals(): void {
    if (this.registered) return;
    this.registered = true;
    this.approvals.register({
      actionType: REFUND_ACTION,
      eligibleRoles: APPROVERS,
      schema: refundPayload,
      onePerSubject: true,
      prepare: async (tx, request) => lockPayment(tx, request.companyId, request.subjectId),
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof refundPayload>;
        const [payment] = await paymentsByIds(tx, [request.subjectId]);
        const [refund] = await tx
          .select({ status: schema.unmatchedRefund.status })
          .from(schema.unmatchedRefund)
          .where(eq(schema.unmatchedRefund.id, proposed.refundId));
        return {
          ...proposed,
          refundable:
            !!payment &&
            !payment.leaseId &&
            !payment.reversedAccountingDate &&
            refund?.status === 'awaiting_approval',
        };
      },
      execute: async (tx, request, payload) => {
        const [payment] = await paymentsByIds(tx, [payload.paymentId]);
        if (!payment) throw notFound('Payment');
        await tx
          .update(schema.unmatchedRefund)
          .set({ status: 'approved', updatedAt: this.clock.now() })
          .where(eq(schema.unmatchedRefund.id, payload.refundId));
        if (payment.row.cashAccount === '1050') {
          await enqueueOutbox(tx, {
            companyId: request.companyId,
            type: REFUND_JOB,
            payload: { refundId: payload.refundId },
            idempotencyKey: `${REFUND_JOB}:${payload.refundId}`,
          });
          return;
        }
        // A transfer was refunded outside the platform (D1), with proof: P31 posts now.
        await this.postRefund(
          tx,
          request.companyId,
          payload.refundId,
          payment,
          payment.row.cashAccount as CashAccount,
          null,
        );
      },
    });
  }
}

function exceptionView(row: typeof schema.reconciliationException.$inferSelect): ExceptionView {
  return {
    id: row.id,
    kind: row.kind as ExceptionKind,
    provider: row.provider,
    reference: row.reference,
    settlementId: row.settlementRef,
    detail: row.detail,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
  };
}
