import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { graPaymentLines, vatPaymentLines } from '@rent/domain/ledger';
import type { Actor } from '@rent/domain/policy';
import { checkChosenSettlement, settleOldestFirst } from '@rent/domain/tax';
import { v7 as uuidv7 } from 'uuid';
import { formatInvoiceNumber, isoNow, ownerBookId } from '../billing/records';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, GRA_RECEIPT_UPLOAD } from '../documents/documents.service';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { lockOwnerTax, ruleStatuses, taxItems, uuids } from './tax-records';

export interface GraPaymentInput {
  readonly ownerId: string;
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly graReceiptNumber: string;
  readonly receiptUploadId: string;
  readonly paidFrom: 'owner_account' | 'agency_account';
  /** The items it settles; oldest due first when left out (plan 5.3). */
  readonly items?: readonly { readonly itemId: string; readonly amountMinor: number }[] | null;
  readonly note?: string | null;
}

export interface VatPaymentInput {
  readonly ownerId: string;
  /** The return's month, as its first day (2026-10-01). */
  readonly periodMonth: string;
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly graReceiptNumber: string;
  readonly receiptUploadId: string;
  readonly paidFrom: 'owner_account' | 'agency_account';
  readonly note?: string | null;
}

export interface GraPaymentView {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly paidOn: string;
  readonly accountingDate: string;
  readonly amountMinor: number;
  readonly graReceiptNumber: string;
  readonly receiptDocumentId: string;
  readonly paidFrom: 'owner_account' | 'agency_account';
  readonly note: string | null;
  readonly items: readonly {
    readonly itemId: string;
    readonly receiptNumber: string | null;
    readonly unitCode: string;
    readonly valueDate: string;
    readonly amountMinor: number;
  }[];
  readonly createdAt: Date;
}

export interface VatReport {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly ownerTin: string | null;
  readonly month: string;
  readonly invoices: readonly {
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly unitCode: string;
    readonly tenantName: string;
    readonly tenantTin: string | null;
    /** The tax point: the invoice or the payment that made it issue, whichever came first (P32). */
    readonly taxPoint: string;
    readonly vatMinor: number;
    readonly nhilMinor: number;
    readonly getfundMinor: number;
    /** Credit notes on the VAT and levy lines in the month (P27), negative. */
    readonly adjustmentsMinor: number;
    readonly totalMinor: number;
  }[];
  readonly totals: {
    readonly vatMinor: number;
    readonly nhilMinor: number;
    readonly getfundMinor: number;
    readonly adjustmentsMinor: number;
    readonly totalMinor: number;
    readonly paidMinor: number;
    readonly outstandingMinor: number;
  };
  readonly payments: readonly VatPaymentView[];
  readonly warnings: readonly string[];
}

export interface VatPaymentView {
  readonly id: string;
  readonly ownerId: string;
  readonly periodMonth: string;
  readonly paidOn: string;
  readonly accountingDate: string;
  readonly amountMinor: number;
  readonly graReceiptNumber: string;
  readonly receiptDocumentId: string;
  readonly paidFrom: 'owner_account' | 'agency_account';
  readonly note: string | null;
  readonly createdAt: Date;
}

const ACCOUNT = { owner_account: '1010', agency_account: '1070' } as const;

const domainInvalid = (error: unknown): never => {
  if (error instanceof DomainError) throw invalid(error.code, error.message);
  throw error;
};

/**
 * Paying GRA (TX-03, P18; P33; M5 plan 5.3 and 5.6): rent tax paid with GRA's receipt, settling
 * chosen items (oldest due first by default), and VAT and levies paid with a return. Each posts
 * from the owner's account (1010) or the agency's client account (1070), in the owner's book.
 */
@Injectable()
export class GraService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private unscoped(staff: StaffActor) {
    return { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' as const };
  }

