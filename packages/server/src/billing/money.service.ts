import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import { bankingLines, compactLines, type JournalLineDraft } from '@rent/domain/ledger';
import {
  creditableMinor,
  planCreditNote,
  planWriteOff,
  writeOffableMinor,
} from '@rent/domain/billing';
import { DomainError } from '@rent/domain/errors';
import type { Actor, StaffRole } from '@rent/domain/policy';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService, type ApprovalView } from '../approvals/approvals.service';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import {
  BANKING_SLIP_UPLOAD,
  CASH_PHOTO_UPLOAD,
  DocumentsService,
  TRANSFER_PROOF_UPLOAD,
  type UploadPurpose,
} from '../documents/documents.service';
import { activeMemberIds } from '../identity/memberships';
import { personContact } from '../identity/person-directory';
import { ownerBook, sumLines } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { ownerNameThroughProperty } from '../portfolio/ownership';
import { billingLeaseOf, leaseLabels } from '../tenancy/billing-facts';
import { BillingEngine, lineLabel, type LeaseState } from './engine';
import {
  bankableMinor,
  cashKey,
  companyBookId,
  formatInvoiceNumber,
  formatReceiptNumber,
  isoNow,
  leaseBookOf,
  leaseGroup,
  lockCollectorCash,
  lockCounters,
  lockLeases,
  lockPayment,
  ownerBookId,
  paymentsByIds,
  pendingBanking,
  requireBook,
} from './records';

export const CASH_RECEIPT_ACTION = 'payment.cash_receipt';
export const DIRECT_RECEIPT_ACTION = 'payment.direct_receipt';
export const BANKING_ACTION = 'cash.banking';
export const REVERSAL_ACTION = 'payment.reversal';
export const CREDIT_NOTE_ACTION = 'invoice.credit_note';
export const WRITE_OFF_ACTION = 'invoice.write_off';

/** Who approves any money action (plan 4.17): never the person who started it (database-enforced). */
export const MONEY_APPROVERS: readonly StaffRole[] = [
  'owner',
  'agency_admin',
  'property_manager',
  'accountant',
];
const APPROVERS = MONEY_APPROVERS;

/** Lease states that money may be recorded against: signed, current, or ended with arrears. */
const PAYABLE = ['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated'];

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().max(200).nullable();
/**
 * Approval payloads (AD-05) carry what the approvals screen shows (the amount, who, which unit) as
 * well as what the decision checks. At decision time only the decision facts are read again (has
 * it posted, does the collector still hold the cash, is it still within the line's limit), so a
 * renamed tenant never cancels a request; the records themselves never change.
 */
const cashPayload = z
  .object({
    cashRecordId: uuid,
    leaseId: uuid,
    unitCode: z.string(),
    tenantName: name,
    method: z.enum(['cash', 'cheque']),
    amountMinor: z.number().int().positive(),
    receivedOn: isoDate,
    payerName: name,
    chequeNumber: z.string().nullable(),
    chequeBank: z.string().nullable(),
    collectorPersonId: uuid,
    collectorName: name,
    /** The receipt-book page or cheque photo, for the approver (absent on older requests). */
    evidenceDocumentId: uuid.optional(),
    posted: z.boolean(),
  })
  .strict();
const transferPayload = z
  .object({
    directReceiptId: uuid,
    leaseId: uuid.nullable(),
    unitCode: z.string().nullable(),
    tenantName: name,
    ownerId: uuid.nullable(),
    ownerName: name,
    receivedInto: z.enum(['owner_account', 'agency_account']),
    method: z.literal('bank_transfer'),
    amountMinor: z.number().int().positive(),
    receivedOn: isoDate,
    senderReference: z.string().nullable(),
    /** The transfer's proof, for the approver (absent on older requests). */
    evidenceDocumentId: uuid.optional(),
    posted: z.boolean(),
  })
  .strict();
const bankingPayload = z
  .object({
    bankingId: uuid,
    collectorPersonId: uuid,
    collectorName: name,
    ownerId: uuid,
    ownerName: name,
    bookId: uuid,
    bankedInto: z.enum(['owner_account', 'agency_account']),
    amountMinor: z.number().int().positive(),
    bankedOn: isoDate,
    /** The banking slip, for the approver (absent on older requests). */
    evidenceDocumentId: uuid.optional(),
    withinHeld: z.boolean(),
  })
  .strict();
const reversalPayload = z
  .object({
    paymentId: uuid,
    receiptNumber: z.string().nullable(),
    leaseId: uuid.nullable(),
    unitCode: z.string().nullable(),
    tenantName: name,
    method: z.enum(['cash', 'cheque', 'bank_transfer', 'momo', 'card', 'test']),
    amountMinor: z.number().int().positive(),
    receivedOn: isoDate,
    reason: z.enum(['bounced_cheque', 'wrong_entry', 'wrong_lease', 'other']),
    note: z.string().min(5).max(500),
    moneyNowIn: z.enum(['collector', 'owner_account', 'agency_account', 'provider']),
    reversed: z.boolean(),
  })
  .strict();
