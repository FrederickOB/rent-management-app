import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import {
  checkFeeTerms,
  feesTakenLines,
  ownerFundingLines,
  ownerPostingKeys,
  remittanceLines,
  remittanceProblems,
  rentTaxHoldBackMinor,
  suggestRemittance,
  type FeeKind,
  type FeeTerms,
  type GraPayer,
  type JournalLineDraft,
  type RemittanceMethod,
} from '@rent/domain/ledger';
import type { Actor } from '@rent/domain/policy';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { MONEY_APPROVERS } from '../billing/money.service';
import { EntitlementsService } from '../companies/entitlements.service';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, TRANSFER_PROOF_UPLOAD } from '../documents/documents.service';
import { agentCashHeld, insufficientAgentCash, lockOwnerMoney } from '../ledger/agent-cash';
import { balance, ownerBook } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { ownersVisibleTo } from './visibility';

export const FEE_TERMS_ACTION = 'management_fee_terms.change';

async function personNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.person.id, name: schema.person.name })
    .from(schema.person)
    .where(inArray(schema.person.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const termsShape = z
  .object({
    kind: z.enum(['none', 'percentage', 'fixed_per_unit']),
    rateBps: z.number().int().nullable(),
    fixedMinor: z.number().int().nullable(),
    graPaidBy: z.enum(['agency', 'owner']),
    effectiveFrom: isoDate,
  })
  .strict();
const feeTermsPayload = termsShape
  .extend({ ownerId: z.string().uuid(), ownerName: z.string(), current: termsShape.nullable() })
  .strict();

export interface FeeTermsView {
  readonly kind: FeeKind;
  readonly rateBps: number | null;
  readonly fixedMinor: number | null;
  readonly graPaidBy: GraPayer;
  readonly effectiveFrom: string;
}

const viewOf = (row: typeof schema.managementFeeTerms.$inferSelect): FeeTermsView => ({
  kind: row.kind as FeeKind,
  rateBps: row.rateBps,
  fixedMinor: row.fixedMinor === null ? null : Number(row.fixedMinor),
  graPaidBy: row.graPaidBy as GraPayer,
  effectiveFrom: row.effectiveFrom,
});

const termsFrom = (input: {
  kind: FeeKind;
  rateBps?: number | null;
  fixedMinor?: number | null;
}): FeeTerms =>
  input.kind === 'percentage'
    ? { kind: 'percentage', rateBps: input.rateBps ?? 0 }
    : input.kind === 'fixed_per_unit'
      ? { kind: 'fixed_per_unit', amountMinor: input.fixedMinor ?? 0 }
      : { kind: 'none' };

export interface OwnerMoneyView {
  readonly id: string;
  readonly kind: 'remittance' | 'fees_taken' | 'owner_funding';
  readonly owner: { readonly id: string; readonly name: string };
  readonly on: string;
  readonly amountMinor: number;
  readonly feesRetainedMinor: number;
  readonly method: RemittanceMethod | null;
  readonly reference: string | null;
  readonly hasProof: boolean;
  readonly recordedAt: Date;
  readonly recordedByName: string | null;
  readonly reversed: {
    readonly at: Date;
    readonly on: string;
    readonly reason: string;
    readonly byName: string | null;
  } | null;
}

type RawOwnerMoney = {
  readonly id: string;
  readonly kind: OwnerMoneyView['kind'];
  readonly owner_id: string;
  readonly day: string;
  readonly amount: string;
  readonly fees: string;
  readonly method: RemittanceMethod | null;
  readonly reference: string | null;
  readonly proof: string | null;
  readonly created_at: Date | string;
  readonly created_by: string | null;
  readonly reversed_at: Date | string | null;
  readonly reversed_on: string | null;
  readonly reversal_reason: string | null;
  readonly reversed_by: string | null;
};

const PROBLEM_CODES = {
  over_agent_cash: ['over_agent_cash', 'The agent does not hold this much of the owner’s money'],
  fees_over_due: ['fees_over_due', 'More fees cannot be taken than the owner owes'],
  into_rent_tax: [
    'into_rent_tax',
    'This reaches into the rent tax the agency must pay GRA for the owner',
  ],
} as const;

/**
 * Fee terms (AC-02; decision 1) and the owner's money the agent holds (AC-05; decision 8):
 * remittances with fees retained (P16), fees taken on their own, and owner funding (P30). Each is
 * a record of a transfer already made, with proof, so no approval step; fee terms change only
 * through a second person's approval (`management_fee_terms.change`). Growth only (decision 13),
 * and only for an agency's owners.
 */
@Injectable()
export class OwnerMoneyService implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registerApprovals();
  }

  private approvalsRegistered = false;

  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register({
      actionType: FEE_TERMS_ACTION,
      eligibleRoles: MONEY_APPROVERS,
      schema: feeTermsPayload,
      onePerSubject: true,
      // What is in force now: if it changed since, the approver saw something else.
      currentPayload: async (tx, request) => {
        const asked = request.payload as z.infer<typeof feeTermsPayload>;
        const today = await this.today(tx, request.companyId);
        return { ...asked, current: await this.currentIn(tx, asked.ownerId, today) };
      },
      execute: async (tx, request, p) => {
        const today = await this.today(tx, request.companyId);
        await tx.insert(schema.managementFeeTerms).values({
          companyId: request.companyId,
          ownerId: p.ownerId,
          kind: p.kind,
          rateBps: p.kind === 'percentage' ? p.rateBps : null,
          fixedMinor: p.kind === 'fixed_per_unit' ? p.fixedMinor : null,
          graPaidBy: p.graPaidBy,
          // Never in the past: no backfill (decision 2).
          effectiveFrom: p.effectiveFrom < today ? today : p.effectiveFrom,
          approvalRequestId: request.id,
          createdBy: request.initiatedBy,
        });
      },
    });
  }

  // Fee terms -------------------------------------------------------------------------------------

  async feeTerms(actor: Actor | null, ownerId: string) {
    const staff = await this.reader(actor);
    await this.assertVisible(staff, ownerId);
    return withCompany(this.database, this.whole(staff), async (tx) => {
      const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
      if (!owner) throw notFound('Owner');
      return this.feeTermsView(tx, ownerId, owner.name, await this.today(tx, staff.companyId));
    });
  }

  /**
   * Properties the owner shares with another owner: a fixed fee posts only on a property one owner
   * holds alone, so these carry none (M9 review: fixed-fee gaps). Shown beside the fee terms.
   */
  async coOwnedProperties(
    actor: Actor | null,
    ownerId: string,
  ): Promise<{ id: string; name: string }[]> {
    const staff = await this.reader(actor);
    await this.assertVisible(staff, ownerId);
    return withCompany(this.database, this.whole(staff), async (tx) =>
      (
        await tx.execute<{ id: string; name: string }>(
          sql`select p.id, coalesce(p.name, p.code) as name from property p
              where p.id in (select co.property_id from property_current_ownership co
                             where co.owner_id = ${ownerId}::uuid)
                and (select count(*) from property_current_ownership o
                     where o.company_id = p.company_id and o.property_id = p.id) > 1
              order by p.code`,
        )
      ).rows.map((p) => ({ id: p.id, name: p.name })),
    );
  }

  private async feeTermsView(tx: Tx, ownerId: string, name: string, today: string) {
    const rows = await tx
      .select()
      .from(schema.managementFeeTerms)
      .where(eq(schema.managementFeeTerms.ownerId, ownerId))
      .orderBy(schema.managementFeeTerms.effectiveFrom, schema.managementFeeTerms.createdAt);
    const current = await this.currentIn(tx, ownerId, today);
    const open = (await this.approvals.openRequestsFor(tx, [ownerId], FEE_TERMS_ACTION)).get(
      ownerId,
    );
    const asked = open ? feeTermsPayload.safeParse(open.payload) : null;
    return {
      owner: { id: ownerId, name },
      current,
      upcoming: rows.filter((r) => r.effectiveFrom > today).map(viewOf),
      pending:
        open && asked?.success
          ? {
              approvalId: open.id,
              terms: {
                kind: asked.data.kind,
                rateBps: asked.data.rateBps,
                fixedMinor: asked.data.fixedMinor,
                graPaidBy: asked.data.graPaidBy,
                effectiveFrom: asked.data.effectiveFrom,
              },
            }
          : null,
    };
  }

  private async currentIn(tx: Tx, ownerId: string, date: string): Promise<FeeTermsView | null> {
    const rows = await tx
      .select()
      .from(schema.managementFeeTerms)
      .where(eq(schema.managementFeeTerms.ownerId, ownerId))
      .orderBy(schema.managementFeeTerms.effectiveFrom, schema.managementFeeTerms.createdAt);
    const on = rows.filter((r) => r.effectiveFrom <= date);
    const latest = on.at(-1);
    return latest ? viewOf(latest) : null;
  }

  /** Asks for new fee terms from a date: a second person approves (`fees.manage`). */
  async requestFeeTerms(
    actor: Actor | null,
    input: {
      readonly ownerId: string;
      readonly kind: FeeKind;
      readonly rateBps?: number | null;
      readonly fixedMinor?: number | null;
      readonly graPaidBy: GraPayer;
      readonly effectiveFrom: string;
    },
    claim: IdempotencyClaim | null = null,
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'fees.manage');
    await this.entitlements.assert(staff.companyId, 'owner_reporting');
    if (staff.companyKind !== 'agency')
      throw conflict('not_an_agency', 'A landlord pays no management fee');
    try {
      checkFeeTerms(termsFrom(input));
    } catch {
      throw invalid(
        'fee_terms',
        'Choose no fee, a rate from 1 to 10,000 basis points, or a fixed amount per unit',
      );
    }
    await this.assertVisible(staff, input.ownerId);
    return withCompany(this.database, this.whole(staff), async (tx) => {
      await claim?.claim(tx);
      const owner = (await ownerFacts(tx, [input.ownerId])).get(input.ownerId);
      if (!owner) throw notFound('Owner');
      const today = await this.today(tx, staff.companyId);
      if (input.effectiveFrom < today)
        throw invalid(
          'effective_from_past',
          'Fee terms cannot change in the past; choose today or later',
        );
      await this.approvals.createInTx(tx, staff, {
        actionType: FEE_TERMS_ACTION,
        subjectType: 'owner',
        subjectId: input.ownerId,
        propertyId: null,
        payload: {
          ownerId: input.ownerId,
          ownerName: owner.name.slice(0, 200),
          kind: input.kind,
          rateBps: input.kind === 'percentage' ? (input.rateBps ?? null) : null,
          fixedMinor: input.kind === 'fixed_per_unit' ? (input.fixedMinor ?? null) : null,
          graPaidBy: input.graPaidBy,
          effectiveFrom: input.effectiveFrom,
          current: await this.currentIn(tx, input.ownerId, today),
        },
      });
      await claim?.done(tx, { ownerId: input.ownerId });
      return this.feeTermsView(tx, input.ownerId, owner.name, today);
    });
  }

  // Balances and the suggestion -------------------------------------------------------------------

  /**
   * The owner's balances with the agent, read over the whole book (the caller's visibility was
   * checked first): the agent's cash (1070, F3), fees due (2300; above zero is over-taken and is
   * flagged, never clamped), and the rent tax payable (2200) less tax a tenant withheld that waits
   * for its certificate (1150), which the agency never pays GRA (review #9, worked example B).
   */
  private async balances(tx: Tx, ownerId: string, date: string) {
    const bookId = await ownerBook(tx, ownerId);
    if (!bookId) throw notFound('Owner');
    const terms = await this.currentIn(tx, ownerId, date);
    const fees = await balance(tx, { accounts: ['2300'], bookIds: [bookId] });
    const payable = -(await balance(tx, { accounts: ['2200'], bookIds: [bookId] }));
    const withheld = Math.max(0, await balance(tx, { accounts: ['1150'], bookIds: [bookId] }));
    return {
      bookId,
      agentHeldMinor: await agentCashHeld(tx, bookId),
      feesDueMinor: Math.max(0, -fees),
      feesOverTakenMinor: Math.max(0, fees),
      rentTaxWithheldMinor: withheld,
      rentTax: {
        graPaidBy: (terms?.graPaidBy ?? 'owner') as GraPayer,
        payableMinor: Math.max(0, payable - withheld),
      },
    };
  }

  async suggestion(actor: Actor | null, ownerId: string) {
    const staff = await this.reader(actor);
    await this.assertVisible(staff, ownerId);
    return withCompany(this.database, this.whole(staff), async (tx) => {
      const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
      if (!owner) throw notFound('Owner');
      const today = await this.today(tx, staff.companyId);
      const b = await this.balances(tx, ownerId, today);
      const s = suggestRemittance({
        agentHeldMinor: b.agentHeldMinor,
        feesDueMinor: b.feesDueMinor,
        rentTax: b.rentTax,
      });
      return {
        owner: { id: ownerId, name: owner.name },
        asOf: today,
        agentCashMinor: b.agentHeldMinor,
        feesDueMinor: b.feesDueMinor,
        graPaidBy: b.rentTax.graPaidBy,
        rentTaxHeldBackMinor: rentTaxHoldBackMinor(b.rentTax),
        totalMinor: s.totalMinor,
        feesRetainedMinor: s.feesRetainedMinor,
        netMinor: s.netMinor,
        // A remittance pays the owner something; when the fees due take all there is, the agent
        // takes them on their own; otherwise there is nothing to remit.
        proposal:
          s.netMinor > 0
            ? ('remit' as const)
            : s.feesRetainedMinor > 0
              ? ('take_fees' as const)
              : ('nothing' as const),
        rentTaxWithheldMinor: b.rentTaxWithheldMinor,
        feesOverTakenMinor: b.feesOverTakenMinor,
      };
    });
  }

  // Recording ----------------------------------------------------------------------------------

  async createUpload(actor: Actor | null, input: { contentType: string; sizeBytes: number }) {
    const staff = await this.writer(actor);
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      TRANSFER_PROOF_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  /** P16: a remittance already made, with proof, and the fees it retained. */
  async remit(
    actor: Actor | null,
    input: {
      readonly ownerId: string;
      readonly on: string;
      readonly method: RemittanceMethod;
      readonly reference: string;
      readonly proofUploadId: string;
      readonly netMinor: number;
      readonly feesRetainedMinor: number;
    },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly id: string }> {
    const staff = await this.writer(actor);
    const total = input.netMinor + input.feesRetainedMinor;
    // Scope, dates and balances before the proof is staged (staged files are kept write-once).
    await this.precheck(staff, input.ownerId, input.on, {
      totalMinor: total,
      feesRetainedMinor: input.feesRetainedMinor,
    });
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.proofUploadId,
      TRANSFER_PROOF_UPLOAD,
    );
    const id = uuidv7();
    await this.write(staff, input.ownerId, async (tx) => {
      await claim?.claim(tx);
      const b = await this.checked(tx, staff, input.ownerId, input.on, {
        totalMinor: total,
        feesRetainedMinor: input.feesRetainedMinor,
      });
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P16',
        key: ownerPostingKeys.remittance(id),
        valueDate: input.on,
        lines: remittanceLines({
          bookId: b.bookId,
          totalMinor: total,
          netMinor: input.netMinor,
          feesRetainedMinor: input.feesRetainedMinor,
        }),
        record: { type: 'remittance', id },
        causedBy: staff.personId,
      });
      const proofDocumentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'transfer_proof',
      );
      await tx.insert(schema.remittance).values({
        id,
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId: b.bookId,
        kind: 'remittance',
        paidOn: input.on,
        method: input.method,
        reference: input.reference.trim().slice(0, 120),
        proofDocumentId,
        netMinor: input.netMinor,
        feesRetainedMinor: input.feesRetainedMinor,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { id });
    });
    await this.documents.discardStagedUpload(staged);
    return { id };
  }

  /** Fees taken without a remittance: Dr 2300, Cr 1070. */
  async takeFees(
    actor: Actor | null,
    input: {
      readonly ownerId: string;
      readonly on: string;
      readonly amountMinor: number;
      readonly reference?: string | null;
    },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly id: string }> {
    const staff = await this.writer(actor);
    await this.precheck(staff, input.ownerId, input.on, {
      totalMinor: input.amountMinor,
      feesRetainedMinor: input.amountMinor,
    });
    const id = uuidv7();
    await this.write(staff, input.ownerId, async (tx) => {
      await claim?.claim(tx);
      const b = await this.checked(tx, staff, input.ownerId, input.on, {
        totalMinor: input.amountMinor,
        feesRetainedMinor: input.amountMinor,
      });
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P16',
        key: ownerPostingKeys.feesTaken(id),
        valueDate: input.on,
        lines: feesTakenLines({ bookId: b.bookId, amountMinor: input.amountMinor }),
        record: { type: 'remittance', id },
        causedBy: staff.personId,
      });
      await tx.insert(schema.remittance).values({
        id,
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId: b.bookId,
        kind: 'fees_taken',
        paidOn: input.on,
        reference: input.reference?.trim().slice(0, 120) || null,
        netMinor: 0,
        feesRetainedMinor: input.amountMinor,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { id });
    });
    return { id };
  }

  /** P30: money the owner sent the agent for the owner's bills, with proof. */
  async fund(
    actor: Actor | null,
    input: {
      readonly ownerId: string;
      readonly on: string;
      readonly method: RemittanceMethod;
      readonly reference: string;
      readonly proofUploadId: string;
      readonly amountMinor: number;
    },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly id: string }> {
    const staff = await this.writer(actor);
    await this.precheck(staff, input.ownerId, input.on, null);
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.proofUploadId,
      TRANSFER_PROOF_UPLOAD,
    );
    const id = uuidv7();
    await this.write(staff, input.ownerId, async (tx) => {
      await claim?.claim(tx);
      const b = await this.checked(tx, staff, input.ownerId, input.on, null);
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P30',
        key: ownerPostingKeys.ownerFunding(id),
        valueDate: input.on,
        lines: ownerFundingLines({ bookId: b.bookId, amountMinor: input.amountMinor }),
        record: { type: 'owner_funding', id },
        causedBy: staff.personId,
      });
      const proofDocumentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'transfer_proof',
      );
      await tx.insert(schema.ownerFunding).values({
        id,
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId: b.bookId,
        receivedOn: input.on,
        method: input.method,
        reference: input.reference.trim().slice(0, 120),
        proofDocumentId,
        amountMinor: input.amountMinor,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { id });
    });
    await this.documents.discardStagedUpload(staged);
    return { id };
  }

  /**
   * P21(a): a remittance, fees taken or owner funding recorded in error, reversed (M9 review #8):
   * each line of its entry, sign flipped, dated today, with a reason. The record stays and shows
   * as reversed; one reversal each (409 OWNER_MONEY_REVERSED). Reversing owner funding takes the
   * money back out of the agent's cash, so F3 applies (409 INSUFFICIENT_AGENT_CASH).
   */
  async reverse(
    actor: Actor | null,
    input: { readonly id: string; readonly reason: string },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly id: string }> {
    const staff = await this.writer(actor);
    // Found under the caller's own scope (RLS), or not at all.
    const [record] = await withCompany(this.database, staffContext(staff), (tx) =>
      this.rows(tx, { id: input.id }),
    );
    if (!record) throw notFound('Record');
    const reason = input.reason.trim().slice(0, 500);
    await this.write(staff, record.owner_id, async (tx) => {
      await claim?.claim(tx);
      const [done] = await tx
        .select({ id: schema.ownerMoneyReversal.id })
        .from(schema.ownerMoneyReversal)
        .where(eq(schema.ownerMoneyReversal.recordId, record.id));
      if (done) throw conflict('owner_money_reversed', 'This was reversed already');
      const table = record.kind === 'owner_funding' ? schema.ownerFunding : schema.remittance;
      const [original] = await tx
        .select({ entryId: table.entryId, bookId: table.bookId })
        .from(table)
        .where(eq(table.id, record.id));
      const lines = await tx
        .select()
        .from(schema.journalLine)
        .where(eq(schema.journalLine.entryId, original!.entryId));
      if (record.kind === 'owner_funding') {
        const out = lines
          .filter((l) => l.accountCode === '1070')
          .reduce((sum, l) => sum + Number(l.amountMinor), 0);
        const held = await agentCashHeld(tx, original!.bookId);
        if (out > held) throw insufficientAgentCash(held);
      }
      const today = await this.today(tx, staff.companyId);
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P21',
        key: `P21:${record.id}`,
        valueDate: today,
        lines: lines.map((l) => ({
          bookId: l.bookId,
          accountCode: l.accountCode as JournalLineDraft['accountCode'],
          amountMinor: -Number(l.amountMinor),
          propertyId: l.propertyId,
          unitId: l.unitId,
          leaseId: l.leaseId,
          tenantId: l.tenantId,
          invoiceLineId: l.invoiceLineId,
          paymentId: l.paymentId,
          collectorId: l.collectorId,
          provider: l.provider,
          settlementAccountId: l.settlementAccountId,
          settlementId: l.settlementId,
        })),
        record: { type: 'owner_money_reversal', id: record.id },
        causedBy: staff.personId,
      });
      await tx.insert(schema.ownerMoneyReversal).values({
        companyId: staff.companyId,
        ownerId: record.owner_id,
        bookId: original!.bookId,
        recordKind: record.kind === 'owner_funding' ? 'owner_funding' : 'remittance',
        recordId: record.id,
        reason,
        reversedOn: today,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { id: record.id });
    });
    return { id: record.id };
  }

  // Reading ------------------------------------------------------------------------------------

  /**
   * The records under the caller's own scope (RLS: `app.owner_book_visible`, review must-fix 2),
   * named in a transaction over the company: people limited to properties see no owner records.
   */
  async list(
    actor: Actor | null,
    filter: { readonly ownerId?: string; readonly kind?: OwnerMoneyView['kind'] },
  ): Promise<OwnerMoneyView[]> {
    const staff = await this.reader(actor);
    const raw = await withCompany(this.database, staffContext(staff), (tx) =>
      this.rows(tx, filter),
    );
    return this.present(staff, raw);
  }

  /** One remittance, fees taken or owner funding, as the list shows it. */
  async get(actor: Actor | null, id: string): Promise<OwnerMoneyView> {
    const staff = await this.reader(actor);
    const raw = await withCompany(this.database, staffContext(staff), (tx) =>
      this.rows(tx, { id }),
    );
    const [row] = await this.present(staff, raw);
    if (!row) throw notFound('Record');
    return row;
  }

  private async rows(
    tx: Tx,
    filter: {
      readonly ownerId?: string;
      readonly kind?: OwnerMoneyView['kind'];
      readonly id?: string;
    },
  ): Promise<RawOwnerMoney[]> {
    const result = await tx.execute<RawOwnerMoney>(sql`
      select x.*, v.created_at as reversed_at, v.reversed_on::text as reversed_on,
             v.reason as reversal_reason, v.created_by as reversed_by
      from (
        select r.id, r.kind, r.owner_id, r.paid_on::text as day, r.net_minor::text as amount,
               r.fees_retained_minor::text as fees, r.method, r.reference,
               r.proof_document_id::text as proof, r.created_at, r.created_by
        from remittance r
        union all
        select f.id, 'owner_funding', f.owner_id, f.received_on::text, f.amount_minor::text, '0',
               f.method, f.reference, f.proof_document_id::text, f.created_at, f.created_by
        from owner_funding f
      ) x
      left join owner_money_reversal v on v.record_id = x.id
      where (${filter.ownerId ?? null}::uuid is null or x.owner_id = ${filter.ownerId ?? null}::uuid)
        and (${filter.kind ?? null}::text is null or x.kind = ${filter.kind ?? null}::text)
        and (${filter.id ?? null}::uuid is null or x.id = ${filter.id ?? null}::uuid)
      order by x.day desc, x.created_at desc, x.id desc
      limit 500`);
    return result.rows;
  }

  private async present(staff: StaffActor, raw: readonly RawOwnerMoney[]) {
    if (raw.length === 0) return [];
    return withCompany(this.database, this.whole(staff), async (tx) => {
      const owners = await ownerFacts(tx, [...new Set(raw.map((r) => r.owner_id))]);
      const people = await personNames(
        tx,
        raw.flatMap((r) => [
          ...(r.created_by ? [r.created_by] : []),
          ...(r.reversed_by ? [r.reversed_by] : []),
        ]),
      );
      return raw.map((r) => this.view(r, owners, people));
    });
  }

  private view(
    r: RawOwnerMoney,
    owners: Map<string, { name: string }>,
    people: Map<string, string>,
  ): OwnerMoneyView {
    return {
      id: r.id,
      kind: r.kind,
      owner: { id: r.owner_id, name: owners.get(r.owner_id)?.name ?? '' },
      on: r.day,
      amountMinor: Number(r.kind === 'fees_taken' ? r.fees : r.amount),
      feesRetainedMinor: r.kind === 'remittance' ? Number(r.fees) : 0,
      method: r.method,
      reference: r.reference,
      hasProof: r.proof !== null,
      recordedAt: new Date(r.created_at),
      recordedByName: r.created_by ? (people.get(r.created_by) ?? null) : null,
      reversed: r.reversed_at
        ? {
            at: new Date(r.reversed_at),
            on: r.reversed_on!,
            reason: r.reversal_reason ?? '',
            byName: r.reversed_by ? (people.get(r.reversed_by) ?? null) : null,
          }
        : null,
    };
  }

  async proofUrl(actor: Actor | null, id: string) {
    const staff = await this.reader(actor);
    // Read under the caller's own scope (RLS): another owner's record is not found.
    const found = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [r] = await tx
        .select({ doc: schema.remittance.proofDocumentId, ownerId: schema.remittance.ownerId })
        .from(schema.remittance)
        .where(eq(schema.remittance.id, id));
      if (r) return r;
      const [f] = await tx
        .select({ doc: schema.ownerFunding.proofDocumentId, ownerId: schema.ownerFunding.ownerId })
        .from(schema.ownerFunding)
        .where(eq(schema.ownerFunding.id, id));
      return f ?? null;
    });
    if (!found) throw notFound('Proof');
    const url = found.doc ? await this.documents.downloadUrl(staff.companyId, found.doc) : null;
    if (!url) throw notFound('Proof');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  // Internals ----------------------------------------------------------------------------------

  private async reader(actor: Actor | null): Promise<StaffActor> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'statements.read');
    await this.entitlements.assert(staff.companyId, 'owner_reporting');
    return staff;
  }

  private async writer(actor: Actor | null): Promise<StaffActor> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'remittance.record');
    await this.entitlements.assert(staff.companyId, 'owner_reporting');
    if (staff.companyKind !== 'agency')
      throw conflict('not_an_agency', 'Only an agency holds an owner’s money');
    return staff;
  }

  /** The caller's scope first, then the checks, before the proof is staged; again in the write. */
  private async precheck(
    staff: StaffActor,
    ownerId: string,
    on: string,
    money: { totalMinor: number; feesRetainedMinor: number } | null,
  ): Promise<void> {
    await this.assertVisible(staff, ownerId);
    await withCompany(this.database, this.whole(staff), (tx) =>
      this.checked(tx, staff, ownerId, on, money),
    );
  }

  /**
   * The owner's whole book, for a person the policy and `assertVisible` have allowed this owner:
   * balances are the owner's, not the part of them one person's scope shows (as statements).
   */
  private whole(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  /** AD-02: an owner the person may see (`ownersVisibleTo`), or not found. */
  private async assertVisible(staff: StaffActor, ownerId: string): Promise<void> {
    if (!(await ownersVisibleTo(this.database, this.policy, staff, [ownerId])).has(ownerId))
      throw notFound('Owner');
  }

  private async checked(
    tx: Tx,
    staff: StaffActor,
    ownerId: string,
    on: string,
    money: { totalMinor: number; feesRetainedMinor: number } | null,
  ) {
    const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
    if (!owner) throw notFound('Owner');
    const today = await this.today(tx, staff.companyId);
    if (on > today) throw invalid('date_in_future', 'Record a transfer once it has been made');
    const b = await this.balances(tx, ownerId, today);
    if (money) {
      const problems = remittanceProblems({
        totalMinor: money.totalMinor,
        feesRetainedMinor: money.feesRetainedMinor,
        agentHeldMinor: b.agentHeldMinor,
        feesDueMinor: b.feesDueMinor,
        rentTax: b.rentTax,
      });
      const first = problems[0];
      if (first) throw conflict(PROBLEM_CODES[first][0], PROBLEM_CODES[first][1]);
    }
    return b;
  }

  /**
   * The write, one at a time per owner: two records made at once could each pass the balance
   * checks and together take more than the agent holds.
   */
  private async write<T>(
    staff: StaffActor,
    ownerId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return withCompany(this.database, this.whole(staff), async (tx) => {
      await lockOwnerMoney(tx, ownerId);
      return fn(tx);
    });
  }

  private async today(tx: Tx, companyId: string): Promise<string> {
    const company = await companyRecord(tx, companyId);
    return toIsoDate(
      businessDateOf(instantFrom(this.clock.now()), company?.timeZone ?? 'Africa/Accra'),
    );
  }
}
