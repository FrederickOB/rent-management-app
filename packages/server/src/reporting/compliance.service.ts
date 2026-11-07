import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, type Database, type SQL, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  formatBusinessDate,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import {
  parseRuleValue,
  resolveAsOf,
  type RuleRow,
  type VerificationStatus,
} from '@rent/domain/rules';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import { parseCompanySettings } from '@rent/domain/settings';
import { isoNow } from '../billing/records';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { invalid, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import { taxItems } from '../tax/tax-records';

export type ComplianceKind =
  | 'rent_tax_due'
  | 'rent_tax_overdue'
  | 'rent_control_registration'
  | 'withholding_certificate'
  | 'vat_return'
  | 'advance_over_cap';

export type ComplianceScreen =
  'rent_tax' | 'rent_control' | 'withholding' | 'vat' | 'advance_rent' | 'lease';

/** One thing to do, as the contract's `complianceItemSchema` carries it. */
export interface ComplianceItem {
  /**
   * Stable and unique within the list (a React key; M9 review): the kind plus the record it is
   * about (a lease, a withholding, a flagged advance), or the group it adds up (rent tax by owner,
   * property and due date; VAT by owner and month).
   */
  readonly id: string;
  readonly kind: ComplianceKind;
  readonly owner: { readonly id: string; readonly name: string } | null;
  readonly property: { readonly id: string; readonly name: string } | null;
  readonly lease: { readonly id: string; readonly unitCode: string } | null;
  readonly dueDate: string | null;
  readonly amountMinor: number | null;
  readonly description: string;
  readonly link: { readonly screen: ComplianceScreen; readonly id: string | null };
}

export interface ComplianceFilter {
  readonly ownerId?: string;
  readonly propertyId?: string;
}

const VAT_RETURN_DUE_KEY = 'vat.return_due_days';

/** A rule key's rows for a country, read in the caller's transaction (the table is global). */
async function ruleRows(tx: Tx, country: string, key: string): Promise<RuleRow[]> {
  const rows = await tx
    .select()
    .from(schema.rule)
    .where(and(eq(schema.rule.country, country), eq(schema.rule.key, key)));
  return rows.map((r) => ({
    id: r.id,
    country: r.country,
    key: r.key,
    value: r.value,
    effectiveFrom: parseBusinessDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? parseBusinessDate(r.effectiveTo) : null,
    source: r.source,
    verificationStatus: r.verificationStatus as VerificationStatus,
    createdAt: r.createdAt,
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amount = (minor: number) => format(money(minor));
/** The warning an unverified rule carries where it is used (CLAUDE.md section 7). */
const UNVERIFIED = 'The period comes from a rule not yet verified; counsel to confirm.';
const MONTH_NAMES = [
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
];
const monthName = (month: string) =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/**
 * The compliance list (M9 decision 14; MVP screen inventory): what needs doing for tax and Rent
 * Control, read-only, from records that exist already, each with a link to the screen where it is
 * dealt with. Rent tax due and overdue (TX-02), Rent Control registrations outstanding (TX-05),
 * withholding certificates awaited (TX-04), VAT returns not yet paid (P33), and advances over the
 * cap only where `advance_rent_policy` is `warn` or `block` (OQ-28: under `off` nothing is
 * flagged). Read in the reader's scope; filtered by owner and property. Nothing is posted or sent.
 */
@Injectable()
export class ComplianceService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(actor: Actor | null, filter: ComplianceFilter = {}): Promise<ComplianceItem[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'compliance.read');
    for (const id of [filter.ownerId, filter.propertyId])
      if (id !== undefined && !UUID.test(id)) throw invalid('bad_filter', 'Choose from the list');
    return withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const company = await companyRecord(tx, staff.companyId);
        if (!company) throw notFound('Company');
        const today = isoNow(this.clock, company.timeZone);
        const names = await this.names(tx);
        const items = [
          ...(await this.rentTax(tx, filter, today, names)),
          ...(await this.rentControl(tx, filter, names)),
          ...(await this.withholding(tx, filter, names)),
          ...(filter.propertyId
            ? []
            : await this.vat(tx, filter, today, company.countryCode, names)),
          ...(['warn', 'block'].includes(parseCompanySettings(company.settings).advanceRentPolicy)
            ? await this.advances(tx, filter, names)
            : []),
        ];
        return items.sort(
          (a, b) =>
            (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
            a.kind.localeCompare(b.kind) ||
            (a.property?.name ?? '').localeCompare(b.property?.name ?? '') ||
            (a.lease?.unitCode ?? '').localeCompare(b.lease?.unitCode ?? '') ||
            a.id.localeCompare(b.id),
        );
      },
      { accessMode: 'read only' },
    );
  }

  /** The owners and properties the reader sees, by id. */
  private async names(tx: Tx) {
    const owners = await tx.execute<{ id: string; name: string }>(
      sql`select id, display_name as name from owner`,
    );
    const properties = await tx.execute<{ id: string; name: string }>(
      sql`select id, name from property`,
    );
    return {
      owner: (id: string | null) => {
        const found = id ? owners.rows.find((o) => o.id === id) : undefined;
        return found ? { id: found.id, name: found.name } : null;
      },
      property: (id: string | null) => {
        const found = id ? properties.rows.find((p) => p.id === id) : undefined;
        return found ? { id: found.id, name: found.name } : null;
      },
    };
  }

  /**
   * TX-02: rent tax still to pay GRA, per owner, property and due date, as the rent tax screen's
   * due list reads it (`taxItems`): overdue once its due date has passed.
   */
  private async rentTax(
    tx: Tx,
    filter: ComplianceFilter,
    today: string,
    names: Awaited<ReturnType<ComplianceService['names']>>,
  ): Promise<ComplianceItem[]> {
    const where: SQL[] = [sql`true`];
    if (filter.ownerId) where.push(sql`i.owner_id = ${filter.ownerId}::uuid`);
    if (filter.propertyId) where.push(sql`i.property_id = ${filter.propertyId}::uuid`);
    const open = (await taxItems(tx, sql.join(where, sql` and `))).filter(
      (i) => i.outstandingMinor > 0,
    );
    const groups = new Map<
      string,
      { ownerId: string; propertyId: string; dueDate: string | null; total: number; n: number }
    >();
    for (const item of open) {
      const key = `${item.ownerId}:${item.propertyId}:${item.dueDate ?? ''}`;
      const group = groups.get(key) ?? {
        ownerId: item.ownerId,
        propertyId: item.propertyId,
        dueDate: item.dueDate,
        total: 0,
        n: 0,
      };
      group.total += item.outstandingMinor;
      group.n += 1;
      groups.set(key, group);
    }
    return [...groups.values()].map((g) => {
      const overdue = g.dueDate !== null && g.dueDate < today;
      const receipts = g.n === 1 ? 'one receipt' : `${g.n} receipts`;
      const kind = overdue ? ('rent_tax_overdue' as const) : ('rent_tax_due' as const);
      return {
        id: `${kind}:${g.ownerId}:${g.propertyId}:${g.dueDate ?? 'undated'}`,
        kind,
        owner: names.owner(g.ownerId),
        property: names.property(g.propertyId),
        lease: null,
        dueDate: g.dueDate,
        amountMinor: g.total,
        description: overdue
          ? `Rent tax of ${amount(g.total)} on ${receipts} was due to GRA by ${formatBusinessDate(g.dueDate!)} and is not recorded as paid.`
          : `Pay GRA ${amount(g.total)} of rent tax on ${receipts}${g.dueDate ? ` by ${formatBusinessDate(g.dueDate)}` : ''}.`,
        link: { screen: 'rent_tax' as const, id: null },
      };
    });
  }

  /** TX-05: leases Rent Control applies to with no registration recorded, as M3's tracker reads them. */
  private async rentControl(
    tx: Tx,
    filter: ComplianceFilter,
    names: Awaited<ReturnType<ComplianceService['names']>>,
  ): Promise<ComplianceItem[]> {
    const where: SQL[] = [
      sql`l.status in ('signed', 'active', 'ending', 'holding_over')`,
      sql`l.rent_control_applies`,
      sql`l.rent_control_registered_on is null`,
    ];
    if (filter.propertyId) where.push(sql`l.property_id = ${filter.propertyId}::uuid`);
    const rows = await tx.execute<{
      id: string;
      property_id: string;
      unit_code: string;
      deadline: string | null;
      status: string | null;
      owner_id: string | null;
    }>(
      sql`select l.id, l.property_id, u.code as unit_code, l.rent_control_deadline::text as deadline,
            (select r.verification_status from rule r where r.id = l.rent_control_rule_id) as status,
            (select co.owner_id from property_current_ownership co
             where co.company_id = l.company_id and co.property_id = l.property_id
             order by co.share_bps desc, co.owner_id limit 1) as owner_id
          from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where ${sql.join(where, sql` and `)}`,
    );
    return rows.rows
      .filter((r) => !filter.ownerId || r.owner_id === filter.ownerId)
      .map((r) => ({
        id: `rent_control_registration:${r.id}`,
        kind: 'rent_control_registration' as const,
        owner: names.owner(r.owner_id),
        property: names.property(r.property_id),
        lease: { id: r.id, unitCode: r.unit_code },
        dueDate: r.deadline,
        amountMinor: null,
        description: [
          `Register the lease for ${r.unit_code} with Rent Control${r.deadline ? ` by ${formatBusinessDate(r.deadline)}` : ''}, then record the number and date on the lease.`,
          r.status === 'verified' ? null : UNVERIFIED,
        ]
          .filter(Boolean)
          .join(' '),
        link: { screen: 'rent_control' as const, id: r.id },
      }));
  }

  /** TX-04: tax a corporate tenant withheld with no confirmed certificate, and not written off. */
  private async withholding(
    tx: Tx,
    filter: ComplianceFilter,
    names: Awaited<ReturnType<ComplianceService['names']>>,
  ): Promise<ComplianceItem[]> {
    const where: SQL[] = [
      sql`not exists (select 1 from withholding_certificate c where c.company_id = w.company_id
            and c.withholding_id = w.id and c.status = 'confirmed')`,
      sql`not exists (select 1 from withholding_write_off o where o.company_id = w.company_id
            and o.withholding_id = w.id)`,
    ];
    if (filter.ownerId) where.push(sql`w.owner_id = ${filter.ownerId}::uuid`);
    if (filter.propertyId) where.push(sql`w.property_id = ${filter.propertyId}::uuid`);
    const rows = await tx.execute<{
      id: string;
      lease_id: string;
      owner_id: string;
      property_id: string;
      unit_code: string;
      value_date: string;
      amount_minor: number;
      uploaded: boolean;
    }>(
      sql`select w.id, w.lease_id, w.owner_id, w.property_id, u.code as unit_code, w.value_date::text as value_date,
            w.amount_minor,
            exists (select 1 from withholding_certificate c where c.company_id = w.company_id
                    and c.withholding_id = w.id and c.status = 'awaiting_confirmation') as uploaded
          from withholding w
          join lease l on l.company_id = w.company_id and l.id = w.lease_id
          join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where ${sql.join(where, sql` and `)}`,
    );
    return rows.rows.map((r) => ({
      id: `withholding_certificate:${r.id}`,
      kind: 'withholding_certificate' as const,
      owner: names.owner(r.owner_id),
      property: names.property(r.property_id),
      lease: { id: r.lease_id, unitCode: r.unit_code },
      dueDate: null,
      amountMinor: Number(r.amount_minor),
      description: r.uploaded
        ? `The withholding tax certificate for ${amount(Number(r.amount_minor))} withheld on ${formatBusinessDate(r.value_date)} is uploaded and waits for a user for the owner to confirm it.`
        : `Ask the tenant for the withholding tax certificate for ${amount(Number(r.amount_minor))} withheld on ${formatBusinessDate(r.value_date)}.`,
      link: { screen: 'withholding' as const, id: r.lease_id },
    }));
  }

  /**
   * P33: VAT and levies an owner charged in a past month (by tax point, as the VAT report reads
   * it) and has not yet paid to GRA with the month's return. The return's due date is the rule
   * `vat.return_due_days` in force at the month's end: days after it. The rule has no value until
   * the tax adviser supplies one (OQ-61), so until then no date is shown and the item says the due
   * date is unverified; an unverified value, once there, gives a date with that warning.
   */
  private async vat(
    tx: Tx,
    filter: ComplianceFilter,
    today: string,
    country: string,
    names: Awaited<ReturnType<ComplianceService['names']>>,
  ): Promise<ComplianceItem[]> {
    const thisMonth = `${today.slice(0, 7)}-01`;
    const owner = filter.ownerId ? sql`and b.owner_id = ${filter.ownerId}::uuid` : sql``;
    const charged = await tx.execute<{ owner_id: string; value_date: string; amount: number }>(
      sql`select b.owner_id, e.value_date::text as value_date, (-sum(l.amount_minor))::bigint as amount
          from journal_line l
          join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
          join book b on b.company_id = l.company_id and b.id = l.book_id
          where l.account_code = '2210' and e.rule in ('P32', 'P27') and b.owner_id is not null
            and e.value_date < ${thisMonth}::date ${owner}
          group by b.owner_id, e.value_date`,
    );
    if (charged.rows.length === 0) return [];
    const paid = await tx.execute<{ owner_id: string; month: string; amount: number }>(
      sql`select owner_id, period_month::text as month, sum(amount_minor)::bigint as amount
          from vat_payment group by owner_id, period_month`,
    );
    const due = new Map<string, number>();
    for (const r of charged.rows) {
      const key = `${r.owner_id}|${r.value_date.slice(0, 7)}`;
      due.set(key, (due.get(key) ?? 0) + Number(r.amount));
    }
    for (const p of paid.rows) {
      const key = `${p.owner_id}|${p.month.slice(0, 7)}`;
      if (due.has(key)) due.set(key, due.get(key)! - Number(p.amount));
    }
    const rules = await ruleRows(tx, country, VAT_RETURN_DUE_KEY);
    const items: ComplianceItem[] = [];
    for (const [key, outstanding] of due) {
      if (outstanding <= 0) continue;
      const [ownerId, month] = key.split('|') as [string, string];
      const monthEnd = addDays(addMonths(parseBusinessDate(`${month}-01`), 1), -1);
      const rule = resolveAsOf(rules, monthEnd);
      const days =
        rule?.value === null || rule?.value === undefined
          ? null
          : (parseRuleValue(VAT_RETURN_DUE_KEY, rule.value) as { days: number }).days;
      const dueDate = days === null ? null : toIsoDate(addDays(monthEnd, days));
      const verified = rule?.verificationStatus === 'verified' && dueDate !== null;
      items.push({
        id: `vat_return:${ownerId}:${month}`,
        kind: 'vat_return' as const,
        owner: names.owner(ownerId),
        property: null,
        lease: null,
        dueDate,
        amountMinor: outstanding,
        description: [
          `VAT and levies of ${amount(outstanding)} charged in ${monthName(month)} are not yet recorded as paid to GRA with the month's return${dueDate ? `, due by ${formatBusinessDate(dueDate)}` : ''}.`,
          verified
            ? null
            : dueDate
              ? 'Due date unverified: the rule it comes from is not yet verified (tax adviser to confirm, OQ-61).'
              : 'Due date unverified: the rules table has no value for it yet (tax adviser to confirm, OQ-61).',
        ]
          .filter(Boolean)
          .join(' '),
        link: { screen: 'vat' as const, id: ownerId },
      });
    }
    return items;
  }

  /** AR-05 under `warn` or `block`: payments flagged over the advance limit (M5's report). */
  private async advances(
    tx: Tx,
    filter: ComplianceFilter,
    names: Awaited<ReturnType<ComplianceService['names']>>,
  ): Promise<ComplianceItem[]> {
    const where: SQL[] = [sql`a.flagged`];
    if (filter.ownerId) where.push(sql`p.owner_id = ${filter.ownerId}::uuid`);
    if (filter.propertyId) where.push(sql`a.property_id = ${filter.propertyId}::uuid`);
    const rows = await tx.execute<{
      id: string;
      lease_id: string;
      property_id: string;
      owner_id: string | null;
      unit_code: string;
      value_date: string;
      months_ahead: number;
      limit_months: number | null;
      amount_minor: number;
      status: string | null;
    }>(
      sql`select a.id, a.lease_id, a.property_id, p.owner_id, u.code as unit_code, a.value_date::text as value_date,
            a.months_ahead, a.limit_months, p.amount_minor, r.verification_status as status
          from payment_advance a
          join payment p on p.company_id = a.company_id and p.id = a.payment_id
          join lease l on l.company_id = a.company_id and l.id = a.lease_id
          join unit u on u.company_id = l.company_id and u.id = l.unit_id
          left join rule r on r.id = a.rule_id
          where ${sql.join(where, sql` and `)}`,
    );
    return rows.rows.map((r) => ({
      id: `advance_over_cap:${r.id}`,
      kind: 'advance_over_cap' as const,
      owner: names.owner(r.owner_id),
      property: names.property(r.property_id),
      lease: { id: r.lease_id, unitCode: r.unit_code },
      dueDate: null,
      amountMinor: Number(r.amount_minor),
      description: [
        `A payment of ${amount(Number(r.amount_minor))} on ${formatBusinessDate(r.value_date)} paid ${r.months_ahead} months ahead${r.limit_months === null ? '' : `, over the limit of ${r.limit_months}`}.`,
        r.status === 'verified'
          ? null
          : 'The limit comes from a rule not yet verified; counsel to confirm.',
      ]
        .filter(Boolean)
        .join(' '),
      link: { screen: 'advance_rent' as const, id: r.lease_id },
    }));
  }
}
