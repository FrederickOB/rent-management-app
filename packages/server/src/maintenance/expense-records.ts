import { sql, type Tx } from '@rent/db';
import {
  EXPENSE_CATEGORY_LABELS,
  formatTicketNumber,
  type ExpenseCategory,
  type ExpensePaidBy,
  type ExpenseStatus,
} from '@rent/domain/maintenance';

/** An expense as the lists show it (AC-03): its status derived from its payment and reversal. */
export interface ExpenseRowView {
  readonly id: string;
  readonly category: ExpenseCategory;
  readonly categoryLabel: string;
  readonly supplierName: string;
  readonly amountMinor: number;
  readonly currency: 'GHS';
  readonly expenseDate: string;
  readonly paidBy: ExpensePaidBy;
  readonly status: ExpenseStatus;
  readonly property: { readonly id: string; readonly name: string };
  readonly unit: { readonly id: string; readonly code: string } | null;
  readonly owner: { readonly id: string; readonly name: string };
  readonly job: { readonly id: string; readonly ticket: string } | null;
  readonly hasReceipt: boolean;
  /** F3: receipts are optional; one without is flagged "No receipt" (M9 carries it on). */
  readonly noReceipt: boolean;
  readonly note: string | null;
  readonly paidOn: string | null;
  readonly reversal: {
    readonly reason: string;
    readonly at: Date;
    readonly byName: string | null;
  } | null;
  readonly createdAt: Date;
  /** Internal: the receipt to download and the entries to reverse. */
  readonly receiptDocumentId: string | null;
  readonly entryId: string;
  readonly paymentEntryId: string | null;
  readonly bookId: string;
  readonly unitId: string | null;
}

export interface ExpenseFilter {
  readonly expenseId?: string;
  readonly jobId?: string;
  readonly propertyId?: string;
  readonly ownerId?: string;
  readonly status?: ExpenseStatus;
  readonly category?: ExpenseCategory;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Expenses in the caller's transaction, newest first; Row Level Security keeps them to the
 * reader's properties and owners (decision 9).
 */
export async function expenseRows(tx: Tx, f: ExpenseFilter): Promise<ExpenseRowView[]> {
  const rows = await tx.execute<{
    id: string;
    category: string;
    supplier_name: string;
    amount_minor: string;
    expense_date: string;
    paid_by: string;
    property_id: string;
    property_name: string;
    unit_id: string | null;
    unit_code: string | null;
    owner_id: string;
    owner_name: string;
    job_id: string | null;
    ticket_number: number | null;
    receipt_document_id: string | null;
    note: string | null;
    entry_id: string;
    book_id: string;
    created_at: Date;
    paid_on: string | null;
    payment_entry_id: string | null;
    reversal_reason: string | null;
    reversed_at: Date | null;
    reversed_by: string | null;
  }>(sql`
    select e.id, e.category, e.supplier_name, e.amount_minor, e.expense_date::text as expense_date,
           e.paid_by, e.property_id, p.name as property_name, e.unit_id, u.code as unit_code,
           e.owner_id, o.display_name as owner_name, e.job_id, j.ticket_number,
           e.receipt_document_id, e.note, e.entry_id, e.book_id, e.created_at,
           pay.paid_on::text as paid_on, pay.entry_id as payment_entry_id,
           r.reason as reversal_reason, r.created_at as reversed_at, pr.name as reversed_by
    from expense e
    join property p on p.company_id = e.company_id and p.id = e.property_id
    join owner o on o.company_id = e.company_id and o.id = e.owner_id
    left join unit u on u.company_id = e.company_id and u.id = e.unit_id
    left join maintenance_job j on j.company_id = e.company_id and j.id = e.job_id
    left join expense_payment pay on pay.company_id = e.company_id and pay.expense_id = e.id
    left join expense_reversal r on r.company_id = e.company_id and r.expense_id = e.id
    left join person pr on pr.id = r.created_by
    where true
      ${f.expenseId ? sql`and e.id = ${f.expenseId}` : sql``}
      ${f.jobId ? sql`and e.job_id = ${f.jobId}` : sql``}
      ${f.propertyId ? sql`and e.property_id = ${f.propertyId}` : sql``}
      ${f.ownerId ? sql`and e.owner_id = ${f.ownerId}` : sql``}
      ${f.category ? sql`and e.category = ${f.category}` : sql``}
      ${f.from ? sql`and e.expense_date >= ${f.from}::date` : sql``}
      ${f.to ? sql`and e.expense_date <= ${f.to}::date` : sql``}
      ${
        f.status === 'reversed'
          ? sql`and r.id is not null`
          : f.status === 'paid'
            ? sql`and r.id is null and (e.paid_by <> 'unpaid' or pay.id is not null)`
            : f.status === 'unpaid'
              ? sql`and r.id is null and e.paid_by = 'unpaid' and pay.id is null`
              : sql``
      }
    order by e.expense_date desc, e.created_at desc
    limit 500`);
  return rows.rows.map((r) => ({
    id: r.id,
    category: r.category as ExpenseCategory,
    categoryLabel: EXPENSE_CATEGORY_LABELS[r.category as ExpenseCategory],
    supplierName: r.supplier_name,
    amountMinor: Number(r.amount_minor),
    currency: 'GHS',
    expenseDate: r.expense_date,
    paidBy: r.paid_by as ExpensePaidBy,
    status: r.reversal_reason
      ? 'reversed'
      : r.paid_by === 'unpaid' && !r.payment_entry_id
        ? 'unpaid'
        : 'paid',
    property: { id: r.property_id, name: r.property_name },
    unit: r.unit_id ? { id: r.unit_id, code: r.unit_code ?? '' } : null,
    owner: { id: r.owner_id, name: r.owner_name },
    job:
      r.job_id && r.ticket_number !== null
        ? { id: r.job_id, ticket: formatTicketNumber(r.ticket_number) }
        : null,
    hasReceipt: r.receipt_document_id !== null,
    noReceipt: r.receipt_document_id === null,
    note: r.note,
    paidOn: r.paid_on ?? (r.paid_by === 'unpaid' ? null : r.expense_date),
    reversal:
      r.reversal_reason && r.reversed_at
        ? { reason: r.reversal_reason, at: new Date(r.reversed_at), byName: r.reversed_by }
        : null,
    createdAt: new Date(r.created_at),
    receiptDocumentId: r.receipt_document_id,
    entryId: r.entry_id,
    paymentEntryId: r.payment_entry_id,
    bookId: r.book_id,
    unitId: r.unit_id,
  }));
}
