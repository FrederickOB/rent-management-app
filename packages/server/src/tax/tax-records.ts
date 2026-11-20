import { schema, sql, type SQL, type Tx } from '@rent/db';
import { verificationWarning, type VerificationStatus } from '@rent/domain/rules';
import {
  taxItemOutstanding,
  taxItemStatus,
  type TaxItemKind,
  type TaxItemStatus,
} from '@rent/domain/tax';
import { formatReceiptNumber } from '../billing/records';

/**
 * Rent tax items as the screens, the report and the jobs read them (M5 plan 5.1 to 5.3): each
 * with what corrected it, what GRA payments settled and whether its withholding was written off,
 * all optionally as of an accounting date (a report for a past period sees only what had been
 * recorded for it then, so it regenerates identically).
 */
export interface TaxItemRecord {
  readonly id: string;
  readonly kind: TaxItemKind;
  /**
   * The lease, unit and tenant it is tax on. Null for an owner-level item (M11, P25): rent tax the
   * owner still owed GRA at the cut-over (kind `opening`), and a reversal that lowers one.
   */
  readonly leaseId: string | null;
  readonly propertyId: string | null;
  readonly unitId: string | null;
  readonly tenantId: string | null;
  readonly ownerId: string;
  readonly bookId: string;
  readonly paymentId: string | null;
  readonly withholdingId: string | null;
  readonly reversesItemId: string | null;
  readonly valueDate: string;
  readonly accountingDate: string;
  readonly dueDate: string | null;
  readonly baseMinor: number;
  readonly rateBps: number;
  readonly taxMinor: number;
  readonly leaseUse: 'residential' | 'commercial' | null;
  readonly unitCode: string | null;
  readonly tenantName: string | null;
  readonly receiptNumber: string | null;
  /** Null for an owner-level item: its amount was brought in, not worked out at a rate. */
  readonly rateRuleId: string | null;
  readonly ruleIds: readonly string[];
  readonly alertRuleId: string | null;
  /** The due days and alert days its rules rows held (TX-02, TX-08; M5 review 8). */
  readonly dueDays: number | null;
  readonly alertDays: readonly number[];
  readonly correctedMinor: number;
  readonly paidMinor: number;
  readonly withholdingWrittenOff: boolean;
  readonly status: TaxItemStatus;
  readonly outstandingMinor: number;
  readonly createdAt: Date;
}

type ItemRow = {
  id: string;
  kind: TaxItemKind;
  lease_id: string | null;
  property_id: string | null;
  unit_id: string | null;
  tenant_id: string | null;
  owner_id: string;
  book_id: string;
  payment_id: string | null;
  withholding_id: string | null;
  reverses_item_id: string | null;
  value_date: string;
  accounting_date: string;
  due_date: string | null;
  base_minor: string;
  rate_bps: number;
  tax_minor: string;
  lease_use: 'residential' | 'commercial' | null;
  unit_code: string | null;
  tenant_name: string | null;
  receipt_number: string | null;
  rate_rule_id: string | null;
  base_rule_id: string | null;
  rounding_rule_id: string | null;
  service_charge_rule_id: string | null;
  due_rule_id: string | null;
  alert_rule_id: string | null;
  due_value: unknown;
  alert_value: unknown;
  corrected: string;
  paid: string;
  written_off: boolean;
  created_at: Date | string;
};

