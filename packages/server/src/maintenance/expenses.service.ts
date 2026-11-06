import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { expenseLines, expensePaymentLines } from '@rent/domain/ledger';
import {
  checkExpense,
  expenseAccountOf,
  formatTicketNumber,
  type ExpenseCategory,
  type ExpensePaidBy,
  type ExpenseStatus,
} from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import { v7 as uuidv7 } from 'uuid';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { maintenanceCheckConflict } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import {
  DocumentsService,
  EXPENSE_RECEIPT_UPLOAD,
  type StagedMedia,
} from '../documents/documents.service';
import { ownerBook } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { ownersOn } from '../portfolio/ownership';
import { expenseRows, type ExpenseFilter, type ExpenseRowView } from './expense-records';
import { MaintenanceService } from './maintenance.service';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

const isoNow = (clock: Clock, timeZone: string): string =>
  toIsoDate(businessDateOf(instantFrom(clock.now()), timeZone));

/** Where an expense's money came from, as P15 posts it (decision 8). */
const SOURCE: Record<ExpensePaidBy, '1010' | '1070' | '2500'> = {
  owner: '1010',
  agent: '1070',
  unpaid: '2500',
};
const PAID_FROM: Record<'owner_account' | 'agency_account', '1010' | '1070'> = {
  owner_account: '1010',
  agency_account: '1070',
};

const domainInvalid = (error: unknown): never => {
  if (error instanceof DomainError) throw invalid(error.code.replace(/\./g, '_'), error.message);
  throw maintenanceCheckConflict(error) ?? error;
};

