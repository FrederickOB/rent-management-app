import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, type Tx } from '@rent/db';
import { monthOf } from '@rent/domain/ledger';
import {
  accountingDateFor,
  checkEntry,
  reversalLines,
  type AccountCode,
  type BookKind,
  type JournalLineDraft,
  type PostingRule,
} from '@rent/domain/ledger';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';

/** One business event to post (CLAUDE.md section 4): its rule, its key and its lines. */
export interface PostingRequest {
  readonly companyId: string;
  readonly rule: PostingRule;
  /** `<rule>:<record id>`; accruals `P02:<invoice line id>`. A replay posts nothing new. */
  readonly key: string;
  /** When it happened. The accounting date follows from the books' locked months. */
  readonly valueDate: string;
  readonly lines: readonly JournalLineDraft[];
  /** The business record the entry belongs to. */
  readonly record: { readonly type: string; readonly id: string };
  /** P21(a): the entry this one reverses, line for line. */
  readonly reverses?: string | null;
  readonly causedBy?: string | null;
  readonly requestId?: string | null;
}

export interface PostedEntry {
  readonly entryId: string;
  readonly accountingDate: string;
  /** True when the key had been posted before: nothing new was written. */
  readonly replayed: boolean;
}

export type EntryLine = JournalLineDraft & { readonly entryId: string };

/**
 * The only code that writes journal rows (ADR-003; M4a plan 4.1). It checks each entry with the
 * domain's rules, takes the accounting date from the books' locks, and inserts the entry and its
 * lines as `ledger_writer`, the only role with INSERT on the journal, in the caller's transaction,
 * so the entry commits or rolls back with its business record. The database checks the entry again
 * at commit (two lines or more, zero in each book) and refuses anyone else. Each entry is audited
 * once (`ledger.entry_posted`).
 */