const linePayload = z
  .object({
    lineId: uuid,
    leaseId: uuid,
    invoiceId: uuid,
    invoiceNumber: z.string(),
    lineLabel: z.string(),
    unitCode: z.string(),
    tenantName: name,
    amountMinor: z.number().int().positive(),
    reason: z.string().min(5).max(500),
    withinLimit: z.boolean(),
  })
  .strict();

export interface CashInput {
  readonly leaseId: string;
  readonly method: 'cash' | 'cheque';
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly payerName: string;
  readonly collectorPersonId?: string | null;
  readonly chequeNumber?: string | null;
  readonly chequeBank?: string | null;
  readonly photoUploadId: string;
  readonly note?: string | null;
}

export interface TransferInput {
  readonly leaseId?: string | null;
  readonly receivedInto: 'owner_account' | 'agency_account';
  readonly ownerId?: string | null;
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly senderReference?: string | null;
  readonly proofUploadId: string;
  readonly note?: string | null;
}

export interface BankingInput {
  readonly collectorPersonId: string;
  readonly ownerId: string;
  readonly bankedInto: 'owner_account' | 'agency_account';
  readonly amountMinor: number;
  readonly bankedOn: string;
  readonly slipUploadId: string;
  readonly note?: string | null;
}

export interface Writing {
  /** The request's idempotency claim (M2 S8), taken in the write's transaction. */
  readonly claim?: IdempotencyClaim | null;
}

const text = (value: string | null | undefined, max: number) => value?.trim().slice(0, max) || null;

const UPLOADS: Record<
  'cash_photo' | 'transfer_proof' | 'banking_slip',
  { purpose: UploadPurpose; action: 'payment.record' | 'payment.record_transfer' | 'cash.bank' }
> = {
  cash_photo: { purpose: CASH_PHOTO_UPLOAD, action: 'payment.record' },
  transfer_proof: { purpose: TRANSFER_PROOF_UPLOAD, action: 'payment.record_transfer' },
  banking_slip: { purpose: BANKING_SLIP_UPLOAD, action: 'cash.bank' },
};

/**
 * Money in and its corrections (BC-05, BC-07, P07, P21, P23, P24, P27, P28; plan 4.8 and 4.9).
 * Cash and cheques, transfers, banking and every correction wait for a second person through the
 * approvals engine; nothing posts before that, and a rejection posts nothing. On approval the
 * money is taken, allocated and posted in the deciding transaction. Matching an unmatched receipt
 * is a person's confirmation itself.
 */
@Injectable()
export class MoneyService {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Uploads -----------------------------------------------------------------------------------