/**
 * Expenses (AC-03; M8 decision 8): recorded with their receipt on a property or unit, in its
 * owner's book, and posted by P15 in the same transaction. A payable paid later posts its own
 * P15; a mistake is reversed (P21a) and recorded again. A job's cost is the sum of its expenses.
 * On every plan. Idempotency keys come from the API (money writes require one).
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(actor: Actor | null, filter: ExpenseFilter): Promise<ExpenseRowView[]> {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), (tx) => expenseRows(tx, filter));
  }

  async get(actor: Actor | null, expenseId: string): Promise<ExpenseRowView> {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), (tx) => this.row(tx, expenseId));
  }

  async createUpload(
    actor: Actor | null,
    declared: { contentType: string; sizeBytes: number; durationSeconds?: number | null },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'expense.record');
    return this.documents.createMediaUpload(
      { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
      staff.personId,
      EXPENSE_RECEIPT_UPLOAD,
      declared,
    );
  }

  async receiptUrl(actor: Actor | null, expenseId: string) {
    const staff = this.reader(actor);
    const row = await withCompany(this.database, staffContext(staff), (tx) =>
      this.row(tx, expenseId),
    );
    const url = row.receiptDocumentId
      ? await this.documents.downloadUrl(staff.companyId, row.receiptDocumentId)
      : null;
    if (!url) throw notFound('Receipt');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  /** P15 (decision 8): Dr 5000 or 5400; Cr 2500 unpaid, 1070 paid by the agent, 1010 by the owner. */
  async record(
    actor: Actor | null,
    input: {
      readonly propertyId: string;
      readonly unitId?: string | null;
      readonly category: ExpenseCategory;
      readonly supplierName: string;
      readonly amountMinor: number;
      readonly expenseDate: string;
      readonly paidBy: ExpensePaidBy;
      readonly receiptUploadId?: string | null;
      readonly jobId?: string | null;
      readonly note?: string | null;
    },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly expenseId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'expense.record');
    // Every check before the receipt is staged: staged files are kept write-once (M8 review).
    await this.write(staff, (tx) => this.validate(tx, staff, input));
    const receipt: StagedMedia | null = input.receiptUploadId
      ? await this.documents.stageMediaUpload(
          { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
          staff.personId,
          input.receiptUploadId,
          EXPENSE_RECEIPT_UPLOAD,
        )
      : null;
    const id = await this.write(staff, async (tx) => {
      await claim?.claim(tx);
      const { ownerId, bookId } = await this.validate(tx, staff, input);
      const expenseId = uuidv7();
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P15',
        key: `P15:${expenseId}`,
        valueDate: input.expenseDate,
        lines: expenseLines({
          bookId,
          account: expenseAccountOf(input.category),
          from: SOURCE[input.paidBy],
          propertyId: input.propertyId,
          unitId: input.unitId ?? null,
          amountMinor: input.amountMinor,
        }),
        record: { type: 'expense', id: expenseId },
        causedBy: staff.personId,
      });
      const receiptDocumentId = receipt
        ? await this.documents.recordStagedMedia(tx, receipt, 'expense_receipt')
        : null;
      await tx.insert(schema.expense).values({
        id: expenseId,
        companyId: staff.companyId,
        propertyId: input.propertyId,
        unitId: input.unitId ?? null,
        ownerId,
        bookId,
        category: input.category,
        supplierName: input.supplierName.trim(),
        amountMinor: input.amountMinor,
        expenseDate: input.expenseDate,
        paidBy: input.paidBy,
        receiptDocumentId,
        jobId: input.jobId ?? null,
        note: input.note?.trim() || null,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      if (input.jobId) {
        const [job] = await tx
          .select()
          .from(schema.maintenanceJob)
          .where(eq(schema.maintenanceJob.id, input.jobId));
        await this.maintenance.event(
          tx,
          job!,
          'expense_linked',
          { kind: 'staff', personId: staff.personId },
          {
            expenseId,
            amountMinor: input.amountMinor,
            supplierName: input.supplierName.trim(),
            ticket: formatTicketNumber(job!.ticketNumber),
          },
        );
      }
      await claim?.done(tx, { expenseId });
      return expenseId;
    });
    if (receipt) await this.documents.discardStagedMedia(receipt);
    return { expenseId: id };
  }

  /** What makes an expense recordable, checked before its receipt is staged and again in it. */
  private async validate(
    tx: Tx,
    staff: StaffActor,
    input: {
      readonly propertyId: string;
      readonly unitId?: string | null;
      readonly supplierName: string;
      readonly amountMinor: number;
      readonly expenseDate: string;
      readonly paidBy: ExpensePaidBy;
      readonly jobId?: string | null;
    },
  ): Promise<{ ownerId: string; bookId: string }> {
    const company = await companyRecord(tx, staff.companyId);
    const today = isoNow(this.clock, company?.timeZone ?? 'Africa/Accra');
    try {
      checkExpense({
        amountMinor: input.amountMinor,
        supplierName: input.supplierName,
        expenseDate: input.expenseDate,
        today,
        paidBy: input.paidBy,
        companyKind: company?.kind ?? 'landlord',
      });
    } catch (error) {
      domainInvalid(error);
    }
    const [property] = await tx
      .select({ id: schema.property.id })
      .from(schema.property)
      .where(eq(schema.property.id, input.propertyId));
    if (!property) throw notFound('Property');
    if (input.unitId) {
      const [unit] = await tx
        .select({ propertyId: schema.unit.propertyId })
        .from(schema.unit)
        .where(eq(schema.unit.id, input.unitId));
      if (!unit || unit.propertyId !== input.propertyId) throw notFound('Unit');
    }
    if (input.jobId) {
      const [job] = await tx
        .select({ propertyId: schema.maintenanceJob.propertyId })
        .from(schema.maintenanceJob)
        .where(eq(schema.maintenanceJob.id, input.jobId));
      if (!job || job.propertyId !== input.propertyId) throw notFound('Repair');
    }
    const owners = await ownersOn(tx, input.propertyId, input.expenseDate);
    if (owners.length !== 1 || owners[0]!.shareBps !== 10_000)
      throw conflict(
        owners.length === 0 ? 'no_owner' : 'joint_owners',
        owners.length === 0
          ? 'This property has no owner on the expense date'
          : 'This property has more than one owner, so its expenses cannot be posted yet (PR-07)',
      );
    const ownerId = owners[0]!.ownerId;
    const bookId = await ownerBook(tx, ownerId);
    if (!bookId) throw conflict('no_owner', 'The owner has no book');
    return { ownerId, bookId };
  }

  /** A payable paid later (P15: Dr 2500, Cr 1010 or 1070), once. */
  async pay(
    actor: Actor | null,
    expenseId: string,
    input: {
      paidOn: string;
      paidFrom: 'owner_account' | 'agency_account';
      reference?: string | null;
    },
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly expenseId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'expense.record');
    await this.write(staff, async (tx) => {
      await claim?.claim(tx);
      const row = await this.row(tx, expenseId, true);
      if (row.status !== 'unpaid')
        throw conflict('expense_closed', 'Only an unpaid expense can be paid');
      if (input.paidOn < row.expenseDate)
        throw invalid('paid_on', 'It was paid on or after the expense date');
      const company = await companyRecord(tx, staff.companyId);
      if (input.paidOn > isoNow(this.clock, company?.timeZone ?? 'Africa/Accra'))
        throw invalid('paid_on', 'Record a payment once it has been made');
      // A self-managing landlord has no agency account: 1070 never enters a landlord's book.
      if (input.paidFrom === 'agency_account' && company?.kind !== 'agency')
        throw invalid(
          'agency_account_not_available',
          'Only an agency pays from its own account; record it as paid from the owner’s account',
        );
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P15',
        key: `P15:${expenseId}:paid`,
        valueDate: input.paidOn,
        lines: expensePaymentLines({
          bookId: row.bookId,
          from: PAID_FROM[input.paidFrom],
          propertyId: row.property.id,
          unitId: row.unitId,
          amountMinor: row.amountMinor,
        }),
        record: { type: 'expense', id: expenseId },
        causedBy: staff.personId,
      });
      await tx.insert(schema.expensePayment).values({
        companyId: staff.companyId,
        propertyId: row.property.id,
        expenseId,
        paidOn: input.paidOn,
        paidFrom: input.paidFrom,
        reference: input.reference?.trim() || null,
        entryId: posted!.entryId,
        accountingDate: posted!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { expenseId });
    });
    return { expenseId };
  }

  /**
   * An expense recorded in error (P21a): its entry, and its payment's if paid later, each reversed
   * line for line. The right one is recorded as a new expense.
   */
  async reverse(
    actor: Actor | null,
    expenseId: string,
    reason: string,
    claim: IdempotencyClaim | null = null,
  ): Promise<{ readonly expenseId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'expense.record');
    await this.write(staff, async (tx) => {
      await claim?.claim(tx);
      const row = await this.row(tx, expenseId, true);
      if (row.status === 'reversed') throw conflict('expense_closed', 'This expense was reversed');
      const company = await companyRecord(tx, staff.companyId);
      const today = isoNow(this.clock, company?.timeZone ?? 'Africa/Accra');
      const reversal = uuidv7();
      const paymentEntry = row.paymentEntryId
        ? await this.posting.reverse(tx, {
            companyId: staff.companyId,
            entryId: row.paymentEntryId,
            key: `P21:${expenseId}:paid`,
            valueDate: today,
            record: { type: 'expense_reversal', id: reversal },
            causedBy: staff.personId,
          })
        : null;
      const entry = await this.posting.reverse(tx, {
        companyId: staff.companyId,
        entryId: row.entryId,
        key: `P21:${expenseId}`,
        valueDate: today,
        record: { type: 'expense_reversal', id: reversal },
        causedBy: staff.personId,
      });
      await tx.insert(schema.expenseReversal).values({
        id: reversal,
        companyId: staff.companyId,
        propertyId: row.property.id,
        expenseId,
        reason: reason.trim(),
        entryId: entry!.entryId,
        paymentEntryId: paymentEntry?.entryId ?? null,
        valueDate: today,
        accountingDate: entry!.accountingDate,
        createdBy: staff.personId,
      });
      await claim?.done(tx, { expenseId });
    });
    return { expenseId };
  }

  private reader(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'expense.read');
    return staff;
  }

  private async row(tx: Tx, expenseId: string, lock = false): Promise<ExpenseRowView> {
    // Expenses are append-only (no UPDATE grant, so no row lock): one writer at a time per expense.
    if (lock)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`expense:${expenseId}`}, 0))`,
      );
    const [row] = await expenseRows(tx, { expenseId });
    if (!row) throw notFound('Expense');
    return row;
  }

  private async write<T>(staff: StaffActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withCompany(this.database, staffContext(staff), fn);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return domainInvalid(error);
    }
  }
}

export type { ExpenseStatus };