const iso = (d: string | Date): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** Items matching `where` (a condition on `i`), as of an accounting date when given. */
export async function taxItems(
  tx: Tx,
  where: SQL,
  asOf: string | null = null,
): Promise<TaxItemRecord[]> {
  const until = asOf === null ? sql`true` : sql`x.accounting_date <= ${asOf}::date`;
  const paidUntil = asOf === null ? sql`true` : sql`g.accounting_date <= ${asOf}::date`;
  const offUntil = asOf === null ? sql`true` : sql`o.accounting_date <= ${asOf}::date`;
  const rows = await tx.execute<ItemRow>(
    sql`select i.id, i.kind, i.lease_id, i.property_id, i.unit_id, i.tenant_id, i.owner_id, i.book_id,
          i.payment_id, i.withholding_id, i.reverses_item_id, i.value_date::text, i.accounting_date::text,
          i.due_date::text, i.base_minor, i.rate_bps, i.tax_minor, i.lease_use, i.unit_code, i.tenant_name,
          i.receipt_number, i.rate_rule_id, i.base_rule_id, i.rounding_rule_id, i.service_charge_rule_id,
          i.due_rule_id, i.alert_rule_id, i.created_at,
          (select r.value from rule r where r.id = i.due_rule_id) as due_value,
          (select r.value from rule r where r.id = i.alert_rule_id) as alert_value,
          coalesce((select sum(x.tax_minor) from rent_tax_item x
                    where x.company_id = i.company_id and x.reverses_item_id = i.id and ${until}), 0)::bigint as corrected,
          coalesce((select sum(p.amount_minor) from gra_payment_item p
                    join gra_payment g on g.company_id = p.company_id and g.id = p.gra_payment_id
                    where p.company_id = i.company_id and p.item_id = i.id and ${paidUntil}), 0)::bigint as paid,
          (i.withholding_id is not null and exists (select 1 from withholding_write_off o
            where o.company_id = i.company_id and o.withholding_id = i.withholding_id and ${offUntil})) as written_off
        from rent_tax_item i
        where ${where}
        order by i.accounting_date, i.value_date, i.created_at, i.id`,
  );
  return rows.rows.map((r) => {
    const facts = {
      kind: r.kind,
      taxMinor: Number(r.tax_minor),
      correctedMinor: Number(r.corrected),
      paidMinor: Number(r.paid),
      withholdingWrittenOff: r.written_off,
    };
    return {
      id: r.id,
      kind: r.kind,
      leaseId: r.lease_id,
      propertyId: r.property_id,
      unitId: r.unit_id,
      tenantId: r.tenant_id,
      ownerId: r.owner_id,
      bookId: r.book_id,
      paymentId: r.payment_id,
      withholdingId: r.withholding_id,
      reversesItemId: r.reverses_item_id,
      valueDate: iso(r.value_date),
      accountingDate: iso(r.accounting_date),
      dueDate: r.due_date ? iso(r.due_date) : null,
      baseMinor: Number(r.base_minor),
      rateBps: r.rate_bps,
      taxMinor: facts.taxMinor,
      leaseUse: r.lease_use,
      unitCode: r.unit_code,
      tenantName: r.tenant_name,
      receiptNumber:
        r.receipt_number === null ? null : formatReceiptNumber(Number(r.receipt_number)),
      rateRuleId: r.rate_rule_id,
      ruleIds: [
        r.rate_rule_id,
        r.base_rule_id,
        r.rounding_rule_id,
        r.service_charge_rule_id,
        r.due_rule_id,
        r.alert_rule_id,
      ].filter((x): x is string => x !== null),
      alertRuleId: r.alert_rule_id,
      dueDays: daysOf(r.due_value),
      alertDays: alertDaysOf(r.alert_value),
      correctedMinor: facts.correctedMinor,
      paidMinor: facts.paidMinor,
      withholdingWrittenOff: r.written_off,
      status: taxItemStatus(facts),
      outstandingMinor: taxItemOutstanding(facts),
      createdAt: typeof r.created_at === 'string' ? new Date(r.created_at) : r.created_at,
    };
  });
}

/** Base and tax already pinned to each charge period of a lease, net of every correction. */
export async function taxedByPeriod(
  tx: Tx,
  leaseId: string,
): Promise<Map<string, { baseMinor: number; taxMinor: number }>> {
  const rows = await tx.execute<{ charge_period_id: string; base: string; tax: string }>(
    sql`select charge_period_id, sum(base_minor)::bigint as base, sum(tax_minor)::bigint as tax
        from rent_tax_item_line where lease_id = ${leaseId} group by charge_period_id`,
  );
  return new Map(
    rows.rows.map((r) => [
      r.charge_period_id,
      { baseMinor: Number(r.base), taxMinor: Number(r.tax) },
    ]),
  );
}

/** An item's lines netted with its corrections' lines, per charge period. */
export async function netItemLines(
  tx: Tx,
  itemId: string,
): Promise<
  { chargePeriodId: string; invoiceLineId: string | null; baseMinor: number; taxMinor: number }[]
> {
  const rows = await tx.execute<{
    charge_period_id: string;
    invoice_line_id: string | null;
    base: string;
    tax: string;
  }>(
    sql`select l.charge_period_id, max(l.invoice_line_id::text)::uuid as invoice_line_id,
          sum(l.base_minor)::bigint as base, sum(l.tax_minor)::bigint as tax
        from rent_tax_item_line l join rent_tax_item i on i.company_id = l.company_id and i.id = l.item_id
        where i.id = ${itemId} or i.reverses_item_id = ${itemId}
        group by l.charge_period_id order by l.charge_period_id`,
  );
  return rows.rows.map((r) => ({
    chargePeriodId: r.charge_period_id,
    invoiceLineId: r.invoice_line_id,
    baseMinor: Number(r.base),
    taxMinor: Number(r.tax),
  }));
}

/** The staff warnings for the rules rows used, from each row's verification status (section 7). */
export async function ruleWarnings(tx: Tx, ruleIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(ruleIds)];
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ key: string; verification_status: VerificationStatus }>(
    sql`select key, verification_status from rule where id = any(${uuids(ids)}) order by key`,
  );
  const out: string[] = [];
  for (const r of rows.rows) {
    const warning = verificationWarning(r.verification_status);
    if (warning) out.push(`${r.key}: ${warning}`);
  }
  return [...new Set(out)];
}