@Injectable()
export class PostingService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** The kinds of the books an entry touches, read in the caller's transaction. */
  async bookKinds(tx: Tx, bookIds: readonly string[]): Promise<Map<string, BookKind>> {
    if (bookIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.book.id, kind: schema.book.kind })
      .from(schema.book)
      .where(inArray(schema.book.id, [...new Set(bookIds)]));
    return new Map(rows.map((r) => [r.id, r.kind as BookKind]));
  }

  /**
   * The accounting date for a value date (AC-04): the value date itself, unless its month is
   * locked in one of the books, then the first day of the first open month after it.
   */
  async accountingDate(tx: Tx, bookIds: readonly string[], valueDate: string): Promise<string> {
    if (bookIds.length === 0) return accountingDateFor(valueDate, new Set());
    const locks = await tx
      .select({ month: schema.periodLock.month })
      .from(schema.periodLock)
      .where(
        and(
          inArray(schema.periodLock.bookId, [...new Set(bookIds)]),
          sql`${schema.periodLock.month} >= date_trunc('month', ${valueDate}::date)::date`,
        ),
      );
    return accountingDateFor(valueDate, new Set(locks.map((l) => monthOf(l.month))));
  }

  /** The entry already posted under a key, if any. */
  async findByKey(
    tx: Tx,
    companyId: string,
    key: string,
  ): Promise<{ entryId: string; accountingDate: string } | null> {
    const [row] = await tx
      .select({ id: schema.journalEntry.id, accountingDate: schema.journalEntry.accountingDate })
      .from(schema.journalEntry)
      .where(
        and(
          eq(schema.journalEntry.companyId, companyId),
          eq(schema.journalEntry.idempotencyKey, key),
        ),
      );
    return row ? { entryId: row.id, accountingDate: row.accountingDate } : null;
  }

  /**
   * Posts an entry, or returns the one already posted under its key. An event with no lines (a
   * credit note on a line nothing was charged or paid for) posts nothing and returns null.
   */
  async post(tx: Tx, request: PostingRequest): Promise<PostedEntry | null> {
    const existing = await this.findByKey(tx, request.companyId, request.key);
    if (existing) return { ...existing, replayed: true };
    if (request.lines.length === 0) return null;
    const bookIds = [...new Set(request.lines.map((l) => l.bookId))];
    const kinds = await this.bookKinds(tx, bookIds);
    checkEntry(request.lines, (bookId) => {
      const kind = kinds.get(bookId);
      if (!kind) throw new Error(`Book ${bookId} is not in this company`);
      return kind;
    });
    const accountingDate = await this.accountingDate(tx, bookIds, request.valueDate);
    const entryId = uuidv7();
    await tx.execute(sql`set local role ledger_writer`);
    await tx.insert(schema.journalEntry).values({
      id: entryId,
      companyId: request.companyId,
      rule: request.rule,
      idempotencyKey: request.key,
      valueDate: request.valueDate,
      accountingDate,
      reversesEntryId: request.reverses ?? null,
      recordType: request.record.type,
      recordId: request.record.id,
      causedBy: request.causedBy ?? null,
      requestId: request.requestId ?? null,
    });
    await tx.insert(schema.journalLine).values(
      request.lines.map((line, index) => ({
        id: uuidv7(),
        companyId: request.companyId,
        entryId,
        lineNo: index + 1,
        bookId: line.bookId,
        accountCode: line.accountCode,
        amountMinor: line.amountMinor,
        propertyId: line.propertyId ?? null,
        unitId: line.unitId ?? null,
        leaseId: line.leaseId ?? null,
        tenantId: line.tenantId ?? null,
        invoiceLineId: line.invoiceLineId ?? null,
        paymentId: line.paymentId ?? null,
        collectorId: line.collectorId ?? null,
        provider: line.provider ?? null,
        settlementAccountId: line.settlementAccountId ?? null,
        settlementId: line.settlementId ?? null,
      })),
    );
    await tx.execute(sql`set local role none`);
    await this.audit.append(tx, {
      companyId: request.companyId,
      action: 'ledger.entry_posted',
      recordType: 'journal_entry',
      recordId: entryId,
      data: {
        rule: request.rule,
        key: request.key,
        record: request.record,
        valueDate: request.valueDate,
        accountingDate,
        reverses: request.reverses ?? null,
        lines: request.lines.length,
        books: bookIds.map((bookId) => {
          const mine = request.lines.filter((l) => l.bookId === bookId);
          return {
            bookId,
            debitMinor: mine.reduce((s, l) => s + Math.max(0, l.amountMinor), 0),
            creditMinor: mine.reduce((s, l) => s + Math.max(0, -l.amountMinor), 0),
          };
        }),
      },
    });
    return { entryId, accountingDate, replayed: false };
  }

  /** An entry's lines, in order. */
  async entryLines(tx: Tx, entryId: string): Promise<EntryLine[]> {
    const rows = await tx
      .select()
      .from(schema.journalLine)
      .where(eq(schema.journalLine.entryId, entryId))
      .orderBy(schema.journalLine.lineNo);
    return rows.map((r) => ({
      entryId: r.entryId,
      bookId: r.bookId,
      accountCode: r.accountCode as AccountCode,
      amountMinor: r.amountMinor,
      propertyId: r.propertyId,
      unitId: r.unitId,
      leaseId: r.leaseId,
      tenantId: r.tenantId,
      invoiceLineId: r.invoiceLineId,
      paymentId: r.paymentId,
      collectorId: r.collectorId,
      provider: r.provider,
      settlementAccountId: r.settlementAccountId,
      settlementId: r.settlementId,
    }));
  }

  /**
   * P21(a): reverses an entry nothing has used since, line for line with signs flipped, naming it.
   * An entry is reversed at most once (a unique index); a reversal is never itself reversed.
   */
  async reverse(
    tx: Tx,
    input: {
      readonly companyId: string;
      readonly entryId: string;
      readonly key: string;
      readonly valueDate: string;
      readonly record: { readonly type: string; readonly id: string };
      readonly causedBy?: string | null;
    },
  ): Promise<PostedEntry | null> {
    const [original] = await tx
      .select({ reverses: schema.journalEntry.reversesEntryId })
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.id, input.entryId));
    if (!original) throw new Error(`Entry ${input.entryId} not found`);
    if (original.reverses) throw new Error('A reversal is never itself reversed');
    const lines = await this.entryLines(tx, input.entryId);
    return this.post(tx, {
      companyId: input.companyId,
      rule: 'P21',
      key: input.key,
      valueDate: input.valueDate,
      lines: reversalLines(lines.map(({ entryId: _entry, ...line }) => line)),
      record: input.record,
      reverses: input.entryId,
      causedBy: input.causedBy ?? null,
    });
  }

  /**
   * Locks a month of a book (AC-04). Owner statements issue locks in M9; M4a builds the rule and
   * its tests. Idempotent.
   */
  async lockMonth(
    tx: Tx,
    input: {
      readonly companyId: string;
      readonly bookId: string;
      readonly month: string;
      readonly source: 'owner_statement' | 'manual';
      readonly note?: string | null;
      readonly lockedBy?: string | null;
    },
  ): Promise<void> {
    await tx
      .insert(schema.periodLock)
      .values({
        companyId: input.companyId,
        bookId: input.bookId,
        month: `${monthOf(input.month)}-01`,
        source: input.source,
        note: input.note ?? null,
        lockedBy: input.lockedBy ?? null,
      })
      .onConflictDoNothing();
  }
}
