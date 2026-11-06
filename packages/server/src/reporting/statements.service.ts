import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type CompanyContext, type Database, type SQL, type Tx } from '@rent/db';
import { templates, type OwnerStatementDocumentData } from '@rent/documents';
import { addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import type { Actor } from '@rent/domain/policy';
import {
  diffStatementFigures,
  failedStatementChecks,
  flattenStatementFigures,
  reportMonth,
  type OwnerStatementFigures,
  type StatementFigureRow,
} from '@rent/domain/reporting';
import { v5 as uuidv5 } from 'uuid';
import { isoNow } from '../billing/records';
import { companyRecord, staffActor, type CompanyRecord } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { queueMessage } from '../core/messages';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { ownerBook } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { ownersVisibleTo } from './visibility';
import {
  computeOwnerStatement,
  statementDates,
  type StatementComputation,
  type StatementExpenseRow,
} from './statement-queries';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

/** The statement's PDF (AC-04). Template keys are `area.name` with dashes. */
export const OWNER_STATEMENT_TEMPLATE = { key: 'reporting.owner-statement', version: 1 } as const;
/** Monthly, 1st at 06:00 Africa/Accra: last month's draft for every owner (architecture 10). */
export const OWNER_STATEMENTS_JOB = 'reporting.owner-statements';

const NAMESPACE = '5d7c1e3a-9b2f-4c6d-8e1a-3f5b7d9c2e40';
const DOWNLOAD_MS = 300_000;
const FIGURE_BATCH = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const monthLabel = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

export type OwnerStatementStatus = 'draft' | 'issued';

export interface OwnerStatementView {
  readonly id: string;
  readonly owner: { readonly id: string; readonly name: string };
  readonly month: string;
  readonly status: OwnerStatementStatus;
  /** When these figures were worked out: now for a draft, the moment of issue once issued. */
  readonly generatedAt: Date;
  readonly issuedAt: Date | null;
  readonly issuedBy: { readonly personId: string; readonly name: string } | null;
  readonly sha256: string | null;
  readonly ownerTimeZone: string;
  readonly companyTimeZone: string;
  /** When the email with the PDF was queued to the owner (null: not sent, or no email). */
  readonly deliveredAt: Date | null;
}

export interface OwnerStatementDetailView extends OwnerStatementView {
  readonly figures: OwnerStatementFigures;
  readonly properties: readonly { readonly id: string; readonly name: string }[];
  readonly expenses: readonly StatementExpenseRow[];
  /** Issued: whether working the month out again gives the issued figures (AC-04 ★). */
  readonly matchesIssued: boolean | null;
  readonly actions: { readonly issue: boolean; readonly regenerate: boolean };
}

export interface OwnerStatementFilters {
  readonly ownerId?: string;
  readonly month?: string;
  readonly status?: OwnerStatementStatus;
}

/** An `owner_statement` row, as the reader's own transaction sees it (RLS). */
type StatementRecord = {
  readonly id: string;
  readonly owner_id: string;
  readonly book_id: string;
  readonly month: string;
  readonly status: OwnerStatementStatus;
  readonly generated_at: Date | string;
  readonly issued_at: Date | string | null;
  readonly issued_by: string | null;
  readonly render_request_id: string | null;
  readonly document_id: string | null;
  readonly sha256: string | null;
  readonly delivered_at: Date | string | null;
};

/** With its owner's facts and its issuer's name, read once the reader may see the owner. */
type StatementRow = StatementRecord & {
  readonly issued_by_name: string | null;
  readonly owner_name: string;
  readonly owner_reference: string;
  readonly owner_time_zone: string | null;
  readonly owner_email: string | null;
};

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const orNull = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);

/**
 * Monthly owner statements (AC-04; M9 plan 4.3, decisions 5 to 7 and 15). A draft is worked out
 * from the ledger on every read; issuing freezes its figures (`owner_statement_figure`), locks the
 * month in the owner's book, and renders the PDF; once rendered, its fingerprint is recorded and
 * it is emailed to the owner. A statement read later is worked out again and compared with the
 * issued figures. Owners' users and advisers see their own owners' statements only, by the
 * database's owner scope and by this service; the figures themselves are always worked out over
 * the owner's whole book, so they never depend on who reads them (decision 5) and an issued
 * statement stays complete for its owner after a property changes hands (decision 15). Growth
 * only (decision 13).
 */
