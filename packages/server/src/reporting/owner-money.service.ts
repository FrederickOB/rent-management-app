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
import { balance, ownerBook } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { PolicyService } from '../policy/policy.service';
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
}

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

  private async balances(tx: Tx, ownerId: string, date: string) {
    const bookId = await ownerBook(tx, ownerId);
    if (!bookId) throw notFound('Owner');
    const terms = await this.currentIn(tx, ownerId, date);
    return {
      bookId,
      agentHeldMinor: await balance(tx, { accounts: ['1070'], bookIds: [bookId] }),
      feesDueMinor: -(await balance(tx, { accounts: ['2300'], bookIds: [bookId] })),
      rentTax: {
        graPaidBy: (terms?.graPaidBy ?? 'owner') as GraPayer,
        payableMinor: -(await balance(tx, { accounts: ['2200'], bookIds: [bookId] })),
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

  // Reading ------------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filter: { readonly ownerId?: string; readonly kind?: OwnerMoneyView['kind'] },
  ): Promise<OwnerMoneyView[]> {
    const staff = await this.reader(actor);
    const scope = this.policy.scopeFor(staff);
    let owners: string[] | null = null;
    if (scope !== null) {
      const held = await withCompany(this.database, this.whole(staff), (tx) =>
        tx.execute<{ owner_id: string }>(
          sql`select owner_id from remittance union select owner_id from owner_funding`,
        ),
      );
      owners = [
        ...(await ownersVisibleTo(
          this.database,
          this.policy,
          staff,
          held.rows.map((r) => r.owner_id),
        )),
      ];
      if (owners.length === 0) return [];
    }
    return withCompany(this.database, this.whole(staff), (tx) =>
      this.rows(tx, { ...filter, owners }),
    );
  }

  /** One remittance, fees taken or owner funding, as the list shows it. */
  async get(actor: Actor | null, id: string): Promise<OwnerMoneyView> {
    const staff = await this.reader(actor);
    const [row] = await withCompany(this.database, this.whole(staff), (tx) =>
      this.rows(tx, { id, owners: null }),
    );
    if (!row || !(await ownersVisibleTo(this.database, this.policy, staff, [row.owner.id])).size)
      throw notFound('Record');
    return row;
  }

  private async rows(
    tx: Tx,
    filter: {
      readonly ownerId?: string;
      readonly kind?: OwnerMoneyView['kind'];
      readonly id?: string;
      /** The owners the reader may see; null for all. */
      readonly owners: readonly string[] | null;
    },
  ): Promise<OwnerMoneyView[]> {
    const result = await tx.execute<{
      id: string;
      kind: OwnerMoneyView['kind'];
      owner_id: string;
      day: string;
      amount: string;
      fees: string;
      method: RemittanceMethod | null;
      reference: string | null;
      proof: string | null;
      created_at: Date | string;
      created_by: string | null;
    }>(sql`
      select x.* from (
        select r.id, r.kind, r.owner_id, r.paid_on::text as day, r.net_minor::text as amount,
               r.fees_retained_minor::text as fees, r.method, r.reference,
               r.proof_document_id::text as proof, r.created_at, r.created_by
        from remittance r
        union all
        select f.id, 'owner_funding', f.owner_id, f.received_on::text, f.amount_minor::text, '0',
               f.method, f.reference, f.proof_document_id::text, f.created_at, f.created_by
        from owner_funding f
      ) x
      where (${filter.ownerId ?? null}::uuid is null or x.owner_id = ${filter.ownerId ?? null}::uuid)
        and (${filter.kind ?? null}::text is null or x.kind = ${filter.kind ?? null}::text)
        and (${filter.id ?? null}::uuid is null or x.id = ${filter.id ?? null}::uuid)
        and (${filter.owners === null}::boolean
             or x.owner_id = any(${`{${(filter.owners ?? []).join(',')}}`}::uuid[]))
      order by x.day desc, x.created_at desc, x.id desc
      limit 500`);
    const owners = await ownerFacts(tx, [...new Set(result.rows.map((r) => r.owner_id))]);
    const people = await personNames(
      tx,
      result.rows.flatMap((r) => (r.created_by ? [r.created_by] : [])),
    );
    return result.rows.map((r) => ({
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
    }));
  }

  async proofUrl(actor: Actor | null, id: string) {
    const staff = await this.reader(actor);
    const found = await withCompany(this.database, this.whole(staff), async (tx) => {
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
    if (!found || !(await ownersVisibleTo(this.database, this.policy, staff, [found.ownerId])).size)
      throw notFound('Proof');
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`owner-money:${ownerId}`}, 0))`,
      );
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