  /** A presigned upload for GRA's receipt (rent tax or VAT). */
  async createUpload(
    actor: Actor | null,
    input: { readonly contentType: string; readonly sizeBytes: number },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tax.manage');
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      GRA_RECEIPT_UPLOAD,
      input.contentType,
      input.sizeBytes,
    );
  }

  private async checkPayment(
    tx: Tx,
    staff: StaffActor,
    input: Pick<GraPaymentInput, 'ownerId' | 'paidOn' | 'paidFrom' | 'graReceiptNumber'>,
  ): Promise<string> {
    parseBusinessDate(input.paidOn);
    const company = await companyRecord(tx, staff.companyId);
    if (input.paidOn > isoNow(this.clock, company!.timeZone))
      throw invalid('paid_in_future', 'The day it was paid cannot be in the future');
    if (input.paidFrom === 'agency_account' && company!.kind !== 'agency')
      throw invalid('paid_from', 'Only an agency has an agency account');
    if (!input.graReceiptNumber.trim()) throw invalid('gra_receipt', 'Enter GRA’s receipt number');
    if (!(await ownerFacts(tx, [input.ownerId])).has(input.ownerId)) throw notFound('Owner');
    return ownerBookId(tx, input.ownerId);
  }

  /** Records rent tax paid to GRA (P18), settling items, with GRA's receipt attached. */
  async recordGraPayment(
    actor: Actor | null,
    input: GraPaymentInput,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tax.manage');
    await withCompany(this.database, staffContext(staff), (tx) =>
      this.checkPayment(tx, staff, input),
    );
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.receiptUploadId,
      GRA_RECEIPT_UPLOAD,
    );
    const id = uuidv7();
    await withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      const bookId = await this.checkPayment(tx, staff, input);
      await lockOwnerTax(tx, staff.companyId, input.ownerId);
      const open = (await taxItems(tx, sql`i.owner_id = ${input.ownerId}`)).filter(
        (i) => i.outstandingMinor > 0,
      );
      let settlement: { itemId: string; amountMinor: number }[];
      try {
        if (input.items && input.items.length > 0) {
          const total = checkChosenSettlement(
            new Map(open.map((i) => [i.id, i.outstandingMinor])),
            input.items,
          );
          if (total !== input.amountMinor)
            throw invalid('items_total', 'The amounts per item add up to the payment');
          settlement = [...input.items];
        } else
          settlement = settleOldestFirst(
            open.map((i) => ({
              id: i.id,
              dueDate: i.dueDate ?? i.valueDate,
              outstandingMinor: i.outstandingMinor,
            })),
            input.amountMinor,
          );
      } catch (error) {
        return domainInvalid(error);
      }
      const byId = new Map(open.map((i) => [i.id, i]));
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P18',
        key: `P18:${id}`,
        valueDate: input.paidOn,
        lines: graPaymentLines({
          bookId,
          from: ACCOUNT[input.paidFrom],
          items: settlement.map((s) => {
            const item = byId.get(s.itemId)!;
            return {
              paymentId: item.paymentId,
              amountMinor: s.amountMinor,
              lease: {
                propertyId: item.propertyId,
                unitId: item.unitId,
                leaseId: item.leaseId,
                tenantId: item.tenantId,
              },
            };
          }),
        }),
        record: { type: 'gra_payment', id },
        causedBy: staff.personId,
      });
      const receiptDocumentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'gra_receipt',
      );
      await tx.insert(schema.graPayment).values({
        id,
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId,
        paidOn: input.paidOn,
        accountingDate: posted!.accountingDate,
        amountMinor: input.amountMinor,
        graReceiptNumber: input.graReceiptNumber.trim().slice(0, 80),
        receiptDocumentId,
        paidFrom: input.paidFrom,
        note: input.note?.trim().slice(0, 500) || null,
        entryId: posted!.entryId,
        recordedBy: staff.personId,
      });
      await tx.insert(schema.graPaymentItem).values(
        settlement.map((s) => ({
          companyId: staff.companyId,
          graPaymentId: id,
          itemId: s.itemId,
          amountMinor: s.amountMinor,
        })),
      );
      await options.claim?.done(tx, { graPaymentId: id });
    });
    await this.documents.discardStagedUpload(staged);
    return id;
  }

  async graPayments(
    actor: Actor | null,
    filter: {
      readonly ownerId?: string;
      readonly from?: string;
      readonly to?: string;
      readonly ids?: readonly string[];
    },
  ): Promise<GraPaymentView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), (tx) => this.graPaymentsIn(tx, filter));
  }

  async graPaymentsIn(
    tx: Tx,
    filter: {
      readonly ownerId?: string;
      readonly from?: string;
      readonly to?: string;
      readonly ids?: readonly string[];
    },
  ): Promise<GraPaymentView[]> {
    const conditions = [sql`true`];
    if (filter.ownerId) conditions.push(sql`g.owner_id = ${filter.ownerId}`);
    if (filter.from) conditions.push(sql`g.accounting_date >= ${filter.from}::date`);
    if (filter.to) conditions.push(sql`g.accounting_date <= ${filter.to}::date`);
    if (filter.ids) conditions.push(sql`g.id = any(${uuids([...filter.ids])})`);
    const rows = await tx.execute<{
      id: string;
      owner_id: string;
      owner_name: string;
      paid_on: string;
      accounting_date: string;
      amount_minor: string;
      gra_receipt_number: string;
      receipt_document_id: string;
      paid_from: 'owner_account' | 'agency_account';
      note: string | null;
      created_at: Date;
    }>(
      sql`select g.id, g.owner_id, o.display_name as owner_name, g.paid_on::text, g.accounting_date::text,
            g.amount_minor, g.gra_receipt_number, g.receipt_document_id, g.paid_from, g.note, g.created_at
          from gra_payment g join owner o on o.company_id = g.company_id and o.id = g.owner_id
          where ${sql.join(conditions, sql` and `)}
          order by g.accounting_date, g.paid_on, g.created_at, g.id`,
    );
    const ids = rows.rows.map((r) => r.id);
    const items =
      ids.length === 0
        ? []
        : (
            await tx.execute<{
              gra_payment_id: string;
              item_id: string;
              receipt_number: string | null;
              unit_code: string;
              value_date: string;
              amount_minor: string;
            }>(
              sql`select p.gra_payment_id, p.item_id, i.receipt_number, i.unit_code, i.value_date::text, p.amount_minor
                  from gra_payment_item p join rent_tax_item i on i.company_id = p.company_id and i.id = p.item_id
                  where p.gra_payment_id = any(${uuids(ids)}) order by i.value_date, i.id`,
            )
          ).rows;
    return rows.rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      paidOn: r.paid_on,
      accountingDate: r.accounting_date,
      amountMinor: Number(r.amount_minor),
      graReceiptNumber: r.gra_receipt_number,
      receiptDocumentId: r.receipt_document_id,
      paidFrom: r.paid_from,
      note: r.note,
      items: items
        .filter((i) => i.gra_payment_id === r.id)
        .map((i) => ({
          itemId: i.item_id,
          receiptNumber:
            i.receipt_number === null ? null : `RC-${String(i.receipt_number).padStart(6, '0')}`,
          unitCode: i.unit_code,
          valueDate: i.value_date,
          amountMinor: Number(i.amount_minor),
        })),
      createdAt: r.created_at,
    }));
  }

  // VAT returns (P33) -----------------------------------------------------------------------------

  /**
   * The VAT and levies an owner charged in a month, by invoice, at their tax points (P32), with
   * credit notes on VAT lines as adjustments (P27), the VAT paid for the month (P33) and what is
   * still to pay for it. Selected by the tax point (the entry's value date).
   */
  async vatReport(
    actor: Actor | null,
    input: { readonly ownerId: string; readonly month: string },
  ): Promise<VatReport> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    const start = monthStart(input.month);
    const end = toIsoDate(addDays(addMonths(parseBusinessDate(start), 1), -1));
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const owner = (await ownerFacts(tx, [input.ownerId])).get(input.ownerId);
      if (!owner) throw notFound('Owner');
      const rows = await tx.execute<{
        invoice_id: string;
        invoice_number: string;
        unit_code: string;
        tenant_name: string;
        tenant_tin: string | null;
        rule: string;
        kind: string;
        tax_point: string;
        amount: string;
      }>(
        sql`select i.id as invoice_id, i.number as invoice_number, i.unit_code, i.billed_to_name as tenant_name,
              i.billed_to_tin as tenant_tin, e.rule, il.kind, min(e.value_date)::text as tax_point,
              (-sum(l.amount_minor))::bigint as amount
            from journal_line l
            join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
            join invoice_line il on il.company_id = l.company_id and il.id = l.invoice_line_id
            join invoice i on i.company_id = il.company_id and i.id = il.invoice_id
            join book b on b.company_id = l.company_id and b.id = l.book_id
            where b.owner_id = ${input.ownerId} and l.account_code = '2210' and e.rule in ('P32', 'P27')
              and e.value_date between ${start}::date and ${end}::date
            group by i.id, i.number, i.unit_code, i.billed_to_name, i.billed_to_tin, e.rule, il.kind
            order by i.number`,
      );
      const byInvoice = new Map<string, VatReport['invoices'][number] & { [k: string]: unknown }>();
      for (const r of rows.rows) {
        const current = byInvoice.get(r.invoice_id) ?? {
          invoiceId: r.invoice_id,
          invoiceNumber: formatInvoiceNumber(Number(r.invoice_number)),
          unitCode: r.unit_code,
          tenantName: r.tenant_name,
          tenantTin: r.tenant_tin,
          taxPoint: r.tax_point,
          vatMinor: 0,
          nhilMinor: 0,
          getfundMinor: 0,
          adjustmentsMinor: 0,
          totalMinor: 0,
        };
        const amount = Number(r.amount);
        const next = { ...current };
        if (r.rule === 'P27') next.adjustmentsMinor += amount;
        else if (r.kind === 'vat') next.vatMinor += amount;
        else if (r.kind === 'nhil') next.nhilMinor += amount;
        else if (r.kind === 'getfund') next.getfundMinor += amount;
        if (r.rule === 'P32' && r.tax_point < next.taxPoint) next.taxPoint = r.tax_point;
        next.totalMinor =
          next.vatMinor + next.nhilMinor + next.getfundMinor + next.adjustmentsMinor;
        byInvoice.set(r.invoice_id, next);
      }
      const invoices = [...byInvoice.values()];
      const payments = await this.vatPaymentsIn(tx, { ownerId: input.ownerId, periodMonth: start });
      const sum = (
        k: 'vatMinor' | 'nhilMinor' | 'getfundMinor' | 'adjustmentsMinor' | 'totalMinor',
      ) => invoices.reduce((s, i) => s + i[k], 0);
      const paid = payments.reduce((s, p) => s + p.amountMinor, 0);
      const rules = await tx.execute<{ id: string }>(
        sql`select distinct il.rule_id as id from invoice_line il
            where il.invoice_id = any(${uuids(invoices.map((i) => i.invoiceId))}) and il.rule_id is not null`,
      );
      const statuses = await ruleStatuses(
        tx,
        rules.rows.map((r) => r.id),
      );
      return {
        ownerId: input.ownerId,
        ownerName: owner.name,
        ownerTin: owner.tinMasked,
        month: start,
        invoices,
        totals: {
          vatMinor: sum('vatMinor'),
          nhilMinor: sum('nhilMinor'),
          getfundMinor: sum('getfundMinor'),
          adjustmentsMinor: sum('adjustmentsMinor'),
          totalMinor: sum('totalMinor'),
          paidMinor: paid,
          outstandingMinor: sum('totalMinor') - paid,
        },
        payments,
        warnings: [...statuses.values()]
          .filter((r) => r.status !== 'verified')
          .map((r) => `${r.key}: unverified, tax adviser to confirm (OQ-20)`),
      };
    });
  }

  /** Records VAT and levies paid to GRA with a return (P33): Dr 2210, Cr 1010 or 1070. */
  async recordVatPayment(
    actor: Actor | null,
    input: VatPaymentInput,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tax.manage');
    const month = monthStart(input.periodMonth);
    await withCompany(this.database, staffContext(staff), (tx) =>
      this.checkPayment(tx, staff, input),
    );
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.receiptUploadId,
      GRA_RECEIPT_UPLOAD,
    );
    const id = uuidv7();
    await withCompany(this.database, this.unscoped(staff), async (tx) => {
      await options.claim?.claim(tx);
      const bookId = await this.checkPayment(tx, staff, input);
      await lockOwnerTax(tx, staff.companyId, input.ownerId);
      const owed = await tx.execute<{ total: string }>(
        sql`select coalesce(-sum(amount_minor), 0)::bigint as total from journal_line
            where book_id = ${bookId} and account_code = '2210'`,
      );
      if (input.amountMinor > Number(owed.rows[0]?.total ?? 0))
        throw conflict('vat_over_payable', 'The payment is more than the VAT and levies owed');
      const posted = await this.posting.post(tx, {
        companyId: staff.companyId,
        rule: 'P33',
        key: `P33:${id}`,
        valueDate: input.paidOn,
        lines: vatPaymentLines({
          bookId,
          from: ACCOUNT[input.paidFrom],
          amountMinor: input.amountMinor,
        }),
        record: { type: 'vat_payment', id },
        causedBy: staff.personId,
      });
      const receiptDocumentId = await this.documents.recordStagedEvidence(
        tx,
        staged,
        'gra_receipt',
      );
      await tx.insert(schema.vatPayment).values({
        id,
        companyId: staff.companyId,
        ownerId: input.ownerId,
        bookId,
        periodMonth: month,
        paidOn: input.paidOn,
        accountingDate: posted!.accountingDate,
        amountMinor: input.amountMinor,
        graReceiptNumber: input.graReceiptNumber.trim().slice(0, 80),
        receiptDocumentId,
        paidFrom: input.paidFrom,
        note: input.note?.trim().slice(0, 500) || null,
        entryId: posted!.entryId,
        recordedBy: staff.personId,
      });
      await options.claim?.done(tx, { vatPaymentId: id });
    });
    await this.documents.discardStagedUpload(staged);
    return id;
  }

  async vatPayments(
    actor: Actor | null,
    filter: {
      readonly ownerId?: string;
      readonly periodMonth?: string;
      readonly ids?: readonly string[];
    },
  ): Promise<VatPaymentView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), (tx) => this.vatPaymentsIn(tx, filter));
  }

  private async vatPaymentsIn(
    tx: Tx,
    filter: {
      readonly ownerId?: string;
      readonly periodMonth?: string;
      readonly ids?: readonly string[];
    },
  ): Promise<VatPaymentView[]> {
    const rows = await tx.select().from(schema.vatPayment).orderBy(schema.vatPayment.paidOn);
    return rows
      .filter(
        (r) =>
          (!filter.ownerId || r.ownerId === filter.ownerId) &&
          (!filter.periodMonth || r.periodMonth === monthStart(filter.periodMonth)) &&
          (!filter.ids || filter.ids.includes(r.id)),
      )
      .map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        periodMonth: r.periodMonth,
        paidOn: r.paidOn,
        accountingDate: r.accountingDate,
        amountMinor: r.amountMinor,
        graReceiptNumber: r.graReceiptNumber,
        receiptDocumentId: r.receiptDocumentId,
        paidFrom: r.paidFrom as 'owner_account' | 'agency_account',
        note: r.note,
        createdAt: r.createdAt,
      }));
  }

  /** Whether a document is a GRA receipt of a payment the person may see. */
  async receiptDocumentVisible(tx: Tx, documentId: string): Promise<boolean> {
    const [g] = await tx
      .select({ id: schema.graPayment.id })
      .from(schema.graPayment)
      .where(eq(schema.graPayment.receiptDocumentId, documentId));
    if (g) return true;
    const [v] = await tx
      .select({ id: schema.vatPayment.id })
      .from(schema.vatPayment)
      .where(eq(schema.vatPayment.receiptDocumentId, documentId));
    return Boolean(v);
  }
}

/** A month as its first day: `2026-10` or any date in it gives `2026-10-01`. */
export function monthStart(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (!match) throw invalid('month', 'Give the month as 2026-10');
  const first = `${match[1]}-${match[2]}-01`;
  parseBusinessDate(first);
  return first;
}