/** A rule row's verification status, for the screens' warnings. */
export async function ruleStatuses(
  tx: Tx,
  ruleIds: readonly string[],
): Promise<Map<string, { key: string; status: VerificationStatus }>> {
  const ids = [...new Set(ruleIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{
    id: string;
    key: string;
    verification_status: VerificationStatus;
  }>(sql`select id, key, verification_status from rule where id = any(${uuids(ids)})`);
  return new Map(rows.rows.map((r) => [r.id, { key: r.key, status: r.verification_status }]));
}

/** A list of ids as one Postgres uuid[] parameter (an array literal), for `= any(...)`. */
export const uuids = (ids: readonly string[]): SQL =>
  sql`${`{${ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).join(',')}}`}::uuid[]`;

/** Serialises an owner's rent tax writes (items settled by GRA payments, VAT paid). */
export async function lockOwnerTax(tx: Tx, companyId: string, ownerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`rent_tax:${companyId}:${ownerId}`}, 0))`,
  );
}

/**
 * The lock order for rent tax items (M5 review 10): lease locks first (every billing write holds
 * them), then the owners' tax locks, in id order. A GRA payment takes only its owner's tax lock,
 * and every correction of an item (a reversal's P21, a withholding's offset) takes it after its
 * lease locks, so an item is never settled beyond its net tax and no two writers wait on each
 * other in a circle.
 */
export async function lockOwnersTax(
  tx: Tx,
  companyId: string,
  ownerIds: readonly string[],
): Promise<void> {
  for (const ownerId of [...new Set(ownerIds)].sort()) await lockOwnerTax(tx, companyId, ownerId);
}

/** A rules row's whole number of days (`rent_tax.due_days_after_receipt`), or null. */
export function daysOf(value: unknown): number | null {
  const days = (value as { days?: unknown } | null)?.days;
  return typeof days === 'number' && Number.isSafeInteger(days) ? days : null;
}

/** A rules row's alert days (`rent_tax.alert_days`), in order. */
export function alertDaysOf(value: unknown): number[] {
  const days = (value as { days?: unknown } | null)?.days;
  return Array.isArray(days)
    ? days
        .filter((d): d is number => typeof d === 'number' && Number.isSafeInteger(d))
        .sort((a, b) => a - b)
    : [];
}

/** A rent tax event that could not be assessed (M5 review 7), as the audit log keeps it. */
export interface NotAssessedEvent {
  readonly event: 'receipt' | 'carry_over' | 'deposit_applied' | 'withholding';
  /** The P17 key its assessment uses: `P17:<payment>`, `P17:<carry-over>` or `P17:<withholding>`. */
  readonly eventKey: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly unitCode: string;
  readonly paymentId: string | null;
  readonly withholdingId: string | null;
  readonly valueDate: string;
  /** The most it may be taxed on: the receipt's rent money, the credit carried, the amount withheld. */
  readonly capMinor: number;
  /** For a withholding: cash it returned to credit, by payment (review 2). */
  readonly released: readonly { readonly paymentId: string; readonly amountMinor: number }[];
  readonly reason: 'rule_missing' | 'rule_unsupported';
  readonly ruleKey: string | null;
  readonly message: string;
}

export const NOT_ASSESSED_ACTION = 'rent_tax.not_assessed';
export const ASSESSED_ACTION = 'rent_tax.assessed';

/**
 * Records in the audit log (append-only, hash-chained) that an event's rent tax was not assessed,
 * or was assessed later: the money posted all the same (TX-08; M5 review 7).
 */
export async function appendTaxEvent(
  tx: Tx,
  companyId: string,
  action: typeof NOT_ASSESSED_ACTION | typeof ASSESSED_ACTION,
  eventKey: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    sql`select audit.append(${companyId}::uuid, ${action}, ${'rent_tax_event'}, ${eventKey}, ${JSON.stringify(data)}::jsonb)`,
  );
}

/** Events not assessed and not assessed since, oldest first, optionally for an owner or a lease. */
export async function notAssessedEvents(
  tx: Tx,
  filter: { readonly ownerId?: string; readonly leaseId?: string; readonly open?: boolean } = {},
): Promise<(NotAssessedEvent & { readonly recordedAt: Date; readonly assessed: boolean })[]> {
  const rows = await tx.execute<{
    data: NotAssessedEvent;
    occurred_at: Date | string;
    assessed: boolean;
  }>(
    sql`select e.data, e.occurred_at,
          exists (select 1 from audit_event a where a.company_id = e.company_id and a.action = ${ASSESSED_ACTION}
                    and a.record_type = 'rent_tax_event' and a.record_id = e.record_id) as assessed
        from audit_event e
        where e.action = ${NOT_ASSESSED_ACTION} and e.record_type = 'rent_tax_event'
        order by e.seq`,
  );
  return rows.rows
    .map((r) => ({
      ...r.data,
      recordedAt: typeof r.occurred_at === 'string' ? new Date(r.occurred_at) : r.occurred_at,
      assessed: r.assessed,
    }))
    .filter(
      (e) =>
        (!filter.ownerId || e.ownerId === filter.ownerId) &&
        (!filter.leaseId || e.leaseId === filter.leaseId) &&
        (filter.open === undefined || e.assessed !== filter.open),
    );
}

export { schema };