  /** A presigned upload for a receipt-book photo, a transfer proof or a banking slip. */
  async createUpload(
    actor: Actor | null,
    input: {
      readonly purpose: 'cash_photo' | 'transfer_proof' | 'banking_slip';
      readonly contentType: string;
      readonly sizeBytes: number;
    },
  ) {
    const staff = staffActor(actor);
    const { purpose, action } = UPLOADS[input.purpose];
    this.policy.assert(staff, action);
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      purpose,
      input.contentType,
      input.sizeBytes,
    );
  }

  // Cash and cheques (BC-05, P06) --------------------------------------------------------------

  /**
   * Records cash or a cheque received, with the photo of the receipt-book page or the cheque, and
   * asks a second person to approve it. Nothing posts until then. A caretaker records cash on the
   * properties assigned to them; naming someone else as the collector needs cash.bank_others.
   */
  async recordCash(
    actor: Actor | null,
    input: CashInput,
    options: Writing = {},
  ): Promise<{ cashRecordId: string; approvalId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payment.record');
    const collector = input.collectorPersonId ?? staff.personId;
    if (collector !== staff.personId) this.policy.assert(staff, 'cash.bank_others');
    if (input.method === 'cheque' && !input.chequeNumber?.trim())
      throw invalid('cheque_number', 'Enter the cheque number');
    const payer = input.payerName.trim();
    if (payer.length < 2) throw invalid('payer_name', 'Enter who paid');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.photoUploadId,
      CASH_PHOTO_UPLOAD,
    );
    const cashRecordId = uuidv7();
    const approvalId = await withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const lease = await billingLeaseOf(tx, input.leaseId);
      if (!PAYABLE.includes(lease.status))
        throw conflict('lease_not_billable', 'Money can be recorded only for a signed lease');
      await this.checkReceivedOn(tx, staff.companyId, input.receivedOn);
      if (!(await activeMemberIds(tx, [collector])).has(collector))
        throw invalid('collector', 'The collector must be an active member of your company');
      const photoDocumentId = await this.documents.recordStagedEvidence(tx, staged, 'cash_photo');
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: CASH_RECEIPT_ACTION,
        subjectType: 'cash_record',
        subjectId: cashRecordId,
        propertyId: lease.propertyId,
        payload: {
          cashRecordId,
          leaseId: lease.id,
          unitCode: lease.unitCode,
          tenantName: lease.tenantName.slice(0, 200),
          method: input.method,
          amountMinor: input.amountMinor,
          receivedOn: input.receivedOn,
          payerName: payer.slice(0, 160),
          chequeNumber: input.method === 'cheque' ? text(input.chequeNumber, 40) : null,
          chequeBank: input.method === 'cheque' ? text(input.chequeBank, 80) : null,
          collectorPersonId: collector,
          collectorName: (await personContact(tx, collector))?.name.slice(0, 200) ?? null,
          evidenceDocumentId: photoDocumentId,
          posted: false,
        },
      });
      await tx.insert(schema.cashRecord).values({
        id: cashRecordId,
        companyId: staff.companyId,
        propertyId: lease.propertyId,
        tenantId: lease.tenantId,
        leaseId: lease.id,
        unitId: lease.unitId,
        method: input.method,
        amountMinor: input.amountMinor,
        receivedOn: input.receivedOn,
        payerName: payer.slice(0, 160),
        collectorPersonId: collector,
        chequeNumber: input.method === 'cheque' ? text(input.chequeNumber, 40) : null,
        chequeBank: input.method === 'cheque' ? text(input.chequeBank, 80) : null,
        photoDocumentId,
        note: text(input.note, 500),
        approvalRequestId: id,
        recordedBy: staff.personId,
      });
      await options.claim?.done(tx, { cashRecordId, approvalId: id });
      return id;
    });
    await this.documents.discardStagedUpload(staged);
    return { cashRecordId, approvalId };
  }

  private async checkReceivedOn(tx: Tx, companyId: string, date: string): Promise<void> {
    const company = await companyRecord(tx, companyId);
    if (date > isoNow(this.clock, company!.timeZone))
      throw invalid('received_in_future', 'The day the money was received cannot be in the future');
  }

  // Transfers into the owner's or the agency's account (P28, P23) -----------------------------

  /**
   * Records a transfer straight into the owner's or the agency's account, with its proof, and
   * asks a second person to approve it. With no lease, it waits as unmatched once approved (P23):
   * in the owner's book for the owner's account, in the company book for the agency's.
   */
  async recordTransfer(
    actor: Actor | null,
    input: TransferInput,
    options: Writing = {},
  ): Promise<{ directReceiptId: string; approvalId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payment.record_transfer');
    if (input.receivedInto === 'agency_account' && staff.companyKind !== 'agency')
      throw invalid('received_into', 'Only an agency has an agency account');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.proofUploadId,
      TRANSFER_PROOF_UPLOAD,
    );
    const directReceiptId = uuidv7();
    const approvalId = await withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      await this.checkReceivedOn(tx, staff.companyId, input.receivedOn);
      let lease: Awaited<ReturnType<typeof billingLeaseOf>> | null = null;
      let ownerId: string | null = null;
      if (input.leaseId) {
        lease = await billingLeaseOf(tx, input.leaseId);
        if (!PAYABLE.includes(lease.status))
          throw conflict('lease_not_billable', 'Money can be recorded only for a signed lease');
        const company = await companyRecord(tx, staff.companyId);
        const book = requireBook(
          await leaseBookOf(tx, lease, isoNow(this.clock, company!.timeZone)),
        );
        if (input.ownerId && input.ownerId !== book.ownerId)
          throw invalid('owner', 'This lease’s rent is due to another owner');
        ownerId = book.ownerId;
      } else if (input.receivedInto === 'owner_account') {
        if (!input.ownerId) throw invalid('owner_required', 'Say whose account it went into');
        if (!(await ownerFacts(tx, [input.ownerId])).has(input.ownerId)) throw notFound('Owner');
        ownerId = input.ownerId;
      } else if (input.ownerId) {
        throw invalid(
          'owner',
          'Money in the agency’s account waits for its lease; leave the owner out',
        );
      }
      const proofDocumentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'transfer_proof',
      );
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: DIRECT_RECEIPT_ACTION,
        subjectType: 'direct_receipt',
        subjectId: directReceiptId,
        propertyId: lease?.propertyId ?? null,
        payload: {
          directReceiptId,
          leaseId: lease?.id ?? null,
          unitCode: lease?.unitCode ?? null,
          tenantName: lease?.tenantName.slice(0, 200) ?? null,
          ownerId,
          ownerName: ownerId ? await this.ownerName(tx, staff.companyId, ownerId) : null,
          receivedInto: input.receivedInto,
          method: 'bank_transfer',
          amountMinor: input.amountMinor,
          receivedOn: input.receivedOn,
          senderReference: text(input.senderReference, 80),
          evidenceDocumentId: proofDocumentId,
          posted: false,
        },
      });
      await tx.insert(schema.directReceipt).values({
        id: directReceiptId,
        companyId: staff.companyId,
        propertyId: lease?.propertyId ?? null,
        tenantId: lease?.tenantId ?? null,
        leaseId: lease?.id ?? null,
        unitId: lease?.unitId ?? null,
        receivedInto: input.receivedInto,
        ownerId,
        amountMinor: input.amountMinor,
        receivedOn: input.receivedOn,
        senderReference: text(input.senderReference, 80),
        proofDocumentId,
        note: text(input.note, 500),
        approvalRequestId: id,
        recordedBy: staff.personId,
      });
      await options.claim?.done(tx, { directReceiptId, approvalId: id });
      return id;
    });
    await this.documents.discardStagedUpload(staged);
    return { directReceiptId, approvalId };
  }

  // Banking (P07) ------------------------------------------------------------------------------

  /**
   * Records a collector's cash banked into the owner's account or handed to the agency, with the
   * slip, and asks a second person to approve it: never more than the collector holds in that
   * owner's book.
   */
  async recordBanking(
    actor: Actor | null,
    input: BankingInput,
    options: Writing = {},
  ): Promise<{ bankingId: string; approvalId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(
      staff,
      input.collectorPersonId === staff.personId ? 'cash.bank' : 'cash.bank_others',
    );
    if (input.bankedInto === 'agency_account' && staff.companyKind !== 'agency')
      throw invalid('banked_into', 'Only an agency has an agency account');
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.slipUploadId,
      BANKING_SLIP_UPLOAD,
    );
    const bankingId = uuidv7();
    const approvalId = await withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      await this.checkReceivedOn(tx, staff.companyId, input.bankedOn);
      const bookId = await ownerBook(tx, input.ownerId);
      if (!bookId) throw notFound('Owner');
      const book = { id: bookId };
      await lockCollectorCash(tx, staff.companyId, input.collectorPersonId, book.id);
      const held = await this.engine.collectorHeld(tx, input.collectorPersonId, book.id);
      const waiting = await pendingBanking(tx, staff.companyId, [input.collectorPersonId]);
      const pending = waiting.get(cashKey(input.collectorPersonId, book.id)) ?? 0;
      if (input.amountMinor > bankableMinor(held, pending))
        throw conflict(
          'cash_short',
          'That is more than the collector holds for this owner, less banking waiting for approval',
        );
      const slipDocumentId = await this.documents.recordStagedEvidence(tx, staged, 'banking_slip');
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: BANKING_ACTION,
        subjectType: 'cash_banking',
        subjectId: bankingId,
        // Cash of several properties can be banked at once: a company-level request.
        propertyId: null,
        payload: {
          bankingId,
          collectorPersonId: input.collectorPersonId,
          collectorName:
            (await personContact(tx, input.collectorPersonId))?.name.slice(0, 200) ?? null,
          ownerId: input.ownerId,
          ownerName: await this.ownerName(tx, staff.companyId, input.ownerId),
          bookId: book.id,
          bankedInto: input.bankedInto,
          amountMinor: input.amountMinor,
          bankedOn: input.bankedOn,
          evidenceDocumentId: slipDocumentId,
          withinHeld: true,
        },
      });
      await tx.insert(schema.cashBanking).values({
        id: bankingId,
        companyId: staff.companyId,
        collectorPersonId: input.collectorPersonId,
        ownerId: input.ownerId,
        bookId: book.id,
        bankedInto: input.bankedInto,
        amountMinor: input.amountMinor,
        bankedOn: input.bankedOn,
        slipDocumentId,
        note: text(input.note, 500),
        approvalRequestId: id,
        recordedBy: staff.personId,
      });
      await options.claim?.done(tx, { bankingId, approvalId: id });
      return id;
    });
    await this.documents.discardStagedUpload(staged);
    return { bankingId, approvalId };
  }

  /**
   * P07 for an approved banking: the collector's cash comes out of 1060 property by property,
   * oldest cash first, so every line keeps its property and each scoped view stays right.
   */
  private async postBanking(
    tx: Tx,
    banking: typeof schema.cashBanking.$inferSelect,
  ): Promise<void> {
    const byProperty = await sumLines(
      tx,
      { accounts: ['1060'], collectorIds: [banking.collectorPersonId], bookIds: [banking.bookId] },
      ['propertyId'],
    );
    const held = {
      rows: byProperty
        .filter((r) => r.balanceMinor > 0)
        .sort((a, b) =>
          (a.firstValueDate ?? '') !== (b.firstValueDate ?? '')
            ? (a.firstValueDate ?? '') < (b.firstValueDate ?? '')
              ? -1
              : 1
            : (a.propertyId ?? '') < (b.propertyId ?? '')
              ? -1
              : 1,
        )
        .map((r) => ({ property_id: r.propertyId ?? null, held: r.balanceMinor })),
    };
    let left = banking.amountMinor;
    const lines: JournalLineDraft[] = [];
    for (const row of held.rows) {
      if (left === 0) break;
      const amount = Math.min(left, Number(row.held));
      lines.push(
        ...bankingLines({
          bookId: banking.bookId,
          collectorId: banking.collectorPersonId,
          to: banking.bankedInto === 'owner_account' ? '1010' : '1070',
          amountMinor: amount,
          propertyId: row.property_id,
        }),
      );
      left -= amount;
    }
    if (left > 0)
      throw conflict('cash_short', 'That is more than the collector holds for this owner');
    await this.posting.post(tx, {
      companyId: banking.companyId,
      rule: 'P07',
      key: `P07:${banking.id}`,
      valueDate: banking.bankedOn,
      lines: compactLines(lines),
      record: { type: 'cash_banking', id: banking.id },
      causedBy: banking.recordedBy,
    });
  }

  // Corrections (P21, P24, P27; decision 3) ------------------------------------------------------

  /** Asks to reverse a payment (a bounced cheque, a wrong entry or a wrong lease); a second person approves. */
  async requestReversal(
    actor: Actor | null,
    paymentId: string,
    input: {
      readonly reason: z.infer<typeof reversalPayload>['reason'];
      readonly note: string;
      readonly moneyNowIn: z.infer<typeof reversalPayload>['moneyNowIn'];
    },
    options: Writing = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const [payment] = await paymentsByIds(tx, [paymentId]);
      if (!payment) throw notFound('Payment');
      if (payment.reversedAccountingDate)
        throw conflict('payment_reversed', 'This payment was already reversed');
      const options_ = payment.leaseId
        ? await this.engine.reversalOptions(tx, payment, staff.companyKind)
        : [payment.row.cashAccount === '1070' ? 'agency_account' : 'owner_account'];
      if (!options_.includes(input.moneyNowIn))
        throw invalid('money_location', 'Say where the money is now: one of the options shown');
      const label = payment.leaseId
        ? (await leaseLabels(tx, [payment.leaseId])).get(payment.leaseId)
        : null;
      const [receipt] = await tx
        .select({ number: schema.receipt.number })
        .from(schema.receipt)
        .where(and(eq(schema.receipt.paymentId, paymentId), eq(schema.receipt.kind, 'receipt')));
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: REVERSAL_ACTION,
        subjectType: 'payment',
        subjectId: paymentId,
        propertyId: payment.leaseId
          ? (await billingLeaseOf(tx, payment.leaseId)).propertyId
          : (payment.row.propertyId ?? null),
        payload: {
          paymentId,
          receiptNumber: receipt ? formatReceiptNumber(receipt.number) : null,
          leaseId: payment.leaseId,
          unitCode: label?.unitCode ?? null,
          tenantName: label?.tenantName.slice(0, 200) ?? null,
          method: payment.row.method as z.infer<typeof reversalPayload>['method'],
          amountMinor: payment.amountMinor,
          receivedOn: payment.row.receivedOn,
          reason: input.reason,
          note: input.note.trim(),
          moneyNowIn: input.moneyNowIn,
          reversed: false,
        },
      });
      await options.claim?.done(tx, id);
      return id;
    });
  }

  /** Asks for a credit note on a line (P27); its VAT lines follow. A second person approves. */
  async requestCreditNote(
    actor: Actor | null,
    lineId: string,
    input: { readonly amountMinor: number; readonly reason: string },
    options: Writing = {},
  ): Promise<string> {
    return this.requestLineCorrection(actor, lineId, input, options, CREDIT_NOTE_ACTION);
  }

  /** Asks to write off what is owed on a line (P24). A second person approves. */
  async requestWriteOff(
    actor: Actor | null,
    lineId: string,
    input: { readonly amountMinor: number; readonly reason: string },
    options: Writing = {},
  ): Promise<string> {
    return this.requestLineCorrection(actor, lineId, input, options, WRITE_OFF_ACTION);
  }

  private async requestLineCorrection(
    actor: Actor | null,
    lineId: string,
    input: { readonly amountMinor: number; readonly reason: string },
    options: Writing,
    actionType: typeof CREDIT_NOTE_ACTION | typeof WRITE_OFF_ACTION,
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const [line] = await tx
        .select({ leaseId: schema.invoiceLine.leaseId })
        .from(schema.invoiceLine)
        .where(eq(schema.invoiceLine.id, lineId));
      if (!line) throw notFound('Invoice line');
      const state = await this.engine.load(tx, staff.companyId, line.leaseId);
      // Checked now so the request asks only what can be done; checked again at approval.
      this.checkLineCorrection(state, lineId, input.amountMinor, actionType);
      const record = state.lines.find((l) => l.id === lineId)!;
      const id = await this.approvals.createInTx(tx, staff, {
        actionType,
        subjectType: 'invoice_line',
        subjectId: lineId,
        propertyId: state.lease.propertyId,
        payload: {
          lineId,
          leaseId: line.leaseId,
          invoiceId: record.invoiceId,
          invoiceNumber: formatInvoiceNumber(record.invoiceNumber),
          lineLabel: lineLabel(record),
          unitCode: state.lease.unitCode,
          tenantName: state.lease.tenantName.slice(0, 200),
          amountMinor: input.amountMinor,
          reason: input.reason.trim(),
          withinLimit: true,
        },
      });
      await options.claim?.done(tx, id);
      return id;
    });
  }

  private checkLineCorrection(
    state: LeaseState,
    lineId: string,
    amountMinor: number,
    actionType: typeof CREDIT_NOTE_ACTION | typeof WRITE_OFF_ACTION,
  ): void {
    const line = state.lines.find((l) => l.id === lineId);
    if (!line) throw notFound('Invoice line');
    if (actionType === CREDIT_NOTE_ACTION)
      planCreditNote({
        line,
        taxLines: state.lines.filter((l) => l.baseLineId === lineId),
        allocations: state.allocations,
        payments: state.payments,
        amountMinor,
      });
    else planWriteOff({ line, allocations: state.allocations, amountMinor });
  }

  private withinLimit(
    state: LeaseState,
    lineId: string,
    amountMinor: number,
    actionType: typeof CREDIT_NOTE_ACTION | typeof WRITE_OFF_ACTION,
  ): boolean {
    const line = state.lines.find((l) => l.id === lineId);
    if (!line) return false;
    const cap =
      actionType === WRITE_OFF_ACTION
        ? writeOffableMinor(line, state.allocations)
        : creditableMinor(line, state.allocations);
    return amountMinor <= cap;
  }

  // Matching (P23) ---------------------------------------------------------------------------------

  /**
   * Matches unmatched money to a lease, which allocates it (P23). The person sees both in their
   * scope; the posting runs in a transaction of the whole company, as every posting does.
   */
  async match(
    actor: Actor | null,
    paymentId: string,
    leaseId: string,
    options: Writing = {},
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const [payment] = await paymentsByIds(tx, [paymentId]);
      if (!payment) throw notFound('Payment');
      await billingLeaseOf(tx, leaseId);
    });
    await withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      await lockPayment(tx, staff.companyId, paymentId);
      await lockLeases(tx, staff.companyId, await leaseGroup(tx, leaseId));
      await lockCounters(tx, staff.companyId);
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      if (!PAYABLE.includes(state.lease.status))
        throw conflict('lease_not_billable', 'Money can be matched only to a signed lease');
      const [payment] = await paymentsByIds(tx, [paymentId]);
      if (!payment) throw notFound('Payment');
      await this.engine.match(tx, state, payment, staff.personId);
      await options.claim?.done(tx, { paymentId });
    });
  }

  private unscoped(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  // The provider test harness (stands in for M4b) -------------------------------------------------

  /**
   * Money confirmed by a payment provider (P03), as M4b's verified webhook will record it: held
   * with the provider (1050) until settlement. A test harness in M4a; not exposed by the API.
   */
  async recordProviderPayment(
    companyId: string,
    input: {
      readonly leaseId: string;
      readonly amountMinor: number;
      readonly receivedOn: string;
      readonly provider?: string;
      readonly reference?: string;
    },
  ): Promise<{ paymentId: string; receiptId: string }> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      await lockLeases(tx, companyId, await leaseGroup(tx, input.leaseId));
      await lockCounters(tx, companyId);
      const state = await this.engine.load(tx, companyId, input.leaseId);
      return this.engine.receive(tx, state, {
        amountMinor: input.amountMinor,
        receivedOn: input.receivedOn,
        method: 'test',
        rule: 'P03',
        cashAccount: '1050',
        provider: input.provider ?? 'test',
        sourceType: 'provider_test',
        sourceId: uuidv7(),
        senderReference: input.reference ?? null,
      });
    });
  }

  // Approval handlers ------------------------------------------------------------------------------

  /** Registers the money actions with the approvals engine (decision 3). Once per process. */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    const today = async (tx: Tx, companyId: string) =>
      isoNow(this.clock, (await companyRecord(tx, companyId))!.timeZone);

    this.approvals.register({
      actionType: CASH_RECEIPT_ACTION,
      eligibleRoles: APPROVERS,
      schema: cashPayload,
      // Lease, then the counters (receipt; invoices a VAT advance issues), before the decision row.
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string }).leaseId;
        await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
        await lockCounters(tx, request.companyId);
      },
      currentPayload: async (tx, request) => {
        const record = await this.cashRecord(tx, request.subjectId);
        return {
          ...(request.payload as z.infer<typeof cashPayload>),
          posted: await this.paymentExists(tx, 'cash_record', record.id),
        };
      },
      execute: async (tx, request) => {
        const record = await this.cashRecord(tx, request.subjectId);
        const state = await this.engine.load(tx, request.companyId, record.leaseId);
        await this.engine.receive(tx, state, {
          amountMinor: record.amountMinor,
          receivedOn: record.receivedOn,
          method: record.method as 'cash' | 'cheque',
          rule: 'P06',
          cashAccount: '1060',
          collectorPersonId: record.collectorPersonId,
          sourceType: 'cash_record',
          sourceId: record.id,
          payerName: record.payerName,
          chequeNumber: record.chequeNumber,
          chequeBank: record.chequeBank,
          note: record.note,
          proofDocumentId: record.photoDocumentId,
          recordedBy: record.recordedBy,
          causedBy: request.initiatedBy,
        });
      },
    });

    this.approvals.register({
      actionType: DIRECT_RECEIPT_ACTION,
      eligibleRoles: APPROVERS,
      schema: transferPayload,
      prepare: async (tx, request) => {
        const leaseId = (request.payload as { leaseId: string | null }).leaseId;
        if (leaseId) await lockLeases(tx, request.companyId, await leaseGroup(tx, leaseId));
        await lockCounters(tx, request.companyId);
      },
      currentPayload: async (tx, request) => {
        const record = await this.directReceipt(tx, request.subjectId);
        return {
          ...(request.payload as z.infer<typeof transferPayload>),
          posted: await this.paymentExists(tx, 'direct_receipt', record.id),
        };
      },
      execute: async (tx, request) => {
        const record = await this.directReceipt(tx, request.subjectId);
        const account = record.receivedInto === 'owner_account' ? '1010' : '1070';
        const money = {
          amountMinor: record.amountMinor,
          receivedOn: record.receivedOn,
          method: 'bank_transfer' as const,
          cashAccount: account as '1010' | '1070',
          sourceType: 'direct_receipt' as const,
          sourceId: record.id,
          senderReference: record.senderReference,
          note: record.note,
          proofDocumentId: record.proofDocumentId,
          recordedBy: record.recordedBy,
          causedBy: request.initiatedBy,
        };
        if (record.leaseId) {
          const state = await this.engine.load(tx, request.companyId, record.leaseId);
          await this.engine.receive(tx, state, { ...money, rule: 'P28' });
          return;
        }
        const bookId =
          record.receivedInto === 'owner_account'
            ? await ownerBookId(tx, record.ownerId!)
            : await companyBookId(tx);
        await this.engine.receiveUnmatched(tx, {
          ...money,
          companyId: request.companyId,
          bookId,
          ownerId: record.receivedInto === 'owner_account' ? record.ownerId : null,
        });
      },
    });

    this.approvals.register({
      actionType: BANKING_ACTION,
      eligibleRoles: APPROVERS,
      schema: bankingPayload,
      prepare: async (tx, request) => {
        const p = request.payload as { collectorPersonId: string; bookId: string };
        await lockCollectorCash(tx, request.companyId, p.collectorPersonId, p.bookId);
      },
      currentPayload: async (tx, request) => {
        const banking = await this.banking(tx, request.subjectId);
        const posted = await this.posting.findByKey(tx, request.companyId, `P07:${banking.id}`);
        const held = await this.engine.collectorHeld(tx, banking.collectorPersonId, banking.bookId);
        return {
          ...(request.payload as z.infer<typeof bankingPayload>),
          withinHeld: !posted && banking.amountMinor <= held,
        };
      },
      execute: async (tx, request) => {
        await this.postBanking(tx, await this.banking(tx, request.subjectId));
      },
    });

    this.approvals.register({
      actionType: REVERSAL_ACTION,
      eligibleRoles: APPROVERS,
      schema: reversalPayload,
      onePerSubject: true,
      // Every lease the payment touches (re-read once they are locked, until it holds still), the
      // collector's cash when the money is taken back from them, then the receipt counter.
      prepare: async (tx, request) => {
        await lockPayment(tx, request.companyId, request.subjectId);
        // All of them at once, in id order; if one more appeared before the locks were held, this
        // attempt ends and the next takes the full set in order (second review D1).
        const leases = await this.leasesOfPayment(tx, request.subjectId);
        await lockLeases(tx, request.companyId, leases);
        const now = await this.leasesOfPayment(tx, request.subjectId);
        if (now.some((id) => !leases.includes(id)))
          throw new AppError(
            409,
            'payment_moved',
            'The payment changed while it was being reversed. Try again.',
          );
        const payload = request.payload as z.infer<typeof reversalPayload>;
        const [payment] = await paymentsByIds(tx, [request.subjectId]);
        if (payload.moneyNowIn === 'collector' && payment?.row.collectorPersonId)
          await lockCollectorCash(
            tx,
            request.companyId,
            payment.row.collectorPersonId,
            payment.row.bookId,
          );
        await lockCounters(tx, request.companyId);
      },
      currentPayload: async (tx, request) => {
        const proposed = request.payload as z.infer<typeof reversalPayload>;
        const [payment] = await paymentsByIds(tx, [request.subjectId]);
        // Matched since it was asked for: the request no longer describes it (review 5).
        return {
          ...proposed,
          leaseId: payment?.leaseId ?? proposed.leaseId,
          reversed: !payment || payment.reversedAccountingDate !== null,
        };
      },
      execute: async (tx, request, payload) => {
        const [payment] = await paymentsByIds(tx, [payload.paymentId]);
        if (!payment) throw notFound('Payment');
        const states: LeaseState[] = [];
        for (const leaseId of await this.leasesOfPayment(tx, payment.id))
          states.push(await this.engine.load(tx, request.companyId, leaseId));
        await this.engine.reverse(tx, states, payment, {
          reason: payload.reason,
          note: payload.note,
          moneyNowIn: payload.moneyNowIn,
          approvalRequestId: request.id,
          requestedBy: request.initiatedBy,
          today: await today(tx, request.companyId),
        });
      },
    });

    for (const actionType of [CREDIT_NOTE_ACTION, WRITE_OFF_ACTION] as const)
      this.approvals.register({
        actionType,
        eligibleRoles: APPROVERS,
        schema: linePayload,
        // One open request per line and action: a second would ask the same question (review 18).
        onePerSubject: true,
        prepare: async (tx, request) =>
          lockLeases(
            tx,
            request.companyId,
            await leaseGroup(tx, (request.payload as { leaseId: string }).leaseId),
          ),
        currentPayload: async (tx, request) => {
          const proposed = request.payload as z.infer<typeof linePayload>;
          const state = await this.engine.load(tx, request.companyId, proposed.leaseId);
          return {
            ...proposed,
            withinLimit: this.withinLimit(state, proposed.lineId, proposed.amountMinor, actionType),
          };
        },
        execute: async (tx, request, payload) => {
          const state = await this.engine.load(tx, request.companyId, payload.leaseId);
          const input = {
            lineId: payload.lineId,
            amountMinor: payload.amountMinor,
            reason: payload.reason,
            approvalRequestId: request.id,
            createdBy: request.initiatedBy,
            valueDate: await today(tx, request.companyId),
          };
          if (actionType === CREDIT_NOTE_ACTION)
            await this.engine.credit(tx, state, { ...input, kind: 'approved' });
          else await this.engine.writeOff(tx, state, input);
        },
      });
  }

  // Helpers -----------------------------------------------------------------------------------------

  /**
   * An owner's name for a request's summary. A caretaker does not see owner records, so the name
   * comes from a property of the owner's that they do see (the narrow function of M3).
   */
  private async ownerName(tx: Tx, companyId: string, ownerId: string): Promise<string | null> {
    const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
    if (owner) return owner.displayName.slice(0, 200);
    return (await ownerNameThroughProperty(tx, companyId, ownerId))?.slice(0, 200) ?? null;
  }

  /** Every lease a payment touches: the one it pays, the one its credit sits on, and its lines'. */
  private async leasesOfPayment(tx: Tx, paymentId: string): Promise<string[]> {
    const [payment] = await paymentsByIds(tx, [paymentId]);
    if (!payment) return [];
    const lines = await tx
      .selectDistinct({ leaseId: schema.allocation.leaseId })
      .from(schema.allocation)
      .where(eq(schema.allocation.paymentId, paymentId));
    // And every lease its credit or deposit was carried to (P29).
    const carried = await tx
      .selectDistinct({ leaseId: schema.creditCarryOver.leaseId })
      .from(schema.creditCarryOver)
      .where(eq(schema.creditCarryOver.paymentId, paymentId));
    return [
      ...new Set(
        [
          payment.leaseId,
          payment.creditLeaseId,
          ...lines.map((l) => l.leaseId),
          ...carried.map((c) => c.leaseId),
        ].filter((id): id is string => id !== null),
      ),
    ].sort();
  }

  private async paymentExists(tx: Tx, sourceType: string, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(and(eq(schema.payment.sourceType, sourceType), eq(schema.payment.sourceId, sourceId)));
    return rows.length > 0;
  }

  private async cashRecord(tx: Tx, id: string) {
    const [row] = await tx.select().from(schema.cashRecord).where(eq(schema.cashRecord.id, id));
    if (!row) throw notFound('Cash record');
    return row;
  }

  private async directReceipt(tx: Tx, id: string) {
    const [row] = await tx
      .select()
      .from(schema.directReceipt)
      .where(eq(schema.directReceipt.id, id));
    if (!row) throw notFound('Transfer');
    return row;
  }

  private async banking(tx: Tx, id: string) {
    const [row] = await tx.select().from(schema.cashBanking).where(eq(schema.cashBanking.id, id));
    if (!row) throw notFound('Banking');
    return row;
  }

  /** The approval views for requests, for the API's responses. */
  approval(actor: Actor | null, id: string): Promise<ApprovalView> {
    return this.approvals.get(actor, id);
  }

  /** Domain refusals of a correction, as the API shows them. */
  static isDomain(error: unknown): error is DomainError {
    return error instanceof DomainError;
  }

  /** Approval requests still open for subjects, for the payment detail's "reversal requested". */
  async openApprovals(tx: Tx, subjectIds: readonly string[]): Promise<Map<string, string>> {
    return this.approvals.openFor(tx, subjectIds);
  }
}