@Injectable()
export class OwnerStatementsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Who may -----------------------------------------------------------------------------------

  private async allowed(actor: Actor | null, action: 'statements.read' | 'statements.issue') {
    const staff = staffActor(actor);
    this.policy.assert(staff, action);
    await this.entitlements.assert(staff.companyId, 'owner_reporting');
    return staff;
  }

  /**
   * The owner's whole book, for a reader the policy and the scope check below have allowed this
   * owner: the reader's own scope is left out on purpose, so the figures are the owner's, not the
   * part of them one person may see (decision 5), and stay so after ownership changes (decision
   * 15). The person is kept for the audit trail.
   */
  private wholeOwner(staff: StaffActor): CompanyContext {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' };
  }

  /**
   * AD-02 and decision 15: a statement covers its owner's whole book, so a person limited to some
   * owners sees those owners' statements, and a person limited to some properties sees an owner's
   * statements only when every property the owner has held is theirs.
   */
  private visibleOwners(staff: StaffActor, ownerIds: readonly string[]): Promise<Set<string>> {
    return ownersVisibleTo(this.database, this.policy, staff, ownerIds);
  }

  private async assertVisible(staff: StaffActor, ownerId: string): Promise<void> {
    if (!(await this.visibleOwners(staff, [ownerId])).has(ownerId)) throw notFound('Statement');
  }

  // Reads -------------------------------------------------------------------------------------

  /** Statement rows in the caller's transaction: the reader's own, RLS applying. */
  private async records(tx: Tx, where: SQL): Promise<StatementRecord[]> {
    const result = await tx.execute<StatementRecord>(
      sql`select s.id, s.owner_id, s.book_id, s.month, s.status, s.generated_at, s.issued_at,
            s.issued_by, s.render_request_id, s.document_id, s.sha256, s.delivered_at
          from owner_statement s where ${where}`,
    );
    return result.rows;
  }

  /**
   * The owners' facts and the issuers' names for statements the reader may see, in a
   * transaction over the whole company (people limited to properties see no owner records, and
   * reach an owner's name through what they are allowed: here, the statement). Newest month first.
   */
  private async withFacts(tx: Tx, records: readonly StatementRecord[]): Promise<StatementRow[]> {
    if (records.length === 0) return [];
    const owners = await tx.execute<{
      id: string;
      display_name: string;
      reference: string;
      time_zone: string | null;
      email: string | null;
    }>(
      sql`select id, display_name, reference, time_zone, email from owner
          where id = any(${`{${[...new Set(records.map((r) => r.owner_id))].join(',')}}`}::uuid[])`,
    );
    const issuers = records.flatMap((r) => (r.issued_by ? [r.issued_by] : []));
    const people =
      issuers.length === 0
        ? { rows: [] as { id: string; name: string }[] }
        : await tx.execute<{ id: string; name: string }>(
            sql`select id, name from person where id = any(${`{${[...new Set(issuers)].join(',')}}`}::uuid[])`,
          );
    const ownerOf = new Map(owners.rows.map((o) => [o.id, o]));
    const nameOf = new Map(people.rows.map((p) => [p.id, p.name]));
    return records
      .map((r) => {
        const o = ownerOf.get(r.owner_id);
        return {
          ...r,
          issued_by_name: r.issued_by ? (nameOf.get(r.issued_by) ?? null) : null,
          owner_name: o?.display_name ?? 'Owner',
          owner_reference: o?.reference ?? 'OWNER',
          owner_time_zone: o?.time_zone ?? null,
          owner_email: o?.email ?? null,
        };
      })
      .sort((a, b) =>
        a.month !== b.month
          ? a.month < b.month
            ? 1
            : -1
          : a.owner_name !== b.owner_name
            ? a.owner_name.localeCompare(b.owner_name)
            : a.id < b.id
              ? -1
              : 1,
      );
  }

  /** The company's facts and statements' facts, read over the whole company. */
  private facts(companyId: string, records: readonly StatementRecord[]) {
    return withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => ({
        rows: await this.withFacts(tx, records),
        company: await companyRecord(tx, companyId),
      }),
      { accessMode: 'read only' },
    );
  }

  /** Reads in the reader's own scope first (RLS: an owner's user sees their owners' rows only). */
  private async scopedRow(staff: StaffActor, statementId: string) {
    if (!UUID.test(statementId)) throw notFound('Statement');
    const [record] = await withCompany(
      this.database,
      staffContext(staff),
      (tx) => this.records(tx, sql`s.id = ${statementId}::uuid`),
      { accessMode: 'read only' },
    );
    if (!record) throw notFound('Statement');
    await this.assertVisible(staff, record.owner_id);
    const { rows, company } = await this.facts(staff.companyId, [record]);
    if (!rows[0] || !company) throw notFound('Statement');
    return { row: rows[0], company };
  }

  private view(row: StatementRow, company: CompanyRecord): OwnerStatementView {
    return {
      id: row.id,
      owner: { id: row.owner_id, name: row.owner_name },
      month: row.month,
      status: row.status,
      generatedAt: asDate(row.generated_at),
      issuedAt: orNull(row.issued_at),
      issuedBy: row.issued_by ? { personId: row.issued_by, name: row.issued_by_name ?? '' } : null,
      sha256: row.sha256,
      ownerTimeZone: row.owner_time_zone ?? company.timeZone,
      companyTimeZone: company.timeZone,
      deliveredAt: orNull(row.delivered_at),
    };
  }

  async list(
    actor: Actor | null,
    filters: OwnerStatementFilters = {},
  ): Promise<OwnerStatementView[]> {
    const staff = await this.allowed(actor, 'statements.read');
    if (filters.ownerId !== undefined && !UUID.test(filters.ownerId))
      throw invalid('bad_filter', 'Choose an owner from the list');
    if (filters.month !== undefined && !MONTH.test(filters.month))
      throw invalid('bad_filter', 'Use a month such as 2026-10');
    const where: SQL[] = [sql`true`];
    if (filters.ownerId) where.push(sql`s.owner_id = ${filters.ownerId}::uuid`);
    if (filters.month) where.push(sql`s.month = ${filters.month}`);
    if (filters.status) where.push(sql`s.status = ${filters.status}`);
    const records = await withCompany(
      this.database,
      staffContext(staff),
      (tx) => this.records(tx, sql.join(where, sql` and `)),
      { accessMode: 'read only' },
    );
    const visible = await this.visibleOwners(
      staff,
      records.map((r) => r.owner_id),
    );
    const { rows, company } = await this.facts(
      staff.companyId,
      records.filter((r) => visible.has(r.owner_id)),
    );
    if (!company) throw notFound('Company');
    return rows.map((r) => this.view(r, company));
  }

  async get(actor: Actor | null, statementId: string): Promise<OwnerStatementDetailView> {
    const staff = await this.allowed(actor, 'statements.read');
    const { row, company } = await this.scopedRow(staff, statementId);
    return this.detail(staff, row, company);
  }

  private compute(tx: Tx, row: StatementRow, company: CompanyRecord) {
    return computeOwnerStatement(tx, {
      ownerId: row.owner_id,
      bookId: row.book_id,
      month: row.month,
      agency: company.kind === 'agency',
      timeZone: company.timeZone,
    });
  }

  private async detail(
    staff: StaffActor,
    row: StatementRow,
    company: CompanyRecord,
  ): Promise<OwnerStatementDetailView> {
    const canIssue = this.policy.can(staff, 'statements.issue').allowed;
    return withCompany(
      this.database,
      this.wholeOwner(staff),
      async (tx) => {
        if (row.status === 'draft') {
          const fresh = await this.compute(tx, row, company);
          return {
            ...this.view(row, company),
            // Worked out again on this read (contract: generatedAt).
            generatedAt: this.clock.now(),
            figures: fresh.figures,
            properties: await this.propertyNames(tx, fresh.figures),
            expenses: fresh.expenses,
            matchesIssued: null,
            actions: { issue: canIssue, regenerate: canIssue },
          };
        }
        // Issued: the figures as frozen, and whether the month still works out the same. A
        // month that can no longer be worked out at all does not match; it never hides the issue.
        const fresh = await this.compute(tx, row, company).catch((error: unknown) => {
          if (error instanceof DomainError) return null;
          throw error;
        });
        const frozen = row.render_request_id
          ? await this.documents.renderedDocument(tx, row.render_request_id)
          : null;
        const data = frozen?.data as OwnerStatementDocumentData | undefined;
        const figures = data?.figures as OwnerStatementFigures | undefined;
        if (!figures) throw notFound('Statement');
        return {
          ...this.view(row, company),
          figures,
          properties: await this.propertyNames(tx, figures),
          expenses: data?.expenses ?? [],
          matchesIssued:
            fresh !== null &&
            diffStatementFigures(
              await this.issuedRows(tx, row.id),
              flattenStatementFigures(fresh.figures),
            ).length === 0,
          actions: { issue: false, regenerate: false },
        };
      },
      { accessMode: 'read only' },
    );
  }

  private async propertyNames(tx: Tx, figures: OwnerStatementFigures) {
    const ids = figures.properties.map((p) => p.propertyId as string);
    if (ids.length === 0) return [];
    const rows = await tx.execute<{ id: string; name: string }>(
      sql`select id, name from property where id = any(${`{${ids.join(',')}}`}::uuid[])`,
    );
    const names = new Map(rows.rows.map((r) => [r.id, r.name]));
    return ids.map((id) => ({ id, name: names.get(id) ?? 'A former property' }));
  }

  /** The figures as issued, in the order they were stored. */
  private async issuedRows(tx: Tx, statementId: string): Promise<StatementFigureRow[]> {
    const rows = await tx.execute<{ key: string; value_minor: string }>(
      sql`select key, value_minor from owner_statement_figure
          where statement_id = ${statementId}::uuid order by position`,
    );
    return rows.rows.map((r) => ({ key: r.key, value: Number(r.value_minor) }));
  }

  // Draft and issue -----------------------------------------------------------------------------

  private currentMonth(company: CompanyRecord): string {
    return isoNow(this.clock, company.timeZone).slice(0, 7);
  }

  private refuseOpenMonth(month: string, company: CompanyRecord): void {
    if (month >= this.currentMonth(company))
      throw conflict(
        'month_not_over',
        `${monthLabel(month)} is not over yet: a statement is drafted once its month has ended`,
      );
  }

  /**
   * Drafts an owner's statement for a past month, or works an existing draft out again. One per
   * owner and month; an issued one is never drafted again (409 STATEMENT_ISSUED).
   */
  async draft(
    actor: Actor | null,
    input: { readonly ownerId: string; readonly month: string },
  ): Promise<OwnerStatementDetailView> {
    const staff = await this.allowed(actor, 'statements.issue');
    if (!UUID.test(input.ownerId)) throw notFound('Owner');
    if (!MONTH.test(input.month)) throw invalid('bad_month', 'Use a month such as 2026-10');
    // The scope rule for statements first (a person limited to properties sees no owner
    // records), then the owner itself.
    await this.assertVisible(staff, input.ownerId);
    const company = await withCompany(
      this.database,
      { companyId: staff.companyId, actorKind: 'system' },
      async (tx) => {
        const owner = await tx.execute<{ id: string }>(
          sql`select id from owner where id = ${input.ownerId}::uuid`,
        );
        if (owner.rows.length === 0) throw notFound('Owner');
        return companyRecord(tx, staff.companyId);
      },
      { accessMode: 'read only' },
    );
    if (!company) throw notFound('Company');
    this.refuseOpenMonth(input.month, company);
    const statementId = await withCompany(this.database, this.wholeOwner(staff), async (tx) => {
      const bookId = await ownerBook(tx, input.ownerId);
      if (!bookId) throw notFound('Owner');
      const now = this.clock.now();
      const existing = await tx.execute<{ id: string; status: OwnerStatementStatus }>(
        sql`select id, status from owner_statement
            where owner_id = ${input.ownerId}::uuid and month = ${input.month} for update`,
      );
      const found = existing.rows[0];
      if (found?.status === 'issued')
        throw conflict(
          'statement_issued',
          `The statement for ${monthLabel(input.month)} was issued already`,
        );
      if (found) {
        await tx.execute(
          sql`update owner_statement set generated_at = ${now}, updated_at = ${now}
              where id = ${found.id}::uuid`,
        );
        return found.id;
      }
      return this.insertDraft(tx, {
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId,
        month: input.month,
        createdBy: staff.personId,
        now,
      });
    });
    const { row } = await this.scopedRow(staff, statementId);
    return this.detail(staff, row, company);
  }

  private async insertDraft(
    tx: Tx,
    input: {
      readonly companyId: string;
      readonly ownerId: string;
      readonly bookId: string;
      readonly month: string;
      readonly createdBy: string | null;
      readonly now: Date;
    },
  ): Promise<string> {
    const m = reportMonth(input.month);
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into owner_statement (company_id, owner_id, book_id, month, first_day, last_day,
            status, template_key, template_version, generated_at, created_by)
          values (${input.companyId}::uuid, ${input.ownerId}::uuid, ${input.bookId}::uuid,
            ${input.month}, ${m.firstDay}::date, ${m.lastDay}::date, 'draft',
            ${OWNER_STATEMENT_TEMPLATE.key}, ${OWNER_STATEMENT_TEMPLATE.version}, ${input.now},
            ${input.createdBy}::uuid)
          on conflict (company_id, owner_id, month) do nothing
          returning id`,
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const again = await tx.execute<{ id: string }>(
      sql`select id from owner_statement where owner_id = ${input.ownerId}::uuid and month = ${input.month}`,
    );
    return again.rows[0]!.id;
  }

  /**
   * Issues a drafted statement (decision 7), in one transaction: the month must be over and every
   * check must pass; its figures are frozen as worked out now, the month is locked in the owner's
   * book (anything recorded later takes the open month's accounting date), and its PDF is
   * requested. The email follows once the PDF exists (`onDocumentRendered`). Nothing is sent to a
   * provider here. Idempotent by state: a second issue is refused (409 STATEMENT_ISSUED).
   */
  async issue(
    actor: Actor | null,
    statementId: string,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<OwnerStatementDetailView> {
    const staff = await this.allowed(actor, 'statements.issue');
    const { row, company } = await this.scopedRow(staff, statementId);
    await withCompany(this.database, this.wholeOwner(staff), async (tx) => {
      await options.claim?.claim(tx);
      const [locked] = (
        await tx.execute<{ status: OwnerStatementStatus }>(
          sql`select status from owner_statement where id = ${row.id}::uuid for update`,
        )
      ).rows;
      if (!locked) throw notFound('Statement');
      if (locked.status === 'issued')
        throw conflict(
          'statement_issued',
          `The statement for ${monthLabel(row.month)} was issued already`,
        );
      this.refuseOpenMonth(row.month, company);
      const computed = await this.compute(tx, row, company);
      const failed = failedStatementChecks(computed.figures);
      if (failed.length > 0)
        throw conflict(
          'statement_unbalanced',
          `The statement does not add up, so it cannot be issued: ${failed
            .map((c) => `${c.name} (${c.scope})`)
            .join(', ')}`,
          { checks: failed.map((c) => `${c.name}:${c.scope}`).join(',') },
        );
      const now = this.clock.now();
      const issuer = await tx.execute<{ name: string }>(
        sql`select name from person where id = ${staff.personId}::uuid`,
      );
      const data = await this.documentData(tx, {
        row,
        company,
        computed,
        issuedAt: now,
        issuedByName: issuer.rows[0]?.name ?? 'Staff',
      });
      // Checked as the renderer will check it, so a statement never issues with a PDF that fails.
      templates
        .get(OWNER_STATEMENT_TEMPLATE.key, OWNER_STATEMENT_TEMPLATE.version)
        .schema.parse(data);
      const renderRequestId = await this.documents.requestRender(tx, {
        companyId: staff.companyId,
        templateKey: OWNER_STATEMENT_TEMPLATE.key,
        templateVersion: OWNER_STATEMENT_TEMPLATE.version,
        data: data as unknown as Record<string, unknown>,
        requestedBy: staff.personId,
      });
      await tx.execute(
        sql`update owner_statement set status = 'issued', issued_at = ${now},
              issued_by = ${staff.personId}::uuid, generated_at = ${now},
              template_key = ${OWNER_STATEMENT_TEMPLATE.key},
              template_version = ${OWNER_STATEMENT_TEMPLATE.version},
              render_request_id = ${renderRequestId}::uuid, updated_at = ${now}
            where id = ${row.id}::uuid`,
      );
      const figures = flattenStatementFigures(computed.figures);
      for (let i = 0; i < figures.length; i += FIGURE_BATCH) {
        const part = figures.slice(i, i + FIGURE_BATCH);
        await tx.execute(
          sql`insert into owner_statement_figure (company_id, statement_id, owner_id, key, value_minor, position)
              values ${sql.join(
                part.map(
                  (f, j) =>
                    sql`(${staff.companyId}::uuid, ${row.id}::uuid, ${row.owner_id}::uuid, ${f.key}, ${f.value}, ${i + j + 1})`,
                ),
                sql`, `,
              )}`,
        );
      }
      await this.posting.lockMonth(tx, {
        companyId: staff.companyId,
        bookId: row.book_id,
        month: row.month,
        source: 'owner_statement',
        note: `Owner statement ${row.id}`,
        lockedBy: staff.personId,
      });
      await options.claim?.done(tx, { statementId: row.id });
    });
    const issued = await this.scopedRow(staff, row.id);
    return this.detail(staff, issued.row, company);
  }

  /** The PDF's frozen data: the figures as issued, names, times, payments and expenses. */
  private async documentData(
    tx: Tx,
    input: {
      readonly row: StatementRow;
      readonly company: CompanyRecord;
      readonly computed: StatementComputation;
      readonly issuedAt: Date;
      readonly issuedByName: string;
    },
  ): Promise<OwnerStatementDocumentData> {
    const { row, company, computed } = input;
    const properties = await this.propertyNames(tx, computed.figures);
    return {
      statementId: row.id,
      companyName: company.displayName,
      ownerName: row.owner_name,
      ownerReference: row.owner_reference,
      companyTimeZone: company.timeZone,
      ownerTimeZone: row.owner_time_zone ?? company.timeZone,
      generatedAt: input.issuedAt.toISOString(),
      issuedAt: input.issuedAt.toISOString(),
      issuedByName: input.issuedByName,
      propertyNames: properties.map((p) => ({ id: p.id, name: p.name })),
      figures: computed.figures as unknown as OwnerStatementDocumentData['figures'],
      payments: computed.payments.map((p) => ({
        propertyId: p.propertyId,
        unitCode: p.unitCode,
        kind: p.kind,
        method: p.method,
        receivedOn: p.receivedOn,
        recordedAt: p.recordedAt.toISOString(),
        amountMinor: p.amountMinor,
      })),
      expenses: computed.expenses.map((e) => ({ ...e })),
    };
  }

  /** A 5-minute link to the issued statement's PDF; 409 STATEMENT_RENDERING while it renders. */
  async document(
    actor: Actor | null,
    statementId: string,
  ): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    const staff = await this.allowed(actor, 'statements.read');
    const { row } = await this.scopedRow(staff, statementId);
    if (row.status !== 'issued')
      throw conflict('statement_not_issued', 'A draft has no PDF: issue the statement first');
    let documentId = row.document_id;
    if (!documentId && row.render_request_id) {
      const rendered = await withCompany(
        this.database,
        this.wholeOwner(staff),
        (tx) => this.documents.renderedDocument(tx, row.render_request_id!),
        { accessMode: 'read only' },
      );
      if (rendered?.status === 'rendered') documentId = rendered.documentId;
    }
    if (!documentId)
      throw conflict('statement_rendering', 'The PDF is still being made. Try again in a moment.');
    const url = await this.documents.downloadUrl(
      staff.companyId,
      documentId,
      `owner-statement-${row.month}.pdf`,
    );
    if (!url) throw notFound('Statement PDF');
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_MS) };
  }

  /**
   * `documents.rendered` for a statement (as M8's `MoveOutService.onDocumentRendered`): the PDF's
   * document and SHA-256 are recorded once on the issued statement, and the email with the PDF
   * attached is queued through the outbox to the owner's email on record, in the same
   * transaction; `delivered_at` is when it was queued. An owner with no email is not emailed, and
   * sees the statement in the web app. Idempotent.
   */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== OWNER_STATEMENT_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId ||
        !rendered.sha256
      )
        return false;
      const [row] = await this.withFacts(
        tx,
        await this.records(tx, sql`s.render_request_id = ${renderRequestId}::uuid`),
      );
      if (!row || row.status !== 'issued' || row.document_id) return false;
      const company = await companyRecord(tx, companyId);
      const now = this.clock.now();
      let deliveredAt: Date | null = null;
      if (row.owner_email) {
        await queueMessage(tx, companyId, {
          messageId: uuidv5(`${row.id}:statement-email`, NAMESPACE),
          recipient: { type: 'owner', ownerId: row.owner_id },
          // No purpose of its own yet: an owner's message about their own money, as M4b's alerts.
          purpose: 'settlement_alert',
          channels: ['email'],
          subject: `Your statement for ${monthLabel(row.month)}`,
          body: `${company?.displayName ?? 'Your agent'} has issued your owner statement for ${monthLabel(row.month)}. It is attached.`,
          related: { type: 'owner_statement', id: row.id },
          requestedBy: row.issued_by,
          document: {
            documentId: rendered.documentId,
            filename: `owner-statement-${row.month}.pdf`,
          },
        });
        deliveredAt = now;
      }
      await tx.execute(
        sql`update owner_statement set document_id = ${rendered.documentId}::uuid,
              sha256 = ${rendered.sha256}, delivered_at = ${deliveredAt}, updated_at = ${now}
            where id = ${row.id}::uuid and document_id is null`,
      );
      return true;
    });
  }

  // The monthly job -----------------------------------------------------------------------------

  /**
   * `reporting.owner-statements` for one company (decision 7): last month's draft, in the
   * company's time zone, for every owner with a book. Idempotent per owner and month; a company
   * without owner statements on its plan is skipped. Works nothing out: a draft is worked out
   * when it is read.
   */
  async draftLastMonth(companyId: string): Promise<{ month: string | null; drafted: number }> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      if (!(await this.entitlements.hasIn(tx, companyId, 'owner_reporting')))
        return { month: null, drafted: 0 };
      const company = await companyRecord(tx, companyId);
      if (!company) throw notFound('Company');
      const thisMonth = parseBusinessDate(`${this.currentMonth(company)}-01`);
      const month = toIsoDate(addMonths(thisMonth, -1)).slice(0, 7);
      const d = statementDates(month, company.timeZone);
      const inserted = await tx.execute(
        sql`insert into owner_statement (company_id, owner_id, book_id, month, first_day, last_day,
              status, template_key, template_version, generated_at)
            select b.company_id, b.owner_id, b.id, ${month}, ${d.firstDay}::date, ${d.lastDay}::date,
              'draft', ${OWNER_STATEMENT_TEMPLATE.key}, ${OWNER_STATEMENT_TEMPLATE.version},
              ${this.clock.now()}
            from book b where b.kind = 'owner' and b.owner_id is not null
            on conflict (company_id, owner_id, month) do nothing`,
      );
      return { month, drafted: inserted.rowCount ?? 0 };
    });
  }
}
